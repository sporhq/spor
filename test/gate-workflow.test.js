// THE GATE LIST AS A WORKFLOW FUNCTION (lib/shell/gate-workflow.js,
// task-spor-gate-list-as-workflow-function): the pipeline's control flow is
// one deterministic function over the replay kernel, and the proofs the
// integration stage paid for (test/integration-workflow.test.js) hold for it:
//   1. a crash at EVERY activity boundary resumes to the same result and the
//      same side effects — only the before-journal window re-executes, exactly
//      one activity, absorbed by that activity's own idempotency;
//   2. a pure replay over the recorded journal reproduces the result with no
//      activity available to call;
//   3. a worker that dies while a fix cycle (or a rescue) runs resumes
//      awaiting the SAME run — the dispatch is journaled with its run id
//      before the await — instead of dispatching a second;
//   4. an `interrupted` hand-up is a durable YIELD over the real file journal
//      (execution-store.js openWorkflowJournal): the driver reports
//      `interrupted` exactly as before, a re-drive before the timer returns
//      the same journaled result with nothing run, and a re-drive after it
//      continues into the NEXT PASS — never replaying the interrupted verdict
//      forever;
//   5. the outage backoff is a durable timer sliced as the runner sliced it;
//   6. a journal this worker cannot continue (another version, an edited
//      definition) is REFUSED through the shared tombstone-then-settle door
//      (stage-workflow.js settleOrRefuse) — escalation, demotion, fact — and a
//      re-drive re-settles from the tombstone; a COMPLETED journal replays
//      under any edit, since the gate list rides its `open` entry
//      (task-spor-delete-loop-resume-machinery-after-workflow-stages);
//   7. a REPLAY FAULT is a hard, tagged failure that never logs a fallback —
//      every resume scenario here asserts the words never appear in a log;
//   8. an orphan adopted mid-await is continued, and the journaled
//      `afterAwait` read runs the supersession check it owes;
//   9. the activities table and the binding name the same set.
// test/gate-pipeline.test.js is the behavioural oracle (unchanged by the
// rewrite); this file is the durability oracle.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const wf = require("../lib/shell/gate-workflow.js");
const store = require("../lib/shell/execution-store.js");
const kernel = require("../lib/kernel/workflow.js");
const { Execution, drive, fakeClock } = kernel;

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes: new Map() });
  assert.deepEqual(errors, [], errors.join("; "));
  return factory;
}

const BASE = { factory: "test", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer", risk_classes: { "touches:auth": ["lib/auth.js"] } };
const GATES = [
  { id: "acceptance", kind: "command", command: "npm test" },
  { id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 },
];
// The three scripts the sweep runs over: the PASSED path (the review asks for
// one fix — a run signal — then passes the moved head), the SETTLED path (no
// fix cycles declared: the review refuses -> escalate -> demote -> fact), and
// the RESCUED path (the refusal is handed to the rescue lane — a second run
// signal and a report read — and the re-judged pass passes).
const SCRIPTS = {
  passed: { factory: factoryOf({ ...BASE, gates: GATES }) },
  settled: { factory: factoryOf({ ...BASE, gates: [GATES[0], { ...GATES[1], cycles: 0 }] }), refuses: true },
  rescued: { factory: factoryOf({ ...BASE, gates: [GATES[0], { ...GATES[1], cycles: 0 }], rescue: { profile: "profile-rescue", attempts: 1 } }), refuses: true, rescuePasses: true },
};

const CHANGES = '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"lib/x.js","summary":"boom","evidence":"ran npm test, it failed"}]}\n```';
const PASS_AFTER_FIX = '```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved","note":"fixed"}]}\n```';
const PASS = '```json\n{"verdict":"pass"}\n```';

// A scripted world whose every answer is a function of its ARGS and of the
// idempotent state the pipeline leaves (which runs were launched, which facts
// are on the graph) — never of a call counter — so a re-executed activity
// answers exactly as its first execution did.
function makeWorld({ clock, script = SCRIPTS.passed, adopt = true, home = null, stage = "gates-a0" } = {}) {
  const w = { signals: [], calls: new Map(), effects: [], facts: new Map(), escalations: [], demotions: [], launched: new Map(), dispatches: 0, rescues: 0, reviews: [], suites: 0, progress: new Map(), rescueState: null, stopping: false, preflight: { ok: true }, preflights: 0, slept: 0 };
  const headNow = () => `head-v${1 + w.launched.size}`;
  const deps = {
    now: () => clock.now(),
    sleep: async (ms) => {
      w.slept += 1;
      clock.advanceBy(ms);
    },
    stopping: () => w.stopping,
    ...(home ? { workflowJournal: () => store.openWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage }) } : {}),
    checkEvidenceOrigins: async () => {
      w.preflights += 1;
      return w.preflight;
    },
    changedPaths: async () => ({ ok: true, paths: ["lib/x.js"], head: headNow(), base: "base0000", trustedRef: "main", trustedSha: "trust000", branch: "task-demo", cwd: "/repo/wt" }),
    runSuite: async () => {
      w.suites += 1;
      return { ok: true };
    },
    review: async ({ cycle, rescue }) => {
      w.reviews.push({ cycle, rescue: rescue || 0 });
      if (rescue && script.rescuePasses) return { ok: true, text: PASS_AFTER_FIX }; // the carried ledger's F1 must be answered
      if (script.refuses) return { ok: true, text: CHANGES };
      return { ok: true, text: cycle === 0 ? CHANGES : PASS_AFTER_FIX };
    },
    dispatchFix: async ({ gate, cycle }) => {
      const name = `fix-${gate.id}-${cycle}`;
      if (adopt && w.launched.has(name)) return { ok: true, runId: w.launched.get(name), adopted: true };
      w.dispatches += 1;
      const runId = `fix-${w.dispatches}`;
      w.launched.set(name, runId);
      w.signals.push({ name: `run:${runId}`, payload: { ok: true, classification: { outcome: "resolved" } } });
      return { ok: true, runId };
    },
    dispatchRescue: async ({ attempt }) => {
      const name = `rescue-${attempt}`;
      if (adopt && w.launched.has(name)) return { ok: true, runId: w.launched.get(name), adopted: true };
      w.rescues += 1;
      const runId = `rescue-run-${w.rescues}`;
      w.launched.set(name, runId);
      w.signals.push({ name: `rescue-run:${runId}`, payload: { ok: true } });
      return { ok: true, runId };
    },
    rescueReport: async ({ runId }) => ({ diagnosis: `fixed in ${runId}`, category: "real-defect", fixed: true, filed: ["task-factory-tweak"], unread: false }),
    // Under the kernel's drive() the queued signals are delivered before this is
    // ever asked; under the real driver it answers the run's terminal state.
    awaitRun: async ({ runId }) => ({ ok: true, runId, classification: { outcome: "resolved" } }),
    loadGateProgress: async ({ gate, rescue = 0 }) => w.progress.get(`${rescue}:${gate.id}`) || null,
    saveGateProgress: async ({ gate, progress, rescue = 0 }) => {
      w.progress.set(`${rescue}:${gate.id}`, JSON.parse(JSON.stringify(progress)));
    },
    loadRescueState: async () => w.rescueState,
    saveRescueState: async ({ rescues }) => {
      w.rescueState = JSON.parse(JSON.stringify(rescues));
    },
    recordFact: async ({ id, markdown }) => {
      w.facts.set(id, markdown); // if_exists: skip + identical content — a re-write is the same node
      return { ok: true, id };
    },
    escalate: async ({ gate }) => {
      const id = `task-gate-${gate.id}`;
      if (!w.escalations.includes(id)) w.escalations.push(id); // deterministic id, if_exists: skip
      return { ok: true, id };
    },
    demote: async ({ blockerId }) => {
      if (!w.demotions.includes(blockerId)) w.demotions.push(blockerId);
      return { ok: true, demoted: true, note: "task-demo rolled back done -> open" };
    },
  };
  const { activities } = wf.bindGateActivities(deps, { item: ITEM, factory: script.factory, log: () => {} });
  w.deps = deps;
  w.activities = activities;
  w.onActivity = ({ key, name }) => {
    w.calls.set(key, (w.calls.get(key) || 0) + 1);
    w.effects.push({ key, name });
  };
  return w;
}

