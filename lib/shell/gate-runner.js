// shell/gate-runner.js — the deterministic GATE PIPELINE that runs between a
// worker's claim and the item counting as done (task-spor-work-gate-pipeline).
//
// `spor work` v1 dispatched and accepted whatever came back: an agent that
// wrote a resolver had, by definition, finished. This is the enforcement layer
// that sits after the run and before the worker treats the item as resolved —
// the gates a factory definition declares (kernel/gates.js), applied IN CODE.
// Nothing here is delegated to an orchestrator agent as prose: the suite is
// run by this process, the review's verdict is parsed by this process, the
// approval is polled by this process (dec-spor-software-factory-substrate).
//
// Three rules the shape exists to keep:
//
//   1. **The suite is the TRUSTED ref's, never the implementer branch's copy.**
//      stack72's "tests are more accurate than the code under test" only holds
//      while the thing under test cannot rewrite its own judge. So a command
//      gate takes the implementer's tree and FORCES every declared protected
//      path back to the trusted ref before running anything — and an
//      implementer diff that touched one of those paths at all fails CLOSED
//      (no suite run, no retry) and routes to a separate test-change lane under
//      a different profile. Same entity, same misunderstanding: the lane that
//      writes the test may not be the lane that writes the code.
//   2. **A verdict is READ, never asserted.** A review gate parses a structured
//      findings verdict; anything unreadable is a failure, not a pass. A gate
//      that waves an unparseable report through launders an unread review into
//      an approval.
//   3. **Every gate outcome is a graph fact linked to the work item.** That is
//      what makes maintenance-over-telemetry possible later: the factory's
//      history is in the graph, not in a log file on one box.
//   4. **A refusal DEMOTES the item on the graph, not just on this box.** The
//      gate necessarily runs after the run wrote its resolver, so a refused
//      claim is one the graph is already carrying as finished, and a
//      machine-local cooldown says nothing to any other reader. So a failed or
//      blocked pipeline also writes the refusal as graph state (`demote`
//      below), in two parts that do different jobs:
//        - the `requires: [human]` item it files carries `blocks` onto the work
//          item. THIS is the fail-closed dependency, and the live queue item a
//          person actually sees;
//        - the work item's own COMPLETION status is rolled back, so the
//          status-derived surfaces (`spor get`'s lagging ⚠, analytics, `spor
//          work --status`) stop reporting the refused claim as finished.
//      What the rollback does NOT do is put the item back in the queue: queue
//      liveness is derived from the resolving EDGE, not the status
//      (kernel/queue.js), and this runner deliberately never retracts an edge.
//      That is the right shape — a refused item must not be re-dispatched
//      behind a person's back; the escalation is what carries the work now.
//      Fail-closed here means the refusal outlives the process that made it.
//      The two parts are ONE act, in that order: the rollback happens only
//      once the escalation exists, because rolling back alone leaves the item
//      open, agent-ready and unblocked with a stale resolver — fresh-looking
//      work no reader can tell was refused.
//
// Every side effect enters through `deps`, so the whole pipeline — including
// the fix-cycle loop and its escalation — is drivable with a fake git, a fake
// dispatcher, a fake graph and a fake clock.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const gates = require("../kernel/gates.js");
const candidate = require("../kernel/candidate.js");
const { gitSpawn } = require("./git-exec.js");
const { capBytes } = require("./dispatch-terminal.js");

// The same env-scrubbed git the rest of the shell uses: `cwd` names the repo,
// never an ambient GIT_DIR (issue-spor-dispatch-worktree-wrong-repo-location)
// — and, because these are the JUDGE's git calls over a tree the judged
// change controls, run with `judgeGitEnv()`: the judge's secrets scrubbed and
// every git hook disabled (see judgeGitEnv).
const git = (cwd, args, opts = {}) => gitSpawn(cwd, args, { ...opts, env: judgeGitEnv(opts.env) });

// Node's spawnSync default is 1MB, and these reads are whole-tree listings on a
// real repo. An overflow surfaces as `status: null` — a shape every caller here
// treats as a refusal, but one worth not provoking in the first place.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const SUMMARY_CAP = 460;
// The server caps a node BODY at 8192 bytes and rejects the whole write past
// it, so the fact is built to fit under that with room for its own prose —
// evidence is what gets trimmed, never the verdict.
const NODE_BODY_CAP_BYTES = 8192;
const EVIDENCE_CAP_BYTES = 2500;
const STEM_CAP = 30;
// How finely the infrastructure backoff is sliced, so a worker asked to stop
// answers inside the wait rather than at the end of it.
const OUTAGE_BACKOFF_SLICE_MS = 30000;
// A reviewer outage whose stated reset is further out than this PARKS the
// pipeline — it returns `interrupted` with `paused_until` and the work loop
// frees the slot until then — instead of holding a worker slot for the wait
// (task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-
// reviewer). A shorter one is simply waited out in-process, like a backoff.
const REVIEWER_PAUSE_PARK_MS = 300000;
// The `noRescueWhy` of an empty-diff refusal, and the fallback for any refusal
// that carries `noRescue` without saying why (see `emptyDiffRefusal`).
const EMPTY_DIFF_NO_RESCUE_WHY = "on an empty diff — a rescue has no change to work on";

function oneLine(text, cap) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

function stemOf(nodeId) {
  return String(nodeId || "item")
    .replace(/^[a-z]+-/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, STEM_CAP)
    .replace(/-+$/, "") || "item";
}

function shortRun(runId) {
  return String(runId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "unknown";
}

// A RE-GATE (`spor work --regate <run>`) judges the same run a second time,
// after whatever refused it the first time was fixed outside the item — a red
// trusted ref, a flaky suite. Every id a pipeline mints is keyed on the run so
// a retried write is idempotent; a second VERDICT for the same run must not
// collide with (and be refused by) the first, so the attempt joins the key:
// the readable short gains `-r<n>`, the hash input gains `#r<n>`. Attempt 1
// (or none) is byte-identical to before this existed.
// A RESCUE pass (task-spor-factory-rescue-lane) re-runs every gate on the
// tree the rescue agent left, for the same run and attempt, so its facts,
// escalations, approval items and progress keys take a third segment the
// same way: the readable short gains `-x<n>`, the hash input `#x<n>`. Pass 0
// (the original judgement) is byte-identical to before the lane existed.
function gateRunKey(runId, attempt = 0, rescue = 0) {
  const n = Number(attempt) || 0;
  const x = Number(rescue) || 0;
  return `${n > 1 ? `${runId}#r${n}` : String(runId || "")}${x > 0 ? `#x${x}` : ""}`;
}

function shortRunAttempt(runId, attempt = 0, rescue = 0) {
  const n = Number(attempt) || 0;
  const x = Number(rescue) || 0;
  return `${shortRun(runId)}${n > 1 ? `-r${n}` : ""}${x > 0 ? `-x${x}` : ""}`;
}

// A readable prefix is not an identity: the gate id is cut at 24 chars and the
// node stem at 30, so two gates (or two items) sharing a prefix would land on
// ONE id — and an id already written is skipped, which for a gate FACT means
// the second gate's outcome silently adopting the first's (possibly opposite)
// record. So every gate-minted id ends in a hash of the whole tuple: the
// readable part stays readable, the identity is all of it.
function gateIdSuffix(kind, gateId, nodeId, runId) {
  return crypto.createHash("sha256").update(`${kind}\n${gateId}\n${nodeId}\n${runId}`, "utf8").digest("hex").slice(0, 8);
}

// Deterministic and idempotent, exactly like the dispatch report artifact
// (WORKERS.md §7): the same gate recorded twice for the same run is ONE node,
// so a retried write after a transient failure never doubles the record.
function gateFactId(gateId, nodeId, runId, attempt = 0, rescue = 0, head = null) {
  const g = String(gateId || "gate").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24).replace(/^-+|-+$/g, "");
  return `art-gate-${g || "gate"}-${stemOf(nodeId)}-${shortRunAttempt(runId, attempt, rescue)}-${gateIdSuffix("fact", gateId, nodeId, (head ? `${gateRunKey(runId, attempt, rescue)}@${head}` : gateRunKey(runId, attempt, rescue)))}`;
}

// The rescue lane's own fact (task-spor-factory-rescue-lane): one per rescue
// attempt, keyed like a gate fact so a retried write is the same node.
function rescueFactId(nodeId, runId, attempt = 0, n = 1) {
  return `art-rescue-${stemOf(nodeId)}-${shortRunAttempt(runId, attempt, n)}-${gateIdSuffix("rescue", `x${n}`, nodeId, gateRunKey(runId, attempt, n))}`;
}

// The flake filings on a gate outcome: one issue per failing FILE. `issues` is
// the list; `issue` is the single-filing spelling a caller that files one
// carries, kept readable so an older saved outcome still renders its edge.
function flakeIssues(flake) {
  if (!flake) return [];
  const list = Array.isArray(flake.issues) ? flake.issues : flake.issue ? [flake.issue] : [];
  return list.filter(Boolean).map(String);
}

// The issues whose occurrence edge is DURABLY on the graph already, and the
// fact that carries them. `linked`/`linkedBy` are only ever set from an
// OBSERVED landing (F10/F11): a write that CREATED the fact, or — when the
// write door reported the id already occupied, which is not this markdown
// landing — a read of that occupant that saw the edge. A write door's bare
// `ok` never sets them, and neither does the mere presence of a fact id on a
// durable rescue entry.
function flakeLinked(flake) {
  if (!flake) return [];
  return [...new Set((Array.isArray(flake.linked) ? flake.linked : []).filter(Boolean).map(String))];
}

// The EDGES a fact still owes those filings — the debt the whole flake payload
// exists to pay (F7/F9): an issue's occurrence count is its inbound
// `relates-to` from gate facts, so a filing no fact names is an occurrence
// that never happened, and one TWO facts name is an occurrence that happened
// twice. The payload therefore carries its own discharge state PER ISSUE, and
// a fact writes only what is still owed: the prose still names them all, the
// edge is written once. Nothing here is inferred — an unknown answer leaves
// the debt owed, which the next fact pays, because a duplicate edge overcounts
// one occurrence while a missing one leaves an issue no fact names at all.
function flakeEdges(flake) {
  if (!flake) return [];
  const paid = new Set(flakeLinked(flake));
  return flakeIssues(flake).filter((i) => !paid.has(i));
}

// The occurrence edge's TYPE, and the only type that discharges the debt
// (F14). A flake issue's occurrence count is its inbound `relates-to` from
// gate facts — that is what buildGateFact writes and what the telemetry
// counts — so a `mentions` or a `derived-from` pointing at the same issue
// from the same fact is a different statement, not this occurrence. Reading
// a read-back edge without its type let any edge at all pay the debt.
const FLAKE_EDGE = "relates-to";

// The payload after a fact recorded it: the debt it observably discharged,
// folded in. Called at the ONE place a fact is written for a refusal the
// rescue lane may hand on (F12) — the in-memory refusal and the durable rescue
// entry are stamped from the same value, so a second fact for that refusal
// (its rescue could not be dispatched, so the escalation follows immediately)
// sees the occurrence as already paid, and so does a worker that resumes it.
function flakePaidBy(flake, rec) {
  if (!flake) return null;
  const fresh = ((rec && rec.linked) || []).filter(Boolean).map(String);
  const linked = [...new Set([...flakeLinked(flake), ...fresh])];
  const by = (fresh.length && rec && rec.id) || flake.linkedBy || null;
  return { ...flake, linked, ...(by ? { linkedBy: by } : {}) };
}

// The prose half of the occurrence debt: the issues this fact names but does
// NOT link, because an earlier fact of this same refusal already carries their
// edge. Kept in the body so a person reading either fact can still see every
// issue the pass filed — only the edge, which is the occurrence count, is
// written once.
function flakeAlreadyRecorded(flake) {
  const issues = flakeIssues(flake);
  const paid = new Set(flakeLinked(flake));
  const already = issues.filter((i) => paid.has(i));
  if (!already.length || !flake.linkedBy) return "";
  return already.length === issues.length
    ? ` That occurrence is already recorded on ${flake.linkedBy}, so this fact names the issue(s) without linking them a second time.`
    : ` The occurrence of ${already.join(", ")} is already recorded on ${flake.linkedBy}, so this fact links only the rest.`;
}

