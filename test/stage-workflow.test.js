// lib/shell/stage-workflow.js — the shared half of every stage workflow driver
// (task-spor-shared-stage-workflow-helper): the live-step binding guard, the
// drive loop with its bounded poisoned re-open, the readings of a kernel
// failure, the refusal record / tags / surface, and the tombstone-then-settle
// policy. The stage suites (integration-workflow, implementation-workflow,
// gate-workflow) prove each stage over it; this file pins the helper's own
// contract so the three cannot drift apart again.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");

const kernel = require("../lib/kernel/workflow.js");
const sw = require("../lib/shell/stage-workflow.js");

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", attempt: 2 };
const clockAt = (t) => ({ now: () => t });

// A workflow over the guarded kernel: `open` journals the binding, then one
// activity, one clock read, one timer. `liveDigest` is read from the input so
// a resume can hand it a different live definition.
async function guardedWorkflow(ctx, input) {
  const opened = await ctx.run("open", "open", { digest: input.digest });
  ctx = sw.guardedKernel(ctx, { journaled: opened.digest, live: input.digest, mismatch: () => sw.definitionMismatchError({ stage: "demo", what: "its block", nodeId: "task-demo", runId: "run-1", journaled: opened.digest, live: input.digest }) });
  const a = await ctx.run("step", "step", {});
  const at = ctx.now("now");
  ctx.sleepUntil("timer", at + 1000);
  return { a, at };
}
const activities = { open: (args) => args, step: () => "ran" };

test("guardedKernel: the binding is checked only before a LIVE step — a settled journal replays to its result under an edited definition, a parked one refuses before its next step is journaled, and a matching definition continues", async () => {
  let t = 1000;
  const clock = { now: () => t };
  // The kernel shares the journal array by reference and calls `persist`
  // beside it; `disk` is the persisted copy the resumes below are read from.
  const disk = [];
  const journal = [];
  const first = new kernel.Execution(guardedWorkflow, { digest: "d1" }, { journal, persist: (e) => disk.push(e), clock, activities, workflow: "demo", version: "1" });
  const r1 = await first.run();
  assert.equal(r1.status, "suspended", JSON.stringify(r1));
  assert.equal(r1.kind, "timer");
  assert.deepEqual(disk, journal);
  const parkedLen = journal.length;

  // Parked on the timer, definition EDITED: the timer is not yet past, so the
  // replay ends on it and nothing live is taken — no refusal, no append.
  const edited = new kernel.Execution(guardedWorkflow, { digest: "d2" }, { journal: journal.slice(), clock, activities, workflow: "demo", version: "1" });
  const r2 = await edited.run();
  assert.equal(r2.status, "suspended", "a replay that ends on the parked timer takes no live step");
  assert.equal(edited.journal.length, parkedLen);

  // The timer past: the journal is COMPLETE — it replays to its result under
  // the edited definition (nothing live is left to take).
  t = 5000;
  const settled = new kernel.Execution(guardedWorkflow, { digest: "d2" }, { journal: journal.slice(), clock, activities: {}, workflow: "demo", version: "1" });
  const r3 = await settled.run();
  assert.equal(r3.status, "completed", JSON.stringify(r3));
  assert.deepEqual(r3.result, { a: "ran", at: 1000 });

  // A journal parked BEFORE a live step (only `open` recorded) refuses at
  // that step: the throw is a NonDeterminism tagged definitionMismatch, and
  // the workflow appends nothing.
  const openOnly = journal.filter((e) => e.kind === "version" || (e.kind === "effect" && e.key === "open"));
  const refused = new kernel.Execution(guardedWorkflow, { digest: "d2" }, { journal: openOnly.slice(), clock, activities, workflow: "demo", version: "1" });
  const r4 = await refused.run();
  assert.equal(r4.status, "failed");
  assert.equal(r4.error.name, "NonDeterminism");
  assert.deepEqual(r4.error.definitionMismatch, { runId: "run-1", journaled: "d1", live: "d2" });
  assert.match(r4.error.message, /the factory's demo definition \(its block\) changed while task-demo's demo attempt was in flight/);
  assert.equal(refused.journal.length, openOnly.length, "nothing journaled under a mixed definition");
  assert.ok(sw.unresumable(r4.error));
  assert.ok(!sw.replayFault(r4.error), "a tagged mismatch is not a replay fault");

  // ...and the SAME definition continues it: the live steps run (and park on
  // their own fresh timer), then complete once it is past.
  const same = new kernel.Execution(guardedWorkflow, { digest: "d1" }, { journal: openOnly.slice(), clock, activities, workflow: "demo", version: "1" });
  assert.equal((await same.run()).status, "suspended");
  t = 20_000;
  const done = await same.run();
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual(done.result, { a: "ran", at: 5000 });
});

