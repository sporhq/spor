// The pipeline as ONE workflow function (lib/shell/pipeline-workflow.js,
// task-spor-fold-gate-and-integration-into-one-workflow): the glue between
// the three stage workflows — the stamps, the completion writes, the settle —
// is a deterministic function over one journal. These rows drive it with
// fake activities: a crash at every activity boundary resumes to the same
// result and the same side effects; a child's interrupted hand-up is a
// durable yield the re-drive continues past; the regate child's key is a
// journaled input of the parent; the binding is read from the journal.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const pw = require("../lib/shell/pipeline-workflow.js");
const { Execution, fakeClock, journalVersion } = require("../lib/kernel/workflow.js");
const stageProjection = require("../lib/shell/stage-projection.js");

const ITEM = { run_id: "run-pipe-1", node_id: "task-demo", attempt: 0 };
const BINDING = { controller: true, boundary: "integration", hasImplementation: true, hasIntegration: true, reconcileLanded: true, factoryDigest: "sha256:f" };

// Fake deps recording every call. `script` overrides a stage's successive
// results (one per pass).
function fakes(script = {}) {
  const calls = [];
  const next = (name, fallback) => {
    const q = script[name];
    if (Array.isArray(q) && q.length) return q.length > 1 ? q.shift() : q[0];
    return fallback;
  };
  const deps = {
    open: (args) => { calls.push(["open"]); return { ...args, opened_at: "2026-10-04T00:00:00.000Z" }; },
    implementation: (args) => { calls.push(["implementation", args.stage, args.pass]); return next("implementation", { state: "candidate", handoff: null }); },
    withdraw: (args) => { calls.push(["withdraw", args.reason]); return { ok: true }; },
    gates: (args) => { calls.push(["gates", args.stage, args.pass]); return next("gates", { state: "passed", gates: ["acceptance"], facts: ["art-gate-1"], head: "h1" }); },
    stampGatesState: (args) => { calls.push(["stampGatesState", args.state]); return { ok: true }; },
    completeAtGates: () => { calls.push(["completeAtGates"]); return { ok: true, settled: "written" }; },
    integrationStart: () => { calls.push(["integrationStart"]); return { ok: true }; },
    integration: (args) => {
      calls.push(["integration", args.stage, args.pass, args.regate]);
      return next("integration", { intResult: { state: "passed", facts: ["art-merge-1"], landed_sha: "l1", target_ref: "main", target_sha: "t0" }, gateResult: args.gateResult, gateFacts: args.gateFacts });
    },
    stampIntegrationState: (args) => { calls.push(["stampIntegrationState", args.intResult.state]); return { state: args.intResult.state === "passed" ? "landed" : args.intResult.state }; },
    completeAtIntegration: () => { calls.push(["completeAtIntegration"]); return { ok: true, settled: "written" }; },
    reconcileLanded: (args) => { calls.push(["reconcileLanded", args.landedSha]); return { ok: true }; },
    leave: (args) => { calls.push(["leave", args.result.state]); return { ...args.result, attestation: "art-attest-1" }; },
  };
  return { deps, calls };
}

// Drive to a settled result over a shared journal array, crashing on the
// n-th EXECUTED activity when `crashNth` is given (the kernel's seam), then
// resuming over the same journal with fresh deps.
async function driveOnce({ journal, deps, clock, crashNth = null, binding = BINDING, item = ITEM }) {
  const activities = pw.bindPipelineActivities(deps);
  const exec = new Execution(pw.pipelineWorkflow, { item, binding, log: () => {} }, {
    journal, clock, activities, workflow: pw.WORKFLOW_NAME, version: pw.WORKFLOW_VERSION,
    crashPlan: crashNth ? { at: "before-journal", nth: crashNth } : null,
  });
  return exec.run();
}