function exec(world, clock, { journal = [], crashPlan = null, factory = SCRIPTS.passed.factory } = {}) {
  const input = { item: ITEM, factory, deps: world.deps, log: () => {}, driver: { parked: null } };
  return new Execution(wf.gateWorkflow, input, { journal, clock, activities: world.activities, crashPlan, onActivity: world.onActivity, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
}

// The idempotent effects: the graph nodes written (a Map — if_exists: skip),
// the escalations/demotions filed (deterministic ids, deduped), the fix and
// rescue runs launched (adopt-by-name), and the durable progress left behind.
const sideEffects = (w) => ({ facts: [...w.facts.keys()].sort(), escalations: [...w.escalations], demotions: [...w.demotions], dispatches: w.dispatches, rescues: w.rescues, progress: [...w.progress.entries()].sort(), rescueState: w.rescueState });

test("happy path: every activity executes exactly once, the fix cycle arrives as a run signal, and a pure replay reproduces the result with no activity available", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock });
  const e = exec(world, clock);
  const r = await drive(e, { clock, signals: world.signals });
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.result.state, "passed");
  assert.equal(r.result.head, "head-v2", "the moved head was re-judged and stands as the judged head");
  assert.deepEqual(r.result.gates.map((g) => [g.gate, g.verdict, g.head]), [["acceptance", "passed", "head-v2"], ["review", "passed", "head-v2"]]);
  for (const [key, n] of world.calls) assert.equal(n, 1, `${key} executed ${n} times`);
  assert.equal(world.dispatches, 1);
  assert.equal(world.reviews.length, 2);
  assert.equal(world.suites, 2, "the acceptance gate re-ran on the moved head");
  assert.equal(world.facts.size, 3, "the acceptance gate judged both heads, the review the final one");
  assert.equal(e.journal.filter((j) => j.kind === "signal").length, 1);
  assert.equal(e.journal.filter((j) => j.kind === "await" && j.outcome.received).length, 1, "the fix run was awaited as a signal");
  assert.equal(e.journal.filter((j) => j.kind === "timer").length, 0, "nothing yielded or waited");
  assert.ok(e.journal.some((j) => j.kind === "effect" && /\/judge#1$/.test(j.key)), "a gate attempt is one journaled activity");

  // Pure replay: activities that would fail loudly if called, the same journal.
  const poison = Object.fromEntries(Object.keys(world.activities).map((k) => [k, () => { throw new Error(`activity ${k} called during pure replay`); }]));
  const replay = new Execution(wf.gateWorkflow, { item: ITEM, factory: SCRIPTS.passed.factory, deps: world.deps, log: () => {}, driver: { parked: null } }, { journal: e.journal.slice(), clock, activities: poison, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  const rr = await replay.run();
  assert.equal(rr.status, "completed", rr.error && rr.error.message);
  assert.deepEqual(rr.result, r.result);
  assert.equal(replay.journal.length, e.journal.length, "a pure replay appends nothing");
});

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`crash sweep (${name}): a crash at EVERY activity boundary resumes to the same result AND the same side effects; only the before-journal window re-executes, exactly one activity`, async () => {
    const refClock = fakeClock(1_700_000_000_000);
    const ref = makeWorld({ clock: refClock, script });
    const reference = await drive(exec(ref, refClock, { factory: script.factory }), { clock: refClock, signals: ref.signals });
    assert.equal(reference.status, "completed", JSON.stringify(reference));
    assert.equal(reference.result.state, { passed: "passed", settled: "failed", rescued: "passed" }[name]);
    const effectCount = ref.effects.length;
    assert.ok(effectCount > 8, `expected a non-trivial effect count, got ${effectCount}`);
    const refEffects = sideEffects(ref);
    if (name === "settled") assert.deepEqual({ e: refEffects.escalations.length, d: refEffects.demotions.length, f: refEffects.facts.length, fixes: refEffects.dispatches }, { e: 1, d: 1, f: 2, fixes: 0 });
    if (name === "rescued") {
      assert.deepEqual({ e: refEffects.escalations.length, rescues: refEffects.rescues, fixes: refEffects.dispatches }, { e: 0, rescues: 1, fixes: 0 });
      assert.ok(refEffects.facts.some((id) => /^art-rescue-/.test(id)), "the rescue fact is on the graph");
      assert.equal(reference.result.rescues.length, 1);
      assert.equal(reference.result.rescues[0].category, "real-defect");
    }

    for (const at of ["before-execute", "before-journal", "after-journal"]) {
      for (let nth = 1; nth <= effectCount; nth++) {
        const clock = fakeClock(1_700_000_000_000);
        const world = makeWorld({ clock, script });
        let crashed = 0;
        const e = exec(world, clock, { crashPlan: { at, nth }, factory: script.factory });
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

test("WITHOUT adopt-by-name in the fix dispatch, a before-journal crash on it launches a second fixer — the window the activity's own idempotency closes", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const probe = makeWorld({ clock });
  await drive(exec(probe, clock), { clock, signals: probe.signals });
  const nth = probe.effects.findIndex((x) => x.name === "dispatchFix") + 1;
  assert.ok(nth > 0);
  const world = makeWorld({ clock: fakeClock(1_700_000_000_000), adopt: false });
  const c2 = fakeClock(1_700_000_000_000);
  const r = await drive(exec(world, c2, { crashPlan: { at: "before-journal", nth } }), { clock: c2, signals: world.signals });
  assert.equal(r.status, "completed");
  assert.equal(world.dispatches, 2, "two fixers: the defect adopt-by-name exists to close");
});

test("a worker that dies while a fix cycle runs: the resumed execution awaits the SAME run instead of dispatching a second fixer", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock });
  const e = exec(world, clock);
  // Run until the workflow suspends on the fix run's signal — deliver nothing.
  const first = await e.run();
  assert.equal(first.status, "suspended");
  assert.equal(first.kind, "signal");
  assert.equal(first.detail.name, "run:fix-1");
  assert.equal(world.dispatches, 1);
  // A NEW worker over the same journal: it replays to the same await.
  const resumed = exec(world, clock, { journal: e.journal });
  const again = await resumed.run();
  assert.equal(again.status, "suspended");
  assert.equal(again.detail.name, "run:fix-1");
  assert.equal(world.dispatches, 1, "the dispatch is journaled with its run id before the await, so nothing is launched again");
  const r = await drive(resumed, { clock, signals: world.signals });
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  assert.equal(world.dispatches, 1);
});

test("a worker that dies while a RESCUE runs: the resumed execution awaits the same rescue run and reads its report once", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, script: SCRIPTS.rescued });
  const e = exec(world, clock, { factory: SCRIPTS.rescued.factory });
  const first = await e.run();
  assert.equal(first.status, "suspended");
  assert.equal(first.detail.name, "rescue-run:rescue-run-1");
  assert.equal(world.rescues, 1);
  assert.equal(world.rescueState[0].dispatched, true, "the launch is on the rescue state before the await");
  assert.equal(world.rescueState[0].runId, "rescue-run-1");
  const resumed = exec(world, clock, { journal: e.journal, factory: SCRIPTS.rescued.factory });
  const r = await drive(resumed, { clock, signals: world.signals });
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  assert.equal(world.rescues, 1);
  assert.equal(world.effects.filter((x) => x.name === "rescueReport").length, 1);
});

function scratchHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spor-gatewf-${label}-`));
}

test("an interrupted hand-up YIELDS over the file journal: reported interrupted as before, the same result on an early re-drive with nothing run, and the NEXT PASS on a late one", async () => {
  const home = scratchHome("yield");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  world.preflight = { ok: false, reason: "pending flake evidence belongs to a different or unknown graph; resume against its original graph" };
  const run = () => gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: world.deps });

  const first = await run();
  assert.equal(first.state, "interrupted");
  assert.match(first.reason, /different or unknown graph/);
  assert.equal(world.preflights, 1);
  assert.equal(world.reviews.length, 0, "nothing judged");
  const onDisk = () => store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const j1 = onDisk();
  assert.equal(j1[0].kind, "version");
  assert.deepEqual({ workflow: j1[0].workflow, version: j1[0].version }, { workflow: "gates", version: wf.WORKFLOW_VERSION });
  assert.ok(j1.some((j) => j.kind === "timer" && /\/e0\/yield\/timer#1$/.test(j.key)), "the yield is a durable timer on disk");
  assert.ok(j1.some((j) => j.kind === "effect" && /\/e0\/yield\/yield#1$/.test(j.key)), "the interrupted result is journaled");

  // Re-driven BEFORE the timer: nothing runs, the same journaled result.
  world.preflight = { ok: true };
  const early = await run();
  assert.deepEqual(early, first);
  assert.equal(world.preflights, 1, "no activity ran");
  assert.equal(onDisk().length, j1.length, "an early re-drive appends nothing");

  // Re-driven AFTER the timer: the workflow continues into the next pass.
  clock.advanceBy(wf.YIELD_MS + 1);
  const late = await run();
  assert.equal(late.state, "passed", JSON.stringify(late));
  assert.equal(world.preflights, 2, "the next pass re-reads the preflight");
  assert.equal(world.dispatches, 1);
  assert.ok(onDisk().some((j) => j.kind === "effect" && /\/e1\//.test(j.key)), "the second pass is journaled under its own epoch");
  assert.equal(world.slept, 0, "a yield never sleeps in-process");

  // ...and the settled journal replays to the settled result with nothing run.
  const settled = await run();
  assert.deepEqual(settled, late);
  assert.equal(world.preflights, 2);
  assert.equal(world.dispatches, 1);
});

test("a reviewer PAUSE yields on its own wake: the parked result carries paused_until, and a re-drive before it dispatches nothing", async () => {
  const home = scratchHome("pause");
  const clock = fakeClock(1_700_000_000_000);
  const factory = factoryOf({ ...BASE, gates: [{ ...GATES[1], cycles: 1 }], implementation: { profile: "profile-impl", retry: { attempts: 3 } } });
  const world = makeWorld({ clock, home, script: { factory } });
  const resetAt = clock.now() + 2 * 3600000;
  let outageReviews = 0;
  world.deps.review = async () => {
    outageReviews += 1;
    return { ok: false, reason: "usage limit", classification: { outcome: "infrastructure", pool: "retry", reason: "usage limit", reset_at: resetAt } };
  };
  let pools = { retry: { spent: 0 } };
  world.deps.loadGatePools = async () => pools;
  world.deps.saveGatePools = async ({ pools: next }) => { pools = next; };
  const run = () => gateRunner.runGatePipeline({ item: ITEM, factory, deps: world.deps });
  const first = await run();
  assert.equal(first.state, "interrupted");
  assert.equal(first.outage_interrupted, true);
  assert.equal(first.paused_until, resetAt);
  assert.equal(outageReviews, 1);
  assert.equal(pools.retry.spent, 1, "the review after the pause is charged before the yield");
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const timer = j.find((x) => x.kind === "timer");
  assert.equal(timer.fireAt, resetAt, "the pause IS the durable timer");

  clock.advanceBy(3600000);
  const early = await run();
  assert.deepEqual(early, first, "still paused: the journaled result, nothing dispatched");
  assert.equal(outageReviews, 1);

  clock.advanceBy(3600000 + 1);
  world.deps.review = async () => ({ ok: true, text: PASS });
  const late = await run();
  assert.equal(late.state, "passed", JSON.stringify(late));
  assert.equal(pools.retry.spent, 1, "the resume takes the retry already charged");
});

test("the outage backoff is a durable timer sliced as the runner sliced it: one sleep per slice, a stop answered inside the wait", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const factory = factoryOf({ ...BASE, gates: [{ ...GATES[1], cycles: 1 }], implementation: { profile: "profile-impl", retry: { attempts: 3, backoff_ms: 90000 } } });
  const world = makeWorld({ clock, script: { factory } });
  let reviews = 0;
  world.deps.review = async () => {
    reviews += 1;
    return reviews === 1 ? { ok: false, reason: "boom", classification: { outcome: "infrastructure", pool: "retry", reason: "the harness ended on an environment failure" } } : { ok: true, text: PASS };
  };
  let pools = { retry: { spent: 0 } };
  world.deps.loadGatePools = async () => pools;
  world.deps.saveGatePools = async ({ pools: next }) => { pools = next; };
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: world.deps });
  assert.equal(res.state, "passed");
  assert.equal(world.slept, 3, "90s in 30s slices: three sleeps, three timers");
  assert.equal(reviews, 2);
  assert.equal(pools.retry.spent, 1);

  // ...and a stop that lands inside the first slice is answered there.
  const clock2 = fakeClock(1_700_000_000_000);
  const w2 = makeWorld({ clock: clock2, script: { factory } });
  w2.deps.review = async () => ({ ok: false, reason: "boom", classification: { outcome: "infrastructure", pool: "retry", reason: "the harness ended on an environment failure" } });
  let pools2 = { retry: { spent: 0 } };
  w2.deps.loadGatePools = async () => pools2;
  w2.deps.saveGatePools = async ({ pools: next }) => { pools2 = next; };
  w2.deps.stopping = () => w2.slept >= 1;
  const stopped = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w2.deps });
  assert.equal(stopped.state, "interrupted");
  assert.match(stopped.reason, /backoff/);
  assert.equal(w2.slept, 1);
  assert.equal(pools2.retry.spent, 1, "the retry stays charged for the resume");
});

// A journal this worker cannot continue is REFUSED, never re-judged
// (task-spor-delete-loop-resume-machinery-after-workflow-stages): the same
// tombstone-then-settle door as the integration and implementation stages
// (stage-workflow.js settleOrRefuse). The settle makes the three §10.7 writes
// under deterministic ids — the escalation that blocks the item, the demotion,
// the art-gate fact — and the result carries the shared refusal tags the run
// record stamps as `gate_refusal`.
test("a journal recorded by another workflow version is REFUSED: tombstoned first, then settled as failed with the escalation, the demotion and the fact — never judged over a fresh in-memory journal; a re-drive re-settles from the tombstone under the same ids", async () => {
  const home = scratchHome("version");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  const h = store.openWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  h.persist({ kind: "version", spec: kernel.JOURNAL_SPEC_VERSION, workflow: "gates", version: "0" });
  h.persist({ kind: "effect", key: "stale", result: null });
  const logs = [];
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: world.deps, log: (l) => logs.push(l) });
  assert.equal(res.state, "failed", JSON.stringify(res));
  assert.equal(res.journal_version_mismatch, true);
  assert.equal(res.refusal_tombstoned, true);
  assert.equal(res.refusal_replayed, undefined);
  assert.equal(res.noRescue, true, "a refusal never reaches the rescue lane");
  assert.match(res.reason, /another version of the workflow/);
  assert.equal(world.suites, 0, "no suite ran");
  assert.equal(world.reviews.length, 0, "no review ran");
  assert.deepEqual(world.escalations, ["task-gate-acceptance"], "the escalation is filed against the first gate of the live list (the stale journal names none)");
  assert.deepEqual(world.demotions, ["task-gate-acceptance"]);
  assert.equal(res.escalated_to, "task-gate-acceptance");
  assert.equal(res.demoted, true);
  assert.deepEqual(res.facts, [...world.facts.keys()]);
  assert.equal(res.facts.length, 1);
  assert.match(world.facts.get(res.facts[0]), /another version of the workflow/);
  assert.ok(!logs.some((l) => /fresh in-memory journal|REPLAY FAULT|gate progress carries/.test(l)), logs.join("\n"));
  const onDisk = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  assert.equal(onDisk.length, 3, "the stale journal gained exactly its tombstone");
  assert.equal(onDisk[2].kind, "tombstone");
  assert.equal(onDisk[2].reason, "journal_version_mismatch");
  assert.equal(onDisk[2].detail.gate.id, "acceptance");

  // A re-drive (a parked re-offer, an orphan resume): re-settled from the
  // tombstone's record — same ids, nothing new on the graph, nothing judged.
  const logs2 = [];
  const again = await gateRunner.runGatePipeline({ item: { ...ITEM, resumed: true }, factory: SCRIPTS.passed.factory, deps: world.deps, log: (l) => logs2.push(l) });
  assert.equal(again.state, "failed");
  assert.equal(again.refusal_replayed, true);
  assert.equal(again.escalated_to, res.escalated_to);
  assert.deepEqual(again.facts, res.facts);
  assert.equal(world.escalations.length, 1);
  assert.equal(world.facts.size, 1);
  assert.equal(world.suites + world.reviews.length, 0);
  assert.ok(logs2.some((l) => /re-settled from the attempt's refusal tombstone/.test(l)), logs2.join("\n"));
  assert.equal(store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" }).length, 3, "a tombstoned journal is never appended to");
});

test("an EDITED definition between two drives of a parked journal is REFUSED at the next live step (the gate list, rescue, implementation, completion, trusted ref, protected paths, test lane and risk classes are the binding — never the revision stamps or the factory id); a revert after the refusal re-settles the refusal, never lands", async () => {
  const home = scratchHome("definition");
  const clock = fakeClock(1_700_000_000_000);
  const w = makeWorld({ clock, home });
  w.preflight = { ok: false, reason: "pending flake evidence belongs to a different or unknown graph" };
  const first = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w.deps });
  assert.equal(first.state, "interrupted");
  w.preflight = { ok: true };
  clock.advanceBy(wf.YIELD_MS + 1);
  // Provenance is not binding: a re-stamped revision, a rename chain, a repo
  // scope, a different factory id — none refuses.
  const restamped = { ...SCRIPTS.passed.factory, id: "factory-renamed", revision: "deadbeef", renamedFrom: ["factory-test"], repos: ["demo"], definition: { ...SCRIPTS.passed.factory.definition, factory: { ...SCRIPTS.passed.factory.definition.factory, revision: "deadbeef" } } };
  assert.equal(wf.definitionBindingDigest(restamped), wf.definitionBindingDigest(SCRIPTS.passed.factory));
  // The integration block is the integration stage's binding, not the gate
  // list's (declaring one re-parses the completion DEFAULT to `after:
  // integration`, which IS a gate-stage input — so the block is swapped on the
  // parsed object here, not re-parsed).
  const otherBlock = { ...SCRIPTS.passed.factory, integration: { mode: "merge", strategy: "merge", targetRef: "main", command: "npm test" } };
  assert.equal(wf.definitionBindingDigest(otherBlock), wf.definitionBindingDigest(SCRIPTS.passed.factory));
  const boundaryMoved = { ...SCRIPTS.passed.factory, completion: { ...SCRIPTS.passed.factory.completion, after: "integration" } };
  assert.notEqual(wf.definitionBindingDigest(boundaryMoved), wf.definitionBindingDigest(SCRIPTS.passed.factory), "the completion boundary is a gate-stage input");
  const edited = factoryOf({ ...BASE, gates: [GATES[0]] });
  assert.notEqual(wf.definitionBindingDigest(edited), wf.definitionBindingDigest(SCRIPTS.passed.factory));
  // Every bound input refuses the same way — the gate list is driven to the
  // settle below; the others are driven over their own parked journals here,
  // each a block gatePass itself branches on (the pin, the pool caps, the
  // completion boundary), so a replay reaches the live-step guard rather than
  // a key mismatch.
  for (const [label, moved] of [
    ["implementation", factoryOf({ ...BASE, gates: GATES, implementation: { profile: "profile-impl", retry: { backoff_ms: 1000 } }, completion: { by: "controller" } })],
    ["completion", { ...SCRIPTS.passed.factory, completion: { ...SCRIPTS.passed.factory.completion, after: "integration" } }],
    ["trusted ref", { ...SCRIPTS.passed.factory, trustedRef: "release" }],
    ["rescue", factoryOf({ ...BASE, gates: GATES, rescue: { profile: "profile-rescue", attempts: 1 } })],
  ]) {
    const homeN = scratchHome(`definition-${label.replace(/\s+/g, "-")}`);
    const wN = makeWorld({ clock, home: homeN });
    wN.preflight = { ok: false, reason: "pending flake evidence belongs to a different or unknown graph" };
    assert.equal((await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: wN.deps })).state, "interrupted", label);
    wN.preflight = { ok: true };
    clock.advanceBy(wf.YIELD_MS + 1);
    const logsN = [];
    const refused = await gateRunner.runGatePipeline({ item: ITEM, factory: moved, deps: wN.deps, log: (l) => logsN.push(l) });
    assert.equal(refused.state, "failed", `${label}: ${JSON.stringify(refused)}`);
    assert.equal(refused.refusal_tombstoned, true, label);
    assert.equal(refused.definition_mismatch.live, wf.definitionBindingDigest(moved), label);
    assert.equal(wN.suites + wN.reviews.length, 0, `${label}: nothing judged`);
    assert.deepEqual(wN.escalations, ["task-gate-acceptance"], label);
    assert.ok(!logsN.some((l) => /REPLAY FAULT|fresh in-memory journal/.test(l)), `${label}: ${logsN.join("\n")}`);
  }
  const logs = [];
  const second = await gateRunner.runGatePipeline({ item: ITEM, factory: edited, deps: w.deps, log: (l) => logs.push(l) });
  assert.equal(second.state, "failed", JSON.stringify(second));
  assert.deepEqual(second.definition_mismatch, { runId: ITEM.run_id, journaled: wf.definitionBindingDigest(SCRIPTS.passed.factory), live: wf.definitionBindingDigest(edited) });
  assert.equal(second.refusal_tombstoned, true);
  assert.match(second.reason, /definition .* was edited while this attempt was in flight/);
  assert.equal(w.suites + w.reviews.length, 0, "nothing was judged under a mixed definition");
  assert.deepEqual(w.escalations, ["task-gate-acceptance"], "filed against the first gate of the list the attempt OPENED under");
  assert.deepEqual(w.demotions, ["task-gate-acceptance"]);
  assert.equal(w.facts.size, 1);
  assert.ok(!logs.some((l) => /fresh in-memory journal|REPLAY FAULT|judging over a fresh/.test(l)), logs.join("\n"));
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  assert.equal(j[j.length - 1].kind, "tombstone");
  assert.equal(j[j.length - 1].reason, "definition_mismatch");
  // Reverted: the journal is closed for good — re-settled, never continued.
  const third = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w.deps });
  assert.equal(third.state, "failed");
  assert.equal(third.refusal_replayed, true);
  assert.equal(w.suites + w.reviews.length, 0);
  assert.equal(w.escalations.length, 1);
  assert.equal(w.facts.size, 1);
});

