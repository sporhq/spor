// THE IMPLEMENTATION STAGE AS A WORKFLOW FUNCTION
// (lib/shell/implementation-workflow.js,
// task-spor-implementation-stage-as-workflow-function): the stage's control
// flow is one deterministic function over the replay kernel, and the proofs
// the spike paid for (spikes/durable-workflow/spike.test.js) hold for it:
//   1. a crash at EVERY activity boundary resumes to the same result and the
//      same side effects — only the before-journal window re-executes, exactly
//      one activity, absorbed by that activity's own idempotency;
//   2. a pure replay over the recorded journal reproduces the result with no
//      activity available to call;
//   3. a worker that dies while a re-dispatched implementer runs resumes
//      awaiting the SAME run (the launch is journaled with its run id before
//      the await) instead of dispatching a second implementer;
//   4. a stop and the retry backoff are durable YIELDS over the real file
//      journal (execution-store.js openWorkflowJournal): the driver reports
//      `interrupted` exactly as before, and a re-drive CONTINUES from the
//      yield — the reserved attempt is launched, the pool is not charged
//      again, the ledger is not re-read — never replaying the stop verdict;
//   5. a factory edited between attempts fails CLOSED: the resume settles the
//      attempt `escalated` under a tombstoned journal, and a revert cannot
//      continue it;
//   6. the activities table and the binding name the same set.
// The stage rows in test/gate-pipeline.test.js are the behavioural oracle
// (unchanged by the rewrite); this file is the durability oracle.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gates = require("../lib/kernel/gates.js");
const implementationStage = require("../lib/shell/implementation-stage.js");
const wf = require("../lib/shell/implementation-workflow.js");
const store = require("../lib/shell/execution-store.js");
const kernel = require("../lib/kernel/workflow.js");
const { Execution, drive, fakeClock } = kernel;

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo", attempt: 0 };
const BASE = { factory: "test", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer", gates: [{ id: "acceptance", kind: "command", command: "npm test" }] };
function factoryOf(implementation) {
  const body = ["```json", JSON.stringify({ ...BASE, implementation }), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes: new Map() });
  assert.deepEqual(errors, [], errors.join("; "));
  return factory;
}
const implRecord = (termination_class, extra = {}) => ({ run_id: extra.run_id || ITEM.run_id, node_id: ITEM.node_id, state: "exited", termination_class, terminal_state: "reported", started_at: "2026-09-06T00:00:00.000Z", ...extra });

// The three scripts the sweep runs over: the RETRY path (attempt 1 failed in
// the harness, the re-dispatch commits a candidate), the OUTAGE path (attempt
// 1 hit an environment failure: the shared pool is charged, the backoff timer
// fires, the re-dispatch commits a candidate), and the EXHAUSTED path (two
// clean runs that committed nothing: escalated).
const SCRIPTS = {
  retry: { factory: factoryOf({ budget: { attempts: 3 } }), record: implRecord("failed", { termination_reason: "exit 1" }), commits: true, pools: false, state: "candidate" },
  outage: { factory: factoryOf({ budget: { attempts: 1 }, retry: { attempts: 1, backoff_ms: 5000 } }), record: implRecord("environment", { termination_signal: "credit-exhausted" }), commits: true, pools: true, state: "candidate" },
  exhausted: { factory: factoryOf({ budget: { attempts: 2 } }), record: implRecord("completed"), commits: false, pools: false, state: "exhausted" },
};

