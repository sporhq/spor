// The pipeline's `leave` activity is idempotent per lease token
// (issue-spor-slice5-leave-not-idempotent-and-regate-stamps-unowned). `leave`
// settles the run record, writes the attestation and stamps it — one journaled
// activity, so a pass whose settle LANDED but whose `leave` journal entry never
// did re-runs it. The re-run must change nothing durable: the verdict's time is
// the workflow's journaled clock read (`…/leave/now`), the settle of a record
// already carrying this token's verdict returns it unchanged (no re-stamp that
// would re-arm `gate_attestation_pending`/`_missing` over a written node), and
// the attestation is not re-published.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const sporCli = require("../bin/spor.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { loadConfig } = require("../lib/config.js");
const { gitEnv } = require("./helpers/git.js");

const RUN = "11111111-2222-3333-4444-0000000000c5";

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
}

function repo(t) {
  const dir = scratch(t, "spor-leave-replay-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "trusted\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "branch");
  fs.writeFileSync(path.join(dir, "b.txt"), "the work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "branch work");
  return dir;
}

test("settleRunRecord under a token whose verdict the record already carries returns it unchanged — no re-stamp, the first settle's time stands", (t) => {
  const home = scratch(t, "spor-leave-replay-");
  const file = dispatchRuns.runPaths(home, RUN).record;
  dispatchRuns.atomicJson(file, { run_id: RUN, node_id: "task-x", state: "done" });
  const claim = dispatchRuns.claimPipeline(home, RUN, { workerId: "w", factory: "factory-test" });
  assert.equal(claim.ok, true, claim.refused);
  const first = sporCli.settleRunRecord(home, RUN, { state: "passed" }, "w", { token: claim.token, at: Date.parse("2026-10-04T10:00:00.000Z") });
  assert.equal(first.landed, true);
  assert.equal(first.already, undefined);
  assert.equal(dispatchRuns.readJson(file).gate_at, "2026-10-04T10:00:00.000Z", "the settle writes the caller's journaled time");
  // The attestation lands and clears its debt, as writeRunAttestation does.
  dispatchRuns.stampGateState(home, RUN, { gate_attestation: "art-attest-x", gate_attestation_missing: false, gate_attestation_pending: null }, { own: claim.token });
  const before = fs.readFileSync(file, "utf8");
  const again = sporCli.settleRunRecord(home, RUN, { state: "passed" }, "w", { token: claim.token, at: Date.parse("2026-10-04T11:00:00.000Z"), pending: { built: { id: "art-attest-x" } } });
  assert.equal(again.landed, true);
  assert.equal(again.already, true);
  assert.equal(again.at, "2026-10-04T10:00:00.000Z");
  assert.equal(fs.readFileSync(file, "utf8"), before, "the record is byte-identical: no fresh gate_at, no re-armed attestation debt");
});

test("a crash between the settle and the `leave` journal entry replays to the same record: the journaled settle time, no re-stamp, no second attestation write", async (t) => {
  const home = scratch(t, "spor-leave-replay-home-");
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-leave.md"), "---\nid: task-leave\ntype: task\ntitle: Leave replay\nsummary: A work item whose pipeline's leave activity is replayed after a crash.\nstatus: done\ndate: 2026-10-04\n---\n\nBody.\n");
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
  const dir = repo(t);
  const entry = { node_id: "task-leave", run_id: RUN, attempt: 0 };
  const recordPath = dispatchRuns.runPaths(home, RUN).record;
  dispatchRuns.atomicJson(recordPath, { run_id: RUN, node_id: entry.node_id, state: "done", cwd: dir, created_at: new Date().toISOString() });
  const factory = {
    id: "factory-leave", trustedRef: "main", protectedPaths: [], riskClasses: {}, testLaneProfile: null, integration: null,
    gates: [{ id: "acceptance", kind: "command", command: "true", timeoutMs: 60000, cycles: 0, source: "inline", risk: [] }],
    definition: { factory: { id: "factory-leave", revision: null, digest: "sha256:0000" }, gates: [{ id: "acceptance", source: "inline", revision: null, digest: "sha256:1111" }] },
  };
  const leaveKey = `"key":"${RUN}/pipeline/a0/leave"`;
  // Fail the persist of the `leave` activity's result ONCE (the crash window:
  // the settle and the attestation have landed, the journal has not), then
  // observe every durable write that follows: record renames and attestation
  // node writes.
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  const origLink = fs.linkSync;
  let injected = null;
  const after = { recordWrites: 0, attestWrites: 0 };
  fs.writeFileSync = function (target, data, ...rest) {
    if (!injected && typeof target === "number" && typeof data === "string" && data.includes(leaveKey) && data.includes('"kind":"effect"')) {
      injected = { record: JSON.parse(fs.readFileSync(recordPath, "utf8")) };
      throw Object.assign(new Error("ENOSPC: no space left on device (injected)"), { code: "ENOSPC" });
    }
    if (injected && typeof target === "string" && path.basename(target).startsWith("art-attest-")) after.attestWrites += 1;
    return origWrite.call(fs, target, data, ...rest);
  };
  fs.renameSync = function (from, to, ...rest) {
    if (injected && to === recordPath) after.recordWrites += 1;
    if (injected && typeof to === "string" && path.basename(to).startsWith("art-attest-")) after.attestWrites += 1;
    return origRename.call(fs, from, to, ...rest);
  };
  fs.linkSync = function (from, to, ...rest) {
    if (injected && typeof to === "string" && path.basename(to).startsWith("art-attest-")) after.attestWrites += 1;
    return origLink.call(fs, from, to, ...rest);
  };
  const logs = [];
  let res;
  try {
    res = await sporCli.runGateAndIntegration(cfg, entry, { cwd: dir, run_id: RUN }, {
      factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: (l) => logs.push(l), home, stopping: () => false,
    });
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
    fs.linkSync = origLink;
  }
  assert.ok(injected, "the leave entry's persist was reached and failed once");
  assert.ok(logs.some((l) => /pipeline workflow journal .* could not be written .* re-opening/.test(l)), `the driver re-opened the journal and replayed (logs: ${logs.join(" | ")})`);
  assert.equal(res.state, "passed", res.reason);
  assert.ok(res.attestation, "the replayed leave reports the attestation the first run wrote");
  assert.equal(after.recordWrites, 0, "the replayed leave re-stamped nothing on the run record");
  assert.equal(after.attestWrites, 0, "the replayed leave re-published no attestation");
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.deepEqual(rec, injected.record, "the record after the replay is the record the crashed run left");
  assert.equal(rec.gate_attestation, res.attestation);
  assert.equal(rec.gate_attestation_missing, false);
  assert.equal(rec.gate_attestation_pending, null);
  // The settle's time is the journaled clock read.
  const journal = fs.readFileSync(path.join(dispatchRuns.runPaths(home, RUN).workflows, "pipeline-a0.workflow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const nowEntry = journal.find((e) => e.kind === "now" && e.key === `${RUN}/pipeline/a0/leave/now`);
  assert.ok(nowEntry, "the leave's clock read is journaled");
  assert.equal(rec.gate_at, new Date(nowEntry.at).toISOString());
  assert.equal(journal.filter((e) => e.kind === "effect" && e.key === `${RUN}/pipeline/a0/leave`).length, 1, "leave is journaled once, by the replay");
});

// The activity sweep's one other replay hazard: a fix/rescue dispatch activity
// re-executed after a crash adopts its run by name and re-stamps the launch —
// which must keep the first stamp's time, since the replay launched nothing.
test("stampPipelineLaunch re-made for the run the record already names keeps the first launch time; a new run takes the new time", (t) => {
  const { stampPipelineLaunch } = require("../lib/shell/gate-deps.js");
  const home = scratch(t, "spor-leave-replay-launch-");
  const file = dispatchRuns.runPaths(home, RUN).record;
  dispatchRuns.atomicJson(file, { run_id: RUN, node_id: "task-x", state: "done" });
  const claim = dispatchRuns.claimPipeline(home, RUN, { workerId: "w", factory: "factory-test" });
  assert.equal(claim.ok, true, claim.refused);
  stampPipelineLaunch(home, RUN, claim.token, { gate_fix_run_id: "fix-1", gate_fix_at: "2026-10-04T10:00:00.000Z", gate_fix_gate: "g", gate_fix_cycle: 1 });
  stampPipelineLaunch(home, RUN, claim.token, { gate_fix_run_id: "fix-1", gate_fix_at: "2026-10-04T12:00:00.000Z", gate_fix_gate: "g", gate_fix_cycle: 1 });
  assert.equal(dispatchRuns.readJson(file).gate_fix_at, "2026-10-04T10:00:00.000Z", "the adopted run's launch time stands");
  stampPipelineLaunch(home, RUN, claim.token, { gate_fix_run_id: "fix-2", gate_fix_at: "2026-10-04T13:00:00.000Z", gate_fix_gate: "g", gate_fix_cycle: 2 });
  assert.equal(dispatchRuns.readJson(file).gate_fix_at, "2026-10-04T13:00:00.000Z", "a different run is a new launch");
});

// completeAtGates/completeAtIntegration are journaled activities too: a re-run
// after the completion's CAS landed reads the item terminal with no hold, and
// must return the recorded settlement — never CONSUME over a written
// completion (a fresh completion_consumed_at, an `ended` report).
test("writeCompletion on a record whose completion already settled returns that settlement and writes nothing", async () => {
  const completionShell = require("../lib/shell/completion.js");
  const calls = [];
  const reports = [];
  const execution = { completed: async (resolver) => reports.push(["completed", resolver]), ended: async (why) => reports.push(["ended", why]) };
  const deps = new Proxy({}, { get: (_t, name) => (name === "execution" ? execution : (...args) => { calls.push(name); throw new Error(`unexpected ${String(name)}(${JSON.stringify(args).slice(0, 80)})`); }) });
  const base = { node_id: "task-x", run_id: RUN, impl_claim: { execution_id: "exec-1", completion: { by: "controller", after: "gates" } } };
  assert.deepEqual(await completionShell.writeCompletion({ record: { ...base, completion_written_at: "2026-10-04T10:00:00.000Z", completion_resolver: "art-completion-x" }, deps, boundary: "gates" }), { ok: true, settled: "written", resolver: "art-completion-x", already: true });
  assert.deepEqual(await completionShell.writeCompletion({ record: { ...base, completion_consumed_at: "2026-10-04T10:00:00.000Z" }, deps, boundary: "gates" }), { ok: true, settled: "consumed", already: true });
  assert.deepEqual(await completionShell.writeCompletion({ record: { ...base, completion_withdrawn_at: "2026-10-04T10:00:00.000Z" }, deps, boundary: "gates" }), { ok: true, settled: "withdrawn", already: true });
  assert.deepEqual(calls, [], "no stamp, read or write");
  assert.deepEqual(reports, [["completed", "art-completion-x"]], "only the written completion's idempotent `completed` report is re-sent — never `ended`");
});