test("a COMPLETED gate journal is a pure function of the journal: under an EDITED factory — a gate's command, or the gate LIST itself — it replays to the journaled verdicts with nothing re-run, nothing refused, nothing appended and nothing re-logged", async () => {
  const home = scratchHome("settled-edit");
  const clock = fakeClock(1_700_000_000_000);
  const w = makeWorld({ clock, home });
  const first = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w.deps });
  assert.equal(first.state, "passed");
  const onDisk = () => store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const j1 = onDisk();
  const opened = j1.find((x) => x.kind === "effect" && /\/open#1$/.test(x.key));
  assert.deepEqual(opened.result.gates.map((g) => g.id), ["acceptance", "review"], "the gate list rides the open entry");
  assert.equal(opened.result.rescue, null);
  const suites = w.suites;
  const reviews = w.reviews.length;

  for (const [label, factory] of [
    ["the suite command edited", factoryOf({ ...BASE, gates: [{ ...GATES[0], command: "npm run test:all" }, GATES[1]] })],
    ["the gate list moved", factoryOf({ ...BASE, gates: [GATES[0]] })],
    ["a gate added", factoryOf({ ...BASE, gates: [...GATES, { id: "lint", kind: "command", command: "npm run lint" }] })],
  ]) {
    assert.notEqual(wf.definitionBindingDigest(factory), wf.definitionBindingDigest(SCRIPTS.passed.factory), label);
    const logs = [];
    const replayed = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps, log: (l) => logs.push(l) });
    assert.equal(replayed.state, "passed", `${label}: ${JSON.stringify(replayed)}`);
    assert.deepEqual(replayed.gates.map((g) => g.gate), first.gates.map((g) => g.gate), `${label}: the journaled verdicts`);
    assert.deepEqual(logs, [], `${label}: a full replay re-logs nothing — ${logs.join(" | ")}`);
    assert.equal(w.suites, suites, `${label}: no suite re-ran`);
    assert.equal(w.reviews.length, reviews, `${label}: no review re-ran`);
    assert.deepEqual(onDisk(), j1, `${label}: nothing appended`);
    assert.equal(w.escalations.length, 0, `${label}: nothing refused`);
  }
});

