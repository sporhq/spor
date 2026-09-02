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
//
// Commit-bound and definition-bound (task-spor-factory-gate-attestation): the
// fact names the head it judged (`gate_head`/`gate_base` in the frontmatter,
// machine-readable; the trusted ref and its sha in the body) and the digests of
// the factory and gate definitions that judged it, so a later reader — the
// integration stage's head-equality check, a CI validate-attestation job — can
// tell WHAT was judged and BY WHICH rules rather than trusting the verdict word.
function buildGateFact({ gate, nodeId, runId, project, verdict, detail, evidence, attempts, escalatedTo, demotion, date, factory, attempt = 0, change = null, definition = null }) {
  const id = gateFactId(gate.id, nodeId, runId, attempt);
  const passed = verdict === "passed" || verdict === "skipped";
  const head = change && change.head ? String(change.head) : null;
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
    ...(head ? [`gate_head: ${head}`] : []),
    ...(base ? [`gate_base: ${base}`] : []),
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(escalatedTo ? [`  - {type: relates-to, to: ${escalatedTo}}`] : []),
    "---",
    "",
    `The \`${gate.kind}\` gate \`${gate.id}\`${gate.source && gate.source !== "inline" ? ` (from the shared gate node \`${gate.source}\`)` : ""}`,
    `${passed ? "passed" : verdict === "blocked" ? "is blocking" : "failed"} for dispatched run \`${runId}\` on ${nodeId}${factory ? `, under factory \`${factory}\`` : ""}${Number(attempt) > 1 ? ` (re-gate, attempt ${Number(attempt)})` : ""}.`,
    "",
    ...provenance,
    "",
    detail ? `Outcome: ${detail}` : "",
    escalatedTo ? `Escalated to ${escalatedTo}.` : "",
    demotion ? `Demotion: ${oneLine(demotion, 300)}` : "",
    "",
    ...(attempts && attempts.length > 1
      ? ["Cycles:", ...attempts.map((a, i) => `${i + 1}. ${a.verdict} — ${oneLine(a.detail || "", 200)}`), ""]
      : []),
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
    return { ok: false, reason: `the run left uncommitted changes to tracked files in ${cwd} — a gate judges committed work, so this one cannot judge it at all` };
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
  const trusted = git(cwd, ["rev-parse", "--verify", `${trustedRef}^{commit}`]);
  const trustedSha = trusted.status === 0 ? (trusted.stdout || "").trim() : null;
  const branchOut = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = branchOut.status === 0 ? (branchOut.stdout || "").trim() : "";
  const branch = branchName && branchName !== "HEAD" ? branchName : null;
  return { ok: true, paths, head: headSha, base: baseSha, trustedRef, trustedSha, branch, top: (top.stdout || "").trim(), cwd };
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
async function runGatePipeline({ item, factory, deps, log = () => {} }) {
  const nodeId = item.node_id;
  const runId = item.run_id;
  const now = deps.now || (() => Date.now());
  const results = [];
  const facts = [];
  let changed = null;
  let changedReason = null;
  // The whole change-set read (head/base/trusted sha/branch), not just its
  // paths — every fact and the run record carry it (task-spor-factory-gate-
  // attestation), and the integration stage compares its own re-read against
  // the head the last passing gate judged.
  let change = null;

  // The diff under judgement, read once and refreshed after every fix cycle.
  // A read that FAILS is not an empty diff: an empty list would silently
  // disarm both the protected-path check and every risk class, which is the
  // fail-OPEN direction. So the failure is carried and every path-dependent
  // gate treats it as a gate failure.
  const readChanged = async () => {
    try {
      const r = await deps.changedPaths({ trustedRef: factory.trustedRef });
      if (r && r.ok) {
        changed = r.paths || [];
        change = { head: r.head || null, base: r.base || null, trustedRef: r.trustedRef || factory.trustedRef, trustedSha: r.trustedSha || null, branch: r.branch || null };
        changedReason = null;
        return true;
      }
      changedReason = (r && r.reason) || "the change under judgement could not be read";
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

  const record = async (gate, { verdict, detail, evidence, attempts, escalatedTo, demotion, startedAt = null }) => {
    let factId = null;
    try {
      const fact = buildGateFact({
        gate, nodeId, runId, project: item.project || null, verdict, detail, evidence, attempts, escalatedTo, demotion,
        date: new Date(now()).toISOString().slice(0, 10),
        factory: factory.id,
        attempt: item.attempt || 0,
        change,
        definition: factory.definition || null,
      });
      const wrote = await deps.recordFact({ id: fact.id, markdown: fact.markdown, nodeId, gate, verdict });
      if (wrote && wrote.ok) factId = fact.id;
      else log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
    if (factId) facts.push(factId);
    const defGate = factory.definition && Array.isArray(factory.definition.gates) ? factory.definition.gates.find((g) => g.id === gate.id) : null;
    const finishedAt = now();
    results.push({
      gate: gate.id, kind: gate.kind, verdict, detail: detail || null, fact: factId, escalated_to: escalatedTo || null,
      source: gate.source || "inline",
      digest: (defGate && defGate.digest) || null,
      revision: (defGate && defGate.revision) || null,
      head: change ? change.head : null,
      base: change ? change.base : null,
      cycles: attempts ? attempts.length : 1,
      started_at: startedAt != null ? new Date(startedAt).toISOString() : null,
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: startedAt != null ? Math.max(0, finishedAt - startedAt) : null,
    });
    return factId;
  };

  // What the pipeline hands back beside the verdict: the head/base the LAST
  // read saw (after any fix cycle, i.e. what the final gate judged), the
  // trusted ref and its sha, the branch, and the definition provenance.
  const chain = () => ({
    head: change ? change.head : null,
    base: change ? change.base : null,
    trusted_ref: factory.trustedRef,
    trusted_sha: change ? change.trustedSha : null,
    branch: change ? change.branch : null,
    definition: factory.definition || null,
  });

  for (const gate of factory.gates) {
    const attempts = [];
    let outcome = null;
    const startedAt = now();
    for (let cycle = 0; ; cycle += 1) {
      outcome = await runOneGate({ gate, cycle, factory, item, changed, changedReason, deps, log });
      attempts.push({ verdict: outcome.verdict, detail: outcome.detail });
      if (outcome.passed) break;
      if (outcome.noRetry || gates.cycleDecision(gate, cycle) === "escalate") break;
      log(`work: gate ${gate.id} failed on ${nodeId} — fix cycle ${cycle + 1}/${gate.cycles}`);
      let fixed = null;
      try {
        fixed = await deps.fix({ gate, cycle, item, findings: outcome.findings || [], evidence: outcome.evidence || "", detail: outcome.detail });
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
        attempts.push({ verdict: outcome.verdict, detail: outcome.detail });
        break;
      }
      // The tree moved under us: re-read the diff so the next attempt's
      // protected-path and risk-class checks judge what is there NOW.
      await readChanged();
    }

    if (outcome.passed) {
      await record(gate, { verdict: outcome.verdict, detail: outcome.detail, attempts, startedAt });
      log(`work: gate ${gate.id} ${outcome.verdict} on ${nodeId}`);
      continue;
    }

    // A blocked human gate is already a person's item — escalating it again
    // would file a second approval for the same question.
    let escalatedTo = outcome.escalatedTo || null;
    if (!escalatedTo && outcome.verdict !== "blocked") {
      try {
        const esc = await deps.escalate({
          gate, item, factory, attempts,
          detail: outcome.detail,
          evidence: outcome.evidence || "",
          findings: outcome.findings || [],
        });
        if (esc && esc.ok) escalatedTo = esc.id;
        else log(`work: gate ${gate.id} escalation could not be filed (${(esc && esc.reason) || "no response"})`);
      } catch (e) {
        log(`work: gate ${gate.id} escalation could not be filed (${(e && e.message) || e})`);
      }
    }
    const state = outcome.verdict === "blocked" ? "blocked" : "failed";
    const demoted = await demote(gate, { state, blockerId: escalatedTo });
    await record(gate, {
      verdict: outcome.verdict, detail: outcome.detail, evidence: outcome.evidence, attempts, escalatedTo,
      demotion: demoted.note || (demoted.reason ? `the item could not be demoted on the graph (${demoted.reason})` : null),
      startedAt,
    });
    log(`work: gate ${gate.id} ${state} on ${nodeId} — ${outcome.detail || "no detail"}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
    return {
      state, gates: results, facts,
      reason: `gate '${gate.id}' ${state}: ${outcome.detail || ""}`.trim(),
      escalated_to: escalatedTo,
      demoted: demoted.demoted,
      demote_reason: demoted.reason,
      ...chain(),
    };
  }

  return { state: "passed", gates: results, facts, reason: `${results.length} gate(s) passed`, ...chain() };
}

