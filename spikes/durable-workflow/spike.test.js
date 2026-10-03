// spikes/durable-workflow/spike.test.js — crash/replay proofs over the gate
// pipeline written as a workflow function, run against the SHIPPED kernel
// (lib/kernel/workflow.js, promoted from this spike's harness.js). NOT part of
// `npm test` (a spike is not a shipped surface); run it with:
//
//   node --test spikes/durable-workflow/spike.test.js
//
// Each test names the shipped defect class it exercises (the relates-to
// issues on task-spor-gate-orchestration-durable-workflow-spike) so the report
// can say which ones the MODEL makes structurally impossible and which stay
// in the activities.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Execution, drive, fakeClock } = require("../../lib/kernel/workflow.js");
const { gatePipeline, ACTIVITIES } = require("./pipeline.workflow.js");

// A fake world: a repo whose head moves when a fix commits, a graph that
// records idempotent writes, a scheduler that turns every dispatch into a
// terminal signal. `script` shapes outcomes per dispatch kind.
//
// The dispatch activities model the shipped ADOPT-BY-NAME rule: a dispatch
// re-executed under a key it already launched for returns the SAME run and
// signals nothing new. Set `adopt: false` to see what happens without it.
function makeWorld({ script = {}, clock, adopt = true } = {}) {
  const calls = new Map(); // key -> count of EXECUTIONS (not replays)
  const effects = []; // ordered executions
  const graph = new Map(); // id -> node
  const signals = []; // pending signals await drive() delivers
  const repo = { head: "aaaa0001", tip: "base0001", commits: 0 };
  const launched = new Map(); // dispatch key -> run_id (the "run named after its key" the adapters adopt)
  let dispatches = 0;
  const next = (kind) => {
    const q = script[kind] || [];
    return q.length ? q.shift() : null;
  };
  const dispatch = (kind, onLaunch) => (args, { key }) => {
    if (adopt && launched.has(key)) return { run_id: launched.get(key), adopted: true };
    const run_id = `${kind}-${++dispatches}`;
    launched.set(key, run_id);
    const outcome = onLaunch(next(kind), args);
    signals.push({ name: `run:${run_id}`, payload: outcome, atOrAfter: clock.now() });
    return { run_id };
  };
  const activities = {
    readChange: () => ({ ok: true, head: repo.head, base: repo.tip, tree: `tree-${repo.head}`, paths: script.paths || ["lib/x.js"], empty: false }),
    pinCandidate: ({ tree }) => ({ candidate_id: `cand-${tree}` }),
    runSuite: ({ gate }) => {
      const s = next(`suite:${gate || "integration"}`);
      return s === null ? { passed: true } : { passed: s.passed, failedFiles: s.failedFiles || [] };
    },
    dispatchReview: dispatch("review", (s) => s || { state: "report", findings: [] }),
    dispatchFix: dispatch("fix", (s) => {
      repo.head = `aaaa${String(++repo.commits + 1).padStart(4, "0")}`;
      return s || { state: "done" };
    }),
    dispatchRescue: dispatch("rescue", (s) => {
      repo.head = `rrrr${String(++repo.commits + 1).padStart(4, "0")}`;
      return s || { state: "done", diagnosis: "fixed the thing" };
    }),
    dispatchImplementer: dispatch("impl", (s) => s || { state: "candidate" }),
    writeFact: ({ id, ...rest }) => {
      if (graph.has(id)) return { id, existing: true }; // if_exists: skip
      graph.set(id, { id, ...rest });
      return { id, created: true };
    },
    fileEscalation: ({ id, ...rest }) => {
      if (!graph.has(id)) graph.set(id, { id, ...rest });
      return { id };
    },
    demote: ({ nodeId }) => ({ demoted: nodeId }),
    buildCandidate: ({ head }) => {
      const s = next("build");
      if (s && s.conflict) return { ok: false, reason: "merge conflict" };
      return { ok: true, dir: "/tmp/cand", candidateSha: `merge-${head}-${repo.tip}`, baseSha: repo.tip };
    },
    landCAS: ({ expectedBase, candidateSha }) => {
      const s = next("land");
      if (s && s.lost) { repo.tip = `base-moved-${++repo.commits}`; return { lost: true }; }
      if (expectedBase !== repo.tip) return { lost: true };
      repo.tip = candidateSha;
      return { landed: true, sha: candidateSha };
    },
    writeCompletion: ({ nodeId, resolver }) => {
      graph.set(nodeId, { id: nodeId, status: "done", resolver });
      return { ok: true };
    },
  };
  // count executions per key via the harness's onActivity hook
  const onActivity = ({ key, name }) => {
    calls.set(key, (calls.get(key) || 0) + 1);
    effects.push({ key, name });
  };
  return { activities, calls, effects, graph, signals, repo, launched, onActivity, get dispatches() { return dispatches; } };
}