test("definitionMismatchError names the stage's own subject when given one", () => {
  const e = sw.definitionMismatchError({ stage: "gate", subject: "gate pipeline", nodeId: "task-x", runId: "r", journaled: "a", live: "b" });
  assert.match(e.message, /the factory's gate definition changed while task-x's gate pipeline was in flight/);
  assert.ok(e instanceof kernel.NonDeterminism);
});

test("the readings of a kernel failure: unresumable, tombstoned, replay fault — each exclusive of the others", () => {
  const version = new kernel.WorkflowVersionMismatch("1", "2");
  const tomb = new kernel.WorkflowTombstoned({ kind: "tombstone", reason: "definition_mismatch" });
  const fault = new kernel.NonDeterminism("key order");
  const plain = new Error("boom");
  assert.ok(sw.unresumable(version) && sw.isVersionMismatch(version));
  assert.ok(!sw.unresumable(tomb) && sw.isTombstoned(tomb), "a tombstone is re-settled, not refused afresh");
  assert.ok(!sw.unresumable(fault) && sw.replayFault(fault));
  assert.ok(!sw.unresumable(plain) && !sw.isTombstoned(plain) && !sw.replayFault(plain));
  // Name-matched too (an error that crossed a module boundary).
  assert.ok(sw.isTombstoned({ name: "WorkflowTombstoned" }));
  assert.ok(sw.unresumable({ name: "WorkflowVersionMismatch" }));
});

test("driveStage: a poisoned journal is re-opened a bounded number of times — on a failed run AND on a poisoned signal delivery — then the error is rethrown", async () => {
  let fails = 0;
  const poisoned = () => {
    const e = new Error("disk full");
    e.poisoned = true;
    return e;
  };
  const logs = [];
  const open = () => ({ run: async () => ({ status: "failed", error: (fails += 1, poisoned()) }) });
  await assert.rejects(sw.driveStage({ label: "demo", nodeId: "task-demo", log: (l) => logs.push(l), open, reopenable: true }), /disk full/);
  assert.equal(fails, 4, "the first run plus three re-opens");
  assert.equal(logs.filter((l) => /could not be written .* re-opening it/.test(l)).length, 3);
  assert.match(logs[0], /\(1\/3\)/);

  // Not reopenable: the first poisoned failure rethrows.
  fails = 0;
  await assert.rejects(sw.driveStage({ label: "demo", nodeId: "task-demo", open, reopenable: false }), /disk full/);
  assert.equal(fails, 1);

  // A poisoned DELIVERY takes the same door.
  let opens = 0;
  const openSignal = () => {
    opens += 1;
    return { run: async () => (opens > 2 ? { status: "completed", result: "done" } : { status: "suspended", kind: "signal", detail: { name: "run:x" } }) };
  };
  const res = await sw.driveStage({
    label: "demo", nodeId: "task-demo", open: openSignal, reopenable: () => true,
    onSuspended: async () => {
      throw poisoned();
    },
  });
  assert.equal(res, "done");
  assert.equal(opens, 3);
});

