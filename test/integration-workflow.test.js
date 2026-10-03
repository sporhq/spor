// THE INTEGRATION STAGE AS A WORKFLOW FUNCTION (lib/shell/integration-workflow.js,
// task-spor-integration-stage-as-workflow-function): the stage's control flow
// is one deterministic function over the replay kernel, and the proofs the
// spike paid for (spikes/durable-workflow/spike.test.js) hold for it:
//   1. a crash at EVERY activity boundary resumes to the same result and the
//      same side effects — only the before-journal window re-executes, exactly
//      one activity, absorbed by that activity's own idempotency;
//   2. a pure replay over the recorded journal reproduces the result with no
//      activity available to call;
//   3. a worker that dies while a fix cycle runs resumes awaiting the SAME run
//      (the dispatch is journaled with its run id before the await) instead
//      of dispatching a second fixer;
//   4. the unsettled hand-ups are durable YIELDS over the real file journal
//      (execution-store.js openWorkflowJournal): the driver reports
//      `interrupted` exactly as before, a re-drive before the timer returns
//      the same journaled result, and a re-drive after it continues — the
//      next attempt after a ci outage, a retried re-gate after an
//      interrupted one — never replaying the outage verdict forever;
//   5. the activities table and the binding name the same set.
// test/integration-step.test.js is the behavioural oracle (unchanged by the
// rewrite); this file is the durability oracle.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const integrationRunner = require("../lib/shell/integration-runner.js");
const wf = require("../lib/shell/integration-workflow.js");
const store = require("../lib/shell/execution-store.js");
const { Execution, drive, fakeClock } = require("../lib/kernel/workflow.js");

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };
const FACTORY = { id: "factory-demo", integration: { targetRef: "main", mode: "local", command: "npm test", strategy: "merge", serialize: "repo", cycles: 2, timeoutMs: 900000, reruns: 0 } };
// The three scripts the sweep runs over: the landed path (fix cycles, a
// re-gate, a lost race), the SETTLED path (no fix cycles declared: suite
// fails -> escalate -> demote -> fact), and the PARKED path (propose mode:
// propose -> parkForReview -> demote -> fact).
const SCRIPTS = {
  landed: { factory: FACTORY, gatedHead: "head-v1" },
  settled: { factory: { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } }, gatedHead: "head-v1", conflictFree: true },
  parked: { factory: { ...FACTORY, integration: { ...FACTORY.integration, mode: "propose" } }, gatedHead: "head-v1", conflictFree: true, suitePasses: true },
};