// The graph fact for one gate outcome. `relates-to`, never `resolves` — a gate
// outcome records what happened, it does not retire the item (a PASSING gate
// records that the implementer's own resolver stands; a FAILING one records
// why the work is not done, and the escalation node is what carries it).
function buildGateFact({ gate, nodeId, runId, project, verdict, detail, evidence, attempts, escalatedTo, demotion, date, factory, attempt = 0, ledger = null, rescue = 0, rescueNext = null, outage = null, flake = null, change = null, definition = null, reviewer = null }) {
  const head = change && change.head ? String(change.head) : null;
  const id = gateFactId(gate.id, nodeId, runId, attempt, rescue, head);
  const passed = verdict === "passed" || verdict === "skipped";
  const base = change && change.base ? String(change.base) : null;
  const defGate = definition && Array.isArray(definition.gates) ? definition.gates.find((g) => g.id === gate.id) : null;
  const defFactory = definition && definition.factory ? definition.factory : null;
  const provenance = [
    head ? `Judged commit: \`${head}\`${base ? ` (base \`${base}\`` : ""}${change.trustedRef ? `${base ? ", " : " ("}trusted ref \`${change.trustedRef}\`${change.trustedSha ? ` at \`${change.trustedSha}\`` : ""}` : ""}${base || change.trustedRef ? ")" : ""}${change.branch ? ` on branch \`${change.branch}\`` : ""}.` : "Judged commit: unknown — the change under judgement could not be read.",
    defFactory || defGate
      ? `Definition: factory \`${(defFactory && defFactory.id) || factory || "?"}\`${defFactory && defFactory.revision ? ` rev \`${defFactory.revision}\`` : ""}${defFactory && defFactory.digest ? ` digest \`${defFactory.digest}\`` : ""}` +
        `${defGate ? `; gate \`${gate.id}\`${defGate.revision ? ` rev \`${defGate.revision}\`` : ""}${defGate.digest ? ` digest \`${defGate.digest}\`` : ""}` : ""}.`
      : "",
  ].filter(Boolean);
  const summary = oneLine(
    `Gate '${gate.id}' (${gate.kind}) ${verdict} on ${nodeId} for dispatched run ${shortRunAttempt(runId, attempt, rescue)}${detail ? `: ${detail}` : "."}`,
    SUMMARY_CAP
  );
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Gate ${gate.id} — ${verdict} on ${oneLine(nodeId, 60)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    ...(head ? [`gate_head: ${head}`] : []),
    ...(base ? [`gate_base: ${base}`] : []),
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(escalatedTo ? [`  - {type: relates-to, to: ${escalatedTo}}`] : []),
    // The flake issues an off-diff pass filed — one per failing FILE. The
    // edges are what make the telemetry aggregatable BY FILE: each issue node
    // is keyed on its own file, so every gate fact that ever tripped over the
    // same flaky file points at the one node whatever else failed beside it,
    // and that node's inbound edges are its occurrence count.
    ...flakeEdges(flake).map((issue) => `  - {type: relates-to, to: ${issue}}`),
    "---",
    "",
    `The \`${gate.kind}\` gate \`${gate.id}\`${gate.source && gate.source !== "inline" ? ` (from the shared gate node \`${gate.source}\`)` : ""}`,
    `${passed ? "passed" : verdict === "blocked" ? "is blocking" : verdict === "scoped" ? "recorded a verified no-code outcome" : verdict === "infrastructure" ? "could not judge the change — its dispatch never answered (an outage, §10.4)" : verdict === "unroutable" ? "could not judge the change — this box refused the dispatch before it started" : "failed"} for dispatched run \`${runId}\` on ${nodeId}${factory ? `, under factory \`${factory}\`` : ""}${Number(attempt) > 1 ? ` (re-gate, attempt ${Number(attempt)})` : ""}${Number(rescue) > 0 ? ` (rescue pass ${Number(rescue)} — the gates re-run on the tree the rescue lane left)` : ""}.`,
    "",
    ...provenance,
    "",
    detail ? `Outcome: ${detail}` : "",
    // An OUTAGE refusal (§10.4): the fact is the gate telemetry surface, so it
    // carries the same two facts the escalation does — that the dispatch never
    // answered, and WHY the gate stopped instead of asking again.
    outage ? `Outage: the dispatch never answered (${outage.reason || "no reason recorded"}); it stopped rather than asking again because ${outage.notRetried || "the runner recorded no reason"}.` : "",
    // WHICH review lane judged (dec-spor-reviewer-reset-pause-budget-and-
    // provenance): present only when the runner routed away from the declared
    // profile, so every primary-reviewed fact is byte-identical.
    // Spread, not a "" placeholder: an empty element would still add a blank
    // line to every fact, and a fact is compared byte-for-byte on read-back.
    ...(reviewer && reviewer.profile
      ? [`Reviewer: \`${reviewer.profile}\` — the declared fallback for \`${reviewer.fallback_for || gate.profile}\`, selected after ${reviewer.after || 1} no-verdict reading(s) under it${reviewer.family ? ` (model family \`${reviewer.family}\`)` : ""}.`]
      : []),
    escalatedTo ? `Escalated to ${escalatedTo}.` : "",
    demotion ? `Demotion: ${oneLine(demotion, 300)}` : "",
    flake && (flake.files || []).length
      ? `Off-diff flake: ${flake.files.join(", ")} failed the whole-suite run and passed alone on the same tree${flakeIssues(flake).length ? `, filed as ${flakeIssues(flake).join(", ")}` : ""}${
          flake.unfiled
            ? `${flakeIssues(flake).length ? ";" : ","} but ${oneLine(flake.unfiled, 300)} could not be filed as its own issue, so the failure was charged rather than passed on a record nothing keeps`
            : flakeIssues(flake).length
              ? ""
              : " (the flake could not be filed as its own issue)"
        }.${flakeAlreadyRecorded(flake)}`
      : "",
    // A refusal the rescue lane takes next is not yet an escalation: the
    // person's item is filed only if the rescue also fails (§10.10).
    rescueNext ? `Rescue: attempt ${rescueNext.n} of ${rescueNext.attempts} under \`${rescueNext.profile}\` follows this refusal before any human escalation.` : "",
    "",
    // One entry per REVIEW: attempt 1 is the initial review, attempt N+1 the
    // review after fix cycle N — so the header counts fix cycles, not
    // attempts (the off-by-one a person reads "4 attempts, cap 3" as).
    ...(attempts && attempts.length > 1
      ? [`Cycles (${gates.describeCycles(gate, attempts).text}):`, ...attempts.map((a, i) => `${i + 1}. ${i === 0 ? "initial review" : `after fix cycle ${i}`}: ${a.verdict} — ${oneLine(a.detail || "", 200)}`), ""]
      : []),
    // The finding ledger (task-spor-review-gate-stateful-bounded): every
    // finding the gate's cycles raised, what cleared it, what still stands —
    // the per-gate convergence record the rescue lane and factory telemetry
    // read, so a memoryless "N findings" summary never hides a moving target.
    ...(ledger && ledger.length ? ["Finding ledger:", "", gates.renderLedger(ledger), ""] : []),
    ...(evidence ? ["Evidence:", "", "```", fenceSafe(capBytes(String(evidence).trim(), EVIDENCE_CAP_BYTES)), "```", ""] : []),
    "This is a gate outcome, not a resolution: it records what the runner",
    "enforced between the claim and the resolve.",
    "",
  ];
  return { id, markdown: capBytes(lines.filter((l) => l !== undefined).join("\n"), NODE_BODY_CAP_BYTES - 512) };
}

// The fields ONE gate fact is built from: everything the gate's OUTCOME
// carries, plus only the additions the recording CALL SITE owns (the attempts
// shown, the ledger, the escalation it filed, the demotion it wrote, which
// pass it belongs to). Hand-picking the outcome half at each site is what let
// `flake` be forwarded at the pass path and silently dropped at the two
// failure paths (F7 on task-spor-factory-flake-rescue-should-not-burn-when-
// failure-is-off-diff): the fact recorded for a CHARGED off-diff pass linked
// none of the issue-flake-* nodes the same run had just created. Spreading
// the whole outcome means a field added to it reaches every fact by
// construction, and the only thing that can ever differ between two sites is
// a name one of them deliberately overrides.
function gateFactFields(outcome, extras) {
  const fields = { ...(outcome || {}), ...(extras || {}) };
  // The two defaults `record` used to apply while destructuring — written as
  // an explicit undefined check so a key present-but-undefined still lands on
  // the default, exactly as the destructuring did.
  if (fields.rescue === undefined) fields.rescue = 0;
  if (fields.rescueNext === undefined) fields.rescueNext = null;
  return fields;
}