test("driveStage: onFailed and onSuspended steer the loop — a result returns, a new Execution continues, undefined rethrows (failed) or runs again (suspended)", async () => {
  const runs = [];
  const mk = (script) => ({ run: async () => runs.push(script.shift()) && runs[runs.length - 1] });
  // failed -> {result}
  assert.equal(await sw.driveStage({ label: "d", nodeId: "n", open: () => mk([{ status: "failed", error: new Error("x") }]), onFailed: (e) => ({ result: `settled:${e.message}` }) }), "settled:x");
  // failed -> {exec}
  const fresh = mk([{ status: "completed", result: "fresh" }]);
  assert.equal(await sw.driveStage({ label: "d", nodeId: "n", open: () => mk([{ status: "failed", error: new Error("y") }]), onFailed: () => ({ exec: fresh }) }), "fresh");
  // failed -> undefined rethrows
  await assert.rejects(sw.driveStage({ label: "d", nodeId: "n", open: () => mk([{ status: "failed", error: new Error("z") }]) }), /z/);
  // suspended -> undefined runs again; {result} returns
  let n = 0;
  const out = await sw.driveStage({
    label: "d", nodeId: "n",
    open: () => ({ run: async () => ({ status: "suspended", kind: "timer", detail: { fireAt: 1 } }) }),
    onSuspended: () => (++n < 3 ? undefined : { result: `after ${n}` }),
  });
  assert.equal(out, "after 3");
  // crashed is the test seam only
  await assert.rejects(sw.driveStage({ label: "demo", nodeId: "n", open: () => mk([{ status: "crashed", where: "here" }]) }), /the demo workflow crashed here/);
});