// A scripted world whose every answer is a function of its ARGS and of the
// idempotent state the stage leaves (the ledger on the record, which runs
// were launched, the pool count) — never of a call counter — so a re-executed
// activity answers exactly as its first execution did.
function makeWorld({ clock, script, adopt = true, stopping = () => false } = {}) {
  const w = { signals: [], calls: new Map(), effects: [], ledger: [], patches: [], dispatches: 0, launched: new Map(), escalations: [], pools: { retry: { spent: 0 } }, poolSaves: 0, reads: 0, ledgerReads: 0 };
  const deps = {
    now: () => clock.now(),
    stopping,
    loadImplAttempts: async () => {
      w.ledgerReads += 1;
      return { attempts: w.ledger.map((e) => ({ ...e })), record: { ...script.record, impl_attempts: w.ledger } };
    },
    saveImplAttempts: async ({ attempts, patch }) => {
      w.ledger = attempts.map((e) => ({ ...e }));
      w.patches.push({ ...patch });
    },
    changedPaths: async () => {
      w.reads += 1;
      // The re-dispatched implementer is what commits: before any launch the
      // tree is empty, after one it carries the candidate (the retry/outage
      // scripts); the exhausted script never commits.
      return script.commits && w.launched.size ? { ok: true, paths: ["lib/x.js"], head: "b".repeat(40) } : { ok: true, paths: [], head: "a".repeat(40) };
    },
    dispatchImplement: async ({ name }) => {
      if (adopt && w.launched.has(name)) return { ok: true, runId: w.launched.get(name), adopted: true };
      w.dispatches += 1;
      const runId = `run-impl-${w.dispatches}`;
      w.launched.set(name, runId);
      w.signals.push({ name: `run:${runId}`, payload: { ok: true, record: wf.recordView(implRecord("completed", { run_id: runId })) } });
      return { ok: true, runId };
    },
    awaitRun: async () => {
      throw new Error("the kernel driver delivers run signals in this world");
    },
    escalateStage: async ({ state }) => {
      const id = `task-impl-${state}-demo`;
      w.escalations.push(id); // deterministic id: a re-write is the same node
      return { ok: true, id };
    },
    ...(script.pools
      ? {
          loadGatePools: async () => ({ retry: { spent: w.pools.retry.spent } }),
          saveGatePools: async ({ pools }) => {
            w.poolSaves += 1;
            w.pools = { retry: { spent: pools.retry.spent } };
          },
        }
      : {}),
  };
  const { activities } = wf.bindImplementationActivities(deps, { item: ITEM });
  w.deps = deps;
  w.activities = activities;
  w.onActivity = ({ key, name }) => {
    w.calls.set(key, (w.calls.get(key) || 0) + 1);
    w.effects.push({ key, name });
  };
  return w;
}

