// Every gate-pipeline stamp goes through the pipeline LEASE's `own` door
// (issue-spor-gate-stamps-bypass-lease-owner). Slice 4 made the lease in
// `pipeline.jsonl` the ownership contract, so a driver displaced by a
// takeover — worker A's lease expired while its pass stalled, worker B claimed
// the pipeline — must land NOTHING on the record B is now driving: not A's
// settled verdict (the loop's markGate, and runGateAndIntegration's own
// settle), not the integration fix cycle's launch stamp, not the proposal's
// park stamp. Each is driven here against a real run record and a real lease
// log; the static half (no unowned stampGateState call outside a listed
// non-pipeline caller) is R9 of test/record-write-lint.test.js.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gateDeps = require("../lib/shell/gate-deps.js");
const work = require("../lib/shell/work.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const sp = require("../lib/shell/stage-projection.js");
const { loadConfig } = require("../lib/config.js");

const RUN = "99999999-aaaa-bbbb-cccc-dddddddddddd";

function scratchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-stamp-owner-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function cfgFor(home) {
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
}

function fakeHost(overrides = {}) {
  const host = { GATE_DIFF_CAP_BYTES: 48 * 1024 };
  for (const name of gateDeps.HOST_FUNCTIONS) {
    host[name] = () => {
      throw new Error(`unexpected host call: ${name}`);
    };
  }
  return { ...host, ...overrides };
}

// A terminal run whose pipeline worker A claimed at t0, whose lease then
// EXPIRED (A's pass stalled past the TTL), and which worker B — live — then
// claimed. Returns both tokens and the record path.
function takenOver(home) {
  const file = dispatchRuns.runPaths(home, RUN).record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ run_id: RUN, node_id: "task-x", state: "done", terminal_state: "resolved", cwd: "/tmp/the-run-checkout" }));
  const t0 = Date.now() - 2 * sp.PIPELINE_LEASE_TTL_MS;
  const a = dispatchRuns.claimPipeline(home, RUN, { workerId: "worker-a", factory: "factory-test", ownerLive: () => true, nowMs: () => t0 });
  assert.strictEqual(a.ok, true, a.refused);
  const b = dispatchRuns.claimPipeline(home, RUN, { workerId: "worker-b", factory: "factory-test", ownerLive: () => true });
  assert.strictEqual(b.ok, true, `an expired lease is taken over: ${b.refused}`);
  assert.notStrictEqual(a.token, b.token);
  assert.strictEqual(sp.pipelineLease(home, { run_id: RUN }).token, b.token, "B holds the lease now");
  return { file, a: a.token, b: b.token };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const GATE_FIELDS = (rec) => Object.fromEntries(Object.entries(rec).filter(([k]) => k.startsWith("gate_")));

test("the loop's settle (markGate) is one owned CAS: A's verdict is refused once B holds the lease, B's lands, and a run with no claim stamps nothing over a claimed one", (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const before = GATE_FIELDS(read(file));
  work.stampLoopVerdict(home, RUN, { gate_state: "failed", gate_reason: "A's stalled pass failed", gate_worker: "worker-a" }, a);
  assert.deepStrictEqual(GATE_FIELDS(read(file)), before, "A's verdict did not land over B's live pipeline");
  // No token at all (a pass that threw before it claimed): a claimed record is not its to settle.
  work.stampLoopVerdict(home, RUN, { gate_state: "failed", gate_reason: "unclaimed" }, undefined);
  assert.deepStrictEqual(GATE_FIELDS(read(file)), before, "an unowned verdict never lands on a claimed pipeline");
  // The holder's own verdict lands.
  work.stampLoopVerdict(home, RUN, { gate_state: "blocked", gate_reason: "B escalated", gate_worker: "worker-b" }, b);
  assert.strictEqual(read(file).gate_state, "blocked");
  assert.strictEqual(read(file).gate_worker, "worker-b");
  // ...and an already-settled verdict is left as it reads, even by its owner
  // (runGateAndIntegration's settle went first; the loop's is the second writer).
  work.stampLoopVerdict(home, RUN, { gate_state: "failed", gate_reason: "late second writer" }, b);
  assert.strictEqual(read(file).gate_state, "blocked");
  assert.strictEqual(read(file).gate_reason, "B escalated");
});

