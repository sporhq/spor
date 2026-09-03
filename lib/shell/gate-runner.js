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
const { gitSpawn } = require("./git-exec.js");
const { capBytes } = require("./dispatch-terminal.js");

// The same env-scrubbed git the rest of the shell uses: `cwd` names the repo,
// never an ambient GIT_DIR (issue-spor-dispatch-worktree-wrong-repo-location).
const git = (cwd, args, opts = {}) => gitSpawn(cwd, args, opts);

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
function gateRunKey(runId, attempt = 0) {
  const n = Number(attempt) || 0;
  return n > 1 ? `${runId}#r${n}` : String(runId || "");
}

function shortRunAttempt(runId, attempt = 0) {
  const n = Number(attempt) || 0;
  return `${shortRun(runId)}${n > 1 ? `-r${n}` : ""}`;
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
function gateFactId(gateId, nodeId, runId, attempt = 0) {
  const g = String(gateId || "gate").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24).replace(/^-+|-+$/g, "");
  return `art-gate-${g || "gate"}-${stemOf(nodeId)}-${shortRunAttempt(runId, attempt)}-${gateIdSuffix("fact", gateId, nodeId, gateRunKey(runId, attempt))}`;
}

// The graph fact for one gate outcome. `relates-to`, never `resolves` — a gate
// outcome records what happened, it does not retire the item (a PASSING gate
// records that the implementer's own resolver stands; a FAILING one records
// why the work is not done, and the escalation node is what carries it).
function buildGateFact({ gate, nodeId, runId, project, verdict, detail, evidence, attempts, escalatedTo, demotion, date, factory, attempt = 0, ledger = null }) {
  const id = gateFactId(gate.id, nodeId, runId, attempt);
  const passed = verdict === "passed" || verdict === "skipped";
  const summary = oneLine(
    `Gate '${gate.id}' (${gate.kind}) ${verdict} on ${nodeId} for dispatched run ${shortRun(runId)}${detail ? `: ${detail}` : "."}`,
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
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(escalatedTo ? [`  - {type: relates-to, to: ${escalatedTo}}`] : []),
    "---",
    "",
    `The \`${gate.kind}\` gate \`${gate.id}\`${gate.source && gate.source !== "inline" ? ` (from the shared gate node \`${gate.source}\`)` : ""}`,
    `${passed ? "passed" : verdict === "blocked" ? "is blocking" : "failed"} for dispatched run \`${runId}\` on ${nodeId}${factory ? `, under factory \`${factory}\`` : ""}${Number(attempt) > 1 ? ` (re-gate, attempt ${Number(attempt)})` : ""}.`,
    "",
    detail ? `Outcome: ${detail}` : "",
    escalatedTo ? `Escalated to ${escalatedTo}.` : "",
    demotion ? `Demotion: ${oneLine(demotion, 300)}` : "",
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

// Evidence is a suite tail or a review report — either can contain a line that
// is itself a ``` fence, which would close ours early and spill the rest into
// the body as prose. Neutralize the fence without losing the character.
function fenceSafe(text) {
  return String(text || "").replace(/^\s*```/gm, (m) => m.replace("```", "'''"));
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

// What a run actually changed, read from the run's own working tree. Committed
// work only: a dirty tree is refused rather than judged, because the tree a
// gate would take is then not the tree the agent produced, and "close enough"
// is exactly the reading a gate exists to refuse.
function gateChangeSet(record, trustedRef) {
  const cwd = record && record.cwd;
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, reason: `the run's working directory (${cwd || "unset"}) is gone, so its change cannot be read` };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { ok: false, reason: `${cwd} is not a git checkout, so the change under judgement cannot be read` };
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) return { ok: false, reason: `${cwd} has no HEAD commit to gate` };
  // TRACKED modifications only. The gate builds its own worktree from
  // `change.head`, so the run's untracked residue — a coverage dir, a log, an
  // un-ignored build artifact, all of which a suite routinely leaves behind —
  // has no bearing on what is judged, and refusing over it would fail every
  // gate in exactly the configuration this feature is for.
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"], { maxBuffer: GIT_MAX_BUFFER });
  if (dirty.status !== 0) {
    // Every other probe here refuses on a failed probe; this one must too. A
    // status call that could not run is not evidence of a clean tree, and
    // reading it as one is the single fail-OPEN hole in the gate's promise to
    // judge committed work.
    return { ok: false, reason: `could not read the working-tree state of ${cwd} (${(dirty.stderr || "").trim().split("\n")[0] || (dirty.error && dirty.error.message) || "git status failed"}), so the gate cannot confirm it is judging committed work` };
  }
  if ((dirty.stdout || "").trim()) {
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
  return { ok: true, paths, head: headSha, base: baseSha, top: (top.stdout || "").trim(), cwd };
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
  const forced = forceProtectedPaths({ top: change.top, dir, trustedRef, protectedPaths });
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
        env: { ...process.env, ...(extraEnv || {}), CI: "1", SPOR_GATE: gate.id },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, code: null, output: "", reason: `\`${gate.command}\` could not be run: ${e.message}` });
      return;
    }
    const chunks = [];
    let size = 0;
    const take = (buf) => {
      chunks.push(buf);
      size += buf.length;
      while (size > OUTPUT_CAP_BYTES && chunks.length > 1) size -= chunks.shift().length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    let grace = null;
    const timeoutVerdict = () => ({
      ok: false,
      code: null,
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
      resolve({ ...verdict, output: Buffer.concat(chunks).toString("utf8") });
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
async function runGatePipeline({ item, factory, deps, log = () => {} }) {
  const nodeId = item.node_id;
  const runId = item.run_id;
  const now = deps.now || (() => Date.now());
  const results = [];
  const facts = [];
  let changed = null;
  let changedReason = null;
  let changedHead = null;
  let changedDirty = false;

  // The diff under judgement, read once and refreshed after every fix cycle.
  // A read that FAILS is not an empty diff: an empty list would silently
  // disarm both the protected-path check and every risk class, which is the
  // fail-OPEN direction. So the failure is carried and every path-dependent
  // gate treats it as a gate failure.
  const readChanged = async () => {
    changedDirty = false;
    try {
      const r = await deps.changedPaths({ trustedRef: factory.trustedRef });
      if (r && r.ok) {
        changed = r.paths || [];
        changedHead = r.head || null;
        changedReason = null;
        return true;
      }
      changedReason = (r && r.reason) || "the change under judgement could not be read";
      changedDirty = !!(r && r.dirty);
    } catch (e) {
      changedReason = `the change under judgement could not be read: ${(e && e.message) || e}`;
    }
    changed = null;
    return false;
  };
  await readChanged();


  // The graph-state half of a refusal (rule 4 at the top). Runs once, when the
  // pipeline settles non-passed, AFTER the escalation/approval item exists so
  // the demotion can name the blocker it is now waiting on. Fail-soft in the
  // same sense the fact write is: the enforcement is the verdict, not the
  // bookkeeping — a graph that refuses the demotion does not turn a refusal
  // into a pass, and the runner reports what it could not do instead of
  // claiming a demotion that never landed.
  //
  // What it is NOT allowed to be is fail-soft INDEPENDENTLY of the escalation
  // (task-spor-gate-escalation-demote-atomic): the rollback is only one half
  // of §10.7, and the half that makes a refusal fail-CLOSED is the person's
  // item carrying `blocks` onto the work item. Run alone it produces the one
  // graph state worse than doing nothing — an item reading `open`, agent-ready
  // and unblocked while its resolving edge still stands, i.e. fresh-looking
  // agent work carrying a stale resolver, with the refusal held only in this
  // box's cooldown map. So the caller demotes ONLY with a blocker id in hand.
  const demote = async (gate, { state, blockerId }) => {
    if (!deps.demote) return { demoted: false, note: null, reason: null };
    let r = null;
    try {
      r = await deps.demote({ item, gate, state, blockerId: blockerId || null });
    } catch (e) {
      r = { ok: false, reason: `${(e && e.message) || e}` };
    }
    if (r && r.ok) return { demoted: !!r.demoted, note: r.note || null, reason: null };
    const reason = (r && r.reason) || "no response";
    log(`work: gate ${gate.id} refused ${nodeId}, but the item could not be demoted on the graph (${reason}) — the verdict still stands`);
    return { demoted: false, note: null, reason };
  };

  const record = async (gate, { verdict, detail, evidence, attempts, escalatedTo, demotion, ledger }) => {
    let factId = null;
    try {
      const fact = buildGateFact({
        gate, nodeId, runId, project: item.project || null, verdict, detail, evidence, attempts, escalatedTo, demotion, ledger,
        date: new Date(now()).toISOString().slice(0, 10),
        factory: factory.id,
        attempt: item.attempt || 0,
      });
      const wrote = await deps.recordFact({ id: fact.id, markdown: fact.markdown, nodeId, gate, verdict });
      if (wrote && wrote.ok) factId = fact.id;
      else log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
    if (factId) facts.push(factId);
    results.push({ gate: gate.id, kind: gate.kind, verdict, detail: detail || null, fact: factId, escalated_to: escalatedTo || null });
    return factId;
  };

  // The gate's memory across its fix cycles AND across worker processes
  // (task-spor-review-gate-stateful-bounded, review finding 1 on its first
  // cut): the finding ledger, the fix-cycle count and the last fix are saved
  // through `deps.saveGateProgress` after every step that changes them and
  // read back through `deps.loadGateProgress` when the gate starts. A pipeline
  // a killed worker left behind is RESUMED (§10.8), and without this a resumed
  // review gate restarted from cycle 0 with an empty ledger — forgetting every
  // prior finding and granting the implementer a fresh `cycles` allowance per
  // interruption. Both deps are optional (a caller with no durable record
  // keeps the in-process behaviour) and fail-soft: a journal that cannot be
  // written must not stop the gate, so a failed save is logged and the
  // pipeline goes on — the worst case is the pre-fix behaviour on the next
  // resume, never a wrong verdict now.
  const loadProgress = async (gate) => {
    if (!deps.loadGateProgress) return null;
    try {
      const p = await deps.loadGateProgress({ gate, item });
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      log(`work: gate ${gate.id} progress could not be read (${(e && e.message) || e}) — starting the gate from cycle 0`);
      return null;
    }
  };
  const saveProgress = async (gate, progress) => {
    if (!deps.saveGateProgress) return;
    try {
      // The first gate's saves carry the dirty-tree round-trip (below) so a
      // later save of the ledger never drops the record that it was spent.
      const withPre = preAttempts.length && gate.id === factory.gates[0].id && !progress.preAttempts ? { ...progress, preAttempts } : progress;
      await deps.saveGateProgress({ gate, item, progress: withPre });
    } catch (e) {
      log(`work: gate ${gate.id} progress could not be saved (${(e && e.message) || e}) — a resumed pipeline would restart this gate`);
    }
  };

  // ONE commit-or-discard round-trip for a DIRTY tree
  // (task-spor-worker-declined-outcome). A tree with uncommitted changes to
  // tracked files is the one unreadable change a fix cycle can legitimately
  // repair — the implementer forgot to commit, or left probe residue behind —
  // and escalating it straight to a person paged one for exactly that
  // (task-spor-nexavo-tenant-roll-version-probe). So before any gate judges,
  // the same checkout gets one dispatch told to commit what belongs to the
  // item or discard what does not. Exactly one: a tree still dirty afterwards
  // reaches the first gate, which refuses it unretried as before, and the
  // escalation carries this attempt so the person sees it was tried. Every
  // OTHER unreadable-change reason (a missing checkout, an unresolvable
  // trusted ref, a failed `git status`) is about the checkout, not the work,
  // and goes straight to the gate as before.
  //
  // The round-trip is NOT a ledger attempt: the first gate's `attempts` array
  // is indexed by fix cycle (a resumption reads `attempts[cycle]` and rolls
  // the ledger back to `attempts.length`), so it lives beside the ledger as
  // `preAttempts` — prepended to what the fact and the escalation show, saved
  // on the first gate's progress under its own key BEFORE the dispatch so a
  // resumed pipeline (§10.8) never runs the round-trip twice.
  const preAttempts = [];
  const shownAttempts = (gate, attempts) => (preAttempts.length && gate.id === factory.gates[0].id ? [...preAttempts, ...attempts] : attempts);
  if (changed === null && changedDirty && factory.gates.length && deps.fix) {
    const gate = factory.gates[0];
    const prior = await loadProgress(gate);
    if (Array.isArray(prior && prior.preAttempts) && prior.preAttempts.length) {
      preAttempts.push(...prior.preAttempts.map((a) => ({ ...a })));
      log(`work: ${nodeId} is still dirty and its commit-or-discard round-trip was already spent before this pipeline was resumed — gate ${gate.id} judges the tree as it is`);
    } else {
      preAttempts.push({ verdict: "dirty-tree", detail: changedReason });
      await saveProgress(gate, { ...(prior || {}), preAttempts });
      log(`work: ${nodeId} left uncommitted changes — one commit-or-discard round-trip before gate ${gate.id} judges it`);
      let fixed = null;
      try {
        fixed = await deps.fix({
          gate,
          cycle: "tree",
          item,
          findings: [],
          evidence: "",
          ledger: [],
          kind: "commit-or-discard",
          detail:
            `${changedReason}. Commit what belongs to ${nodeId} (a clear message), discard what does not (\`git restore\`),` +
            ` and leave the working tree CLEAN — this is the one round-trip before the '${gate.id}' gate escalates to a person.`,
        });
      } catch (e) {
        fixed = { ok: false, reason: `the fix cycle could not be dispatched: ${(e && e.message) || e}` };
      }
      if (fixed && fixed.ok) await readChanged();
      else log(`work: the commit-or-discard round-trip for ${nodeId} could not run (${(fixed && fixed.reason) || "no response"}) — the gate judges the tree as it is`);
      if (changed !== null) log(`work: ${nodeId} is clean after the round-trip — judging the committed change`);
    }
  }

  for (const gate of factory.gates) {
    let outcome = null;
    // The gate's memory across its fix cycles (task-spor-review-gate-stateful-
    // bounded): the finding ledger — every finding raised so far, resolved or
    // standing — and the fix the last cycle dispatched (its run and the commits
    // it added), so review N is handed what review N-1 said and what the fixer
    // did about it, and a reviewer cannot restart from nothing each cycle.
    // Seeded from the saved progress when this pipeline is a resumption.
    const saved = await loadProgress(gate);
    const attempts = Array.isArray(saved && saved.attempts) ? saved.attempts.map((a) => ({ ...a })) : [];
    let ledger = Array.isArray(saved && saved.ledger) ? saved.ledger.map((e) => ({ ...e })) : [];
    let lastFix = saved && saved.lastFix && typeof saved.lastFix === "object" ? { ...saved.lastFix } : null;
    // `fixes` is the number of fix cycles this gate has DISPATCHED so far,
    // which is exactly the cycle index the next review runs at: cycle 0 is the
    // initial review, cycle N the review after the Nth fix. Resuming at that
    // index is what keeps the declared cap a cap across interruptions.
    const startCycle = Math.max(0, Math.min(gates.cycleCap(gate), Number.isInteger(saved && saved.fixes) ? saved.fixes : 0));
    // Where a resumed gate stands, read off the saved progress (review
    // finding 2 on the second cut — the count used to be charged BEFORE the
    // fix launched, so a worker killed between that save and the launch
    // resumed at the review AFTER a fix that never ran, judged unfixed code
    // as the fix's result and, at the cap, escalated one cycle early):
    //   - `lastFix.dispatched === false` at this cycle: the review ran and
    //     decided on a fix, but the fix never LAUNCHED — dispatch it now,
    //     then review. A fix is charged to the count only once its launch is
    //     durably known (`onLaunch` from the fix dep, or its completion).
    //   - more attempts than fixes and no pending fix: the review at this
    //     cycle ran but what came next (pass, escalation) was never durably
    //     acted on — roll that cycle's fold out of the ledger and re-run it.
    let pendingFix = null;
    if (saved && saved.lastFix && saved.lastFix.dispatched === false && saved.lastFix.cycle === startCycle && attempts.length === startCycle + 1) {
      pendingFix = { ...saved.lastFix };
    } else if (attempts.length > startCycle) {
      attempts.length = startCycle;
      ledger = gates.rollbackCycle(ledger, startCycle);
    }
    if (saved && (startCycle > 0 || ledger.length || attempts.length || pendingFix)) {
      // A fix that was in flight when the worker died: its commits are whatever
      // the tree carries now, which readChanged() already read.
      if (lastFix && lastFix.dispatched !== false && !lastFix.toHead) lastFix.toHead = changedHead;
      log(`work: gate ${gate.id} resumed on ${nodeId} at fix cycle ${startCycle}/${gate.cycles} — ${ledger.length} ledger finding(s) carried${pendingFix ? `; the fix for cycle ${startCycle} never launched, dispatching it first` : ""}`);
    }
    for (let cycle = startCycle; ; cycle += 1) {
      if (pendingFix) {
        // The review at this cycle already ran and asked for a fix.
        outcome = { passed: false, verdict: attempts[cycle].verdict, detail: attempts[cycle].detail, evidence: pendingFix.evidence || "", findings: pendingFix.findings || [] };
        lastFix = pendingFix;
        pendingFix = null;
      } else {
        outcome = await runOneGate({ gate, cycle, factory, item, changed, changedReason, deps, log, ledger, lastFix });
        if (outcome.ledger) ledger = outcome.ledger;
        attempts.push({ verdict: outcome.verdict, detail: outcome.detail, passed: !!outcome.passed });
        const retry = !outcome.passed && !outcome.noRetry && gates.cycleDecision(gate, cycle) === "retry";
        // The fix this review decided on, recorded as NOT YET LAUNCHED with
        // everything its dispatch needs, in the same save as the verdict:
        // a resumption that finds it pending dispatches it, never skips it.
        if (retry) lastFix = { cycle, runId: null, dispatched: false, fromHead: changedHead, toHead: null, findings: outcome.findings || [], detail: outcome.detail || "", evidence: String(outcome.evidence || "").slice(0, 8000) };
        await saveProgress(gate, { fixes: cycle, attempts, ledger, lastFix });
        if (!retry) break;
      }
      log(`work: gate ${gate.id} failed on ${nodeId} — fix cycle ${cycle + 1}/${gate.cycles}`);
      // Charged the moment the launch is known — not before (an unrun fix
      // must not count) and not only after (a worker killed while it waits
      // on the fix run must resume at the review AFTER it, or the fix is
      // dispatched twice and the cap is one larger than declared).
      const onLaunch = async (l) => {
        lastFix = { ...lastFix, dispatched: true, runId: (l && (l.runId || l.run_id)) || lastFix.runId || null };
        await saveProgress(gate, { fixes: cycle + 1, attempts, ledger, lastFix });
      };
      let fixed = null;
      try {
        fixed = await deps.fix({ gate, cycle, item, findings: outcome.findings || [], evidence: outcome.evidence || "", detail: outcome.detail, ledger, onLaunch });
      } catch (e) {
        fixed = { ok: false, reason: `the fix cycle could not be dispatched: ${(e && e.message) || e}` };
      }
      if (!fixed || !fixed.ok) {
        outcome = {
          passed: false,
          verdict: "failed",
          detail: `${outcome.detail || "gate failed"}; the fix cycle could not run (${(fixed && fixed.reason) || "no response"})`,
          evidence: outcome.evidence,
          findings: outcome.findings,
          noRetry: true,
        };
        attempts.push({ verdict: outcome.verdict, detail: outcome.detail, passed: false });
        break;
      }
      // The tree moved under us: re-read the diff so the next attempt's
      // protected-path and risk-class checks judge what is there NOW.
      await readChanged();
      lastFix = { ...lastFix, dispatched: true, runId: (fixed && fixed.runId) || lastFix.runId || null, toHead: changedHead };
      await saveProgress(gate, { fixes: cycle + 1, attempts, ledger, lastFix });
    }

    if (outcome.passed) {
      await record(gate, { verdict: outcome.verdict, detail: outcome.detail, attempts: shownAttempts(gate, attempts), ledger });
      log(`work: gate ${gate.id} ${outcome.verdict} on ${nodeId}`);
      continue;
    }

    // A blocked human gate is already a person's item — escalating it again
    // would file a second approval for the same question.
    let escalatedTo = outcome.escalatedTo || null;
    if (!escalatedTo && outcome.verdict !== "blocked") {
      try {
        const esc = await deps.escalate({
          gate, item, factory, attempts: shownAttempts(gate, attempts),
          detail: outcome.detail,
          evidence: outcome.evidence || "",
          findings: outcome.findings || [],
          ledger,
        });
        if (esc && esc.ok) escalatedTo = esc.id;
        else log(`work: gate ${gate.id} escalation could not be filed (${(esc && esc.reason) || "no response"})`);
      } catch (e) {
        log(`work: gate ${gate.id} escalation could not be filed (${(e && e.message) || e})`);
      }
    }
    const state = outcome.verdict === "blocked" ? "blocked" : "failed";
    // ATOMIC with the escalation, in that order: with no blocker on the graph
    // there is no demotion (see `demote` above). The status is left exactly as
    // the run left it, the withheld rollback is recorded on the fact, and the
    // pipeline reports `escalation_failed` so the caller can mark the run as a
    // refusal nobody but this box can read — and so an operator is told to
    // re-run the judgement with `spor work --regate <run>` once the graph is
    // writable again.
    const demoted = escalatedTo ? await demote(gate, { state, blockerId: escalatedTo }) : { demoted: false, note: null, reason: null };
    if (!escalatedTo) {
      log(
        `work: gate ${gate.id} refused ${nodeId}, but the escalation that would block it could not be filed — ` +
          `the item's status is left as the run left it; re-run this judgement with 'spor work --regate ${runId}'`
      );
    }
    await record(gate, {
      verdict: outcome.verdict, detail: outcome.detail, evidence: outcome.evidence, attempts: shownAttempts(gate, attempts), escalatedTo, ledger,
      demotion:
        demoted.note ||
        (demoted.reason
          ? `the item could not be demoted on the graph (${demoted.reason})`
          : escalatedTo
          ? null
          : `not attempted — no escalation could be filed to block ${nodeId}, so its status is left as the run left it`),
    });
    log(`work: gate ${gate.id} ${state} on ${nodeId} — ${outcome.detail || "no detail"}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
    return {
      state, gates: results, facts,
      reason:
        `gate '${gate.id}' ${state}: ${outcome.detail || ""}`.trim() +
        (escalatedTo ? "" : " (the escalation could not be filed, so the item's status was left alone)"),
      escalated_to: escalatedTo,
      demoted: demoted.demoted,
      demote_reason: demoted.reason,
      ...(escalatedTo ? {} : { escalation_failed: true }),
    };
  }

  return { state: "passed", gates: results, facts, reason: `${results.length} gate(s) passed` };
}

// ONE attempt at one gate. Returns {passed, verdict, detail, evidence,
// findings, noRetry, escalatedTo}. `noRetry` marks the outcomes a fix cycle
// cannot legitimately address — a protected-path violation (the implementer
// must not be sent back to fix the tests it should not have touched), a
// rejected approval, an unanswered one.
async function runOneGate({ gate, cycle, factory, item, changed, changedReason, deps, log, ledger = [], lastFix = null }) {
  if (gate.kind === "command") {
    if (!changed) {
      return { passed: false, verdict: "failed", detail: changedReason || "the change under judgement could not be read", noRetry: true };
    }
    // FAIL CLOSED, before anything is executed: an implementer branch that
    // edited its own acceptance tests does not get to run them.
    const hits = gates.protectedHits(changed, factory.protectedPaths);
    if (hits.length) {
      let lane = null;
      try {
        const filed = await deps.fileTestLaneItem({ gate, item, paths: hits, profile: factory.testLaneProfile });
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
    let r = null;
    try {
      r = await deps.runSuite({ gate, factory, item, trustedRef: factory.trustedRef, protectedPaths: factory.protectedPaths, armed: armed.classes });
    } catch (e) {
      r = { ok: false, reason: `the gate command could not be run: ${(e && e.message) || e}` };
    } finally {
      if (lease && deps.releaseGateLease) {
        try {
          await deps.releaseGateLease(lease);
        } catch {
          /* best effort — a lease this box could not release lapses on its own */
        }
      }
    }
    if (r && r.ok) {
      return { passed: true, verdict: "passed", detail: `\`${gate.command}\` passed against ${factory.trustedRef}'s copy of the protected paths${armed.classes.length ? ` (armed by ${armed.classes.map((c) => c.class).join(", ")})` : ""}`, evidence: null };
    }
    return {
      passed: false,
      verdict: "failed",
      detail: (r && r.reason) || (r && r.code != null ? `\`${gate.command}\` exited ${r.code}` : "the gate command failed"),
      evidence: failureEvidence((r && r.output) || ""),
    };
  }

  if (gate.kind === "agent-review") {
    // An EMPTY diff is not a clean one (issue-spor-review-gate-empty-diff-
    // vacuous-pass). The first live factory run's implementer landed its
    // commit on the trusted ref itself, so the gate diffed that commit against
    // itself, dispatched a reviewer at nothing, and read back a pass — an
    // unreviewed change laundered into an approval. A review with nothing to
    // judge fails CLOSED and unretried: no fix cycle can produce a diff where
    // the branch carries none, and a person has to look at why it doesn't
    // (self-landed, mis-cut branch, a resolve with no work behind it).
    if (changed && changed.length === 0) {
      return {
        passed: false,
        verdict: "failed",
        noRetry: true,
        detail:
          `the branch carries no committed change against ${factory.trustedRef} — an empty diff has nothing to review,` +
          ` so the gate fails closed rather than passing vacuously (was the work landed on ${factory.trustedRef} directly, or resolved with nothing behind it?)`,
      };
    }
    // The prior set: the blocking findings still open on the ledger. Review N
    // is handed them (and the last fix) and must answer each before it may
    // raise anything new — the protocol lives in gates.parseReviewVerdict.
    const prior = gates.openPriorFindings(ledger);
    // ...and the findings an earlier cycle rated blocking but could not
    // demonstrate: the reviewer may demonstrate one now, by id, without it
    // counting as a goalpost (gates.parseReviewVerdict, `raised`).
    const raised = gates.raisedUndemonstrated(ledger);
    let r = null;
    try {
      r = await deps.review({ gate, cycle, item, factory, prior, raised, ledger, fix: lastFix });
    } catch (e) {
      r = { ok: false, reason: `the review dispatch failed: ${(e && e.message) || e}` };
    }
    if (!r || !r.ok) {
      // An unrun review is not a passed one. The prior set still stands: a
      // review that never ran cleared nothing.
      return { passed: false, verdict: "failed", detail: (r && r.reason) || "the review could not be dispatched", evidence: (r && r.text) || "", findings: prior.map((p) => ({ ...p, origin: "prior", blocking: true, status: "open" })), ledger };
    }
    const v = gates.parseReviewVerdict(r.text, { prior, cycle, raised });
    const next = gates.applyReviewToLedger(ledger, v, cycle);
    v.findings = gates.withLedgerIds(v.findings, next, ledger);
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
      return {
        passed: true,
        verdict: "passed",
        detail: `the review under ${gate.profile} found nothing blocking (verdict: ${v.verdict}${advisory ? `, ${advisory} advisory note${advisory === 1 ? "" : "s"} recorded` : ""})${v.note ? ` — ${v.note}` : ""}`,
        ledger: next,
      };
    }
    const open = v.findings.filter((f) => f.blocking);
    const carried = open.filter((f) => f.origin === "prior").length;
    return {
      passed: false,
      verdict: "failed",
      detail:
        `the review under ${gate.profile} requested changes — ${open.length} blocking finding(s)` +
        (cycle > 0 ? ` (${carried} carried from earlier cycles, ${open.length - carried} new)` : "") +
        (v.error ? `; ${v.error}` : ""),
      findings: v.findings,
      evidence: gates.renderFindings(v.findings) || tailBytes(r.text || ""),
      ledger: next,
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
    filed = await deps.fileHumanItem({ gate, item, factory, classes: armed.classes });
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
  const deadline = (deps.now ? deps.now() : Date.now()) + gate.approvalTimeoutMs;
  for (;;) {
    let state = null;
    try {
      state = await deps.checkApproval({ id: filed.id, gate, item });
    } catch (e) {
      state = { state: "pending", reason: `${(e && e.message) || e}` };
    }
    if (state && state.state === "approved") {
      return { passed: true, verdict: "passed", detail: `approved by ${state.by || "a person"} on ${filed.id}` };
    }
    if (state && state.state === "rejected") {
      return { passed: false, verdict: "failed", noRetry: true, escalatedTo: filed.id, detail: `the approval on ${filed.id} was refused${state.by ? ` by ${state.by}` : ""}` };
    }
    const at = deps.now ? deps.now() : Date.now();
    if (at >= deadline || deps.stopping?.()) {
      return {
        passed: false,
        verdict: "blocked",
        noRetry: true,
        escalatedTo: filed.id,
        detail: `waiting on the human approval item ${filed.id}${armed.classes.length ? ` (risk: ${armed.classes.map((c) => c.class).join(", ")})` : ""} — the resolve stays blocked until it is answered`,
      };
    }
    await deps.sleep(Math.min(gate.pollMs, Math.max(1, deadline - at)));
  }
}

module.exports = {
  runGatePipeline,
  gateIdSuffix,
  fenceSafe,
  capBytes,
  NODE_BODY_CAP_BYTES,
  gateChangeSet,
  prepareGateTree,
  forceProtectedPaths,
  runGateCommand,
  runOneGate,
  buildGateFact,
  gateFactId,
  tailBytes,
  failureEvidence,
  gateRunKey,
  shortRunAttempt,
};