// A scripted world whose every answer is a function of its ARGS and of the
// idempotent state the stage leaves (which fix runs were launched, where the
// target ref stands) — never of a call counter — so a re-executed activity
// answers exactly as its first execution did. The script, in order:
//   read head-v1 -> build conflicts -> fix cycle 1 (run fix-1, a signal) ->
//   re-read head-v2 (moved: re-gate passes) -> build ok -> suite fails ->
//   fix cycle 2 (run fix-2) -> re-read head-v3 -> build ok -> suite ok ->
//   land loses the race (the tip moved t1 -> t2) -> rebuild -> land ok.
function makeWorld({ clock, adopt = true, script = SCRIPTS.landed } = {}) {
  const w = { signals: [], calls: new Map(), effects: [], facts: new Map(), escalations: [], demotions: [], parks: [], proposals: 0, dispatches: 0, launched: new Map(), tip: "t1", main: null, builds: 0, cleanups: 0, leases: 0, released: 0, implementerCleaned: 0 };
  const headNow = () => `head-v${1 + w.launched.size}`;
  const deps = {
    now: () => clock.now(),
    changedTree: async () => ({ ok: true, top: "/repo", head: headNow(), cwd: "/repo/wt" }),
    acquireLease: async () => {
      w.leases += 1;
      return { kind: "fake", at: w.leases };
    },
    releaseLease: async () => {
      w.released += 1;
    },
    buildCandidate: async ({ head }) => {
      if (head === "head-v1" && !script.conflictFree) return { ok: false, conflict: true, reason: "merging head-v1 onto main conflicts", evidence: "CONFLICT (content): lib/x.js" };
      w.builds += 1; // candidates actually materialized (a conflict leaves no worktree to tear down)
      return { ok: true, dir: `/tmp/cand-${head}`, sha: `cand-${head}`, expectedSha: w.tip, cleanup: () => { w.cleanups += 1; } };
    },
    forceProtected: async ({ sha }) => ({ ok: true, sha }),
    runSuite: async ({ head }) => (!script.suitePasses && head === (script.conflictFree ? "cand-head-v1" : "cand-head-v2") ? { ok: false, reason: "npm test exited 1", output: "1 failing" } : { ok: true }),
    propose: async ({ head }) => {
      w.proposals += 1;
      return { ok: true, number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: `branch-${head}`, targetRef: "main", detail: "opened PR #42" };
    },
    parkForReview: async ({ proposal }) => {
      const id = `task-integration-proposed-${proposal.number}`;
      w.parks.push(id); // deterministic id: a re-write is the same node
      return { ok: true, id };
    },
    land: async ({ sha, expectedSha }) => {
      if (expectedSha === "t1") {
        w.tip = "t2";
        return { ok: false, race: true, reason: "main moved to t2 since the candidate was built (expected t1)" };
      }
      w.main = sha;
      return { ok: true, sha, detail: `landed ${sha} on main` };
    },
    dispatchFix: async ({ cycle }) => {
      const name = `integration-fix-${cycle}`;
      if (adopt && w.launched.has(name)) return { ok: true, runId: w.launched.get(name), adopted: true };
      w.dispatches += 1;
      const runId = `fix-${w.dispatches}`;
      w.launched.set(name, runId);
      w.signals.push({ name: `run:${runId}`, payload: { ok: true } });
      return { ok: true, runId };
    },
    awaitRun: async () => { throw new Error("the kernel driver delivers run signals in this world"); },
    regate: async ({ head }) => ({ state: "passed", head, gates: [], facts: [] }),
    escalate: async ({ detail }) => {
      w.escalations.push(detail);
      return { ok: true, id: "task-integration-escalate-x" };
    },
    demote: async ({ blockerId }) => {
      w.demotions.push(blockerId);
      return { ok: true, demoted: true };
    },
    recordFact: async ({ id, markdown }) => {
      w.facts.set(id, markdown); // if_exists: skip + identical content — a re-write is the same node
      return { ok: true, id };
    },
    cleanupImplementer: async () => {
      w.implementerCleaned += 1;
    },
  };
  const { activities, resources } = wf.bindIntegrationActivities(deps);
  w.deps = deps;
  w.activities = activities;
  w.resources = resources;
  w.onActivity = ({ key, name }) => {
    w.calls.set(key, (w.calls.get(key) || 0) + 1);
    w.effects.push({ key, name });
  };
  return w;
}