const FACTORY = {
  trustedRef: "main",
  gates: [
    { id: "gate-suite", kind: "command", command: "npm test", cycles: 1, reruns: 1, protectedPaths: ["test/**"] },
    { id: "gate-review", kind: "agent-review", profile: "profile-codex", cycles: 2, pauseMaxMs: 48 * 3600e3 },
    { id: "gate-auth", kind: "human", riskPaths: ["lib/auth.js"], approvalTimeoutMs: 3600e3 },
  ],
  rescue: { attempts: 1 },
  integration: { targetRef: "main", strategy: "merge", command: "npm test", cycles: 1, mode: "local" },
  completion: { by: "controller", after: "integration" },
};
const ITEM = { node_id: "task-x", run_id: "run-0001" };

function exec(world, clock, { factory = FACTORY, journal = [], crashPlan = null } = {}) {
  return new Execution(gatePipeline, { item: ITEM, factory }, { journal, clock, activities: world.activities, crashPlan, onActivity: world.onActivity });
}
async function runPipeline(world, clock, opts = {}) {
  const e = exec(world, clock, opts);
  const r = await drive(e, { clock, signals: world.signals });
  return { exec: e, r };
}
const keysMatching = (world, re) => [...world.calls.keys()].filter((k) => re.test(k));

test("happy path: every activity executes exactly once and the journal replays to the same result with no activity available", async () => {
  const clock = fakeClock(1000);
  const world = makeWorld({ clock });
  const { exec: e, r } = await runPipeline(world, clock);
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  for (const [key, n] of world.calls) assert.equal(n, 1, `${key} executed ${n} times`);
  assert.ok(world.graph.has("task-x") && world.graph.get("task-x").status === "done");
  assert.ok([...world.graph.keys()].some((k) => k.startsWith("art-attest-")));

  // Pure replay: a fresh execution over the recorded journal, with activities
  // that would fail loudly if called, reproduces the result byte-for-byte.
  const poison = Object.fromEntries(Object.keys(world.activities).map((k) => [k, () => { throw new Error(`activity ${k} called during pure replay`); }]));
  const replay = new Execution(gatePipeline, { item: ITEM, factory: FACTORY }, { journal: e.journal.slice(), clock, activities: poison });
  const rr = await replay.run();
  assert.equal(rr.status, "completed");
  assert.deepStrictEqual(rr.result, r.result);
});