test("a journal whose key sequence diverges DURING replay under a binding that has MOVED (its `open` digest differs from the live one) is read as the definition changing and REFUSED through the tombstone door — never thrown as a replay fault; the same divergence under a MATCHING digest is the fault", async () => {
  // The shape a journal recorded before a bound input existed would take once
  // the code branches on that input during replay: the `open` entry's digest
  // no longer matches the live binding, and the next journaled key is one the
  // code no longer asks for. (Every bound input is journaled today, so this is
  // reachable only from such a journal; the version bump refuses the ones that
  // exist, which is why the fallback is pinned here by hand.)
  const home = scratchHome("moved-binding-replay-fault");
  const clock = fakeClock(1_700_000_000_000);
  const w = makeWorld({ clock, home });
  const h = store.openWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  h.persist({ kind: "version", spec: kernel.JOURNAL_SPEC_VERSION, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  h.persist({ kind: "effect", key: `${ITEM.run_id}/gates/a0/e0/open#1`, result: { has: {}, attempt: 0, digest: "sha256:old", factoryId: "factory-test", gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 }], rescue: null } });
  h.persist({ kind: "effect", key: `${ITEM.run_id}/gates/a0/e0/a-key-the-code-no-longer-asks-for#1`, result: {} });
  const logs = [];
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w.deps, log: (l) => logs.push(l) });
  assert.equal(res.state, "failed", JSON.stringify(res));
  assert.equal(res.refusal_tombstoned, true);
  assert.deepEqual(res.definition_mismatch, { runId: ITEM.run_id, journaled: "sha256:old", live: wf.definitionBindingDigest(SCRIPTS.passed.factory) });
  assert.ok(!logs.some((l) => /REPLAY FAULT/.test(l)), logs.join("\n"));
  assert.equal(w.suites + w.reviews.length, 0, "nothing judged");
  assert.deepEqual(w.escalations, ["task-gate-review"], "filed against the first gate of the list the journal OPENED under");
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  assert.equal(j[j.length - 1].kind, "tombstone");
  assert.equal(j[j.length - 1].reason, "definition_mismatch");

  // The control: the same divergence under a digest that MATCHES the live
  // binding is a determinism bug, thrown and tagged (see the next test).
  const home2 = scratchHome("matching-binding-replay-fault");
  const w2 = makeWorld({ clock, home: home2 });
  const h2 = store.openWorkflowJournal(home2, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  h2.persist({ kind: "version", spec: kernel.JOURNAL_SPEC_VERSION, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  h2.persist({ kind: "effect", key: `${ITEM.run_id}/gates/a0/e0/open#1`, result: { has: {}, attempt: 0, digest: wf.definitionBindingDigest(SCRIPTS.passed.factory), factoryId: "factory-test", gates: [], rescue: null } });
  h2.persist({ kind: "effect", key: `${ITEM.run_id}/gates/a0/e0/a-key-the-code-no-longer-asks-for#1`, result: {} });
  let threw = null;
  try {
    await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w2.deps });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && threw.replayFault === true, threw && threw.message);
  assert.equal(w2.escalations.length, 0, "a fault settles nothing");
  assert.equal(store.readWorkflowJournal(home2, "local", "exec-0123456789abcdef", { stage: "gates-a0" }).length, 3, "a fault appends nothing");
});