test("refusalRecord / recordlessError / refusalTags: one vocabulary for a definition mismatch and a version mismatch", () => {
  const mismatch = new Error("m");
  mismatch.definitionMismatch = { runId: "run-abcdef12", journaled: "sha256:a", live: "sha256:b" };
  const r1 = sw.refusalRecord({ stage: "integration", what: "its integration block", verb: "landed", item: ITEM, error: mismatch, clock: clockAt(42) });
  assert.deepEqual(r1, {
    reason: "definition_mismatch",
    detail: "the factory's integration definition (its integration block) was edited while this attempt was in flight (opened under sha256:a, now sha256:b); nothing is judged or landed under a mixed definition",
    at: 42,
    definition_mismatch: { runId: "run-abcdef12", journaled: "sha256:a", live: "sha256:b" },
    attempt: 2,
  });
  const r2 = sw.refusalRecord({ stage: "implementation", what: "x", verb: "dispatched", item: { ...ITEM, attempt: undefined }, error: new kernel.WorkflowVersionMismatch("1", "2"), clock: clockAt(7) });
  assert.equal(r2.reason, "journal_version_mismatch");
  assert.equal(r2.journal_version_mismatch, true);
  assert.equal(r2.attempt, 0);
  assert.match(r2.detail, /this attempt's implementation workflow journal was recorded by another version of the workflow .*; it is not resumed by this worker/);

  assert.deepEqual(sw.refusalTags(r1), { definition_mismatch: r1.definition_mismatch, refusal_tombstoned: true });
  assert.deepEqual(sw.refusalTags(r2, { replayed: true }), { journal_version_mismatch: true, refusal_tombstoned: true, refusal_replayed: true });

  // A hand-written tombstone with no record: the error is rebuilt from its
  // reason, so the stage's refusalRecord tags it honestly.
  const e1 = sw.recordlessError({ item: ITEM, entry: { reason: "definition_mismatch" } });
  assert.deepEqual(e1.definitionMismatch, { runId: "run-abcdef12", journaled: null, live: null });
  assert.match(e1.message, /carries no record \(reason: definition_mismatch\)/);
  const e2 = sw.recordlessError({ item: ITEM, entry: {} });
  assert.equal(e2.definitionMismatch, undefined);
  assert.match(e2.message, /reason: refused/);
});

test("settleOrRefuse: an unresumable failure is tombstoned FIRST and settled from what the tombstone recorded; a tombstoned journal is re-settled from its record (or a rebuilt one); anything else is not a refusal", async () => {
  const seen = [];
  const settle = async (refusal, { replayed }) => {
    seen.push({ refusal, replayed });
    return { state: "failed", ...sw.refusalTags(refusal, { replayed }) };
  };
  const build = (error) => sw.refusalRecord({ stage: "demo", what: "w", verb: "v", item: ITEM, error, clock: clockAt(9) });
  const mismatch = new Error("m");
  mismatch.definitionMismatch = { runId: "r", journaled: "a", live: "b" };

  // Fresh refusal: tombstone, then settle from the RECORDED detail.
  const tombstones = [];
  const exec = { tombstone: (reason, detail) => (tombstones.push({ reason, detail }), { kind: "tombstone", reason, detail: { ...detail, recorded: true } }) };
  const out = await sw.settleOrRefuse(mismatch, exec, { item: ITEM, build, settle });
  assert.deepEqual(tombstones.map((t) => t.reason), ["definition_mismatch"]);
  assert.equal(seen[0].refusal.recorded, true, "the settle reads the tombstone's record, not the in-memory one");
  assert.equal(seen[0].replayed, false);
  assert.deepEqual(out.result, { state: "failed", definition_mismatch: { runId: "r", journaled: "a", live: "b" }, refusal_tombstoned: true });

  // A tombstone whose persist failed poisons and THROWS: nothing settles.
  const poisoned = { tombstone: () => { const e = new Error("disk"); e.poisoned = true; throw e; } };
  await assert.rejects(sw.settleOrRefuse(mismatch, poisoned, { item: ITEM, build, settle }), /disk/);
  assert.equal(seen.length, 1);

  // A tombstoned journal: re-settled from the record it carries.
  const tomb = new kernel.WorkflowTombstoned({ kind: "tombstone", reason: "definition_mismatch", detail: { reason: "definition_mismatch", detail: "d", at: 1, definition_mismatch: { runId: "r", journaled: "a", live: "b" }, attempt: 2 } });
  const re = await sw.settleOrRefuse(tomb, exec, { item: ITEM, build, settle });
  assert.equal(seen[1].replayed, true);
  assert.equal(seen[1].refusal.detail, "d");
  assert.equal(re.result.refusal_replayed, true);
  assert.equal(tombstones.length, 1, "a re-settle writes no second tombstone");

  // ...or rebuilt when it carries none.
  const bare = new kernel.WorkflowTombstoned({ kind: "tombstone", reason: "journal_version_mismatch" });
  const rb = await sw.settleOrRefuse(bare, exec, { item: ITEM, build, settle });
  assert.equal(seen[2].refusal.reason, "journal_version_mismatch");
  assert.match(seen[2].refusal.detail, /carries no record/);
  assert.equal(rb.result.journal_version_mismatch, true);

  // Not a refusal.
  assert.equal(await sw.settleOrRefuse(new Error("boom"), exec, { item: ITEM, build, settle }), undefined);
  assert.equal(await sw.settleOrRefuse(new kernel.NonDeterminism("key"), exec, { item: ITEM, build, settle }), undefined);
});

test("refusalSurface / carryRefusalTags / describeRefusal: what a pipeline result says about a refused attempt, for the run record and --status — and nothing for a result that is not one", () => {
  assert.equal(sw.refusalSurface({ state: "failed", reason: "the suite failed" }), null);
  assert.equal(sw.refusalSurface(null), null);
  assert.deepEqual(sw.carryRefusalTags({ state: "failed" }), {});
  const res = { state: "failed", stage: "escalated", definition_mismatch: { runId: "r", journaled: "sha256:a", live: "sha256:b" }, refusal_tombstoned: true, refusal_replayed: true };
  assert.deepEqual(sw.refusalSurface(res), { reason: "definition_mismatch", journaled: "sha256:a", live: "sha256:b", tombstoned: true, replayed: true, stage: "escalated" });
  assert.deepEqual(sw.carryRefusalTags(res), { definition_mismatch: res.definition_mismatch, refusal_tombstoned: true, refusal_replayed: true });
  assert.deepEqual(sw.refusalSurface({ journal_version_mismatch: true, refusal_tombstoned: true }), { reason: "journal_version_mismatch", tombstoned: true, replayed: false });
  assert.match(sw.describeRefusal(sw.refusalSurface(res)), /^refused: the factory definition was edited while the attempt was in flight \(opened under sha256:a, now sha256:b\); the attempt's journal is tombstoned \(re-settled from the tombstone\) — a fresh attempt is 'spor work --regate <run>'$/);
  assert.match(sw.describeRefusal({ reason: "journal_version_mismatch", tombstoned: false, replayed: false }), /^refused: the attempt's journal was recorded by another version of the workflow — a fresh attempt/);
  assert.equal(sw.describeRefusal(null), null);
});