test("an unclaimed run still takes the loop's unowned verdict (a pass that threw before any claim)", (t) => {
  const home = scratchHome(t);
  const file = dispatchRuns.runPaths(home, RUN).record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ run_id: RUN, node_id: "task-x", state: "done" }));
  work.stampLoopVerdict(home, RUN, { gate_state: "failed", gate_reason: "the gate pipeline threw" }, undefined);
  assert.strictEqual(read(file).gate_state, "failed");
});

test("runGateAndIntegration's settle (settleRunRecord) under A's displaced token is refused and reports not landed", (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const sporCli = require("../bin/spor.js");
  const lost = sporCli.settleRunRecord(home, RUN, { state: "failed", reason: "A's stalled pass" }, "worker-a", { token: a });
  assert.strictEqual(lost.landed, false);
  assert.strictEqual(read(file).gate_state, undefined, "nothing settled over B");
  const won = sporCli.settleRunRecord(home, RUN, { state: "passed" }, "worker-b", { token: b });
  assert.strictEqual(won.landed, true);
  assert.strictEqual(read(file).gate_state, "passed");
});

test("the integration fix cycle's launch stamp (gate_fix_*) under A's displaced token is refused: nothing lands and the dispatch half throws", async (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const { makeIntegrationDeps } = gateDeps.createGateDeps(fakeHost({ gateStem: (id) => id, launchedFixRun: () => null }));
  const make = (gateOwner) =>
    makeIntegrationDeps(cfgFor(home), {
      record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
      factory: { id: "factory-test", trustedRef: "main", integration: { targetRef: "main", mode: "local", strategy: "merge", command: "npm test", cycles: 2 } },
      passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
      dispatch: async () => ({ ok: true, run: { run_id: `int-fix-${gateOwner}` } }),
    });
  await assert.rejects(make(a).dispatchFix({ cycle: 0, kind: "conflict", detail: "CONFLICT in a.txt" }), /settled or its owner changed/);
  assert.strictEqual(read(file).gate_fix_run_id, undefined, "A's fix launch is not stamped onto B's record");
  const ok = await make(b).dispatchFix({ cycle: 0, kind: "conflict", detail: "CONFLICT in a.txt" });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(read(file).gate_fix_run_id, `int-fix-${b}`);
  assert.strictEqual(read(file).gate_fix_gate, "integration");
});

test("the proposal's park stamp (gate_proposal_*) under A's displaced token is refused: nothing lands and the park throws", async (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const { makeIntegrationDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id,
      proposalTrackingId: (nodeId, runId) => `task-proposal-${nodeId}-${String(runId).slice(0, 8)}`,
      buildProposalTrackingNode: ({ id }) => `---\nid: ${id}\n---\n`,
      writeGateNode: async () => ({ ok: true }),
      mainCheckoutOf: (dir) => dir,
    })
  );
  const make = (gateOwner) =>
    makeIntegrationDeps(cfgFor(home), {
      record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
      factory: { id: "factory-test", trustedRef: "main", integration: { targetRef: "origin/main", mode: "propose", strategy: "merge", command: "npm test", cycles: 2 } },
      slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
    });
  const proposal = { number: 42, repo: "o/r", url: "https://example.invalid/pr/42", branch: "impl", targetSha: "abc123" };
  await assert.rejects(make(a).parkForReview({ proposal }), /settled or its owner changed/);
  assert.strictEqual(read(file).gate_proposal_number, undefined, "A's park is not stamped onto B's record");
  const parked = await make(b).parkForReview({ proposal });
  assert.strictEqual(parked.ok, true);
  assert.strictEqual(read(file).gate_proposal_number, 42);
  assert.strictEqual(read(file).gate_proposal_blocker, parked.id);
});

test("the gate deps' fix-launch stamp (stampLaunch) under A's displaced token is refused too", (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  assert.throws(() => gateDeps.stampPipelineLaunch(home, RUN, a, { gate_fix_run_id: "fix-a" }), /owner changed/);
  assert.throws(() => gateDeps.stampPipelineLaunch(home, RUN, null, { gate_fix_run_id: "fix-unowned" }), /owner changed/, "no owner never stamps a claimed pipeline");
  assert.strictEqual(read(file).gate_fix_run_id, undefined);
  gateDeps.stampPipelineLaunch(home, RUN, b, { gate_fix_run_id: "fix-b" });
  assert.strictEqual(read(file).gate_fix_run_id, "fix-b");
  // A run with no record at all has no holder to protect: a no-op, never a throw.
  assert.strictEqual(gateDeps.stampPipelineLaunch(home, "no-such-run", a, { gate_fix_run_id: "x" }), null);
});