// A REPLAY FAULT — the journal's key sequence is not the one this code produces
// — is a determinism BUG, and a hard failure: thrown, tagged, never logged as
// a fallback and never judged afresh. Every resume scenario in this file
// asserts the words never appear in a log line; this is the one place they do
// appear, in the thrown error's message.
test("a REPLAY FAULT is a hard failure: the driver throws it tagged `replayFault`, logs no fallback, judges nothing afresh, appends nothing", async () => {
  const home = scratchHome("replay-fault");
  const clock = fakeClock(1_700_000_000_000);
  const w = makeWorld({ clock, home });
  const h = store.openWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  h.persist({ kind: "version", spec: kernel.JOURNAL_SPEC_VERSION, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  h.persist({ kind: "effect", key: `${ITEM.run_id}/gates/a0/e0/not-a-key-this-code-produces#1`, result: {} });
  const before = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const logs = [];
  let threw = null;
  try {
    await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: w.deps, log: (l) => logs.push(l) });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "thrown, not settled");
  assert.equal(threw.replayFault, true);
  assert.match(threw.message, /REPLAY FAULT in the gate workflow for task-demo/);
  assert.ok(threw.cause && /NonDeterminism/.test(threw.cause.name), threw.cause && threw.cause.name);
  assert.deepEqual(logs, [], `nothing logged — ${logs.join(" | ")}`);
  assert.equal(w.suites + w.reviews.length + w.escalations.length + w.facts.size, 0, "nothing judged, nothing filed");
  assert.deepEqual(store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" }), before, "nothing appended");
});

test("the one-shot `fix` and `rescue` are still honored when a caller wires them without the signal halves, and a caller-overridden `fix` wins over the composed halves", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock });
  const fixes = [];
  const oneShot = { ...world.deps };
  delete oneShot.dispatchFix;
  oneShot.fix = async ({ cycle, onLaunch }) => {
    fixes.push(cycle);
    await onLaunch({ runId: `oneshot-${cycle}` });
    world.launched.set(`fix-review-${cycle}`, `oneshot-${cycle}`);
    return { ok: true, runId: `oneshot-${cycle}` };
  };
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: oneShot });
  assert.equal(res.state, "passed");
  assert.deepEqual(fixes, [0]);
  assert.equal(world.progress.get("0:review").lastFix.runId, "oneshot-0", "the launch was recorded on the gate's progress from inside the activity");

  const override = { ...world.deps, fix: async ({ cycle }) => { fixes.push(`override-${cycle}`); world.launched.set(`fix-review-${cycle}-o`, "x"); return { ok: true, runId: "override" }; } };
  const w3 = makeWorld({ clock: fakeClock(1_700_000_000_000) });
  const res2 = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: { ...w3.deps, fix: override.fix } });
  assert.equal(res2.state, "passed");
  assert.equal(w3.dispatches, 0, "an untagged fix is the caller's own and wins over dispatchFix");
  assert.deepEqual(fixes.slice(1), ["override-0"]);
});