test("the full pipeline — implementation, gates, completion at the boundary, integration, settle — runs every activity once and journals its closing entry", async () => {
  const { deps, calls } = fakes();
  const journal = [];
  const r = await driveOnce({ journal, deps, clock: fakeClock(1000) });
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  assert.equal(r.result.attestation, "art-attest-1");
  assert.deepEqual(calls.map((c) => c[0]), ["open", "implementation", "gates", "stampGatesState", "integrationStart", "integration", "stampIntegrationState", "completeAtIntegration", "reconcileLanded", "leave"]);
  // The completion at `integration` boundary, not `gates`.
  assert.ok(!calls.some((c) => c[0] === "completeAtGates"));
  // The child journal names are the `open` entry's, and the regate child's
  // key is a JOURNALED input handed to the integration activity.
  const open = journal.find((e) => e.kind === "effect" && /\/open$/.test(e.key)).result;
  assert.deepEqual(open.stages, { implementation: "implementation-a0", gates: "gates-a0", integration: "integration-a0", regate: { prefix: "gates-regate-", attempt: 0 } });
  assert.deepEqual(calls.find((c) => c[0] === "integration")[3], { prefix: "gates-regate-", attempt: 0 });
  assert.deepEqual(journalVersion(journal), { workflow: pw.WORKFLOW_NAME, version: pw.WORKFLOW_VERSION, spec: 1 });
  // The projection reads the parent journal like any stage's.
  const p = stageProjection.projectJournal(journal, stageProjection.parseStageName("pipeline-a0"));
  assert.equal(p.kind, "pipeline");
  assert.equal(p.status, "settled");
  assert.equal(p.state, "passed");
  assert.equal(p.opened_at, "2026-10-04T00:00:00.000Z");
});

test("CRASH SWEEP: a crash at every activity boundary resumes over the same journal to the same result, executing each activity exactly once in total", async () => {
  const reference = fakes();
  await driveOnce({ journal: [], deps: reference.deps, clock: fakeClock(1000) });
  const total = reference.calls.length;
  for (let nth = 1; nth <= total; nth += 1) {
    const journal = [];
    const first = fakes();
    const crashed = await driveOnce({ journal, deps: first.deps, clock: fakeClock(1000), crashNth: nth });
    assert.equal(crashed.status, "crashed", `crash plan ${nth} fired`);
    const second = fakes();
    const resumed = await driveOnce({ journal, deps: second.deps, clock: fakeClock(2000) });
    assert.equal(resumed.status, "completed", `resumed after crash ${nth}`);
    assert.equal(resumed.result.state, "passed");
    // The at-least-once window: the crashed activity ran once before the
    // crash and once more on resume; every other activity exactly once.
    const names = [...first.calls, ...second.calls].map((c) => c[0]);
    const counts = names.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
    for (const [name, n] of counts) assert.ok(n <= 2, `${name} ran ${n} times after a crash at ${nth}`);
    assert.equal(names.length, total + 1, `crash ${nth}: ${names.join(",")}`);
    assert.deepEqual([...new Set(names)].sort(), [...new Set(reference.calls.map((c) => c[0]))].sort());
  }
});

test("a child's INTERRUPTED hand-up is a durable yield: the parent journals it, suspends on a timer, and the re-drive runs the stage's next pass over the same journal", async () => {
  const clock = fakeClock(1000);
  const { deps, calls } = fakes({ gates: [{ state: "interrupted", gates: [], facts: [], reason: "flake evidence pending", paused_until: null }, { state: "passed", gates: ["acceptance"], facts: ["art-gate-1"], head: "h1" }] });
  const journal = [];
  const first = await driveOnce({ journal, deps, clock });
  assert.equal(first.status, "suspended");
  assert.equal(first.kind, "timer");
  assert.equal(first.detail.meta.parked.state, "interrupted", "the parked result rides the Suspend's meta for the driver");
  assert.match(first.detail.meta.parked.reason, /flake evidence pending/);
  // Parked, and due one tick later: the parent's yield is paced by its
  // children's (the loop reads the latest open stage's due).
  const parked = stageProjection.projectJournal(journal, stageProjection.parseStageName("pipeline-a0"));
  assert.equal(parked.status, "parked");
  assert.equal(parked.state, "interrupted");
  assert.equal(parked.due, 1000 + pw.YIELD_MS);
  assert.equal(parked.reoffers, 1);
  // Not yet due: the same suspension, nothing executed.
  const before = calls.length;
  const again = await driveOnce({ journal, deps, clock });
  assert.equal(again.status, "suspended");
  assert.equal(calls.length, before, "a re-drive before the timer executes nothing");
  clock.advanceBy(5);
  const second = await driveOnce({ journal, deps, clock });
  assert.equal(second.status, "completed");
  assert.equal(second.result.state, "passed");
  assert.deepEqual(calls.filter((c) => c[0] === "gates").map((c) => c[2]), [0, 1], "pass 0 interrupted, pass 1 judged — the implementation stage was not re-run");
  assert.equal(calls.filter((c) => c[0] === "implementation").length, 1);
});