test("crash sweep: a crash at EVERY activity boundary resumes to the same result AND the same side effects; only the before-journal window re-executes, exactly one activity, absorbed by the activity's own idempotency", async () => {
  // Reference run: the effects, the graph, and the runs the happy path produces.
  const refClock = fakeClock(1000);
  const ref = makeWorld({ clock: refClock });
  const reference = await runPipeline(ref, refClock);
  const effectCount = ref.effects.length;
  assert.ok(effectCount > 10, `expected a non-trivial effect count, got ${effectCount}`);
  const refGraph = [...ref.graph.keys()].sort();
  const refRuns = ref.dispatches;

  for (const at of ["before-execute", "before-journal", "after-journal"]) {
    for (let nth = 1; nth <= effectCount; nth++) {
      const clock = fakeClock(1000);
      const world = makeWorld({ clock });
      let crashed = 0;
      const e = exec(world, clock, { crashPlan: { at, nth } });
      const r = await drive(e, { clock, signals: world.signals, onCrash: () => crashed++ });
      assert.equal(crashed, 1, `${at}#${nth}: crashed ${crashed} times`);
      assert.equal(r.status, "completed", `${at}#${nth}: ${r.status}`);
      assert.deepStrictEqual(r.result, reference.r.result, `${at}#${nth}: result differs`);
      // SIDE EFFECTS, not just results: the same graph nodes, the same number
      // of agent runs launched — no doubled fact, no second reviewer.
      assert.deepStrictEqual([...world.graph.keys()].sort(), refGraph, `${at}#${nth}: graph differs`);
      assert.equal(world.dispatches, refRuns, `${at}#${nth}: ${world.dispatches} runs launched, expected ${refRuns}`);
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

test("WITHOUT adopt-by-name in the dispatch activity, a before-journal crash on a dispatch launches a second agent — the model narrows duplicate dispatch to that window; closing it is the activity's job", async () => {
  const refClock = fakeClock(1000);
  const ref = makeWorld({ clock: refClock });
  await runPipeline(ref, refClock);
  const nth = ref.effects.findIndex((e) => e.name === "dispatchReview") + 1;
  assert.ok(nth > 0);
  const clock = fakeClock(1000);
  const world = makeWorld({ clock, adopt: false });
  const e = exec(world, clock, { crashPlan: { at: "before-journal", nth } });
  const r = await drive(e, { clock, signals: world.signals });
  assert.equal(r.status, "completed");
  assert.equal(world.dispatches, ref.dispatches + 1, "one extra reviewer was launched");
  const delivered = e.journal.filter((j) => j.kind === "signal").length;
  const consumed = e.journal.filter((j) => j.kind === "await" && j.outcome.received).length;
  assert.equal(delivered - consumed, 1, "and its terminal signal is orphaned in the journal, never awaited");
});

test("a worker that dies while a review is running: the resumed execution awaits the same run instead of dispatching a second reviewer (issue-spor-gate-pipeline-durability-concurrency §duplicate dispatches)", async () => {
  const clock = fakeClock(1000);
  const world = makeWorld({ clock, script: { review: [{ state: "report", findings: [] }] } });
  // Hold the review's terminal signal back so the first worker parks on it.
  const held = [];
  const origDispatch = world.activities.dispatchReview;
  world.activities.dispatchReview = (args, meta) => { const r = origDispatch(args, meta); if (!r.adopted) held.push(world.signals.pop()); return r; };
  const exec1 = exec(world, clock);
  const r1 = await drive(exec1, { clock, signals: world.signals });
  assert.equal(r1.status, "suspended");
  assert.equal(r1.kind, "signal");
  assert.match(r1.detail.name, /^run:review-1$/);
  // worker 1 is gone. Worker 2 picks the journal up: no "orphan adoption", no
  // "gate_state", no "deferred while a live run exists" — the journal says a
  // review is out, so the workflow waits for it.
  const exec2 = exec(world, clock, { journal: exec1.journal });
  world.signals.push(...held);
  const r2 = await drive(exec2, { clock, signals: world.signals });
  assert.equal(r2.status, "completed");
  assert.equal(r2.result.state, "passed");
  assert.equal(world.calls.get("run-0001/gate/gate-review/pass/1/review/1/dispatch"), 1, "the reviewer was dispatched once");
});

test("a fix cycle that moves the head restarts from gate 0 with each gate's memory intact; cycles spent, the rescue lane runs; superseded facts keep their ids", async () => {
  const clock = fakeClock(1000);
  const blocking = { id: "f1", file: "lib/x.js", severity: "blocking", evidence: "node -e ... throws" };
  const world = makeWorld({
    clock,
    script: {
      review: [
        { state: "report", findings: [blocking] }, // pass 1: blocks -> fix 1
        { state: "report", findings: [blocking] }, // pass 2: blocks -> fix 2
        { state: "report", findings: [blocking] }, // pass 3: cycles (2) spent -> RESCUE
        { state: "report", findings: [{ ...blocking, status: "resolved" }] }, // rescue pass: clean
      ],
    },
  });
  const { r } = await runPipeline(world, clock);
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  assert.equal(r.result.rescues, 1);
  assert.equal(r.result.passes, 4, "three gate-list passes then the rescue pass");
  // the command suite re-ran at every moved head (gate 0 restart) — 4 heads, 4 suite runs
  assert.equal(keysMatching(world, /gate\/gate-suite\/pass\/\d+\/run\/0$/).length, 4);
  // fact ids fold the judged head in, so the superseded facts keep their own ids
  assert.equal([...world.graph.keys()].filter((k) => k.startsWith("art-gate-gate-review-")).length, 4);
  assert.ok(world.graph.has("art-rescue-task-x-run0001-x1"));
  assert.equal(r.result.escalations.length, 0);
});

test("after the rescue each gate gets a FRESH fix-cycle budget with the ledger carried; a second refusal after the last rescue escalates", async () => {
  const clock = fakeClock(1000);
  const blocking = { id: "f1", file: "lib/x.js", severity: "blocking", evidence: "throws" };
  const world = makeWorld({
    clock,
    script: {
      review: [
        { state: "report", findings: [blocking] }, // p1 -> fix 1
        { state: "report", findings: [blocking] }, // p2 -> fix 2
        { state: "report", findings: [blocking] }, // p3 -> cap (2) -> rescue
        { state: "report", findings: [blocking] }, // rescue pass -> fresh budget: fix 3
        { state: "report", findings: [blocking] }, // -> fix 4
        { state: "report", findings: [blocking] }, // -> fresh cap spent, no rescue left -> escalate
      ],
    },
  });
  const { r } = await runPipeline(world, clock);
  assert.equal(r.result.state, "failed");
  assert.equal(r.result.rescues, 1);
  assert.equal(keysMatching(world, /gate\/gate-review\/pass\/\d+\/fix\/\d+\/dispatch$/).length, 4, "2 fixes before the rescue, 2 after");
  assert.deepStrictEqual(r.result.escalations, ["task-gate-escalation-task-x-run0001"]);
  // the ledger was carried into the rescue pass: the reviewer after the rescue was handed the prior finding
  const postRescueReview = world.effects.find((e) => e.name === "dispatchReview" && /pass\/4\//.test(e.key));
  assert.ok(postRescueReview);
});

test("a reviewer outage with a stated reset is a durable PAUSE: the workflow suspends until the reset, spends the retry pool not a fix cycle, and re-dispatches once (issue-spor-codex-usage-limit-outage-read-as-a-code-failure, issue-spor-integration-regate-misreads-reviewer-pause)", async () => {
  const clock = fakeClock(1000);
  const resetAt = 1000 + 2 * 3600e3;
  const world = makeWorld({ clock, script: { review: [{ state: "infrastructure", reset_at: resetAt }, { state: "report", findings: [] }] } });
  const e = exec(world, clock);
  let r = await e.run();
  assert.equal(r.status, "suspended"); // awaiting the review run's signal
  for (const s of world.signals.splice(0)) e.signal(s.name, s.payload); // the supervisor reports the run's end
  r = await e.run();
  assert.equal(r.status, "suspended");
  assert.equal(r.kind, "timer");
  assert.equal(r.detail.fireAt, resetAt, "the timer is the reviewer's own stated reset");
  // nothing happens while parked: no slot, no poll, no fix
  assert.equal(keysMatching(world, /\/fix\//).length, 0);
  const done = await drive(e, { clock, signals: world.signals });
  assert.equal(done.status, "completed");
  assert.equal(done.result.state, "passed");
  assert.equal(done.result.retries, 1, "the pause spent the shared retry pool");
  assert.ok(clock.now() >= resetAt);
  assert.equal(keysMatching(world, /review\/\d+\/dispatch$/).length, 2, "one dispatch before the outage, one after the pause");
  assert.equal([...world.graph.values()].filter((n) => n.verdict === "infrastructure").length, 0, "a pause is not a verdict");
});

test("a reset beyond pause_max_ms goes to a person (fact + escalation, no rescue); a spent retry pool does the same; the implementer's outages draw on the SAME pool", async () => {
  // beyond pause_max
  {
    const clock = fakeClock(1000);
    const world = makeWorld({ clock, script: { review: [{ state: "infrastructure", reset_at: 1000 + 72 * 3600e3 }] } });
    const { r } = await runPipeline(world, clock);
    assert.equal(r.result.state, "failed");
    assert.equal(r.result.rescues, 0);
    assert.equal([...world.graph.values()].filter((n) => n.verdict === "infrastructure").length, 1, "the refusal is a gate fact");
    assert.equal(r.result.escalations.length, 1);
  }
  // pool shared between implementer and reviewer, bounded
  {
    const clock = fakeClock(1000);
    const factory = { ...FACTORY, implementation: { attempts: 2, retry_backoff_ms: 1000 }, retry: { attempts: 2 } };
    const world = makeWorld({ clock, script: { impl: [{ state: "infrastructure" }, { state: "candidate" }], review: [{ state: "infrastructure", reset_at: 5000 }, { state: "infrastructure", reset_at: 9000 }] } });
    const { r } = await runPipeline(world, clock, { factory });
    assert.equal(r.result.state, "failed");
    assert.equal(r.result.retries, 2, "one implementer outage + one reviewer outage spent the pool of 2");
    assert.equal(keysMatching(world, /^run-0001\/impl\/\d+\/dispatch$/).length, 2);
    assert.equal(keysMatching(world, /review\/\d+\/dispatch$/).length, 2, "the second reviewer outage found the pool spent");
    assert.match(r.result.reason, /retry pool \(2\) spent/);
  }
  // an outage never spends the attempt budget: [outage, failed] with attempts: 2 still leaves one genuine attempt
  {
    const clock = fakeClock(1000);
    const factory = { ...FACTORY, implementation: { attempts: 2, retry_backoff_ms: 1000 } };
    const world = makeWorld({ clock, script: { impl: [{ state: "infrastructure" }, { state: "failed" }, { state: "candidate" }] } });
    const { r } = await runPipeline(world, clock, { factory });
    assert.equal(r.result.state, "passed");
    assert.equal(keysMatching(world, /impl\/\d+\/dispatch$/).length, 3);
  }
  // an implementer outage loop is bounded by the pool, never unbounded
  {
    const clock = fakeClock(1000);
    const factory = { ...FACTORY, implementation: { attempts: 1, retry_backoff_ms: 1000 } };
    const world = makeWorld({ clock, script: { impl: Array.from({ length: 50 }, () => ({ state: "infrastructure" })) } });
    const { r } = await runPipeline(world, clock, { factory });
    assert.equal(r.result.state, "escalated");
    assert.equal(keysMatching(world, /^run-0001\/impl\/\d+\/dispatch$/).length, 4, "3 retries + the refused 4th");
  }
});

test("a human gate blocks on an approval signal with a durable deadline: approved passes; timeout settles blocked, demotes, files no escalation; refusal escalates", async () => {
  for (const answer of ["approve", "timeout", "refuse"]) {
    const clock = fakeClock(1000);
    const world = makeWorld({ clock, script: { paths: ["lib/auth.js"] } });
    const approvalId = "task-approval-task-x-run0001-gate-auth";
    if (answer === "approve") world.signals.push({ name: `approval:${approvalId}`, payload: { approved: true }, atOrAfter: 1000 + 600e3 });
    if (answer === "refuse") world.signals.push({ name: `approval:${approvalId}`, payload: { approved: false }, atOrAfter: 1000 + 600e3 });
    const { r } = await runPipeline(world, clock);
    assert.equal(r.status, "completed", answer);
    assert.ok(world.graph.has(approvalId), "the approval item was filed under its deterministic id");
    if (answer === "approve") { assert.equal(r.result.state, "passed"); assert.equal(world.calls.get("run-0001/demote"), undefined); }
    if (answer === "timeout") {
      assert.equal(r.result.state, "blocked");
      assert.equal(r.result.escalations.length, 0, "a timeout decides nothing for the person");
      assert.equal(world.calls.get("run-0001/demote"), 1, "but the item is demoted (§10.7) with the approval item as blocker");
    }
    if (answer === "refuse") { assert.equal(r.result.state, "failed"); assert.equal(r.result.escalations.length, 1); }
  }
});

test("integration: a lost CAS race is retried on its own bound and never charged; a conflict is a fix cycle that re-gates the moved head over the SAME state (cumulative caps, no implementer re-run, one attestation)", async () => {
  const clock = fakeClock(1000);
  const blocking = { id: "f1", file: "lib/x.js", severity: "blocking", evidence: "throws" };
  const resolved = { ...blocking, status: "resolved" };
  const factory = { ...FACTORY, implementation: { attempts: 1 } };
  const world = makeWorld({
    clock,
    script: {
      land: [{ lost: true }, { lost: true }],
      build: [null, null, { conflict: true }],
      // gate list pass 1: review blocks once (fix 1 of cap 2) then passes.
      // integration conflict -> fix -> REGATE: review blocks again (fix 2 of cap 2), then passes.
      // A clean verdict must RESOLVE the carried finding: one that ignores it is changes_requested for the prior set.
      review: [{ state: "report", findings: [blocking] }, { state: "report", findings: [resolved] }, { state: "report", findings: [{ ...blocking, introduced_by_fix: true }] }, { state: "report", findings: [resolved] }],
    },
  });
  const { r } = await runPipeline(world, clock, { factory });
  assert.equal(r.status, "completed");
  assert.equal(r.result.state, "passed");
  assert.equal(keysMatching(world, /integration\/\d+\/land$/).length, 3, "two lost races + one landing");
  assert.equal(keysMatching(world, /integration\/3\/fix$/).length, 1);
  assert.ok(keysMatching(world, /^run-0001#regate1\/gate\/gate-suite\//).length > 0, "the regate re-ran the gate list under its own key namespace");
  assert.equal(keysMatching(world, /impl\/\d+\/dispatch$/).length, 1, "the implementer ran once — the regate never re-dispatches it");
  assert.equal([...world.graph.keys()].filter((k) => k.startsWith("art-attest-")).length, 1, "one attestation per run, written by the parent");
  assert.ok(world.graph.has("art-merge-task-x-run0001"));
  // cumulative: the regate's review fix was the SECOND of a cap of 2 — a third blocking verdict would have refused
  const fixes = world.effects.filter((e) => e.name === "dispatchFix" && /gate-review/.test(e.key)).map((e) => e.key);
  assert.deepStrictEqual(fixes, ["run-0001/gate/gate-review/pass/1/fix/1/dispatch", "run-0001#regate1/gate/gate-review/pass/1/fix/2/dispatch"]);
  // and the attestation lists the regate's facts too
  const attest = [...world.graph.values()].find((n) => n.id.startsWith("art-attest-"));
  assert.ok(attest.facts.some((f) => f.includes("gate-review") && f.includes("-run0001r-")), "regate facts are on the parent's attestation");
  assert.ok(attest.facts.length >= 6);
});

test("a protected-path touch (glob-matched) fails closed before the suite, unrun and unrescued; an escalation and demotion land under deterministic ids", async () => {
  const clock = fakeClock(1000);
  const world = makeWorld({ clock, script: { paths: ["test/foo.test.js"] } });
  const { r } = await runPipeline(world, clock);
  assert.equal(r.result.state, "failed");
  assert.equal(r.result.rescues, 0);
  assert.equal(keysMatching(world, /\/run\//).length, 0, "the suite never ran");
  assert.ok(world.graph.has("task-gate-escalation-task-x-run0001"));
  assert.equal(world.calls.get("run-0001/demote"), 1);
});

test("harness: a signal consumed by a replayed await does not resurface to a later await for the same name (replay is a function of the journal)", async () => {
  const wf = (ctx) => {
    const a = ctx.awaitSignal("k1", "approval:x");
    const b = ctx.awaitSignal("k2", "approval:x");
    return { a: a.received, b: b.received };
  };
  const clock = fakeClock(0);
  const e = new Execution(wf, {}, { journal: [], clock });
  e.signal("approval:x", { approved: true });
  assert.equal((await e.run()).status, "suspended", "live: k1 consumes the one signal, k2 suspends");
  assert.equal((await e.run()).status, "suspended", "replay: k1 is replayed, k2 must still suspend");
});

test("the activities table is the bespoke remainder: every ctx.run in the workflow names one of them", async () => {
  const src = require("node:fs").readFileSync(require.resolve("./pipeline.workflow.js"), "utf8");
  const named = new Set([...src.matchAll(/,\s*"([a-zA-Z]+)",\s*\{/g)].map((m) => m[1]));
  const table = new Set(ACTIVITIES.map(([n]) => n).filter((n) => !n.startsWith("signal ")));
  for (const n of named) assert.ok(table.has(n), `${n} is invoked but not in the ACTIVITIES table`);
  for (const n of table) assert.ok(named.has(n), `${n} is in the table but never invoked`);
});