function exec(world, clock, { journal = [], crashPlan = null, gatedHead = "head-v1", factory = FACTORY } = {}) {
  const input = { item: ITEM, factory, gatedHead, deps: world.deps, log: () => {}, driver: { parked: null } };
  return new Execution(wf.integrationWorkflow, input, { journal, clock, activities: world.activities, crashPlan, onActivity: world.onActivity, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
}

// The idempotent effects: the graph nodes written (a Map — if_exists: skip),
// the escalation/tracking items filed (deterministic ids, deduped), the fix
// runs launched (adopt-by-name), where the target ref stands, and whether the
// implementer's worktree is gone (removing a removed worktree is the same end
// state, so the count is not the fact).
const sideEffects = (w) => ({ facts: [...w.facts.keys()].sort(), escalations: [...new Set(w.escalations)], demotions: [...new Set(w.demotions)], parks: [...new Set(w.parks)], dispatches: w.dispatches, main: w.main, implementerCleaned: w.implementerCleaned > 0 });

test("happy path: every activity executes exactly once, the fix cycles arrive as run signals, and a pure replay reproduces the result with no activity available", async () => {
  const clock = fakeClock(1000);
  const world = makeWorld({ clock });
  const e = exec(world, clock);
  const r = await drive(e, { clock, signals: world.signals });
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.result.state, "passed");
  assert.equal(r.result.landed_sha, "cand-head-v3");
  assert.equal(r.result.target_sha, "t2");
  assert.equal(r.result.gated_head, "head-v3", "the moved head was re-gated and stands as the gated head");
  for (const [key, n] of world.calls) assert.equal(n, 1, `${key} executed ${n} times`);
  assert.equal(world.dispatches, 2);
  assert.equal(world.cleanups, 3, "every built candidate (two judged, one rebuilt after the race) is torn down");
  assert.equal(world.leases, 1);
  assert.equal(world.released, 1);
  assert.equal(world.implementerCleaned, 1);
  assert.deepEqual([...world.facts.keys()].map((id) => id.replace(/-[0-9a-f]{8}$/, "")), ["art-merge-demo-runabcde"]);
  assert.equal(e.journal.filter((j) => j.kind === "signal").length, 2);
  assert.equal(e.journal.filter((j) => j.kind === "await" && j.outcome.received).length, 2, "both fix runs were awaited as signals");
  assert.equal(e.journal.filter((j) => j.kind === "timer").length, 0, "nothing yielded");
  assert.equal(world.resources.candidates.size, 0, "no live resource is left behind");
  assert.equal(world.resources.lease, null);

  // Pure replay: activities that would fail loudly if called, the same journal.
  const poison = Object.fromEntries(Object.keys(world.activities).map((k) => [k, () => { throw new Error(`activity ${k} called during pure replay`); }]));
  const replay = new Execution(wf.integrationWorkflow, { item: ITEM, factory: FACTORY, gatedHead: "head-v1", deps: world.deps, log: () => {}, driver: { parked: null } }, { journal: e.journal.slice(), clock, activities: poison, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  const rr = await replay.run();
  assert.equal(rr.status, "completed");
  assert.deepEqual(rr.result, r.result);
  assert.equal(replay.journal.length, e.journal.length, "a pure replay appends nothing");
});

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`crash sweep (${name}): a crash at EVERY activity boundary resumes to the same result AND the same side effects; only the before-journal window re-executes, exactly one activity; every built candidate is torn down`, async () => {
    const refClock = fakeClock(1000);
    const ref = makeWorld({ clock: refClock, script });
    const reference = await drive(exec(ref, refClock, { factory: script.factory, gatedHead: script.gatedHead }), { clock: refClock, signals: ref.signals });
    assert.equal(reference.status, "completed", JSON.stringify(reference));
    assert.equal(reference.result.state, { landed: "passed", settled: "failed", parked: "parked" }[name]);
    const effectCount = ref.effects.length;
    assert.ok(effectCount > 8, `expected a non-trivial effect count, got ${effectCount}`);
    assert.equal(ref.cleanups, ref.builds, "reference: every built candidate is torn down");
    const refEffects = sideEffects(ref);
    if (name === "settled") assert.deepEqual({ e: refEffects.escalations.length, d: refEffects.demotions.length, f: refEffects.facts.length }, { e: 1, d: 1, f: 1 });
    if (name === "parked") assert.deepEqual({ p: refEffects.parks.length, d: refEffects.demotions.length, f: refEffects.facts.length, main: refEffects.main }, { p: 1, d: 1, f: 1, main: null });

    for (const at of ["before-execute", "before-journal", "after-journal"]) {
      for (let nth = 1; nth <= effectCount; nth++) {
        const clock = fakeClock(1000);
        const world = makeWorld({ clock, script });
        let crashed = 0;
        const e = exec(world, clock, { crashPlan: { at, nth }, factory: script.factory, gatedHead: script.gatedHead });
        const r = await drive(e, { clock, signals: world.signals, onCrash: () => crashed++ });
        assert.equal(crashed, 1, `${at}#${nth}: crashed ${crashed} times`);
        assert.equal(r.status, "completed", `${at}#${nth}: ${r.status} ${r.error ? r.error.message : ""}`);
        assert.deepEqual(r.result, reference.result, `${at}#${nth}: result differs`);
        assert.deepEqual(sideEffects(world), refEffects, `${at}#${nth}: side effects differ`);
        // A re-executed build is a second throwaway: torn down too (the
        // binding releases the first on re-registration), so the invariant
        // is cleanups == builds, never "one cleanup".
        assert.equal(world.cleanups, world.builds, `${at}#${nth}: ${world.builds} candidates built, ${world.cleanups} torn down`);
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

test("a factory edited mid-attempt does not fault the journal: the resumed execution keeps judging under the integration block it opened with", async () => {
  // Journal a run under cycles: 2 up to the first fix's await, then resume it
  // with the factory node edited to cycles: 0 — the live block would take the
  // escalate branch where the journal holds a fix dispatch (a replay fault);
  // the journaled block takes the recorded path and lands.
  const clock = fakeClock(1000);
  const world = makeWorld({ clock });
  const held = [];
  const origDispatch = world.deps.dispatchFix;
  world.deps.dispatchFix = async (args) => {
    const r = await origDispatch(args);
    if (!r.adopted) held.push(world.signals.pop());
    return r;
  };
  const first = exec(world, clock);
  assert.equal((await drive(first, { clock, signals: world.signals })).status, "suspended");

  const edited = { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } };
  const world2 = makeWorld({ clock });
  world2.launched.set("integration-fix-0", "fix-1");
  const logs = [];
  const second = new Execution(wf.integrationWorkflow, { item: ITEM, factory: edited, gatedHead: "head-v1", deps: world2.deps, log: (l) => logs.push(l), driver: { parked: null } }, { journal: first.journal.slice(), clock, activities: world2.activities, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
  world2.signals.push(held[0]);
  const r2 = await drive(second, { clock, signals: world2.signals });
  assert.equal(r2.status, "completed", JSON.stringify(r2));
  assert.equal(r2.result.state, "passed");
  assert.equal(world2.dispatches, 1, "the second fix cycle ran under the journaled cycles: 2, not the edited cycles: 0");
  assert.ok(logs.some((l) => /integration block changed while task-demo's integration was in flight/.test(l)), logs.join("\n"));
});

test("WITHOUT adopt-by-name in the fix dispatch, a before-journal crash on it launches a second fixer — the window the activity's own idempotency closes", async () => {
  const refClock = fakeClock(1000);
  const ref = makeWorld({ clock: refClock });
  await drive(exec(ref, refClock), { clock: refClock, signals: ref.signals });
  const nth = ref.effects.findIndex((e) => e.name === "dispatchFix") + 1;
  assert.ok(nth > 0);
  const clock = fakeClock(1000);
  const world = makeWorld({ clock, adopt: false });
  const r = await drive(exec(world, clock, { crashPlan: { at: "before-journal", nth } }), { clock, signals: world.signals });
  assert.equal(r.status, "completed");
  assert.equal(world.dispatches, ref.dispatches + 1, "one extra fixer was launched");
});

test("a worker that dies while a fix cycle runs: the resumed execution awaits the SAME run instead of dispatching a second fixer", async () => {
  const clock = fakeClock(1000);
  const world = makeWorld({ clock });
  // Hold the fix runs' terminal signals back so the first worker parks on one.
  const held = [];
  const origDispatch = world.deps.dispatchFix;
  world.deps.dispatchFix = async (args) => {
    const r = await origDispatch(args);
    if (!r.adopted) held.push(world.signals.pop());
    return r;
  };
  const first = exec(world, clock);
  const r1 = await drive(first, { clock, signals: world.signals });
  assert.equal(r1.status, "suspended");
  assert.equal(r1.kind, "signal");
  assert.equal(r1.detail.name, "run:fix-1");
  assert.equal(world.dispatches, 1);

  // The worker dies; a successor opens the same journal. The box still knows
  // fix-1 was launched (the run record is on disk — here, the launched map),
  // and a dispatch of cycle 0 would throw if called — it is never called: the
  // run id is in the journal, so the successor awaits it and launches only
  // the SECOND fix cycle itself.
  const world2 = makeWorld({ clock });
  world2.launched.set("integration-fix-0", "fix-1");
  const dispatch2 = world2.deps.dispatchFix;
  world2.deps.dispatchFix = async (args) => {
    if (args.cycle === 0) throw new Error("re-dispatched a running fix");
    return dispatch2(args);
  };
  const bound = wf.bindIntegrationActivities(world2.deps);
  world2.activities = bound.activities;
  const second = exec(world2, clock, { journal: first.journal.slice() });
  // deliver the held signal for fix-1; fix-2 is a fresh launch in world2
  world2.signals.push(held[0]);
  const r2 = await drive(second, { clock, signals: world2.signals });
  assert.equal(r2.status, "completed", JSON.stringify(r2));
  assert.equal(r2.result.state, "passed");
  assert.equal(world2.dispatches, 1, "only the second fix cycle was launched by the successor");
  assert.equal(world2.main, "cand-head-v3");
});

// ---------------------------------------------------- the file journal + yields --

function scratchHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spor-intwf-${label}-`));
}
const EXEC = "exec-0123456789abcdef";

// The runner-contract fakes (test/integration-step.test.js's shape), over a
// controllable clock and a file journal.
function stageFakes({ home, clock, suite, regate = null, build = null }) {
  const seen = { trees: 0, builds: 0, suites: 0, lands: 0, fixes: 0, regates: 0, escalations: 0, demotions: 0, facts: [], cleanups: 0, leaseAcquired: 0, leaseReleased: 0, closed: 0, discarded: [] };
  const deps = {
    now: () => clock.now(),
    workflowJournal: () => store.openWorkflowJournal(home, "local", EXEC, { stage: "integration-a0" }),
    changedTree: async () => ({ ok: true, top: "/repo", head: `head-v${1 + seen.fixes}`, cwd: "/repo/wt" }),
    acquireLease: async () => {
      seen.leaseAcquired += 1;
      return { kind: "fake" };
    },
    releaseLease: async () => {
      seen.leaseReleased += 1;
    },
    buildCandidate: async (args) => {
      seen.builds += 1;
      const r = build ? build(args, seen) : { ok: true, dir: `/tmp/candidate-${seen.builds}`, sha: `cand-${args.head}`, expectedSha: "expected1" };
      return { cleanup: () => { seen.cleanups += 1; }, ...r };
    },
    discardCandidate: async ({ dir }) => {
      seen.discarded.push(dir);
    },
    forceProtected: async ({ sha }) => ({ ok: true, sha }),
    runSuite: async (args) => {
      seen.suites += 1;
      return suite(args, seen);
    },
    closeSuite: async () => {
      seen.closed += 1;
    },
    land: async ({ sha }) => {
      seen.lands += 1;
      return { ok: true, sha, detail: `landed ${sha}` };
    },
    fix: async () => {
      seen.fixes += 1;
      return { ok: true, runId: `fix-${seen.fixes}` };
    },
    ...(regate ? { regate: async (args) => { seen.regates += 1; return regate(args, seen); } } : {}),
    escalate: async () => {
      seen.escalations += 1;
      return { ok: true, id: "task-integration-escalate-x" };
    },
    demote: async () => {
      seen.demotions += 1;
      return { ok: true, demoted: true };
    },
    recordFact: async ({ id, markdown }) => {
      seen.facts.push({ id, markdown });
      return { ok: true, id };
    },
    cleanupImplementer: async () => {
      seen.implementerCleaned = true;
    },
  };
  return { deps, seen };
}

test("a ci outage YIELDS over the file journal: reported interrupted as before, the same result on an early re-drive, and the next attempt on a late one — no second escalation, no replayed outage", async () => {
  const home = scratchHome("outage");
  const clock = fakeClock(1_700_000_000_000);
  let ciUp = false;
  const { deps, seen } = stageFakes({ home, clock, suite: () => (ciUp ? { ok: true } : { ok: false, reason: "CI workflow `test.yaml` run 9 concluded 'cancelled'", outage: { outcome: "infrastructure", reason: "cancelled" } }) });
  const factory = { ...FACTORY, integration: { ...FACTORY.integration, reruns: 2, ci: { workflow: "test.yaml" } } };

  const first = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.equal(first.state, "interrupted");
  assert.equal(first.outage_interrupted, true);
  assert.match(first.reason, /an outage, not a verdict on the change/);
  assert.equal(seen.suites, 1);
  assert.equal(seen.closed, 1);
  assert.equal(seen.cleanups, 1, "the candidate is torn down before the yield");
  assert.equal(seen.leaseReleased, 1, "the lease is released before the yield");
  assert.equal(seen.escalations, 0);
  assert.equal(seen.facts.length, 0);
  const onDisk = () => store.readWorkflowJournal(home, "local", EXEC, { stage: "integration-a0" });
  const j1 = onDisk();
  assert.ok(j1.some((j) => j.kind === "timer"), "the yield is a durable timer on disk");
  assert.ok(j1.some((j) => j.kind === "effect" && /\/yield\/0\/parked$/.test(j.key)), "the interrupted result is journaled");
  assert.equal(j1[0].kind, "version");
  assert.deepEqual({ workflow: j1[0].workflow, version: j1[0].version }, { workflow: "integration", version: "1" });

  // Re-driven BEFORE the timer: nothing runs, the same journaled result.
  ciUp = true;
  const early = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.equal(early.state, "interrupted");
  assert.equal(early.reason, first.reason);
  assert.equal(seen.suites, 1, "no activity ran");
  assert.equal(seen.builds, 1);
  assert.equal(onDisk().length, j1.length, "an early re-drive appends nothing");

  // Re-driven AFTER the timer: the workflow continues from the yield — a
  // fresh tree read, the next attempt, and a landing.
  clock.advanceBy(wf.YIELD_MS + 1);
  const late = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.equal(late.state, "passed", JSON.stringify(late));
  assert.equal(seen.builds, 2, "one rebuild, never a replay of the first candidate");
  assert.equal(seen.suites, 2);
  assert.equal(seen.lands, 1);
  assert.equal(seen.fixes, 0, "an outage is never a fix cycle");
  assert.equal(seen.escalations, 0);
  assert.equal(seen.leaseAcquired, 2, "the lease is re-taken after the yield");
  assert.equal(seen.leaseReleased, 2);
  assert.equal(seen.cleanups, 2);
  assert.equal(seen.facts.length, 1);
  assert.match(seen.facts[0].markdown, /^landed_sha: cand-head-v1$/m);
  assert.ok(seen.implementerCleaned);

  // ...and the settled journal replays to the settled result with nothing run.
  const settled = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.deepEqual(settled, late);
  assert.equal(seen.builds, 2);
});

test("a re-gate interrupted mid-outage YIELDS too: the re-drive retries the re-gate under a new key and lands — the stage never replays the interrupted verdict", async () => {
  const home = scratchHome("regate");
  const clock = fakeClock(1_700_000_000_000);
  let outage = true;
  const { deps, seen } = stageFakes({
    home, clock,
    suite: () => ({ ok: true }),
    build: (args, s) => (s.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: `/tmp/candidate-${s.builds}`, sha: `cand-${args.head}`, expectedSha: "expected2" }),
    regate: ({ head }) => (outage ? { state: "interrupted", outage_interrupted: true, reason: "the worker was asked to stop while gate review was waiting out an outage", gates: [], facts: [] } : { state: "passed", head, gates: [], facts: [] }),
  });
  const first = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.equal(first.state, "interrupted");
  assert.equal(first.outage_interrupted, true);
  assert.match(first.reason, /waiting out an outage/);
  assert.equal(seen.fixes, 1);
  assert.equal(seen.regates, 1);
  assert.equal(seen.leaseReleased, seen.leaseAcquired);
  assert.equal(seen.facts.length, 0);

  outage = false;
  clock.advanceBy(wf.YIELD_MS + 1);
  const second = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.equal(second.state, "passed", JSON.stringify(second));
  assert.equal(seen.fixes, 1, "the fix cycle is not re-run — its result is in the journal");
  assert.equal(seen.regates, 2, "the re-gate is retried once, under the next key");
  assert.equal(seen.builds, 2);
  assert.equal(second.gated_head, "head-v2");
  assert.equal(second.landed_sha, "cand-head-v2");
  assert.equal(seen.escalations, 0);
  assert.equal(seen.demotions, 0);
});

test("a resumed worker tears down its predecessor's candidate by path: the cleanup closure is gone, discardCandidate runs instead", async () => {
  const home = scratchHome("discard");
  const clock = fakeClock(1_700_000_000_000);
  // First process: crash right after the build is journaled (the kernel's
  // after-journal seam, driven by hand), leaving the candidate standing.
  const a = stageFakes({ home, clock, suite: () => ({ ok: true }) });
  const { activities } = wf.bindIntegrationActivities(a.deps);
  const h1 = a.deps.workflowJournal();
  const e1 = new Execution(wf.integrationWorkflow, { item: ITEM, factory: FACTORY, gatedHead: null, deps: a.deps, log: () => {}, driver: { parked: null } }, {
    journal: h1.journal, persist: h1.persist, clock, activities, crashPlan: { at: "after-journal", nth: 5 }, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION,
  });
  const r1 = await e1.run();
  assert.equal(r1.status, "crashed");
  assert.equal(a.seen.builds, 1);
  assert.equal(a.seen.cleanups, 0, "the dead worker never ran its cleanup closure");

  // Second process over the same file: no closure, so the discard runs.
  const b = stageFakes({ home, clock, suite: () => ({ ok: true }) });
  const r2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps: b.deps });
  assert.equal(r2.state, "passed");
  assert.equal(b.seen.builds, 0, "the build is replayed, never re-executed");
  assert.equal(b.seen.cleanups, 0);
  assert.deepEqual(b.seen.discarded, ["/tmp/candidate-1"]);
});

test("the activities table and the binding name the same set", () => {
  const { activities } = wf.bindIntegrationActivities({});
  const bound = Object.keys(activities).sort();
  const listed = wf.INTEGRATION_ACTIVITIES.map(([name]) => name).filter((n) => !/^(signal|timer) /.test(n)).sort();
  assert.deepEqual(bound, listed);
});