function exec(world, script, clock, { journal = [], crashPlan = null, factory = script.factory } = {}) {
  const input = { item: ITEM, factory, record: script.record, deps: world.deps, log: () => {}, driver: { parked: null, mode: null } };
  return new Execution(wf.implementationWorkflow, input, { journal, clock, activities: world.activities, crashPlan, onActivity: world.onActivity, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
}

// The idempotent effects: the ledger as it ends on the record, the runs
// launched (adopt-by-name), the escalations filed (deterministic ids,
// deduped), the pool count. A re-executed stamp is the same ledger, so the
// stamp COUNT is not the fact.
const ledgerOf = (w) => w.ledger.map((e) => `${e.index}:${e.outcome}/${e.pool}/${e.run_id}`);
const sideEffects = (w) => ({ ledger: ledgerOf(w), dispatches: w.dispatches, escalations: [...new Set(w.escalations)], pools: w.pools, implState: [...w.patches].reverse().find((p) => p.impl_state) || null });

test("happy path (retry script): every activity executes exactly once, the re-dispatch's terminal state arrives as a run signal, and a pure replay reproduces the result with no activity available", async () => {
  const clock = fakeClock(1000);
  const script = SCRIPTS.retry;
  const world = makeWorld({ clock, script });
  const e = exec(world, script, clock);
  const r = await drive(e, { clock, signals: world.signals });
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.result.state, "candidate");
  assert.deepEqual(ledgerOf(world), ["1:failed/implementation/run-abcdef12", "2:candidate/implementation/run-impl-1"]);
  for (const [key, n] of world.calls) assert.equal(n, 1, `${key} executed ${n} times`);
  assert.equal(world.dispatches, 1);
  assert.equal(world.escalations.length, 0);
  assert.equal(e.journal.filter((j) => j.kind === "signal").length, 1);
  assert.equal(e.journal.filter((j) => j.kind === "await" && j.outcome.received).length, 1, "the re-dispatch was awaited as a signal");
  assert.equal(e.journal.filter((j) => j.kind === "timer").length, 0, "nothing yielded");
  assert.ok(e.journal.some((j) => j.kind === "effect" && /\/a0\/i2\/launched$/.test(j.key)), "the run id was stamped on the reservation before the await");

  // Pure replay: activities that would fail loudly if called, the same journal.
  const poison = Object.fromEntries(Object.keys(world.activities).map((k) => [k, () => { throw new Error(`activity ${k} called during pure replay`); }]));
  const replay = new Execution(wf.implementationWorkflow, { item: ITEM, factory: script.factory, record: script.record, deps: world.deps, log: () => {}, driver: { parked: null, mode: null } }, { journal: e.journal.slice(), clock, activities: poison, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  const rr = await replay.run();
  assert.equal(rr.status, "completed");
  assert.deepEqual(rr.result, r.result);
  assert.equal(replay.journal.length, e.journal.length, "a pure replay appends nothing");
});

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`crash sweep (${name}): a crash at EVERY activity boundary resumes to the same result AND the same side effects; only the before-journal window re-executes, exactly one activity`, async () => {
    const refClock = fakeClock(1000);
    const ref = makeWorld({ clock: refClock, script });
    const reference = await drive(exec(ref, script, refClock), { clock: refClock, signals: ref.signals });
    assert.equal(reference.status, "completed", JSON.stringify(reference));
    assert.equal(reference.result.state, script.state);
    const effectCount = ref.effects.length;
    assert.ok(effectCount > 6, `expected a non-trivial effect count, got ${effectCount}`);
    const refEffects = sideEffects(ref);
    if (name === "outage") {
      assert.deepEqual(refEffects.pools, { retry: { spent: 1 } });
      assert.equal(ref.poolSaves, 1);
      assert.ok(refClock.now() >= 1000 + 5000, "the backoff timer fired on the clock");
    }
    if (name === "exhausted") assert.deepEqual(refEffects.escalations, ["task-impl-exhausted-demo"]);

    for (const at of ["before-execute", "before-journal", "after-journal"]) {
      for (let nth = 1; nth <= effectCount; nth++) {
        const clock = fakeClock(1000);
        const world = makeWorld({ clock, script });
        let crashed = 0;
        const e = exec(world, script, clock, { crashPlan: { at, nth } });
        const r = await drive(e, { clock, signals: world.signals, onCrash: () => crashed++ });
        assert.equal(crashed, 1, `${at}#${nth}: crashed ${crashed} times`);
        assert.equal(r.status, "completed", `${at}#${nth}: ${r.status} ${r.error ? r.error.message : ""}`);
        assert.deepEqual(r.result, reference.result, `${at}#${nth}: result differs`);
        assert.deepEqual(sideEffects(world), refEffects, `${at}#${nth}: side effects differ`);
        const twice = [...world.calls].filter(([, n]) => n > 1);
        if (at === "before-journal") {
          assert.equal(twice.length, 1, `${at}#${nth}: exactly one effect re-executes (the at-least-once window), got ${twice.map(([k]) => k)}`);
          assert.equal(twice[0][1], 2);
        } else {
          assert.equal(twice.length, 0, `${at}#${nth}: nothing re-executes, got ${twice.map(([k]) => k)}`);
        }
      }
    }
  });
}

test("a worker that dies while a re-dispatched implementer runs: the resumed execution awaits the SAME run instead of dispatching a second implementer", async () => {
  const clock = fakeClock(1000);
  const script = SCRIPTS.retry;
  const world = makeWorld({ clock, script });
  // Hold the run's terminal signal back so the first worker parks on it.
  const held = [];
  const origDispatch = world.deps.dispatchImplement;
  world.deps.dispatchImplement = async (args) => {
    const r = await origDispatch(args);
    if (!r.adopted) held.push(world.signals.pop());
    return r;
  };
  const first = exec(world, script, clock);
  const r1 = await drive(first, { clock, signals: world.signals });
  assert.equal(r1.status, "suspended");
  assert.equal(r1.kind, "signal");
  assert.equal(r1.detail.name, "run:run-impl-1");
  assert.equal(world.dispatches, 1);
  assert.equal(world.ledger[1].run_id, "run-impl-1", "the launch stamped its run id onto the reservation before parking");

  // The worker dies; a successor opens the same journal over the same record.
  // A dispatch would throw if called — it is never called: the run id is in
  // the journal, so the successor awaits it.
  const world2 = makeWorld({ clock, script });
  world2.ledger = world.ledger.map((e) => ({ ...e }));
  world2.launched.set(implementationStage.implRunName(ITEM.run_id, 0, 2), "run-impl-1");
  world2.deps.dispatchImplement = async () => {
    throw new Error("re-dispatched a running implementer");
  };
  world2.activities = wf.bindImplementationActivities(world2.deps, { item: ITEM }).activities;
  const second = exec(world2, script, clock, { journal: first.journal.slice() });
  world2.signals.push(held[0]);
  const r2 = await drive(second, { clock, signals: world2.signals });
  assert.equal(r2.status, "completed", JSON.stringify(r2));
  assert.equal(r2.result.state, "candidate");
  assert.equal(world2.dispatches, 0, "the successor launched nothing");
  assert.deepEqual(ledgerOf(world2), ["1:failed/implementation/run-abcdef12", "2:candidate/implementation/run-impl-1"]);
});

function scratchHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spor-implwf-${label}-`));
}
const EXEC = "exec-0123456789abcdef";

// The runner-contract fakes (test/gate-pipeline.test.js's stageFakes shape)
// over a controllable clock, the one-shot `implement`, and a file journal.
function stageFakes({ home, clock, changed = () => ({ ok: true, paths: ["lib/x.js"], head: "c".repeat(40) }), record, pools = null, stopping = () => false } = {}) {
  const seen = { attempts: [], patches: [], implements: 0, escalations: [], reads: 0, ledgerReads: 0, pools: pools ? { ...pools } : null, poolSaves: 0, slept: 0, poolReads: 0 };
  const deps = {
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advanceBy(ms);
      seen.slept += 1;
    },
    stopping,
    changedPaths: async () => {
      seen.reads += 1;
      return changed(seen);
    },
    loadImplAttempts: async () => {
      seen.ledgerReads += 1;
      return { attempts: seen.attempts.map((e) => ({ ...e })), record: { ...record, impl_attempts: seen.attempts } };
    },
    saveImplAttempts: async ({ attempts, patch }) => {
      seen.attempts = attempts.map((e) => ({ ...e }));
      seen.patches.push({ ...patch });
    },
    implement: async (args) => {
      seen.implements += 1;
      if (args.onLaunch) await args.onLaunch({ runId: `run-impl-${args.attempt}` });
      return { ok: true, runId: `run-impl-${args.attempt}`, record: implRecord("completed", { run_id: `run-impl-${args.attempt}` }) };
    },
    escalateStage: async (args) => {
      seen.escalations.push(args);
      return { ok: true, id: `task-impl-${args.state}-demo` };
    },
    ...(pools
      ? {
          loadGatePools: async () => {
            seen.poolReads += 1;
            return seen.pools;
          },
          saveGatePools: async ({ pools: next }) => {
            seen.poolSaves += 1;
            seen.pools = next;
          },
        }
      : {}),
    workflowJournal: () => store.openWorkflowJournal(home, "local", EXEC, { stage: "implementation-a0" }),
  };
  return { deps, seen };
}
const onDisk = (home) => store.readWorkflowJournal(home, "local", EXEC, { stage: "implementation-a0" });

test("a stop YIELDS over the file journal: reported interrupted as before, and a re-drive CONTINUES from the yield — the next attempt is launched, the ledger is never re-read", async () => {
  const home = scratchHome("stop");
  const clock = fakeClock(1_700_000_000_000);
  let stop = true;
  const empty = { ok: true, paths: [], head: "a".repeat(40) };
  const { deps, seen } = stageFakes({ home, clock, record: implRecord("completed"), changed: (s) => (s.reads === 1 ? empty : { ok: true, paths: ["lib/x.js"], head: "c".repeat(40) }), stopping: () => stop });
  const factory = factoryOf({ budget: { attempts: 2 } });

  const first = await implementationStage.runImplementationStage({ item: ITEM, factory, record: implRecord("completed"), deps });
  assert.equal(first.state, "interrupted");
  assert.match(first.reason, /asked to stop before the next implementation attempt/);
  assert.deepEqual(seen.attempts.map((e) => `${e.index}:${e.outcome}`), ["1:no-candidate"], "settled, but no second attempt reserved");
  assert.equal(seen.implements, 0);
  const j1 = onDisk(home);
  assert.equal(j1[0].kind, "version");
  assert.deepEqual({ workflow: j1[0].workflow, version: j1[0].version }, { workflow: "implementation", version: wf.WORKFLOW_VERSION });
  assert.ok(j1.some((j) => j.kind === "timer"), "the yield is a durable timer on disk");
  assert.ok(j1.some((j) => j.kind === "effect" && /\/i2\/next\/yield\/0$/.test(j.key)), "the interrupted result is journaled");

  // Re-driven BEFORE the timer, still stopping: the same journaled result,
  // nothing re-read, nothing appended.
  const early = await implementationStage.runImplementationStage({ item: ITEM, factory, record: implRecord("completed"), deps });
  assert.equal(early.state, "interrupted");
  assert.equal(early.reason, first.reason);
  assert.equal(seen.ledgerReads, 1, "the ledger was read once, by the first drive");
  assert.equal(onDisk(home).length, j1.length, "an early re-drive appends nothing");

  // Re-driven AFTER the timer, no longer stopping: the workflow continues
  // from the yield — asks again, reserves attempt 2, launches it, and judges
  // its candidate. The ledger read and attempt 1's classification are
  // replayed, never re-run.
  stop = false;
  clock.advanceBy(wf.YIELD_MS + 1);
  const late = await implementationStage.runImplementationStage({ item: ITEM, factory, record: implRecord("completed"), deps });
  assert.equal(late.state, "candidate", JSON.stringify(late));
  assert.equal(seen.implements, 1);
  assert.equal(seen.ledgerReads, 1, "never re-read: the journal holds it");
  assert.equal(seen.reads, 2, "attempt 1's tree read was replayed; only attempt 2's ran");
  assert.deepEqual(seen.attempts.map((e) => `${e.index}:${e.outcome}/${e.run_id}`), ["1:no-candidate/run-abcdef12", "2:candidate/run-impl-2"]);
  assert.equal(seen.escalations.length, 0);
  const j2 = onDisk(home);
  assert.equal(j2.filter((j) => j.kind === "effect" && /\/i2\/next\/stop\/\d+$/.test(j.key)).length, 2, "at the yield's site the stop was asked twice: once before the yield, once after it");
  assert.equal(j2.filter((j) => j.kind === "effect" && /\/i2\/dispatch\/stop\/0$/.test(j.key)).length, 1, "...and once more at the launch, as the runner did");

  // ...and the settled journal replays to the settled result with nothing run.
  const settled = await implementationStage.runImplementationStage({ item: ITEM, factory, record: implRecord("completed"), deps });
  assert.deepEqual(settled, late);
  assert.equal(seen.implements, 1);
  assert.equal(seen.reads, 2);

  // The stage sits at the FRONT of the pipeline and is re-entered on every
  // orphan resume: a settled journal replays to its settled result WHATEVER
  // the live definition now reads — the binding is enforced only at a live
  // step, never over work that was never in flight (a prompt-text tweak after
  // the candidate was produced must not refuse the attempt).
  const edited = factoryOf({ budget: { attempts: 3 }, instructions: "be VERY careful" });
  const replayed = await implementationStage.runImplementationStage({ item: ITEM, factory: edited, record: implRecord("completed"), deps });
  assert.deepEqual(replayed, late, "the settled result, byte-identical");
  assert.equal(seen.escalations.length, 0, "no refusal of a settled attempt");
  assert.equal(seen.implements, 1);
  assert.equal(onDisk(home).length, j2.length, "nothing appended, nothing tombstoned");
});

test("the retry backoff is a durable timer: a stop during the wait hands up the reserved attempt, and the re-drive launches it without charging the pool or reading the ledger again", async () => {
  const home = scratchHome("backoff");
  const clock = fakeClock(1_700_000_000_000);
  let stopAfter = 2;
  const outage = implRecord("environment", { termination_signal: "credit-exhausted" });
  const fakesRef = {};
  const { deps, seen } = stageFakes({ home, clock, record: outage, pools: { retry: { spent: 0 } }, stopping: () => stopAfter > 0 && fakesRef.seen.slept >= stopAfter });
  fakesRef.seen = seen;
  const factory = factoryOf({ budget: { attempts: 1 }, retry: { attempts: 1, backoff_ms: 60000 } });

  const first = await implementationStage.runImplementationStage({ item: ITEM, factory, record: outage, deps });
  assert.equal(first.state, "interrupted");
  assert.match(first.reason, /attempt 2 is reserved/);
  assert.deepEqual(seen.pools, { retry: { spent: 1 } }, "the retry was charged");
  assert.deepEqual(seen.attempts.map((e) => `${e.index}:${e.outcome}/${e.pool}`), ["1:infrastructure/retry", "2:pending/null"], "...and the attempt it paid for is RESERVED");
  assert.equal(seen.implements, 0, "nothing dispatched under a stop");
  assert.equal(seen.slept, 2, "the wait was sliced and the stop answered inside it");
  const timer = onDisk(home).find((j) => j.kind === "timer");
  assert.ok(timer, "the backoff is a durable timer on disk");
  assert.equal(timer.fireAt, 1_700_000_000_000 + 60000);

  // The resume, no longer stopping: the driver waits out the REST of the
  // journaled timer (not a fresh 60s), then the workflow launches the
  // reservation — the pool is not charged again and the ledger not re-read.
  stopAfter = 0;
  const resumed = await implementationStage.runImplementationStage({ item: ITEM, factory, record: outage, deps });
  assert.equal(resumed.state, "candidate", JSON.stringify(resumed));
  assert.equal(seen.implements, 1);
  assert.equal(seen.poolSaves, 1, "the charge the first pass made is not made again");
  assert.equal(seen.poolReads, 1);
  assert.equal(seen.ledgerReads, 1);
  assert.equal(clock.now(), timer.fireAt, "the wait ended exactly at the journaled wake time");
  assert.deepEqual(seen.attempts.map((e) => `${e.index}:${e.outcome}/${e.pool}`), ["1:infrastructure/retry", "2:candidate/implementation"]);
});

test("a factory edited between attempts FAILS CLOSED over the file journal: the resume settles the attempt `escalated` under a tombstone — no dispatch — and a revert re-settles the same refusal, never continuing it", async () => {
  const home = scratchHome("mismatch");
  const clock = fakeClock(1_700_000_000_000);
  let stop = true;
  const empty = { ok: true, paths: [], head: "a".repeat(40) };
  const { deps, seen } = stageFakes({ home, clock, record: implRecord("completed"), changed: () => empty, stopping: () => stop });
  const original = factoryOf({ budget: { attempts: 2 } });
  const first = await implementationStage.runImplementationStage({ item: ITEM, factory: original, record: implRecord("completed"), deps });
  assert.equal(first.state, "interrupted");

  // The operator raises the budget while the attempt is parked.
  stop = false;
  clock.advanceBy(wf.YIELD_MS + 1);
  const edited = factoryOf({ budget: { attempts: 3 } });
  const refused = await implementationStage.runImplementationStage({ item: ITEM, factory: edited, record: implRecord("completed"), deps });
  assert.equal(refused.state, "escalated", JSON.stringify(refused));
  assert.ok(refused.definition_mismatch, "tagged with WHY");
  assert.equal(refused.refusal_tombstoned, true);
  assert.match(refused.reason, /implementation definition .* was edited while this attempt was in flight/);
  assert.equal(seen.implements, 0, "nothing dispatched under a mixed definition");
  assert.deepEqual(seen.escalations.map((e) => e.state), ["escalated"]);
  assert.equal(refused.escalated_to, "task-impl-escalated-demo");
  assert.ok(seen.patches.some((p) => p.impl_state === "escalated"), "the stage is settled on the record");
  assert.equal(seen.attempts[0].stop_reason, refused.reason, "the reason rides the segment's last entry, as any stop's does");
  const j = onDisk(home);
  assert.equal(j[j.length - 1].kind, "tombstone");
  assert.equal(j[j.length - 1].reason, "definition_mismatch");

  // Reverted and re-driven: the tombstone wins — re-settled from its record,
  // same ids, same reason; the attempt never continues to a dispatch.
  const again = await implementationStage.runImplementationStage({ item: ITEM, factory: original, record: implRecord("completed"), deps });
  assert.equal(again.state, "escalated");
  assert.equal(again.refusal_replayed, true);
  assert.equal(again.reason, refused.reason);
  assert.equal(seen.implements, 0);
  assert.deepEqual([...new Set(seen.escalations.map((e) => e.reason))].length, 1, "the byte-identical escalation body on re-file");
  assert.equal(onDisk(home).length, j.length, "a tombstoned journal is never appended to");
});

test("the activities table and the binding name the same set", () => {
  const { activities } = wf.bindImplementationActivities({}, { item: ITEM });
  const bound = Object.keys(activities).sort();
  const documented = wf.IMPLEMENTATION_ACTIVITIES.map(([name]) => name).filter((n) => !/^(signal|timer) /.test(n)).sort();
  assert.deepEqual(bound, documented);
});