// ONE attempt at one gate. Returns {passed, verdict, detail, evidence,
// findings, noRetry, escalatedTo}. `noRetry` marks the outcomes a fix cycle
// cannot legitimately address — a protected-path violation (the implementer
// must not be sent back to fix the tests it should not have touched), a
// rejected approval, an unanswered one.
async function runOneGate({ gate, cycle, factory, item, changed, changedReason, deps, log }) {
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
    let r = null;
    try {
      r = await deps.review({ gate, cycle, item, factory });
    } catch (e) {
      r = { ok: false, reason: `the review dispatch failed: ${(e && e.message) || e}` };
    }
    if (!r || !r.ok) {
      // An unrun review is not a passed one.
      return { passed: false, verdict: "failed", detail: (r && r.reason) || "the review could not be dispatched", evidence: (r && r.text) || "" };
    }
    const v = gates.parseReviewVerdict(r.text);
    if (!v.ok) {
      return {
        passed: false,
        verdict: "failed",
        detail: `the review under ${gate.profile} returned no readable verdict (${v.error}) — an unread review is not an approval`,
        evidence: tailBytes(r.text || ""),
      };
    }
    if (v.passed) {
      return { passed: true, verdict: "passed", detail: `the review under ${gate.profile} found nothing blocking (verdict: ${v.verdict})` };
    }
    return {
      passed: false,
      verdict: "failed",
      detail: `the review under ${gate.profile} requested changes — ${v.findings.length} finding(s)`,
      findings: v.findings,
      evidence: gates.renderFindings(v.findings) || tailBytes(r.text || ""),
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
  if (!filed || !filed.ok) {
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