test("an INTERRUPTED implementation stage is handed up in the pipeline's refusal shape; an UNROUTABLE one withdraws the hold and settles failed without a gate", async () => {
  const stopped = fakes({ implementation: [{ state: "interrupted", reason: "the worker was asked to stop", attempts: [] }] });
  const r = await driveOnce({ journal: [], deps: stopped.deps, clock: fakeClock(1000) });
  assert.equal(r.status, "suspended");
  assert.equal(r.detail.meta.parked.state, "interrupted");
  assert.equal(r.detail.meta.parked.stage, "interrupted");
  assert.deepEqual(r.detail.meta.parked.gates, []);
  assert.match(r.detail.meta.parked.reason, /^implementation stage interrupted: the worker was asked to stop/);

  const unroutable = fakes({ implementation: [{ state: "unroutable", reason: "no adapter" }] });
  const journal = [];
  const u = await driveOnce({ journal, deps: unroutable.deps, clock: fakeClock(1000) });
  assert.equal(u.status, "completed");
  assert.equal(u.result.state, "failed");
  assert.equal(u.result.stage, "unroutable");
  assert.deepEqual(unroutable.calls.map((c) => c[0]), ["open", "implementation", "withdraw"], "no gate ran, the hold was withdrawn");
  assert.equal(stageProjection.projectJournal(journal, stageProjection.parseStageName("pipeline-a0")).state, "failed");
});

test("the binding is read from the journal: a replay under a live factory that now declares no integration still branches as the recording did", async () => {
  const { deps, calls } = fakes();
  const journal = [];
  const crashed = await driveOnce({ journal, deps, clock: fakeClock(1000), crashNth: 6 }); // crash on `integration`
  assert.equal(crashed.status, "crashed");
  // The live binding no longer declares integration — the journaled one does.
  const second = fakes();
  const r = await driveOnce({ journal, deps: second.deps, clock: fakeClock(2000), binding: { ...BINDING, hasIntegration: false } });
  assert.equal(r.status, "completed");
  assert.ok(second.calls.some((c) => c[0] === "integration"), "the integration activity ran: the journaled binding won");
  assert.ok(calls.length >= 6);
});

test("a journal of another workflow version is not continued: the driver logs it and drives the stages over a fresh in-memory journal", async () => {
  const { deps, calls } = fakes();
  const stale = [{ kind: "version", spec: 1, workflow: pw.WORKFLOW_NAME, version: "0" }, { kind: "effect", key: "run-pipe-1/pipeline/a0/open", result: {} }];
  const lines = [];
  const res = await pw.drivePipeline({ item: ITEM, binding: BINDING, deps: { ...deps, workflowJournal: () => ({ journal: stale, persist: () => {} }) }, log: (l) => lines.push(l) });
  assert.equal(res.state, "passed");
  assert.ok(lines.some((l) => /cannot be continued by this worker/.test(l)), lines.join("\n"));
  assert.deepEqual(calls.map((c) => c[0]).slice(0, 2), ["open", "implementation"]);
  assert.equal(stale.length, 2, "the stale journal was not appended to");
});

test("the driver hands a yield's parked result up as the pipeline's interrupted result", async () => {
  const { deps } = fakes({ gates: [{ state: "interrupted", gates: [], facts: [], reason: "paused", paused_until: "2030-01-01T00:00:00.000Z", paused_profile: "profile-review" }] });
  const journal = [];
  const res = await pw.drivePipeline({ item: ITEM, binding: BINDING, deps: { ...deps, workflowJournal: () => ({ journal, persist: () => {} }), now: () => 1000 } });
  assert.equal(res.state, "interrupted");
  assert.equal(res.paused_profile, "profile-review");
  const p = stageProjection.projectJournal(journal, stageProjection.parseStageName("pipeline-a0"));
  assert.equal(p.status, "parked");
  assert.equal(p.due, Date.parse("2030-01-01T00:00:00.000Z"), "a reviewer pause's own wake IS the timer");
});

test("stageNames spells every child journal for an attempt, the regate child as a prefix plus the attempt", () => {
  assert.deepEqual(pw.stageNames(2), { implementation: "implementation-a2", gates: "gates-a2", integration: "integration-a2", regate: { prefix: "gates-regate-", attempt: 2 } });
  assert.equal(stageProjection.parseStageName("pipeline-a3").kind, "pipeline");
  assert.equal(stageProjection.parseStageName("gates-regate-abc123-a3").kind, "gates-regate");
  assert.equal(pw.PIPELINE_ACTIVITIES.length, 14);
  for (const [name] of pw.PIPELINE_ACTIVITIES) assert.ok(typeof pw.bindPipelineActivities(fakes().deps)[name] === "function", name);
});