test("a RESUMED drive (the loop marks every adopted orphan and parked re-offer `resumed`) continues a yielded journal — the flag is journaled per pass, so the next pass runs the supersession check a resumed pipeline owes, with no fallback", async () => {
  const home = scratchHome("resumed-yield");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  let checks = 0;
  world.deps.resolved = async () => { checks += 1; return { terminal_state: "open" }; };
  world.deps.landed = async () => ({ known: true, landed: false });
  world.preflight = { ok: false, reason: "pending flake evidence belongs to a different or unknown graph" };
  const logs = [];
  const first = await gateRunner.runGatePipeline({ item: ITEM, factory: SCRIPTS.passed.factory, deps: world.deps, log: (l) => logs.push(l) });
  assert.equal(first.state, "interrupted");
  assert.equal(checks, 0, "a pipeline this worker started off its own harvest is not checked");
  world.preflight = { ok: true };
  clock.advanceBy(wf.YIELD_MS + 1);
  const second = await gateRunner.runGatePipeline({ item: { ...ITEM, resumed: true }, factory: SCRIPTS.passed.factory, deps: world.deps, log: (l) => logs.push(l) });
  assert.equal(second.state, "passed", JSON.stringify(second));
  assert.equal(checks, 1, "the resumed pass re-checks supersession");
  assert.equal(world.preflights, 2);
  assert.ok(!logs.some((l) => /fresh in-memory journal|REPLAY FAULT/.test(l)), logs.join("\n"));
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const passes = j.filter((x) => x.kind === "effect" && /\/pass\/pass#1$/.test(x.key)).map((x) => x.result.resumed);
  assert.deepEqual(passes, [false, true], "each pass journals the reading it was driven under");
});

test("an orphan adopted MID-AWAIT (the journal ends on a run another worker dispatched) is CONTINUED through the journal: the dispatch door adopts the same run by name, the delivered signal continues the pass, and the journaled `afterAwait` read runs the supersession check a resumed drive owes — no record-based door", async () => {
  const home = scratchHome("resumed-await");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  let checks = 0;
  world.deps.resolved = async () => { checks += 1; return { terminal_state: "resolved", resolved_by: "dec-x" }; };
  world.deps.landed = async () => ({ known: true, landed: false });
  // Worker A: drive the bare Execution over the FILE journal until it suspends
  // on the fix run, then die.
  const h = store.openWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const a = new Execution(wf.gateWorkflow, { item: ITEM, factory: SCRIPTS.passed.factory, deps: world.deps, log: () => {}, driver: { parked: null } }, { journal: h.journal, persist: h.persist, clock, activities: world.activities, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  const suspended = await a.run();
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.detail.name, "run:fix-1");
  assert.equal(world.dispatches, 1);
  // Worker B adopts the orphan.
  const logs = [];
  const res = await gateRunner.runGatePipeline({ item: { ...ITEM, resumed: true }, factory: SCRIPTS.passed.factory, deps: world.deps, log: (l) => logs.push(l) });
  assert.equal(res.state, "passed", JSON.stringify(res));
  assert.ok(!logs.some((l) => /ends awaiting run|fresh in-memory journal|REPLAY FAULT/.test(l)), logs.join("\n"));
  assert.equal(checks, 1, "the supersession check a resumed pipeline owes ran — once, after the adopted await");
  assert.equal(world.dispatches, 1, "the dispatch door adopted the same run by name");
  assert.equal(world.reviews.length, 2, "the pass continued past the launched fix: one more review, not a re-ask of cycle 0");
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const delivered = j.filter((x) => x.kind === "signal").map((x) => !!x.payload.adopted);
  assert.deepEqual(delivered, [true], "the delivered signal says THIS drive adopted the await");
  const passes = j.filter((x) => x.kind === "effect" && /\/pass\/pass#1$/.test(x.key)).map((x) => x.result.resumed);
  assert.deepEqual(passes, [false], "the pass itself keeps the reading its first drive made");

  // ...and when the item WAS hand-landed meanwhile, the continued pass ends
  // superseded instead of judging on.
  const home2 = scratchHome("resumed-await-landed");
  const w2 = makeWorld({ clock, home: home2 });
  w2.deps.resolved = async () => ({ terminal_state: "resolved", resolved_by: "dec-x" });
  w2.deps.landed = async () => ({ known: true, landed: true, head: "head-v2" });
  const h2 = store.openWorkflowJournal(home2, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  const a2 = new Execution(wf.gateWorkflow, { item: ITEM, factory: SCRIPTS.passed.factory, deps: w2.deps, log: () => {}, driver: { parked: null } }, { journal: h2.journal, persist: h2.persist, clock, activities: w2.activities, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  assert.equal((await a2.run()).status, "suspended");
  const res2 = await gateRunner.runGatePipeline({ item: { ...ITEM, resumed: true }, factory: SCRIPTS.passed.factory, deps: w2.deps });
  assert.equal(res2.state, "superseded", JSON.stringify(res2));
  assert.equal(res2.resolved_by, "dec-x");
  assert.equal(w2.reviews.length, 1, "no review after the adopted fix: the item is already landed");
  assert.equal(w2.dispatches, 1);
});

test("a drive that dispatched a run ITSELF and waited it out owes no post-await check, whatever the loop marked its slot", async () => {
  const home = scratchHome("own-await");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  let checks = 0;
  world.deps.resolved = async () => { checks += 1; return { terminal_state: "open" }; };
  world.deps.landed = async () => ({ known: true, landed: false });
  const res = await gateRunner.runGatePipeline({ item: { ...ITEM, resumed: true }, factory: SCRIPTS.passed.factory, deps: world.deps });
  assert.equal(res.state, "passed");
  assert.equal(checks, 1, "the top-of-pass check a resumed slot owes, and nothing after the fix it launched and followed itself");
  const j = store.readWorkflowJournal(home, "local", "exec-0123456789abcdef", { stage: "gates-a0" });
  assert.deepEqual(j.filter((x) => x.kind === "signal").map((x) => !!x.payload.adopted), [false]);
});

test("a step that THREW out of the workflow on an earlier drive is the SAME failure on the next: the journal is the attempt, and a fresh attempt (a new stage journal) is the door back", async () => {
  const home = scratchHome("replayed-throw");
  const clock = fakeClock(1_700_000_000_000);
  const world = makeWorld({ clock, home });
  // runOneGate catches a thrown suite or review, so reach the unguarded
  // surface through the ancestor read a controller-completion command gate
  // with rejudge_on_repin:false makes after the fix cycle moves the head.
  world.deps.retainedHeadIsAncestor = () => { throw new Error("git is gone"); };
  const controller = factoryOf({ ...BASE, gates: [{ ...GATES[0], rejudge_on_repin: false }, GATES[1]], completion: { by: "controller" }, implementation: { profile: "profile-impl" } });
  let threw = null;
  try {
    await gateRunner.runGatePipeline({ item: ITEM, factory: controller, deps: world.deps });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && /git is gone/.test(threw.message), "the ancestor read escapes the workflow as it escaped the runner");
  const logs = [];
  world.deps.retainedHeadIsAncestor = () => true;
  let again = null;
  try {
    await gateRunner.runGatePipeline({ item: ITEM, factory: controller, deps: world.deps, log: (l) => logs.push(l) });
  } catch (e) {
    again = e;
  }
  assert.ok(again && /git is gone/.test(again.message) && again.replayed === true, "replayed, not re-run");
  assert.ok(!logs.some((l) => /replays a step that threw|fresh in-memory journal|REPLAY FAULT/.test(l)), logs.join("\n"));
  // The next ATTEMPT opens its own journal and runs live.
  const w3 = makeWorld({ clock, home, stage: "gates-a1" });
  w3.deps.retainedHeadIsAncestor = () => true;
  const res = await gateRunner.runGatePipeline({ item: { ...ITEM, attempt: 1 }, factory: controller, deps: w3.deps });
  assert.ok(["passed", "failed"].includes(res.state), JSON.stringify(res));
});

test("the activities table and the binding name the same set", () => {
  const clock = fakeClock(0);
  const world = makeWorld({ clock });
  const bound = Object.keys(world.activities).sort();
  const documented = wf.GATE_ACTIVITIES.map(([name]) => name).filter((n) => !/^(signal|timer) /.test(n)).sort();
  assert.deepEqual(bound, documented);
  assert.ok(wf.GATE_ACTIVITIES.some(([n]) => n === "signal run:<id>"));
  assert.ok(wf.GATE_ACTIVITIES.some(([n]) => n === "signal rescue-run:<id>"));
  assert.ok(wf.GATE_ACTIVITIES.some(([n]) => n === "timer yield"));
  assert.ok(wf.GATE_ACTIVITIES.some(([n]) => n === "timer wait"));
});