// Evidence is a suite tail or a review report — either can contain a line that
// is itself a ``` fence, which would close ours early and spill the rest into
// the body as prose. Neutralize the fence without losing the character.
function fenceSafe(text) {
  return String(text || "").replace(/^\s*```/gm, (m) => m.replace("```", "'''"));
}

// The rescue lane's graph fact (task-spor-factory-rescue-lane): what the
// rescue diagnosed, whether it committed a fix, and what it filed — linked to
// the gate fact it rescued so /spor:factory's maintenance mode can read "why
// did the last three fail review" from the graph. `relates-to`, never
// `resolves`: the rescue's fix is judged by the gates re-running, not by this
// record. `filed` ids come from the rescue agent's own report, so only
// well-formed ids are linked.
function buildRescueFact({ nodeId, runId, project, attempt = 0, entry, factory, date }) {
  const n = Number(entry.n) || 1;
  const id = rescueFactId(nodeId, runId, attempt, n);
  const filed = (entry.filed || []).filter((f) => /^[a-z0-9][a-z0-9-]*$/.test(String(f)));
  // "Ran" is the absence of a dispatch error, not the presence of a run id:
  // a rescue whose launch was recorded and whose wait then failed has both.
  const ran = !entry.error;
  const diagnosis = entry.diagnosis ? oneLine(entry.diagnosis, 2000) : "";
  const summary = oneLine(
    ran
      ? `Rescue attempt ${n} on ${nodeId} (run ${shortRunAttempt(runId, attempt, n)}) after gate '${entry.gate}' refused it: ${entry.category || "unknown"} — ${diagnosis || "no diagnosis read"}${entry.fixed ? "; a fix was committed for the gates to re-judge" : ""}.`
      : `Rescue attempt ${n} on ${nodeId} (run ${shortRunAttempt(runId, attempt, n)}) after gate '${entry.gate}' refused it could not run: ${entry.error || "no response"}.`,
    SUMMARY_CAP
  );
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Rescue ${n} — ${entry.category || "unknown"} on ${oneLine(nodeId, 60)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(entry.fact ? [`  - {type: relates-to, to: ${entry.fact}}`] : []),
    ...filed.map((f) => `  - {type: relates-to, to: ${f}}`),
    "---",
    "",
    `The rescue lane${factory ? ` of factory \`${factory}\`` : ""} ran on ${nodeId} for dispatched run \`${runId}\` (attempt ${n}${entry.runId ? `, as run \`${entry.runId}\`` : ""}),`,
    `after the \`${entry.gate}\` gate refused it${entry.detail ? `: ${oneLine(entry.detail, 300)}` : "."}`,
    "",
    ran ? `Diagnosis (${entry.category || "unknown"}${entry.unread ? ", no structured block — prose tail" : ""}): ${diagnosis || "(none)"}` : `The rescue could not run: ${entry.error || "no response"}.`,
    "",
    ran ? (entry.fixed ? "The rescue committed a fix; the gates re-ran on that tree (see the rescue-pass gate facts)." : "The rescue committed no fix it claims resolves the refusal; the gates re-ran on the tree it left regardless.") : "",
    filed.length ? `Filed: ${filed.join(", ")} — proposals for factory/gate/prompt changes that would have prevented this pattern.` : "The rescue filed no factory-improvement task.",
    "",
    "This is a rescue record, not a resolution: whether the item stands is decided",
    "by the gates that re-ran after it, never by the rescue's own account.",
    "",
  ];
  return { id, markdown: capBytes(lines.filter((l) => l !== undefined).join("\n"), NODE_BODY_CAP_BYTES - 512) };
}

// The last N bytes of a command's output — a failing suite's tail is where the
// failure is, and the head is usually a thousand passing assertions.
function tailBytes(text, bytes = EVIDENCE_CAP_BYTES) {
  const buf = Buffer.from(String(text || ""), "utf8");
  if (buf.length <= bytes) return String(text || "");
  let cut = buf.subarray(buf.length - bytes).toString("utf8");
  if (cut.startsWith("�")) cut = cut.slice(1);
  return `[…earlier output trimmed]\n${cut}`;
}

// Evidence for a FAILED suite: the lines that say what failed, then the tail.
// The tail alone is not enough — a monorepo runner (nx, turbo, a `&&` chain)
// prints its own summary after the failing package's output, and a long suite
// streams hundreds of passing lines after the one that failed, so a 2.5KB tail
// routinely shows nothing but green checks and a footer saying "server:test
// failed" (the first spor-server factory run's escalation read exactly that).
// So: pull the lines matching the common failure signatures — node:test's
// `✖`/`not ok`, jest's `●`/FAIL, a thrown Error/AssertionError, the runner's
// own "failed" footer — bounded, in order, then the tail for context.
// Anchored at the line start for the runner markers (a PASSING test whose
// title says "running -> failed" must not read as a failure line), and only
// the unambiguous mid-line signatures (an assertion, a TS diagnostic).
const FAILURE_LINE_RE = /^(not ok\b|✖|●|FAIL\b|Failed tasks|NX\b.*\bfailed\b|- [\w-]+:test\s*$)|AssertionError|\bError: |error TS\d+/;
const FAILURE_LINES_CAP_BYTES = 1500;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function failureEvidence(text, bytes = EVIDENCE_CAP_BYTES) {
  const raw = String(text || "");
  const hits = [];
  let size = 0;
  for (const line of raw.split("\n")) {
    const t = line.replace(ANSI_RE, "").trim();
    if (!t || !FAILURE_LINE_RE.test(t)) continue;
    const n = Buffer.byteLength(t, "utf8") + 1;
    if (size + n > FAILURE_LINES_CAP_BYTES) {
      hits.push("[…more failure lines trimmed]");
      break;
    }
    hits.push(t);
    size += n;
  }
  if (!hits.length) return tailBytes(raw, bytes);
  const head = `${hits.join("\n")}\n`;
  const rest = Math.max(400, bytes - Buffer.byteLength(head, "utf8"));
  return `${head}---\n${tailBytes(raw, rest)}`;
}

// TRACKED modifications only, in a given working tree. Untracked residue — a
// coverage dir, a log, an un-ignored build artifact, all of which a suite
// routinely leaves behind — has no bearing on what is judged, so it is
// exempt here the same way it is exempt from `gateChangeSet`'s own dirty
// check below. Exposed standalone so a caller that must judge cleanliness
// on its own — `implementation.candidate.require_clean`
// (issue-spor-candidate-require-clean-parsed-never-read), asking the
// question at candidate submission rather than only inheriting
// `gateChangeSet`'s verdict — asks it in the identical dialect instead of
// re-implementing the probe.
function trackedTreeDirty(cwd) {
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"], { maxBuffer: GIT_MAX_BUFFER });
  if (dirty.status !== 0) {
    // A status call that could not run is not evidence of a clean tree, and
    // reading it as one is the fail-OPEN direction — refuse rather than guess.
    return { ok: false, reason: `could not read the working-tree state of ${cwd} (${(dirty.stderr || "").trim().split("\n")[0] || (dirty.error && dirty.error.message) || "git status failed"})` };
  }
  return { ok: true, dirty: !!(dirty.stdout || "").trim() };
}

// --- the reference half of "off-diff" ----------------------------------------
//
// A failure whose files are not IN the diff is not thereby a failure the change
// had nothing to do with: a test that never appears in a diff can still import,
// spawn or read a file that does. The refusal that prompted this whole feature
// is that exact shape — test/codex-dispatch.test.js spawns `bin/spor.js`, which
// the queue-paging change edited — so path-set difference alone would have
// called it off-diff on the strength of a coincidence.
//
// So an isolation pass runs only when the failing files, and everything they
// reach through the local files they name (a helper holding the CLI path, a
// fixture, and whatever THOSE name in turn), reference nothing the change
// edited. The claim is transitive, so the walk is too: it follows the frontier
// until it is exhausted rather than stopping at a fixed depth, because a walk
// that stopped early would report "no reference" for a test that reaches the
// change two helpers out. Reading is bounded and fails CLOSED in every
// direction that leaves the question open: a seed that is not there, a file
// that exists and could not be read, or a walk that would exceed the read
// budget all read as "not demonstrably off-diff" and the failure is charged
// exactly as it was before this existed.
//
// WHAT counts as a reference is asked two ways, because one spelling alone
// misses the other's shape:
//   - TEXTUALLY (gates.mentionsChanged): any spelling of a changed path in the
//     source — the repo-relative path, the basename as a token (what
//     `path.join(ROOT, "bin", "spor.js")` and a spawn argv leave behind), an
//     extensionless quoted specifier.
//   - by RESOLVED EDGE: every local file the source names is resolved against
//     its own directory (gates.referencedCandidates) and compared to the change
//     set exactly. This is what catches a segmented relative spelling whose
//     text does NOT contain the repo-relative path at all — `lib/index.js`
//     requiring `./kernel/gates.js` references `lib/kernel/gates.js` while
//     containing neither that string nor `gates.js` as an unprefixed token.
//     It is asked at EVERY hop, the last one included: the final hop's
//     candidates were previously computed only to be discarded, so an import
//     edge from a hop-1 helper straight into the diff went unseen.
//
// WHICH files are seeds is likewise two sets. The isolation set (the test files
// the pass would re-RUN) is HARD: a seed that is not there at all stops the
// pass, since we would otherwise re-run a file we could not judge. The other
// files the failure NAMED are soft seeds — the failure went through them, so
// what they import is as much part of the question, but a path scraped out of a
// stack frame need not exist in this tree and one that does not cannot be
// importing anything. That softness is about ABSENCE only: once a file exists,
// not reading it leaves the question open exactly as much as for a hard seed,
// so an existing file this cannot read (too large, a permission error, an I/O
// fault) is unknown for both — a read that did not happen settles nothing.
//
// HOW FAR it walks is the whole transitive closure, not a fixed number of hops.
// "Imported or executed by the failing test" is a transitive claim: a test that
// reaches the change through two helpers references it exactly as much as one
// that requires it directly, and a walk that simply STOPPED at a hop limit
// returned an answer — "no reference" — indistinguishable from having looked
// everywhere. That was the one budget in here that failed OPEN. So the frontier
// is walked to exhaustion and the only bounds left are the read budgets below,
// which fail CLOSED: hitting one with a file still unread is `unknown`, and the
// failure is charged. The budgets are sized so that in a repo of ordinary size
// the closure completes and the bound never binds (this one has ~200 first-party
// source files in total, and node_modules is never entered).
const REF_SCAN_MAX_READS = 512;
const REF_SCAN_MAX_BYTES = 1024 * 1024;
const REF_SCAN_TOTAL_BYTES = 16 * 1024 * 1024;
function changeReferencedBy(dir, seeds, changed, { also = [] } = {}) {
  const root = String(dir || "");
  if (!root) return { reached: [], unknown: "the judged tree's path is unknown" };
  const base = path.resolve(root);
  const touched = new Set((Array.isArray(changed) ? changed : []).map((p) => String(p).replace(/\\/g, "/")));
  const reached = [];
  const seen = new Set();
  let reads = 0;
  let bytes = 0;
  // One frontier, walked to exhaustion: a candidate found at any depth is
  // queued behind the ones already there, so the walk is breadth-first and
  // every file in the closure is read at most once (`seen`).
  const queue = [
    ...(Array.isArray(seeds) ? seeds : []).map((f) => ({ rel: String(f), hard: true })),
    ...(Array.isArray(also) ? also : []).map((f) => ({ rel: String(f), hard: false })),
  ];
  for (let i = 0; i < queue.length; i += 1) {
    const { rel, hard } = queue[i];
    if (seen.has(rel)) continue;
    seen.add(rel);
    // ABSENCE is the only thing a soft seed shrugs off. A hard seed is a file
    // the isolation would RUN, so one that is not there stops the pass; a soft
    // seed (another file the failure named) and a candidate are guesses at a
    // local file, and one that is not in this tree is importing nothing.
    const absent = (why) => (hard ? { reached, unknown: why } : null);
    const p = path.resolve(base, rel);
    if (p !== base && !p.startsWith(base + path.sep)) {
      const f = absent(`${rel} is outside the judged tree`);
      if (f) return f;
      continue;
    }
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      // ENOENT/ENOTDIR is the graph of this tree saying the path is not here.
      // Anything else (a permission error, an I/O fault) is a file we could
      // not look in, and that closes the walk whatever kind of seed it is.
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        const f = absent(`${rel} is not in the judged tree`);
        if (f) return f;
        continue;
      }
      return { reached, unknown: `${rel} could not be read (${(e && e.message) || e})` };
    }
    if (!st.isFile()) {
      const f = absent(`${rel} is not a file in the judged tree`);
      if (f) return f;
      continue;
    }
    // From here the file EXISTS and the failure reached it, so every remaining
    // way of not reading it leaves the question open — for a soft seed exactly
    // as much as for a hard one.
    if (st.size > REF_SCAN_MAX_BYTES) return { reached, unknown: `${rel} is too large to read` };
    if (reads >= REF_SCAN_MAX_READS) return { reached, unknown: `more than ${REF_SCAN_MAX_READS} files would have to be read to answer it` };
    if (bytes + st.size > REF_SCAN_TOTAL_BYTES) return { reached, unknown: `more than ${REF_SCAN_TOTAL_BYTES} bytes would have to be read to answer it` };
    let src = "";
    try {
      reads += 1;
      bytes += st.size;
      src = fs.readFileSync(p, "utf8");
    } catch (e) {
      return { reached, unknown: `${rel} could not be read (${(e && e.message) || e})` };
    }
    for (const hit of gates.mentionsChanged(src, changed)) if (!reached.includes(hit)) reached.push(hit);
    // The same question asked of this file's RESOLVED local specifiers, so a
    // spelling whose text carries no repo-relative path still names what it
    // imports. Asked of every file the walk reads, the last one included.
    // Package entry resolution can redirect to arbitrary source through main /
    // exports. Without resolving that contract, isolation cannot prove absence.
    const packageImport = /(?:\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?|\bfrom\s*)(["'`])([^"'`\n]+)\1/g;
    let spec;
    while ((spec = packageImport.exec(src)) !== null) {
      if (require("module").isBuiltin(spec[2])) continue;
      if (!spec[2].startsWith(".")) return { reached, unknown: `${rel} uses package entry ${spec[2]}, whose references were not resolved` };
      // Inspect the unnormalized specifier too: referencedCandidates excludes
      // the empty repo-relative path, but ../.. can name package.json's main.
      const imported = path.resolve(path.dirname(p), spec[2]);
      if (imported !== base && !imported.startsWith(base + path.sep)) return { reached, unknown: `${rel} imports outside the judged tree` };
      try {
        if (fs.statSync(imported).isDirectory()) return { reached, unknown: `${rel} imports directory ${spec[2]}, whose package entry was not resolved` };
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return { reached, unknown: `${spec[2]} could not be inspected` };
      }
    }
    const cands = gates.referencedCandidates(src, rel);
    for (const c of cands) if (touched.has(c) && !reached.includes(c)) reached.push(c);
    // One reference is the whole answer; there is nothing to refine.
    if (reached.length) return { reached, unknown: "" };
    for (const c of cands) {
      try { if (fs.statSync(path.resolve(base, c)).isDirectory()) return { reached, unknown: `${rel} imports directory ${c}, whose package entry was not resolved` }; } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return { reached, unknown: `${c} could not be inspected` };
      }
      if (!seen.has(c)) queue.push({ rel: c, hard: false });
    }
  }
  return { reached, unknown: "" };
}

// What a run actually changed, read from the run's own working tree. Committed
// work only: a dirty tree is refused rather than judged, because the tree a
// gate would take is then not the tree the agent produced, and "close enough"
// is exactly the reading a gate exists to refuse.
function gateChangeSet(record, trustedRef) {
  const cwd = record && record.cwd;
  // `gone: true` marks the ONE refusal no dispatch can repair (runGatePipeline):
  // a rescue is told to work in the run's own checkout, and there is none.
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, gone: true, cwd: cwd || null, reason: `the run's working directory (${cwd || "unset"}) is gone, so its change cannot be read` };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { ok: false, reason: `${cwd} is not a git checkout, so the change under judgement cannot be read` };
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) return { ok: false, reason: `${cwd} has no HEAD commit to gate` };
  const dirty = trackedTreeDirty(cwd);
  if (!dirty.ok) {
    // Every other probe here refuses on a failed probe; this one must too —
    // see trackedTreeDirty's own comment.
    return { ok: false, reason: `${dirty.reason}, so the gate cannot confirm it is judging committed work` };
  }
  if (dirty.dirty) {
    // `dirty: true` marks the ONE refusal a round-trip can legitimately fix
    // (runGatePipeline): every other reason here is about the checkout itself.
    return { ok: false, dirty: true, cwd, reason: `the run left uncommitted changes to tracked files in ${cwd} — a gate judges committed work, so this one cannot judge it at all` };
  }
  const base = git(cwd, ["merge-base", trustedRef, "HEAD"]);
  if (base.status !== 0) {
    return { ok: false, reason: `the trusted ref '${trustedRef}' does not resolve in ${cwd} — the gate has nothing trustworthy to compare against` };
  }
  const baseSha = (base.stdout || "").trim();
  const headSha = (head.stdout || "").trim();
  const diff = git(cwd, ["diff", "--name-only", `${baseSha}..${headSha}`], { maxBuffer: GIT_MAX_BUFFER });
  if (diff.status !== 0) return { ok: false, reason: `could not diff ${trustedRef}..HEAD in ${cwd}` };
  const paths = (diff.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  // The trusted ref's OWN tip and the branch name ride along for the evidence
  // chain (task-spor-factory-gate-attestation): `base` is the merge-base, which
  // can trail the ref; `trustedSha` pins the exact tree the protected paths
  // were forced back to. A detached HEAD has no branch (null, not "HEAD").
  //
  // The sha is REQUIRED, not best-effort (cross-model review, major finding
  // 5): it is the tree every later step pins to — prepareGateTree forces the
  // protected paths from THIS sha, never from the symbolic ref, so the tree
  // the suite ran and the tree the fact attests are one commit by
  // construction even if the ref moves between the two reads.
  const trusted = git(cwd, ["rev-parse", "--verify", `${trustedRef}^{commit}`]);
  const trustedSha = trusted.status === 0 ? (trusted.stdout || "").trim() : null;
  if (!trustedSha) return { ok: false, reason: `the trusted ref '${trustedRef}' does not resolve to a commit in ${cwd}, so the tree the gate must judge against cannot be pinned` };
  const branchOut = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = branchOut.status === 0 ? (branchOut.stdout || "").trim() : "";
  const branch = branchName && branchName !== "HEAD" ? branchName : null;
  return { ok: true, paths, head: headSha, base: baseSha, trustedRef, trustedSha, branch, top: (top.stdout || "").trim(), cwd };
}

// Whether the run's HEAD is already contained in the trusted ref — the git
// half of "this was landed by hand while no worker was watching"
// (issue-spor-work-adopts-orphaned-pipeline-of-hand-landed-run). Read from the
// run's own checkout when it still exists; when it is GONE (an orchestrator
// merged the branch and removed the worktree), from the branch the dispatch
// worktree was cut on: `spor dispatch` puts a worktree at
// `<repo>/.claude/worktrees/<branch>` (dispatchWorktreeDir in bin/spor.js),
// and `git worktree remove` leaves the branch standing, so the path alone
// names both the repo and the ref. A `--no-worktree` run's checkout IS the
// repo, so a missing one names nothing.
//
// Three-valued on purpose, like isLandedLocally in bin/spor.js: `known: false`
// (no checkout, no branch, no trusted ref, git errored) is not evidence of
// anything and must never be read as "unlanded" — only `known: true` carries
// an answer either way.
function gateHeadLanded(record, trustedRef) {
  const cwd = record && record.cwd;
  if (!cwd || !trustedRef) return { known: false, landed: null, head: null };
  let dir = null;
  let ref = "HEAD";
  if (fs.existsSync(cwd)) {
    dir = cwd;
  } else {
    // <repo>/.claude/worktrees/<branch> — anything else names no ref.
    const parent = path.dirname(cwd);
    if (path.basename(parent) !== "worktrees" || path.basename(path.dirname(parent)) !== ".claude") return { known: false, landed: null, head: null };
    dir = path.dirname(path.dirname(parent));
    ref = `refs/heads/${path.basename(cwd)}`;
    if (!fs.existsSync(dir)) return { known: false, landed: null, head: null };
  }
  const head = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (head.status !== 0) return { known: false, landed: null, head: null };
  const headSha = (head.stdout || "").trim();
  if (git(dir, ["rev-parse", "--verify", "--quiet", `${trustedRef}^{commit}`]).status !== 0) return { known: false, landed: null, head: headSha };
  const r = git(dir, ["merge-base", "--is-ancestor", headSha, trustedRef]);
  if (r.status === 0) return { known: true, landed: true, head: headSha };
  if (r.status === 1) return { known: true, landed: false, head: headSha };
  return { known: false, landed: null, head: headSha };
}

// The git half of a STALE PREMISE (task-spor-factory-skip-resolved-items-
// with-empty-diff): whether every commit stamp already recorded on an item —
// before this pipeline touched anything — is an ancestor of the trusted ref.
// An item's `commits:` stamps can be added by a DIFFERENT task's fix that
// happened to land the same change (the first live case, 2026-09-05: issue-
// spor-codex-handshake-stub-reads-job-after-abandon-unlink named spor 0efea66,
// which landed on main as part of task-spor-queue-api-offset-paging's own
// fix), so by the time this item's own run is dispatched there is nothing
// left for its branch to add — an empty diff that is not the run's own doing.
//
// Reads from the same checkout `gateHeadLanded` does, with the same
// worktree-gone fallback (a dispatch worktree removed by an orchestrator
// merge still names its branch by its directory name): a commit stamp names a
// sha, not a ref, so once SOME checkout for the repo is found, the stamps are
// checked against it directly — no branch ref is needed for this half.
//
// `commits` is the raw `commits:` stamp list (`repo@sha`). Only stamps for
// `repoSlug` (the item's own repo) are checked — a stamp for a sibling repo
// names a commit this checkout cannot verify at all, and is silently excluded
// rather than counted either way. `checked` in the return value is exactly
// what was verifiable, so a caller never credits more than was actually
// tested. Three-valued like `gateHeadLanded`: `known: false` (no checkout, no
// trusted ref, a malformed/unresolvable sha, git errored) is not evidence of
// anything and must never be read as "unlanded".
function gateCommitsLanded(record, trustedRef, commits, repoSlug) {
  const stamps = (Array.isArray(commits) ? commits : []).map((c) => String(c || "").trim()).filter(Boolean);
  if (!stamps.length) return { known: true, checked: [], landed: null, unlanded: [] };
  const cwd = record && record.cwd;
  if (!cwd || !trustedRef) return { known: false, checked: [], landed: null, unlanded: [] };
  let dir = null;
  if (fs.existsSync(cwd)) {
    dir = cwd;
  } else {
    const parent = path.dirname(cwd);
    if (path.basename(parent) !== "worktrees" || path.basename(path.dirname(parent)) !== ".claude") return { known: false, checked: [], landed: null, unlanded: [] };
    dir = path.dirname(path.dirname(parent));
    if (!fs.existsSync(dir)) return { known: false, checked: [], landed: null, unlanded: [] };
  }
  if (git(dir, ["rev-parse", "--verify", "--quiet", `${trustedRef}^{commit}`]).status !== 0) return { known: false, checked: [], landed: null, unlanded: [] };
  const checked = [];
  const unlanded = [];
  for (const stamp of stamps) {
    const at = stamp.indexOf("@");
    if (at <= 0 || at === stamp.length - 1) continue; // malformed `repo@sha` — silently excluded
    const stampRepo = stamp.slice(0, at);
    if (repoSlug && stampRepo !== repoSlug) continue; // a sibling repo's commit — unverifiable in this checkout
    const sha = stamp.slice(at + 1);
    if (git(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).status !== 0) return { known: false, checked, landed: null, unlanded };
    const r = git(dir, ["merge-base", "--is-ancestor", sha, trustedRef]);
    if (r.status === 0) { checked.push(stamp); continue; }
    if (r.status === 1) { checked.push(stamp); unlanded.push(stamp); continue; }
    return { known: false, checked, landed: null, unlanded };
  }
  if (!checked.length) return { known: true, checked: [], landed: null, unlanded: [] };
  return { known: true, checked, landed: unlanded.length === 0, unlanded };
}

// --- the factory CANDIDATE (task-spor-factory-candidate-record) --------------
// FACTORY-IMPLEMENTATION-STAGE.md §3: a pinned commit plus the tree it resolves
// to, plus provenance, plus a reference something other than this process can
// follow. The vocabulary and the identity rule are pure (kernel/candidate.js);
// this is the git half — the reads that turn a run's checkout into the pinned
// object.
//
// The `sha256` the candidate id is derived from. Injected into the kernel so
// that module keeps requiring nothing but its siblings.
const candidateSha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// Pin the tree a run's checkout is sitting on.
//
// `change` is the SUCCESSFUL change-set read the pipeline already made
// (`gateChangeSet`), passed in so the common path costs no second `git status`
// and so the candidate's `clean` verdict is literally the command gate's own:
// that read refuses a dirty tree and refuses an UNREADABLE status (never
// reading a failed probe as a clean tree), so a change-set that came back `ok`
// is exactly the `require_clean` verdict at submission (§3.5, §10.3). Without
// one there is nothing committed to pin and this returns a refusal rather than
// guessing — a candidate whose `clean` a probe could not answer is not one.
//
// Two reads the change-set does not carry: the tree the head resolves to (the
// IDENTITY, §3.2 — a rebase or an amend moves the commit while the judged
// content may be identical, and the tree is what "we already judged this"
// means) and the branch the checkout is on, which is what a `branch` reference
// later pushes from. Both are best-effort in the sense that a FAILED tree read
// refuses the pin (there is no identity without it) while a failed branch or
// trusted-ref-tip read only leaves that field null.
function pinCandidate(record, trustedRef, { change = null, repo = null, nodeId = null, submittedBy = null, provenance = null, resolver = null } = {}) {
  if (!change || !change.ok) {
    return { ok: false, reason: "the change under judgement could not be read, so there is no committed tree to pin" };
  }
  const cwd = change.cwd || (record && record.cwd) || null;
  if (!cwd) return { ok: false, reason: "the run has no working directory to pin a candidate from" };
  const tree = git(cwd, ["rev-parse", `${change.head}^{tree}`]);
  if (tree.status !== 0) return { ok: false, reason: `the tree of ${String(change.head).slice(0, 12)} could not be read in ${cwd}, so the candidate has no identity` };
  // A DETACHED HEAD answers the literal word `HEAD` (exit 0), which names no
  // branch — a null field, not a refusal: `branch` is what a `branch`-kind
  // reference would later push from, and a run with none simply publishes the
  // other way.
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD"]);
  const branchName = branch.status === 0 ? (branch.stdout || "").trim() : "";
  // The trusted ref's TIP at pin time, beside the merge base the change-set
  // already read. They differ exactly when the ref moved under the run, which
  // is the thing a reader of an old candidate most wants to know.
  const refTip = trustedRef ? git(cwd, ["rev-parse", `${trustedRef}^{commit}`]) : { status: 1 };
  const minted = candidate.mintCandidate(
    {
      repo,
      node_id: nodeId,
      commit: change.head,
      tree: (tree.stdout || "").trim(),
      base: {
        ref: trustedRef || null,
        commit: refTip.status === 0 ? (refTip.stdout || "").trim() : null,
        merge_base: change.base,
      },
      branch: branchName && branchName !== "HEAD" ? branchName : null,
      clean: true,
      changed_paths: Array.isArray(change.paths) ? change.paths : [],
      submitted_by: submittedBy,
      provenance: { ...(provenance || {}), cwd },
      resolver,
    },
    { sha256: candidateSha256 }
  );
  if (!minted.ok) return { ok: false, reason: minted.errors.join("; ") };
  return { ok: true, candidate: minted.candidate };
}

// Materialize the tree a command gate runs in: the implementer's commit, with
// every declared protected path FORCED back to the trusted ref's copy.
//
// This is the "tests are more accurate than the code under test" rule as a code
// path (dec-spor-software-factory-substrate). The fail-closed check upstream
// already refuses a branch that touched a protected path at all, so in the
// ordinary case this restore is a no-op — that is the point: the guarantee that
// the suite is the TRUSTED ref's copy does not rest on the check having run.
// The protected set is resolved through the SAME glob matcher the check uses
// (kernel/gates.js), never git's pathspec dialect, so the two can't disagree.
//
// `setup(dir)` is optional: the caller's hook for staging whatever the repo's
// suite needs that is not in git (bin/spor.js runs the repo's own
// dispatch.worktreeSetup there). It runs AFTER the protected paths are forced,
// so nothing it stages can be a protected path the restore then misses, and a
// failure refuses the tree — {ok:false, reason} — rather than running the
// suite on a half-staged one.
//
// `teardown(dir)` is the mirror of `setup`: called first thing in `cleanup`,
// before the worktree goes, so whatever the setup hook started for this tree
// (a database stack, a dev server) can be stopped. Best-effort — a throwing
// teardown never blocks the removal.
function prepareGateTree(change, { trustedRef, protectedPaths, setup = null, teardown = null }) {
  let parent = null;
  try {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-"));
  } catch (e) {
    return { ok: false, reason: `could not create a gate worktree: ${e.message}` };
  }
  const dir = path.join(parent, "tree");
  const cleanup = () => {
    if (teardown) {
      try {
        teardown(dir);
      } catch {
        /* the tree still goes; the hook's own failure is its own to report */
      }
    }
    try {
      // TWO forces: a suite routinely leaves untracked output (a build dir,
      // node_modules, a coverage report) behind it, and a single --force
      // refuses a worktree that is dirty in exactly that way.
      git(change.top, ["worktree", "remove", "--force", "--force", dir]);
    } catch {
      /* best effort — the rm + prune below are the backstop */
    }
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      /* a leaked scratch dir is not worth failing a gate over */
    }
    try {
      // If the remove above failed, the directory is gone but its
      // administrative entry under .git/worktrees is not; git only expires
      // those after months. A gate runs on every accepted item, so prune now.
      git(change.top, ["worktree", "prune"]);
    } catch {
      /* nothing left to do about it */
    }
  };
  const add = git(change.top, ["worktree", "add", "--detach", dir, change.head]);
  if (add.status !== 0) {
    cleanup();
    return { ok: false, reason: `could not create a gate worktree from ${change.head.slice(0, 8)}: ${(add.stderr || "").trim().split("\n")[0] || "git worktree add failed"}` };
  }
  // Force from the PINNED sha gateChangeSet resolved, not the symbolic ref: a
  // ref that advanced between the change-set read and this restore would
  // otherwise hand the suite a tree the fact's `trusted_sha` does not name
  // (cross-model review, major finding 5). The ref is only the fallback for a
  // caller that built `change` without a sha.
  const forced = forceProtectedPaths({ top: change.top, dir, trustedRef: change.trustedSha || trustedRef, protectedPaths });
  if (!forced.ok) {
    cleanup();
    return { ok: false, reason: forced.reason };
  }
  if (setup) {
    let staged = null;
    try {
      staged = setup(dir);
    } catch (e) {
      staged = { ok: false, reason: `the gate tree's setup hook threw: ${(e && e.message) || e}` };
    }
    if (!staged || !staged.ok) {
      cleanup();
      return { ok: false, reason: (staged && staged.reason) || "the gate tree's setup hook failed" };
    }
  }
  return { ok: true, dir, restored: forced.restored, cleanup };
}

// Force every declared PROTECTED path in `dir` back to `trustedRef`'s own copy
// — the "tests are more accurate than the code under test" guarantee as code,
// shared by command gates (prepareGateTree above) and the integration stage's
// candidate tree (shell/integration-runner.js, dec-spor-factory-integration-
// step "same guarantee as command gates, WORKERS.md §10.3"). `top` is the repo
// `dir` was built from (a worktree or a plain checkout); `dir` is the tree to
// force paths INTO. {ok, restored} | {ok:false, reason}.
function forceProtectedPaths({ top, dir, trustedRef, protectedPaths }) {
  const restored = [];
  if (!(protectedPaths || []).length) return { ok: true, restored };
  const ls = git(top, ["ls-tree", "-r", "--name-only", trustedRef], { maxBuffer: GIT_MAX_BUFFER });
  if (ls.status !== 0) {
    return { ok: false, reason: `could not list ${trustedRef}'s tree to restore the protected paths — the gate refuses to run the branch's own copy` };
  }
  const trustedFiles = (ls.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const wanted = gates.matchPaths(trustedFiles, protectedPaths);
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    const co = git(dir, ["checkout", trustedRef, "--", ...chunk]);
    if (co.status !== 0) {
      return { ok: false, reason: `could not restore ${trustedRef}'s copy of the protected paths into the gate worktree` };
    }
    restored.push(...chunk);
  }
  // A protected path present on the branch but absent from the trusted ref is
  // a test the implementer ADDED. Nothing to restore it from, so it is
  // removed: the suite that judges the change is the trusted one, entire.
  const here = git(dir, ["ls-files"], { maxBuffer: GIT_MAX_BUFFER });
  if (here.status === 0) {
    const trusted = new Set(wanted);
    const extra = gates
      .matchPaths((here.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean), protectedPaths)
      .filter((f) => !trusted.has(f));
    for (const f of extra) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        /* the fail-closed check upstream means this set is normally empty */
      }
    }
  }
  return { ok: true, restored };
}

// Run one command gate's suite in that tree.
//
// ASYNC, deliberately. `spawnSync` would freeze this whole process for the
// gate's timeout (15 minutes by default), and the worker is not a one-shot
// command: it would stop harvesting runs, stop publishing status, stop polling
// another pipeline's human approval — and, worst, would not run its own
// SIGINT/SIGTERM handler, so a service stop would escalate to SIGKILL and
// abandon every other in-flight run without the bookkeeping the loop promises.
//
// On POSIX the child gets its own process group so the timeout kills the SUITE,
// not just the shell that launched it (a `sh -c "npm test"` killed alone leaves
// the test runner orphaned and still holding the worktree).
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024; // the tail is what the evidence uses; the head is a thousand passing assertions
//
// `env` is extra environment for the suite — what the tree's own setup hook
// declared for the agent that would run there (bin/spor.js worktreeDeclaredEnv),
// so a pinned dependency path reaches the judge as well as the implementer.
// Layered UNDER the two the gate always sets (CI, SPOR_GATE).
//
// The suite is the JUDGED repository's own code running on the judge's box,
// so the judge's credentials must not reach it (cross-model review, blocking
// finding 1): the attestation signing key would let the branch forge the
// signature anchor, and a graph bearer token would let it write the
// `art-attest-*` graph anchor (or any other node) as the runner. Both are
// scrubbed from the inherited environment AND from the caller's extra env —
// the declared setup env is the repo operator's, but the same names must not
// arrive by that door either. `scrubSecretEnv` is the one list; the
// integration stage's candidate suite runs through this same function.
const SECRET_ENV_RE = /^(SPOR|SUBSTRATE)_(.*_)?(TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)$/i;
const SECRET_ENV_NAMES = new Set(["SPOR_ATTESTATION_KEY", "SPOR_TOKEN", "SUBSTRATE_TOKEN", "SPOR_REFRESH_TOKEN", "SPOR_ADMIN_TOKEN"]);
function isSecretEnvName(name) {
  return SECRET_ENV_NAMES.has(name) || SECRET_ENV_RE.test(name);
}
function scrubSecretEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!isSecretEnvName(k)) out[k] = v;
  return out;
}

// The environment for every git call the JUDGE makes over a tree the judged
// change controls — materializing its worktree, checking the trusted ref's
// protected paths over it, merging the candidate (cross-model review, blocking
// finding 1). Two things ride here. The judge's secrets are scrubbed, the
// same list as the suite's. And every git HOOK is disabled: a `core.hooksPath`
// the judged commit can point at a tracked directory (`.githooks/`), so a
// `post-checkout` in the change under judgement would otherwise run as the
// judge, in the judge's environment, on the judge's own `git worktree add`
// — before a single declared gate has looked at it. `core.hooksPath` is
// forced through git's env-config door (GIT_CONFIG_COUNT/KEY/VALUE, which
// beats every config file) at a path no hook can live under: a path INSIDE
// the null device on POSIX (`/dev/null/…` is ENOTDIR for everyone, so nothing
// on the box — the judged agent included — can create a hook there), and a
// fresh private empty directory on Windows, where no such uncreatable path
// exists. An existing GIT_CONFIG_COUNT in the environment is appended to,
// never clobbered.
let noHooksDir = null;
function noHooksPath() {
  if (noHooksDir) return noHooksDir;
  if (process.platform !== "win32") noHooksDir = path.join(os.devNull, "spor-no-hooks");
  else {
    noHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-no-hooks-"));
    process.on("exit", () => { try { fs.rmSync(noHooksDir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  }
  return noHooksDir;
}
function judgeGitEnv(env = process.env) {
  const out = scrubSecretEnv(env);
  const n = Math.max(0, Number.parseInt(out.GIT_CONFIG_COUNT, 10) || 0);
  out.GIT_CONFIG_COUNT = String(n + 1);
  out[`GIT_CONFIG_KEY_${n}`] = "core.hooksPath";
  out[`GIT_CONFIG_VALUE_${n}`] = noHooksPath();
  return out;
}
function runGateCommand(gate, dir, { env: extraEnv = {} } = {}) {
  const cwd = gate.dir ? path.join(dir, gate.dir) : dir;
  const group = process.platform !== "win32";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gate.command, {
        cwd,
        shell: true, // the declared suite is a command LINE ('npm test && npm run lint'), not an argv
        detached: group,
        env: { ...scrubSecretEnv({ ...process.env, ...(extraEnv || {}) }), CI: "1", SPOR_GATE: gate.id },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, code: null, output: "", reason: `\`${gate.command}\` could not be run: ${e.message}` });
      return;
    }
    const chunks = [];
    let size = 0;
    // Whether the cap dropped bytes: a timeout read cannot call output clean
    // when the start of it is gone (issue-spor-gate-runner-timeout-pathless-
    // failure-read-as-outage).
    let dropped = false;
    const take = (buf) => {
      chunks.push(buf);
      size += buf.length;
      while (size > OUTPUT_CAP_BYTES && chunks.length > 1) {
        size -= chunks.shift().length;
        dropped = true;
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    let grace = null;
    const timeoutVerdict = () => ({
      ok: false,
      code: null,
      timedOut: true,
      reason: `\`${gate.command}\` did not finish within ${Math.round(gate.timeoutMs / 1000)}s`,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // `close` waits for the STDIO PIPES, not the exit — and off POSIX there is
      // no process group to kill, so a surviving grandchild holding the
      // inherited handles would keep `close` from ever firing. Nothing watches a
      // gate pipeline (the run watchdog covers runs), so an unsettled promise
      // here is a slot held for the life of the worker. Settle regardless.
      grace = setTimeout(() => done(timeoutVerdict()), 5000);
    }, gate.timeoutMs);
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ ...verdict, output: Buffer.concat(chunks).toString("utf8"), ...(dropped ? { outputDropped: true } : {}) });
    };
    child.on("error", (e) => done({ ok: false, code: null, reason: `\`${gate.command}\` could not be run: ${e.message}` }));
    child.on("close", (code) => {
      if (timedOut) {
        done(timeoutVerdict());
        return;
      }
      done({ ok: code === 0, code, reason: code === 0 ? null : `\`${gate.command}\` exited ${code}` });
    });
  });
}

// Run the declared gates, in order, for one finished run on one work item.
//
// Returns {state, gates: [...], facts: [...], reason}, plus `escalated_to` /
// `demoted` / `demote_reason` on a refusal:
//   passed   every gate passed (or was not armed) — the item's resolution stands
//   failed   a gate failed; the work is not done, an escalation names why, and
//            the item is demoted on the graph (rule 4)
//   blocked  a human gate is filed and unanswered — the runner is WAITING, and
//            deliberately does not decide on the person's behalf; the item is
//            demoted for the same reason (an unanswered approval is not one)
// A refusal whose escalation could not be filed also carries
// `escalation_failed: true`: nothing on the graph blocks the item, so nothing
// was demoted either and the refusal is readable only on this box. The verdict
// is still settled — the caller records the marker beside it, and `spor work
// --regate <run>` (which judges the run RECORD, untouched by any of this) is
// the door back (WORKERS.md §10.7).
// The OUTAGE a dispatch result carries, or null (FACTORY-IMPLEMENTATION-STAGE.md
// §5.3, task-spor-factory-execution-outcome-classifier). `classification` is
// the shell's `gates.classifyExecutionOutcome` reading of what happened to that
// dispatch — the ONE table every factory dispatch is read through, so a review,
// a fix and the implementation stage cannot disagree about what an outage is.
//
// Only the two readings that are NOT about the change are outages here:
// `infrastructure` (the harness died on the environment) and `unroutable` (the
// dispatch was refused before any run record existed). Everything else — a
// reviewer that ran and wrote garbage included — is still a judgement of the
// change and keeps the fail-closed reading it always had. A dep that classifies
// nothing reads as no outage, so every existing caller is byte-identical.
function outageOf(result) {
  const cls = result && result.classification;
  const outcome = cls && String(cls.outcome || "");
  if (outcome !== "infrastructure" && outcome !== "unroutable") return null;
  const resetAt = Number(cls && cls.reset_at);
  return {
    outcome,
    reason: String((cls && cls.reason) || (result && result.reason) || ""),
    pool: (cls && cls.pool) || null,
    // The outage's own stated end (gates.recordResetAt), and which run said
    // so and when — additive, so an outage with no hint reads as before.
    ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
    ...(result && result.runId ? { runId: result.runId } : {}),
    ...(result && result.finishedAt ? { observedAt: Date.parse(result.finishedAt) || null } : {}),
  };
}

// The gate list is ONE deterministic workflow function over the replay kernel
// (lib/shell/gate-workflow.js, task-spor-gate-list-as-workflow-function); this
// is its DRIVER, under the same signature and result shape as before: every
// deps call is a journaled activity, a gate attempt is `runOneGate` below, the
// fix cycle's and the rescue's run-terminal waits are signals, the outage
// backoff and the reviewer pause are durable timers, and an `interrupted`
// hand-up is a durable yield the work loop still schedules. Required lazily:
// gate-workflow.js requires this module for the gate vocabulary.
async function runGatePipeline(args) {
  return require("./gate-workflow.js").driveGatePipeline(args);
}

// This exact classification is durable before the first issue write. Recovery
// resumes filing against it; it never asks a later green suite to replace it.
async function finishFlakeFiling({ gate, item, factory, armed, firstFailure, isolation, r, attempt, classified }, deps, log) {
    if (isolation && isolation.ok) {
      // ONE issue PER FILE, not one for the set: a flake belongs to the file
      // that flakes, and keying it on the co-failing set would give the same
      // file a different issue every time its companions or their order
      // changed. Every file the isolation re-ran therefore gets its own
      // convergent filing, and the pass needs ALL of them: a file whose issue
      // did not land is a file with no durable record, which is the one thing
      // this pass may not trade away.
      const filed = [];
      if (deps.fileFlakeItem) {
        for (const file of isolation.files) {
          try {
            // Deliberately NOT keyed by rescue pass, unlike every other node a
            // gate files: the same file flaking again on a rescue pass is the
            // same flake, and a second issue for it would be the near-duplicate
            // the per-file keying exists to avoid.
            const f = await deps.fileFlakeItem({ gate, item, file, files: isolation.files, command: gate.command, isolate: isolation.command, origin: deps.filingOrigin });
            // An id already OCCUPIED is a refusal for every other node a gate
            // files — adopting a stranger's approval item would pass a gate
            // nobody looked at. Here it is the opposite: the id is keyed on the
            // failing FILE and on nothing else, so a LIVE occupant IS this
            // flake's issue and is linked rather than rewritten. Which occupants
            // qualify is the filing door's to decide, not this one's: only it
            // can read the graph, and an occupant that is already RESOLVED must
            // NOT be adopted (a fresh occurrence on a settled node resurfaces to
            // nobody). So the answer is taken as given — `ok` with an `existing`
            // id is a link the door reconciled, anything else is unfiled.
            if (f && f.ok && f.id) {
              // A door that converges two files on one issue (or one that
              // simply answers the same id twice) must not put the same edge
              // on the fact twice.
              if (!filed.includes(f.id)) filed.push(f.id);
              if (f.existing) log(`work: the off-diff flake in ${file} is already filed as ${f.id} — linking that issue rather than rewriting it`);
            } else {
              isolation.fileError = `${file}: ${(f && f.reason) || "no response"}`;
            }
          } catch (e) {
            isolation.fileError = `${file}: ${(e && e.message) || String(e)}`;
          }
          if (isolation.fileError) {
            log(`work: the off-diff flake in ${isolation.files.join(", ")} could not be filed (${isolation.fileError}) — the suite failure is charged rather than passed with no durable record of why`);
            break;
          }
        }
      } else {
        isolation.fileError = "this worker has no door to file it through";
      }
      // Fall through to the charged failure below when a filing did not land:
      // `isolation.fileError` is what makes its outcome line say the isolated
      // run PASSED and the failure was charged anyway, so a person reading the
      // escalation can see the flake that could not be recorded. The issues
      // that DID land stay — they are true (that file flaked and passed alone)
      // and they are convergent, so the next pass adopts them rather than
      // filing beside them.
      // The filings that DID land ride the charged outcome too (F7): an issue's
      // occurrence count is its inbound `relates-to` edges from gate facts,
      // and one created for file 1 before file 2's filing failed is a true
      // record of THIS run — charging the failure without linking it would
      // leave that issue with no fact naming it and no occurrence to its name,
      // an orphan the next triage reads as a flake that never happened.
      isolation.filed = filed;
      if (filed.length && !isolation.fileError) {
        const armedBy = armed.classes.length ? ` (armed by ${armed.classes.map((c) => c.class).join(", ")})` : "";
        return {
          passed: true,
          verdict: "passed",
          detail: `${gates.describeFlake(gate.command, isolation.command, isolation.files, filed)}; judged against ${factory.trustedRef}'s copy of the protected paths${armedBy}`,
          evidence: failureEvidence(firstFailure.output || ""),
          flake: { files: isolation.files, issues: filed },
        };
      }
    }
    const reason = (r && r.reason) || (r && r.code != null ? `\`${gate.command}\` exited ${r.code}` : "the gate command failed");
    return {
      passed: false,
      verdict: "failed",
      // Every rerun failed too: say so, so the escalation reads "failed N
      // times on one tree" rather than looking like a single unlucky run —
      // then WHICH files it failed in, and whether re-running them alone
      // failed too, so flake telemetry is aggregatable by file.
      detail: gates.describeRerunsExhausted(reason, attempt) + gates.describeFailingFiles(classified, isolation),
      evidence: failureEvidence((r && r.output) || ""),
      // The same reading as STRUCTURED data (task-spor-gate-escalation-auto-
      // regate-on-flake-fix): the refusal record and the escalation carry the
      // failing test files as a list, which is what lets a later sweep see
      // that every one of them belongs to a since-fixed flake.
      ...(gates.failingTests(classified) ? { failing_tests: gates.failingTests(classified) } : {}),
      // An isolated pass that was charged anyway still happened, and so did
      // the filings that landed before one failed: the fact links every issue
      // this run created or adopted, and says which file went unfiled and why.
      ...(isolation && isolation.ok ? { flake: { files: isolation.files, issues: isolation.filed || [], unfiled: isolation.fileError || "" } } : {}),
    };
}

// The refusal a rescue entry was handed, rebuilt for a resumed pipeline.
//
// The off-diff flake payload rides it (F9). An off-diff pass that was CHARGED
// anyway still filed real issues, and the edge from a gate fact to each of
// them is this run's occurrence — the whole point of keying a flake on its
// file. Without this, a worker killed after the pre-rescue fact write failed
// resumed, escalated the carried refusal, and wrote its fact with no flake at
// all: the issues survived as orphans the next triage reads as flakes that
// never happened. The payload is taken EXACTLY as the entry holds it (F11):
// which of its issues already carry their edge was written into it, per issue,
// in the same stamp as the `fact` id, and only ever from a landing this
// pipeline OBSERVED. Nothing is inferred here from `entry.fact` being set —
// that id says a node with that name is on the graph, not that this markdown
// (and so these edges) landed, and the door that wrote it reports an occupied
// id as a success. An entry from before that stamp existed carries no
// `linked`, so its debt reads OWED and the escalation pays it: a duplicate
// edge overcounts one occurrence, an unwritten one leaves an issue no fact
// names at all and no triage can read as a flake that happened.
function refusalFromEntry(factory, entry) {
  const gate = factory.gates.find((g) => g.id === entry.gate) || { id: entry.gate, kind: "gate", cycles: 0 };
  const flake = entry.flake ? { ...entry.flake } : null;
  return {
    gate,
    outcome: { passed: false, verdict: entry.verdict || "failed", detail: entry.detail || "", evidence: entry.evidence || "", findings: entry.findings || [], escalatedTo: null, flake, ...(Array.isArray(entry.failing_tests) ? { failing_tests: [...entry.failing_tests] } : {}) },
    attempts: (entry.attempts || []).map((a) => ({ ...a })),
    ledger: (entry.ledger || []).map((e) => ({ ...e })),
  };
}

// ONE attempt at one gate. Returns {passed, verdict, detail, evidence,
// findings, noRetry, escalatedTo}. `noRetry` marks the outcomes a fix cycle
// cannot legitimately address — a protected-path violation (the implementer
// must not be sent back to fix the tests it should not have touched), a
// rejected approval, an unanswered one.
// `noRescue` marks the ones the RESCUE lane cannot address either, and every
// refusal that carries it also carries `noRescueWhy` — the phrase the log
// reads after "refused <node>" (`EMPTY_DIFF_NO_RESCUE_WHY` is the first one's).
// The empty diff was for a while the only producer, so the log asserted its
// reason unconditionally; a second one (a review that came back with no verdict
// at all) would have been reported as an empty diff. The reason travels WITH
// the refusal instead.
// An EMPTY diff is not a clean one, whatever kind of gate reads it. The
// review gate learned this first (issue-spor-review-gate-empty-diff-vacuous-
// pass): the first live factory run's implementer landed its commit on the
// trusted ref itself, so the gate diffed that commit against itself,
// dispatched a reviewer at nothing, and read back a pass — an unreviewed
// change laundered into an approval. The command gate learned it the
// expensive way (task-spor-command-gate-empty-diff-short-circuit): run
// d6a89bfe gated a DATA-ONLY item — the deliverable was a graph write, the
// code tree sat at the trusted ref, the diff was `3b5b854..3b5b854` — and the
// acceptance gate ran the full suite anyway on what was literally `main`,
// timed out under load, and handed the item to the rescue lane, which found
// nothing to fix. With no change under it, a suite result is a statement
// about the trusted ref, not about the item: a pass is vacuous and a failure
// (a red trusted ref, box contention) is not the item's either. So BOTH kinds
// fail closed on an empty diff before spending anything — no reviewer, no
// suite, no lease — and unretried, since no fix cycle can produce a diff
// where the branch carries none. A person has to look at why it is empty
// (self-landed, mis-cut branch, a resolve with no work behind it, or a
// deliverable that was a graph write — in which case the thing to verify is
// the write, and the escalation says so).
//
// `noRescue`: the refusal skips the rescue lane too, for the reason a gone
// checkout does (`rescuable`, below). A rescue works in the run's own tree,
// diagnosing and fixing a CHANGE that a gate refused; an empty diff gives it
// no change to work on, and no rescue can turn the refusal into a pass short
// of authoring the whole item — which is an implementer's job, not a fix.
// Both live cases before this (the offset-paging scoping, the already-landed
// handshake stub) spent their rescue re-deriving by hand what the graph
// already recorded; the deterministic routes that read that evidence now run
// BEFORE the gates (§10.11 and its stale-premise sibling), so a diff that is
// still empty here is one a person verifies against the graph, not one a
// strong model diagnoses. The escalation reads the refusal's own account —
// including a declared no-code outcome that did not check out, and why.
function emptyDiffRefusal({ gate, factory, noCodeRefusal = null }) {
  const declared = noCodeRefusal ? `. The run declared a no-code outcome, but it does not check out: ${noCodeRefusal}` : "";
  const detail =
    gate.kind === "command"
      ? `the branch carries no committed change against ${factory.trustedRef} — \`${gate.command}\` would judge ${factory.trustedRef} itself, not the change,` +
        ` so the gate fails closed without running it (the deliverable was not code: a graph write to verify by hand, or was the work landed on ${factory.trustedRef} directly, or resolved with nothing behind it?)` +
        declared
      : `the branch carries no committed change against ${factory.trustedRef} — an empty diff has nothing to review,` +
        ` so the gate fails closed rather than passing vacuously (was the work landed on ${factory.trustedRef} directly, or resolved with nothing behind it?)` +
        declared;
  return { passed: false, verdict: "failed", noRetry: true, noRescue: true, noRescueWhy: EMPTY_DIFF_NO_RESCUE_WHY, emptyDiff: true, detail };
}

function loadNow() {
  try { return require("node:os").loadavg().map((n) => n.toFixed(1)).join("/"); } catch { return "unknown"; }
}

async function runOneGate({ gate, cycle, factory, item, head = null, changed, changedReason, noCodeRefusal = null, deps, log, ledger = [], lastFix = null, rescue = 0, base = 0, retry = 0, awaitApproval = false }) {
  if (gate.kind === "command") {
    if (!changed) {
      return { passed: false, verdict: "failed", detail: changedReason || "the change under judgement could not be read", noRetry: true };
    }
    // An EMPTY diff fails closed BEFORE the suite, the lease, and arming
    // (`emptyDiffRefusal`, task-spor-command-gate-empty-diff-short-circuit):
    // the suite would only ever judge the trusted ref itself. Before arming
    // for the same reason the review branch gives — an empty diff arms
    // nothing, so a risk-declaring gate evaluated for arming first would
    // convert this refusal into a silent `skipped` pass.
    if (changed.length === 0) return emptyDiffRefusal({ gate, factory, noCodeRefusal });
    // FAIL CLOSED, before anything is executed: an implementer branch that
    // edited its own acceptance tests does not get to run them. A `ci` suite
    // adds the CI definition itself to that set (gates.CI_PROTECTED_PATHS).
    const protectedPaths = gates.suiteProtectedPaths(gate, factory.protectedPaths);
    const hits = gates.protectedHits(changed, protectedPaths);
    if (hits.length) {
      let lane = null;
      try {
        const filed = await deps.fileTestLaneItem({ gate, item, paths: hits, profile: factory.testLaneProfile, ...(rescue ? { rescue } : {}) });
        if (filed && filed.ok) lane = filed.id;
        else log(`work: the test-change lane item could not be filed (${(filed && filed.reason) || "no response"})`);
      } catch (e) {
        log(`work: the test-change lane item could not be filed (${(e && e.message) || e})`);
      }
      return {
        passed: false,
        verdict: "fail-closed",
        noRetry: true,
        escalatedTo: lane,
        detail:
          `the implementer's change touches protected test path(s) — ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ""}; ` +
          `the acceptance suite is not run from a branch that edits it${lane ? `, and the test change is routed to the ${factory.testLaneProfile} lane as ${lane}` : ""}`,
        evidence: hits.join("\n"),
      };
    }
    // ARMING (task-spor-command-gate-risk-arming): a command gate declaring
    // risk classes runs only when the change touched one. Unarmed reads
    // `skipped` — recorded as a fact like an unarmed human gate, so the
    // telemetry says the gate was consulted and chose not to run.
    const armed = gates.gateArmed(gate, changed, factory.riskClasses);
    if (!armed.armed) {
      return { passed: true, verdict: "skipped", detail: `no declared risk class (${gate.risk.join(", ")}) was touched by this change — \`${gate.command}\` not run` };
    }
    // The SERIALIZE lease (task-spor-gate-serialize-lease): a suite that owns a
    // singleton per box waits for the previous holder. Fail-open like the
    // integration lease — an unavailable lease is logged, never a verdict.
    let lease = null;
    if (gate.serialize && deps.acquireGateLease) {
      try {
        lease = await deps.acquireGateLease({ gate, item });
        if (!lease) log(`work: gate ${gate.id} could not take its serialize:${gate.serialize} lease — running without it`);
      } catch (e) {
        log(`work: gate ${gate.id} could not take its serialize:${gate.serialize} lease (${(e && e.message) || e}) — running without it`);
      }
    }
    // The bounded RERUN (task-spor-factory-spor-flaky-command-gate-needs-fix-
    // cycle-or-rerun): a declared `reruns` budget runs the SAME command on
    // the SAME tree again before a failure is charged — under the lease the
    // whole time, since a rerun is still this gate's suite. A pass on a rerun
    // is a pass, but it is recorded with the first failure's evidence, so a
    // suite that flakes under load shows up in the telemetry as the flake it
    // is, never as a clean run. A rerun costs a suite run and nothing else;
    // a fix cycle re-dispatches an implementer at work that was never wrong.
    // "The SAME tree" is literal: the judged tree is prepared ONCE for the
    // whole rerun loop. `deps.openSuite` (the door bin/spor.js provides)
    // materializes it — the throwaway worktree with the protected paths
    // forced back — and hands back `run(attempt)` + `close()`, so every
    // rerun executes on the very checkout the declared run failed in and
    // the setup/teardown hooks fire once. A dep exposing only the one-shot
    // `runSuite` (a test fake, an older caller) is run per attempt; that dep
    // owns its own tree lifecycle and is not this loop's to share.
    let r = null;
    let firstFailure = null;
    let attempt = 0;
    let suite = null;
    // What the failure NAMED, and what re-running just that named the second
    // time — both null until the suite has actually failed (see the off-diff
    // pass after the rerun loop). `outputs` keeps EVERY failed run's output,
    // not just the last: the reruns are independent samples of one tree and
    // they need not fail the same way, so the off-diff claim is folded across
    // all of them (gates.offDiffRuns) rather than read off whichever ran last.
    let classified = null;
    let isolation = null;
    let timeoutRead = null;
    const outputs = [];
    const suiteArgs = { gate, factory, item, trustedRef: factory.trustedRef, protectedPaths, armed: armed.classes };
    try {
      if (deps.openSuite) {
        try {
          suite = await deps.openSuite(suiteArgs);
        } catch (e) {
          suite = { ok: false, reason: `the gate tree could not be prepared: ${(e && e.message) || e}` };
        }
      }
      for (;;) {
        attempt += 1;
        try {
          if (suite && !suite.ok) r = { ok: false, reason: suite.reason || "the gate tree could not be prepared", ...(suite.outage ? { outage: suite.outage } : {}) };
          else if (suite) r = await suite.run(attempt);
          else r = await deps.runSuite({ ...suiteArgs, attempt });
        } catch (e) {
          r = { ok: false, reason: `the gate command could not be run: ${(e && e.message) || e}` };
        }
        if (r && r.ok) break;
        // An OUTAGE (a `ci` suite whose CI never judged the change) is not a
        // failure to rerun: the pipeline's infrastructure pool pays for asking
        // again, and a rerun here would spend a suite run on the same silence.
        if (r && r.outage) break;
        outputs.push((r && r.output) || "");
        if (!firstFailure) firstFailure = { ...(r || {}), reason: (r && r.reason) || (r && r.code != null ? `\`${gate.command}\` exited ${r.code}` : "the gate command failed") };
        // A tree that never came up has nothing to rerun on.
        if (suite && !suite.ok) break;
        // A TIMEOUT is not a flaky verdict to sample again: a rerun would spend
        // a second whole budget on the same silence. It is handled below as
        // an outage (dec-spor-timeout-diagnosis-never-substitutes-completed-
        // acceptance), which the infrastructure pool pays to retry.
        if (r && r.timedOut) break;
        if (gates.rerunDecision(gate, attempt) !== "rerun") break;
        log(`work: gate ${gate.id} failed on ${item.node_id} (${(r && r.reason) || "no reason"}) — rerun ${attempt}/${gates.rerunCap(gate)} on the same tree`);
      }
      // The OFF-DIFF pass (task-spor-factory-flake-rescue-should-not-burn-
      // when-failure-is-off-diff), after every declared rerun and before the
      // failure is charged. Two halves, and only the first is unconditional:
      //
      //   (c) TELEMETRY — which files the failure named, and whether the change
      //       touches them, goes on the charged failure's outcome (and so on
      //       its `art-gate-*` fact) for every command gate. Reading paths
      //       costs nothing and needs no declaration; a suite whose paths
      //       cannot be read classifies as nothing and reads exactly as before.
      //   (a) ISOLATION — re-running those files on their own is a SUITE RUN
      //       and can only be spelled by the factory, so it happens solely
      //       when the gate declares `isolate`, the named test files are few,
      //       and the failure is demonstrably off the change's diff on BOTH
      //       readings: no run named a file the change edits, and the failing
      //       tests do not reference one either (changeReferencedBy).
      //
      // It runs on the tree the failure happened on — inside this `try`, before
      // the `finally` closes it — so an isolated pass means "these files pass
      // HERE", never "they pass on some fresh checkout at the same sha".
      // Never after a TIMEOUT: the suite did not complete, so "the files it
      // named pass alone" says nothing about the rest of it, and an isolated
      // green must not stand in for the required full-suite result.
      if (r && r.timedOut && !(suite && !suite.ok)) {
        const dir = (suite && suite.dir) || "";
        const named = gates.offDiffRuns(outputs, changed, { dir });
        // An EARLIER run that completed and failed is an actual failure even when
        // its output named no path (a rerun that then timed out must not launder it),
        // and so is partial output carrying a failure marker but no path, or output
        // that cannot be read at all — including output whose start the capture
        // cap dropped: only clean or empty partial output is an outage
        // (issue-spor-gate-runner-timeout-pathless-failure-read-as-outage).
        const marked = r.outputDropped === true || outputs.some((o) => gates.partialOutputRead(o) !== "clean");
        timeoutRead = { actualFailure: named.files.length > 0 || named.truncated === true || marked || !!(firstFailure && !firstFailure.timedOut), files: named.files, load: loadNow() };
        // DIAGNOSTIC ONLY: when the output named no failure, re-run the test
        // files the change itself touches (if the gate declares `isolate`) so a
        // person sees whether the change's own tests are green. The result is
        // recorded and never changes the verdict.
        const tests = gate.isolate && !timeoutRead.actualFailure ? gates.isolatableTests(changed) : [];
        if (tests.length) {
          const command = gates.isolateCommand(gate, tests);
          let iso = null;
          try {
            if (suite) iso = await suite.run(attempt + 1, command);
            else iso = await deps.runSuite({ ...suiteArgs, attempt: attempt + 1, command });
          } catch (e) {
            iso = { ok: false, reason: `the diagnostic run could not be run: ${(e && e.message) || e}` };
          }
          timeoutRead.diagnostic = { command, files: tests, ok: !!(iso && iso.ok), timedOut: !!(iso && iso.timedOut), reason: (iso && iso.reason) || "", output: failureEvidence((iso && iso.output) || "") };
        }
      } else if (!(r && r.ok) && !(r && r.outage) && !(suite && !suite.ok)) {
        const dir = (suite && suite.dir) || "";
        // ALL the failed runs, not the last one: an on-diff failure on run 1
        // followed by an off-diff one on run 2 is not an off-diff failure.
        classified = gates.offDiffRuns(outputs, changed, { dir });
        let tests = gate.isolate && classified.offDiff ? gates.isolatableTests(classified.files) : [];
        if (tests.length) {
          // The second half of off-diff: the failing tests must not REFERENCE
          // the change either — not being in the diff is a coincidence, not an
          // argument. Fails closed (see changeReferencedBy). The tests are the
          // HARD seeds (they are what the isolation would re-run); every OTHER
          // file the failure named rides along as a soft seed, because the
          // failure went through those too and what they import is part of the
          // same question — a lib/ frame in the stack that imports the change
          // is a reference even when the test file itself never names it.
          const ref = changeReferencedBy(dir, tests, changed, { also: classified.files.filter((f) => !tests.includes(f)) });
          classified.reached = ref.reached;
          classified.refUnknown = ref.unknown;
          if (ref.reached.length) {
            log(`work: gate ${gate.id} failed on ${item.node_id} in ${tests.join(", ")}, which the change does not edit but does reference (${ref.reached.slice(0, 3).join(", ")}) — charged, not isolated`);
            tests = [];
          } else if (ref.unknown) {
            log(`work: gate ${gate.id} failed on ${item.node_id} in ${tests.join(", ")}, and whether they reference the change could not be read (${ref.unknown}) — charged, not isolated`);
            tests = [];
          }
        }
        if (tests.length) {
          const command = gates.isolateCommand(gate, tests);
          log(`work: gate ${gate.id} failed on ${item.node_id} in ${tests.join(", ")}, which the change does not touch — re-running \`${command}\` alone on the same tree`);
          let iso = null;
          try {
            if (suite) iso = await suite.run(attempt + 1, command);
            else iso = await deps.runSuite({ ...suiteArgs, attempt: attempt + 1, command });
          } catch (e) {
            iso = { ok: false, reason: `the isolated rerun could not be run: ${(e && e.message) || e}` };
          }
          isolation = { command, files: tests, ok: !!(iso && iso.ok), reason: (iso && iso.reason) || "", output: (iso && iso.output) || "" };
        }
      }
    } finally {
      // The tree outlives the last run and goes down BEFORE the lease: the
      // next holder may stage its own tree in the same checkout.
      if (suite && suite.ok && typeof suite.close === "function") {
        try {
          await suite.close();
        } catch {
          /* best effort — the teardown hook already warns on its own */
        }
      }
      if (lease && deps.releaseGateLease) {
        try {
          await deps.releaseGateLease(lease);
        } catch {
          /* best effort — a lease this box could not release lapses on its own */
        }
      }
    }
    // CI never answered: not a verdict on the change (dec-spor-command-gate-
    // ci-mode). The pipeline's outage path pays for asking again from the
    // shared infrastructure pool, and otherwise refuses — fail CLOSED, no fix
    // cycle charged, never a pass.
    if (r && !r.ok && r.outage) {
      return {
        passed: false,
        verdict: "infrastructure",
        noRetry: true,
        outage: { outcome: "infrastructure", pool: "retry", ...r.outage },
        detail: `${r.reason || r.outage.reason || "CI did not judge the change"}; that is an outage, not a verdict on the change, so no fix cycle is charged`,
      };
    }
    // A suite that TIMED OUT never completed, so it is neither a pass nor — on
    // its own — a verdict on the change. With no assertion failure in the
    // partial output it is infrastructure: the pipeline's shared retry pool pays
    // to ask again (bounded; exhausted = a durable hold naming the outage), no
    // fix cycle and no rescue is charged, and acceptance still requires the
    // configured command to FINISH green on this candidate. An actual failure
    // in the partial output is separate evidence and is charged below as usual.
    if (r && !r.ok && r.timedOut && timeoutRead && !timeoutRead.actualFailure) {
      const d = timeoutRead.diagnostic;
      const diag = d
        ? `; diagnostic only — \`${d.command}\` on the change's own test files ${d.ok ? "passed" : d.timedOut ? "also timed out" : "FAILED"}, which does not make the suite pass`
        : "";
      const reason = `${r.reason} (candidate ${head || "unknown"}, load ${timeoutRead.load})`;
      return {
        passed: false,
        verdict: "infrastructure",
        noRetry: true,
        outage: { outcome: "infrastructure", pool: "retry", reason },
        detail: `${reason}; the suite never completed and its partial output named no failure, so this is an outage, not a verdict on the change — no fix cycle or rescue is charged and the full suite must still finish${diag}`,
        evidence: [failureEvidence(r.output || ""), d && d.output ? `diagnostic: ${d.output}` : ""].filter(Boolean).join("\n"),
        timeout: { timeout_ms: gate.timeoutMs, command: gate.command, head: head || null, load: timeoutRead.load, ...(d ? { diagnostic: { command: d.command, files: d.files, ok: d.ok } } : {}) },
      };
    }
    if (r && r.ok) {
      const armedBy = armed.classes.length ? ` (armed by ${armed.classes.map((c) => c.class).join(", ")})` : "";
      // Where the verdict came from, when it was not this box's own suite run:
      // a CI run (its url), or the declared local fallback after CI could not
      // be reached — both ride the fact so a pass is never read as the other.
      const via = r.ci && r.ci.url ? ` — judged on CI (${r.ci.url})` : r.ci ? ` — judged on CI (run ${r.ci.run_id})` : "";
      const fellBack = r.fallback ? ` — run on this box under local_fallback because CI could not be reached (${r.fallback})` : "";
      if (firstFailure) {
        return {
          passed: true,
          verdict: "passed",
          detail: `${gates.describeRerun(gate.command, attempt, firstFailure.reason)}; judged against ${factory.trustedRef}'s copy of the protected paths${armedBy}${via}${fellBack}`,
          evidence: failureEvidence(firstFailure.output || ""),
        };
      }
      return { passed: true, verdict: "passed", detail: `\`${gate.command}\` passed against ${factory.trustedRef}'s copy of the protected paths${armedBy}${via}${fellBack}`, evidence: null };
    }
    // An off-diff FLAKE: the whole suite failed, every file it named is off the
    // change's diff, those files reference nothing it edits, and they passed on
    // their own on that same tree. The gate passes — charging this would spend
    // the item's fix cycles, its rescue and finally a person on work that was
    // never wrong — but it is never laundered into a clean run.
    //
    // The pass is CONDITIONAL ON A DURABLE RECORD: it happens only if the flake
    // issue actually landed. Every other node a gate files is best-effort
    // because the gate fact carries the finding — but the fact write is
    // best-effort too (`record` swallows its own failure), and a red suite that
    // passes with neither write landing is a green light nobody can audit. So a
    // filing that fails is not a lost convenience here, it is the missing
    // record: the failure is charged instead, exactly as it was before this
    // feature existed, and the outcome says the isolated run passed and why it
    // was charged anyway.
    const intent = { gate, item, factory, armed, firstFailure: firstFailure && { ...firstFailure, output: failureEvidence(firstFailure.output || "") }, isolation, r: r && { ...r, output: failureEvidence(r.output || "") }, attempt, classified };
    if (isolation && isolation.ok && deps.saveFlakeIntent) {
      try { await deps.saveFlakeIntent(intent); }
      catch (e) { log(`work: flake filing intent could not be saved (${e.message || e}) — no issue is filed`); return { evidencePending: true }; }
    }
    const charged = await finishFlakeFiling(intent, deps, log);
    // Mixed: the timeout does not excuse an actual failure, and the failure does
    // not excuse the timeout — say both.
    if (timeoutRead && charged && !charged.passed) charged.detail = `${r.reason}, and its partial output named an actual failure; ${charged.detail}`;
    return charged;
  }

  if (gate.kind === "agent-review") {
    // An UNREADABLE diff refuses a gate that declares risk classes, for the
    // reason the human branch gives below: a risk class is a path predicate,
    // and with no readable paths "assume it isn't armed" is the fail-open
    // direction. Scoped to a declaring gate on purpose (dec-spor-review-gate-
    // unreadable-diff-fails-closed-only-when-armed): a review gate declaring
    // NO risk consults no paths, and its reviewer reads the implementer's live
    // checkout for itself, so an unconditional refusal here would turn a
    // working review into a failure for every factory already in service.
    if (!changed && (gate.risk || []).length) {
      return {
        passed: false,
        verdict: "failed",
        noRetry: true,
        detail: changedReason || "the change under judgement could not be read, so this gate's risk classes could not be evaluated",
      };
    }
    // An EMPTY diff is not a clean one (issue-spor-review-gate-empty-diff-
    // vacuous-pass): a review with nothing to judge fails CLOSED and
    // unretried, with no reviewer dispatched — `emptyDiffRefusal` above says
    // why, and carries a declared no-code outcome (§10.11) that did not check
    // out, plus what broke, so the escalation never reads as if the run said
    // nothing.
    if (changed && changed.length === 0) return emptyDiffRefusal({ gate, factory, noCodeRefusal });
    // The prior set: the blocking findings still open on the ledger. Review N
    // is handed them (and the last fix) and must answer each before it may
    // raise anything new — the protocol lives in gates.parseReviewVerdict.
    const prior = gates.openPriorFindings(ledger);
    // ARMING (task-spor-review-gate-risk-arming): a review gate declaring risk
    // classes dispatches only when the change touched one — the same
    // predicate, the same `skipped` verdict and the same recorded fact the
    // command and human branches produce. Deliberately AFTER the empty-diff
    // refusal above: an empty diff arms nothing, so evaluating arming first
    // would convert that fail-closed failure into a silent pass and re-open
    // issue-spor-review-gate-empty-diff-vacuous-pass.
    const armed = gates.gateArmed(gate, changed, factory.riskClasses);
    // ...and never while the ledger holds an open blocking finding
    // (dec-spor-review-gate-arming-never-buries-open-findings). Arming is read
    // from a diff that changes across fix cycles, so a fix that reverts the
    // arming paths could otherwise disarm a gate mid-pipeline — and `skipped`
    // passes. A demonstrated defect is retired by a reviewer clearing it,
    // never by the paths that raised it going away.
    if (!armed.armed && !prior.length) {
      return {
        passed: true,
        verdict: "skipped",
        detail: `no declared risk class (${gate.risk.join(", ")}) was touched by this change — no review dispatched under ${gate.profile}`,
      };
    }
    // ...and the findings an earlier cycle rated blocking but could not
    // demonstrate: the reviewer may demonstrate one now, by id, without it
    // counting as a goalpost (gates.parseReviewVerdict, `raised`).
    const raised = gates.raisedUndemonstrated(ledger);
    // A review LANE an earlier outage said is out until a stated reset
    // (task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-
    // reviewer): dispatching into it now only re-reads the same usage-limit
    // line and files one more outage for this item. So nothing is dispatched
    // and the gate answers the outage the stamp describes, marked `cooldown`
    // — the pipeline then pauses (free: no dispatch was made) or routes to a
    // fallback. `gate.profile` here is the ROUTED lane, so a fallback the
    // pipeline already selected is judged by its own cooldown, never its
    // primary's. The stamp is reconciled by the shell (a newer success under
    // the lane clears it; a passed reset never blocks), and a read that fails
    // is no cooldown — the dispatch below then finds out for itself.
    if (deps.reviewerCooldown) {
      let cool = null;
      const at = deps.now ? deps.now() : Date.now();
      try {
        cool = await deps.reviewerCooldown({ profile: gate.profile, now: at });
      } catch {
        cool = null;
      }
      const until = cool && Number(cool.until);
      if (until && until > at) {
        const why = `the review lane ${gate.profile} is out until ${new Date(until).toISOString()}${cool.reason ? ` (${String(cool.reason).slice(0, 200)})` : ""}${cool.run_id ? `, as run ${String(cool.run_id).slice(0, 8)} found` : ""}`;
        return {
          passed: false,
          verdict: "infrastructure",
          noRetry: true,
          outage: { outcome: "infrastructure", reason: why, pool: "retry", resetAt: until, cooldown: true },
          detail: `no review was dispatched: ${why}; that is an outage, not a verdict on the change, so no fix cycle is charged`,
          evidence: "",
        };
      }
    }
    let r = null;
    try {
      // `retry` — the shared infrastructure pool's spent count — rides to the
      // door so a review re-asked after an outage is a DIFFERENT launch
      // identity from the one that found the outage: the dispatch door adopts
      // by name (dec-spor-adopt-by-name-returns-existing), and the re-ask must
      // not adopt the dead reviewer.
      r = await deps.review({ gate, cycle, item, factory, prior, raised, ledger, fix: lastFix, retry, ...(rescue ? { rescue, base } : {}) });
    } catch (e) {
      r = { ok: false, reason: `the review dispatch failed: ${(e && e.message) || e}` };
    }
    // A review that ANSWERED is the lane's own evidence it is back: noted with
    // the run's finish time, so the shell clears only a cooldown OLDER than it
    // (an earlier success must not clear a newer outage). Best-effort.
    if (r && r.ok && deps.noteReviewerSuccess) {
      try {
        // Anchored on when the answering run STARTED: a long review that began
        // before an outage and finished after it proves nothing about the
        // lane after the outage, so it must not clear the newer stamp.
        await deps.noteReviewerSuccess({ profile: gate.profile, at: Date.parse(r.startedAt || "") || Date.parse(r.finishedAt || "") || (deps.now ? deps.now() : Date.now()), run_id: r.runId || null });
      } catch {
        /* best effort — an uncleared stamp still lapses at its own reset */
      }
    }
    if (!r || !r.ok) {
      // An OUTAGE is not a rejection (§5.3, issue-spor-review-gate-reviewer-
      // outage-read-as-rejection). The shell classifies what happened to the
      // dispatch through the SAME `classifyExecutionOutcome` every other
      // factory dispatch is read through, and a reviewer that never answered
      // because its backend was 404ing, its credit ran out or its supervisor
      // vanished is not information about the change: folding a finding,
      // charging a fix cycle and dispatching an implementer at it is telling a
      // fixer to fix nothing. So it is handed back as an outage and the
      // pipeline decides — retry on the shared infrastructure pool, or refuse
      // naming the outage. A dep that classifies NOTHING keeps the fail-closed
      // reading below unchanged, so every existing caller is byte-identical.
      const outage = outageOf(r);
      if (outage) {
        return {
          passed: false,
          verdict: outage.outcome,
          // Nothing about the change was judged, so a fix cycle would be spent
          // on a finding nobody made. The pipeline's own outage handling is
          // what asks again.
          noRetry: true,
          outage,
          detail:
            `the review under ${gate.profile} never answered — ${outage.reason || "the dispatch produced no verdict"}` +
            `; that is ${outage.outcome === "unroutable" ? "a dispatch this box refused" : "an outage"}, not a verdict on the change, so no fix cycle is charged`,
          evidence: (r && r.text) || "",
        };
      }
      // An unrun review is not a passed one. The prior set still stands: a
      // review that never ran cleared nothing.
      const carried = prior.map((p) => ({ ...p, origin: "prior", blocking: true, status: "open" }));
      const why = (r && r.reason) || "the review could not be dispatched";
      // ...but a FIX CYCLE needs something to fix. This arm is reached only
      // when no verdict text ever existed — the dispatch was refused, the run
      // never reached a terminal state, or it ended having written nothing —
      // so the review raised no finding of its own, and with no PRIOR finding
      // still open there is nothing to hand an implementer. Charging a cycle
      // there dispatches one at an empty findings list under a detail line
      // that says the reviewer wrote no report: three items burned all four
      // attempts and then a rescue exactly that way while Codex was
      // credit-dead (task-spor-program-review-report-recovery-20260906 —
      // 16 reviewer dispatches, 0 verdicts, every one a usage-limit refusal).
      // The two halves that fixed the CLASSIFICATION of that case
      // (issue-spor-codex-usage-limit-outage-read-as-a-code-failure) route it
      // to the outage branch above instead — but only for an ending the
      // signature table RECOGNIZES; an unavailable reviewer whose wording it
      // does not still lands here. So this reading does not wait on the
      // classifier agreeing: no verdict read and nothing carried is a refusal
      // to escalate, not a change to repair. `noRescue` for the reason the
      // empty-diff refusal carries it — a rescue is a code-repair dispatch
      // into the checkout, and nothing about the change was refused here
      // either, so it could only re-derive the reviewer's absence by hand.
      if (!carried.length) {
        return {
          passed: false,
          verdict: "failed",
          detail: `${why}; no verdict was read and no earlier finding is open, so there is nothing for a fix cycle to fix — none is charged, and no rescue is dispatched`,
          evidence: "",
          findings: [],
          ledger,
          noRetry: true,
          noRescue: true,
          noRescueWhy: `on a review under ${gate.profile} that produced no verdict — a rescue has no finding to work on`,
        };
      }
      return { passed: false, verdict: "failed", detail: why, evidence: (r && r.text) || "", findings: carried, ledger };
    }
    const v = gates.parseReviewVerdict(r.text, { prior, cycle, raised });
    const next = gates.applyReviewToLedger(ledger, v, cycle);
    v.findings = gates.withLedgerIds(v.findings, next, ledger);
    // A prior finding confirmed open for the second time without the
    // mechanism's rows enumerated is flagged row-by-row on the finding (the
    // fact and the fixer's prompt both render it) — the pattern that spent a
    // whole cycle budget on one finding (task-spor-review-gate-carried-
    // finding-names-the-mechanism-not-the-next-row).
    const rowByRow = new Set(gates.rowByRowFindings(v.findings, cycle).map((f) => f.id));
    if (rowByRow.size) v.findings = v.findings.map((f) => (rowByRow.has(f.id) ? { ...f, rowByRow: true } : f));
    if (!v.ok) {
      if (v.unanswered && v.unanswered.length) {
        // Rule 3: a memoryless verdict counts as changes_requested for the
        // PRIOR SET ONLY — the fixer gets the still-open prior findings, and
        // nothing this review raised is admitted (it did not do its first job).
        return {
          passed: false,
          verdict: "failed",
          detail: `the review under ${gate.profile} ${v.error} — ${v.findings.length} prior finding(s) still open`,
          findings: v.findings,
          evidence: gates.renderFindings(v.findings) || tailBytes(r.text || ""),
          ledger: next,
        };
      }
      // An unreadable verdict that still ANSWERED the prior set (rule 4: it
      // said what it wanted about F1 but its own findings could not be read)
      // keeps those answers — the fixer is sent back at what is still open,
      // not at a finding the reviewer just cleared. One that answered nothing
      // cleared nothing, so the whole prior set stands (v.findings carries
      // it either way). Under rule 5 the undemonstrated findings ride along
      // as advisory, so the fixer sees what the reviewer could not back.
      return {
        passed: false,
        verdict: "failed",
        detail: `the review under ${gate.profile} returned no readable verdict (${v.error}) — an unread review is not an approval`,
        evidence: (v.undemonstrated ? gates.renderFindings(v.findings) : "") || tailBytes(r.text || ""),
        findings: v.findings,
        ledger: next,
      };
    }
    if (v.passed) {
      const advisory = (v.findings || []).filter((f) => !f.blocking).length;
      // Name the arming class on the way through, as the command gate does:
      // the `art-gate-*` fact is the only place a factory maintainer can later
      // read WHY an armed gate ran.
      const armedBy = armed.classes.length ? ` (armed by ${armed.classes.map((c) => c.class).join(", ")})` : "";
      return {
        passed: true,
        verdict: "passed",
        detail: `the review under ${gate.profile} found nothing blocking (verdict: ${v.verdict}${advisory ? `, ${advisory} advisory note${advisory === 1 ? "" : "s"} recorded` : ""})${armedBy}${v.note ? ` — ${v.note}` : ""}`,
        ledger: next,
      };
    }
    const open = v.findings.filter((f) => f.blocking);
    const carried = open.filter((f) => f.origin === "prior").length;
    // A DONE CONDITION the reviewer has now held open for the second fix cycle
    // is a scope dispute, not a defect, and another fix cycle at it buys
    // nothing (task-spor-review-gate-item-done-condition-vs-implementer-
    // conclusion): the run that named this spent all three restating the same
    // conclusion with more evidence, and the rescue met the condition in one
    // materially different attempt. So the refusal stops HERE — `noRetry`
    // sends it to the rescue lane if the factory declares one, else to the
    // human escalation, both of which can do what a fourth restatement
    // cannot. The cap is untouched: this only ever spends FEWER cycles.
    const unmet = gates.unmetConditionFindings(v.findings, cycle).map((f) => f.id);
    return {
      passed: false,
      verdict: "failed",
      detail:
        `the review under ${gate.profile} requested changes — ${open.length} blocking finding(s)` +
        (cycle > 0 ? ` (${carried} carried from earlier cycles, ${open.length - carried} new)` : "") +
        (rowByRow.size ? `; ${rowByRow.size} confirmed row-by-row (carried ${gates.ROW_BY_ROW_CARRY}+ fix cycles without the mechanism's rows enumerated: ${[...rowByRow].join(", ")})` : "") +
        (unmet.length
          ? `; ${unmet.join(", ")} held open as an unmet done condition through ${gates.UNMET_CONDITION_CARRY}+ fix cycles` +
            ` — a scope dispute, not a defect: no further fix cycle is dispatched at it`
          : "") +
        (v.error ? `; ${v.error}` : ""),
      findings: v.findings,
      evidence: gates.renderFindings(v.findings) || tailBytes(r.text || ""),
      ledger: next,
      ...(unmet.length ? { noRetry: true } : {}),
    };
  }

  // human
  if (!changed) {
    // A risk class is a path predicate; with no readable diff we cannot know
    // whether the gate is armed, and "assume it isn't" is the fail-open
    // direction on the one gate kind that exists for the risky changes.
    return { passed: false, verdict: "failed", detail: changedReason || "the change under judgement could not be read, so its risk classes could not be evaluated", noRetry: true };
  }
  const armed = gates.humanGateArmed(gate, changed, factory.riskClasses);
  if (!armed.armed) {
    return { passed: true, verdict: "skipped", detail: `no declared risk class (${gate.risk.join(", ")}) was touched by this change` };
  }
  let filed = null;
  try {
    filed = await deps.fileHumanItem({ gate, item, factory, head, classes: armed.classes, ...(rescue ? { rescue } : {}) });
  } catch (e) {
    filed = { ok: false, reason: `${(e && e.message) || e}` };
  }
  // `ok` without an id is not a filed item: every later step — the poll, the
  // `blocked`/rejected outcomes, and the demotion those two carry — names it,
  // and the demotion now REFUSES to run without one, so an id-less "success"
  // would silently turn a blocked approval into a refusal nothing records.
  if (!filed || !filed.ok || !filed.id) {
    return { passed: false, verdict: "failed", noRetry: true, detail: `the approval item could not be filed (${(filed && filed.reason) || "no response"}) — the change is not approved` };
  }
  const classes = armed.classes.map((c) => c.class);
  const deadline = (deps.now ? deps.now() : Date.now()) + gate.approvalTimeoutMs;
  let state = await readApproval(deps, { id: filed.id, gate, item, head });
  // The WAIT is the workflow's, not this activity's, when the caller asks for
  // it (task-spor-gate-human-approval-await-signal): the item is filed and its
  // answer read ONCE here — an item already answered, or bound to another
  // commit, settles without a wait — and an unanswered one is handed back as
  // `awaiting-approval`, which gate-workflow.js turns into a journaled
  // deadline plus an `approval:<id>` signal the driver's poll delivers. A
  // crash mid-wait then resumes the SAME wait under the SAME deadline instead
  // of re-entering a fresh day-long sleep inside a re-executed activity. The
  // verdict never leaves the workflow.
  for (;;) {
    const answered = approvalVerdict(state, { id: filed.id, head });
    if (answered) return answered;
    if (awaitApproval) return { passed: false, verdict: "awaiting-approval", noRetry: true, awaitingApproval: { id: filed.id, classes } };
    const at = deps.now ? deps.now() : Date.now();
    if (at >= deadline || deps.stopping?.()) return approvalBlocked(filed.id, classes);
    await deps.sleep(Math.min(gate.pollMs, Math.max(1, deadline - at)));
    state = await readApproval(deps, { id: filed.id, gate, item, head });
  }
}

// One read of an approval item's answer. A read that throws is neither an
// approval nor a refusal: it reads `pending`, and the wait polls again.
async function readApproval(deps, { id, gate, item, head }) {
  try {
    return await deps.checkApproval({ id, gate, item, head });
  } catch (e) {
    return { state: "pending", reason: `${(e && e.message) || e}` };
  }
}

// The human gate's verdict off one approval read, or null while it is
// unanswered. Shared by the in-activity poll above and the workflow's signal
// form (gate-workflow.js), so both settle an answer identically.
function approvalVerdict(state, { id, head }) {
  if (state && state.state === "approved") {
    return { passed: true, verdict: "passed", detail: `approved by ${state.by || "a person"} on ${id}` };
  }
  // The approval item names a DIFFERENT judged commit than this pipeline's
  // (its `gate_head:` was edited, or a node was minted by hand under the
  // id): an approval of another commit is not one of this, and waiting on it
  // would block a day for an answer that can never bind. A refusal, and a
  // final one — a changed candidate gets a fresh item under a fresh id.
  if (state && state.state === "mismatch") {
    return { passed: false, verdict: "failed", noRetry: true, escalatedTo: id, detail: `the approval item ${id} is bound to commit ${String(state.head || "?").slice(0, 12)}, not the judged ${String(head).slice(0, 12)} — an approval of another commit is not an approval of this one` };
  }
  if (state && state.state === "rejected") {
    return { passed: false, verdict: "failed", noRetry: true, escalatedTo: id, detail: `the approval on ${id} was refused${state.by ? ` by ${state.by}` : ""}` };
  }
  return null;
}

// The unanswered approval at its deadline (or a stop): BLOCKED, never decided
// on the person's behalf. `classes` are the risk-class names that armed it.
function approvalBlocked(id, classes = []) {
  return {
    passed: false,
    verdict: "blocked",
    noRetry: true,
    escalatedTo: id,
    detail: `waiting on the human approval item ${id}${classes.length ? ` (risk: ${classes.join(", ")})` : ""} — the resolve stays blocked until it is answered`,
  };
}

module.exports = {
  runGatePipeline,
  finishFlakeFiling,
  refusalFromEntry,
  outageOf,
  flakeIssues,
  flakeLinked,
  flakeEdges,
  flakePaidBy,
  FLAKE_EDGE,
  OUTAGE_BACKOFF_SLICE_MS,
  REVIEWER_PAUSE_PARK_MS,
  EMPTY_DIFF_NO_RESCUE_WHY,
  judgeGit: git,
  pinCandidate,
  changeReferencedBy,
  gateIdSuffix,
  fenceSafe,
  capBytes,
  NODE_BODY_CAP_BYTES,
  gateChangeSet,
  trackedTreeDirty,
  gateHeadLanded,
  gateCommitsLanded,
  prepareGateTree,
  forceProtectedPaths,
  scrubSecretEnv,
  judgeGitEnv,
  noHooksPath,
  isSecretEnvName,
  runGateCommand,
  runOneGate,
  approvalVerdict,
  approvalBlocked,
  buildGateFact,
  gateFactFields,
  gateFactId,
  buildRescueFact,
  rescueFactId,
  tailBytes,
  failureEvidence,
  gateRunKey,
  shortRunAttempt,
};
