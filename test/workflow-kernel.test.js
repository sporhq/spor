// THE DURABLE-WORKFLOW REPLAY KERNEL (lib/kernel/workflow.js,
// task-spor-gate-pipeline-as-workflow-kernel). The proofs the spike paid for
// (spikes/durable-workflow/spike.test.js) ran over the harness this file was
// promoted from; these pin the KERNEL's own contract so the pipeline rewrite
// has a fixed floor to stand on:
//   - replay is a pure function of the journal: a recorded journal reproduces
//     the result with no activity available;
//   - a crash at EVERY activity boundary resumes to the same result, and only
//     the before-journal window re-executes anything — exactly one activity;
//   - timers and signal waits suspend and resume from the journal; a consumed
//     signal never resurfaces to a later await;
//   - an out-of-order or duplicate key is NonDeterminism, never a silent
//     re-execution;
//   - a journal is bound to the workflow version that recorded it;
//   - every append is persisted BEFORE the workflow sees the result, and a
//     persist that fails leaves memory equal to disk.
// No I/O, no clock: everything is injected.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const wf = require("../lib/kernel/workflow.js");
const { Execution, drive, fakeClock, NonDeterminism, WorkflowVersionMismatch } = wf;

// A three-step workflow: read, dispatch (awaits the run's terminal signal),
// write — the shape of one gate.
function oneGate(ctx, { id }) {
  const change = ctx.run(`${id}/read`, "read", { id });
  const run = ctx.run(`${id}/dispatch`, "dispatch", { head: change.head });
  const ended = ctx.awaitSignal(`${id}/ended`, `run:${run.run_id}`);
  const fact = ctx.run(`${id}/fact`, "write", { id: `art-${id}-${change.head}`, verdict: ended.payload.verdict });
  return { head: change.head, fact: fact.id, verdict: ended.payload.verdict };
}

function world(clock) {
  const calls = new Map();
  const graph = new Map();
  const signals = [];
  const launched = new Map();
  let dispatches = 0;
  const count = (key) => calls.set(key, (calls.get(key) || 0) + 1);
  const activities = {
    read: () => ({ head: "abc123" }),
    dispatch: (_args, { key }) => {
      if (launched.has(key)) return { run_id: launched.get(key), adopted: true }; // adopt-by-name
      const run_id = `run-${++dispatches}`;
      launched.set(key, run_id);
      signals.push({ name: `run:${run_id}`, payload: { verdict: "passed" }, atOrAfter: clock.now() });
      return { run_id };
    },
    write: ({ id, verdict }) => {
      if (graph.has(id)) return { id, existing: true };
      graph.set(id, { id, verdict });
      return { id, created: true };
    },
  };
  return { activities, calls, graph, signals, onActivity: ({ key }) => count(key), get dispatches() { return dispatches; } };
}

test("replay is a pure function of the journal: the recorded journal reproduces the result with every activity poisoned", async () => {
  const clock = fakeClock(100);
  const w = world(clock);
  const e = new Execution(oneGate, { id: "g" }, { journal: [], clock, activities: w.activities, onActivity: w.onActivity });
  const r = await drive(e, { clock, signals: w.signals });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.result, { head: "abc123", fact: "art-g-abc123", verdict: "passed" });
  for (const [k, n] of w.calls) assert.equal(n, 1, `${k} executed ${n} times`);
  const poison = Object.fromEntries(Object.keys(w.activities).map((k) => [k, () => { throw new Error(`activity ${k} called during replay`); }]));
  const replay = new Execution(oneGate, { id: "g" }, { journal: e.journal.slice(), clock, activities: poison });
  const rr = await replay.run();
  assert.equal(rr.status, "completed");
  assert.deepEqual(rr.result, r.result);
});

test("crash sweep: every activity boundary resumes to the same result and side effects; only the before-journal window re-executes, exactly one activity", async () => {
  const refClock = fakeClock(100);
  const ref = world(refClock);
  const reference = await drive(new Execution(oneGate, { id: "g" }, { journal: [], clock: refClock, activities: ref.activities, onActivity: ref.onActivity }), { clock: refClock, signals: ref.signals });
  const effects = [...ref.calls.keys()].length;
  assert.equal(effects, 3);
  for (const at of ["before-execute", "before-journal", "after-journal"]) {
    for (let nth = 1; nth <= effects; nth++) {
      const clock = fakeClock(100);
      const w = world(clock);
      let crashed = 0;
      const e = new Execution(oneGate, { id: "g" }, { journal: [], clock, activities: w.activities, onActivity: w.onActivity, crashPlan: { at, nth } });
      const r = await drive(e, { clock, signals: w.signals, onCrash: () => crashed++ });
      assert.equal(crashed, 1, `${at}#${nth}`);
      assert.equal(r.status, "completed", `${at}#${nth}: ${r.status}`);
      assert.deepEqual(r.result, reference.result, `${at}#${nth}`);
      assert.deepEqual([...w.graph.keys()], [...ref.graph.keys()], `${at}#${nth}: graph differs`);
      assert.equal(w.dispatches, ref.dispatches, `${at}#${nth}: a second run was launched`);
      const twice = [...w.calls].filter(([, n]) => n > 1);
      if (at === "before-journal") {
        assert.equal(twice.length, 1, `${at}#${nth}: exactly one activity re-executes, got ${twice.map(([k]) => k)}`);
        assert.equal(twice[0][1], 2);
      } else {
        assert.equal(twice.length, 0, `${at}#${nth}: nothing re-executes, got ${twice.map(([k]) => k)}`);
      }
    }
  }
});

test("without adopt-by-name, a before-journal crash on the dispatch launches a second run — the window is the activity's to close", async () => {
  const clock = fakeClock(100);
  const w = world(clock);
  let dispatches = 0;
  w.activities.dispatch = () => {
    const run_id = `run-${++dispatches}`;
    w.signals.push({ name: `run:${run_id}`, payload: { verdict: "passed" }, atOrAfter: clock.now() });
    return { run_id };
  };
  const e = new Execution(oneGate, { id: "g" }, { journal: [], clock, activities: w.activities, crashPlan: { at: "before-journal", nth: 2 } });
  const r = await drive(e, { clock, signals: w.signals });
  assert.equal(r.status, "completed");
  assert.equal(dispatches, 2);
});

test("an asynchronous activity and an async workflow journal exactly like synchronous ones", async () => {
  const clock = fakeClock(0);
  const seen = [];
  const activities = {
    slow: async ({ n }) => { seen.push(n); await new Promise((r) => setImmediate(r)); return n * 2; },
  };
  const fn = async (ctx) => {
    const a = await ctx.run("a", "slow", { n: 1 });
    const b = await ctx.run("b", "slow", { n: a });
    return a + b;
  };
  const e = new Execution(fn, {}, { journal: [], clock, activities });
  assert.deepEqual(await e.run(), { status: "completed", result: 6 });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(e.journal.map((x) => [x.kind, x.key, x.result]), [["effect", "a", 2], ["effect", "b", 4]]);
  const replay = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: { slow: async () => { throw new Error("replayed"); } } });
  assert.deepEqual(await replay.run(), { status: "completed", result: 6 });
});

test("an activity that throws (sync or async) is journaled as a failure and the failure is replayed, marked `replayed`", async () => {
  const clock = fakeClock(0);
  for (const act of [() => { throw new Error("boom"); }, async () => { throw new Error("boom"); }]) {
    const fn = async (ctx) => {
      try {
        await ctx.run("k", "bad", {});
        return "no";
      } catch (e) {
        return { message: e.message, replayed: !!e.replayed };
      }
    };
    const e = new Execution(fn, {}, { journal: [], clock, activities: { bad: act } });
    assert.deepEqual((await e.run()).result, { message: "boom", replayed: false });
    assert.deepEqual(e.journal, [{ kind: "effect", key: "k", threw: true, error: "boom" }]);
    const again = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: {} });
    assert.deepEqual((await again.run()).result, { message: "boom", replayed: true });
  }
});

test("a durable timer suspends, journals its wake time once, and resumes when the clock passes it", async () => {
  const clock = fakeClock(1000);
  const fn = (ctx) => {
    const at = ctx.now("t0");
    ctx.sleepUntil("pause", at + 500);
    return { woke: ctx.now("t1") };
  };
  const e = new Execution(fn, {}, { journal: [], clock, activities: {} });
  const first = await e.run();
  assert.equal(first.status, "suspended");
  assert.deepEqual(first.detail, { key: "pause", fireAt: 1500 });
  assert.deepEqual(e.journal, [{ kind: "now", key: "t0", at: 1000 }, { kind: "timer", key: "pause", fireAt: 1500 }]);
  clock.advanceTo(1200);
  assert.equal((await e.run()).status, "suspended", "still before the wake time");
  clock.advanceTo(1500);
  assert.deepEqual(await e.run(), { status: "completed", result: { woke: 1500 } });
  // a replayed timer never re-derives its wake time from the (now later) clock
  clock.advanceTo(9000);
  assert.deepEqual((await e.run()).result, { woke: 1500 });
});

test("a signal await suspends with no signal, consumes a delivered one, and times out at a durable deadline", async () => {
  const clock = fakeClock(0);
  const fn = (ctx) => {
    const now = ctx.now("n");
    const a = ctx.awaitSignal("approval", "approval:x", { deadlineAt: now + 100 });
    return a;
  };
  const e = new Execution(fn, {}, { journal: [], clock, activities: {} });
  const r1 = await e.run();
  assert.equal(r1.status, "suspended");
  assert.deepEqual(r1.detail, { key: "approval", name: "approval:x", deadlineAt: 100 });
  e.signal("approval:x", { approved: true });
  assert.deepEqual((await e.run()).result, { received: true, payload: { approved: true } });

  const t = new Execution(fn, {}, { journal: [], clock, activities: {} });
  assert.equal((await t.run()).status, "suspended");
  clock.advanceTo(100);
  assert.deepEqual((await t.run()).result, { received: false, timeout: true });
});

test("a signal consumed by a replayed await does not resurface to a later await for the same name", async () => {
  const fn = (ctx) => {
    const a = ctx.awaitSignal("k1", "approval:x");
    const b = ctx.awaitSignal("k2", "approval:x");
    return { a: a.received, b: b.received };
  };
  const e = new Execution(fn, {}, { journal: [], clock: fakeClock(0), activities: {} });
  e.signal("approval:x", { approved: true });
  assert.equal((await e.run()).status, "suspended", "live: k1 consumes the one signal, k2 suspends");
  assert.equal((await e.run()).status, "suspended", "replay: k1 is replayed, k2 must still suspend");
  e.signal("approval:x", { approved: false });
  assert.deepEqual((await e.run()).result, { a: true, b: true });
});

test("drive() delivers queued signals, advances to timers and deadlines, and reports a workflow stuck on a signal nobody will send", async () => {
  const clock = fakeClock(0);
  const fn = (ctx) => {
    ctx.sleepUntil("t", 50);
    const a = ctx.awaitSignal("a", "run:1");
    const b = ctx.awaitSignal("b", "run:2", { deadlineAt: 500 });
    const c = ctx.awaitSignal("c", "run:3");
    return { a: a.payload, b, c: c.payload };
  };
  const e = new Execution(fn, {}, { journal: [], clock, activities: {} });
  const r = await drive(e, { clock, signals: [{ name: "run:1", payload: "one", atOrAfter: 200 }] });
  assert.equal(r.status, "suspended");
  assert.equal(r.stuck, true);
  assert.equal(r.detail.name, "run:3");
  assert.equal(clock.now(), 500);
  e.signal("run:3", "three");
  const done = await drive(e, { clock });
  assert.deepEqual(done.result, { a: "one", b: { received: false, timeout: true }, c: "three" });
});

test("NonDeterminism: a key asked for out of order, or twice, fails the run rather than re-executing", async () => {
  const clock = fakeClock(0);
  const activities = { a: () => 1, b: () => 2 };
  const v1 = (ctx) => ctx.run("a", "a", {}) + ctx.run("b", "b", {});
  const e = new Execution(v1, {}, { journal: [], clock, activities });
  assert.equal((await e.run()).status, "completed");
  const v2 = (ctx) => ctx.run("b", "b", {}) + ctx.run("a", "a", {});
  const r = await new Execution(v2, {}, { journal: e.journal.slice(), clock, activities }).run();
  assert.equal(r.status, "failed");
  assert.ok(r.error instanceof NonDeterminism, String(r.error));
  const dup = (ctx) => ctx.run("a", "a", {}) + ctx.run("a", "a", {});
  const d = await new Execution(dup, {}, { journal: [], clock, activities }).run();
  assert.ok(d.error instanceof NonDeterminism);
  assert.match(d.error.message, /used twice/);
});

test("a journal is bound to the workflow version that recorded it: a header is stamped on an empty journal and a different version is refused", async () => {
  const clock = fakeClock(0);
  const fn = (ctx) => ctx.run("a", "a", {});
  const e = new Execution(fn, {}, { journal: [], clock, activities: { a: () => 1 }, workflow: "gate-pipeline", version: "3" });
  assert.equal((await e.run()).status, "completed");
  assert.deepEqual(e.journal[0], { kind: "version", spec: wf.JOURNAL_SPEC_VERSION, workflow: "gate-pipeline", version: "3" });
  assert.deepEqual(wf.journalVersion(e.journal), { workflow: "gate-pipeline", version: "3", spec: 1 });
  // same version replays
  const same = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: {}, workflow: "gate-pipeline", version: 3 });
  assert.deepEqual(await same.run(), { status: "completed", result: 1 });
  // a bumped version refuses
  const bumped = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: {}, workflow: "gate-pipeline", version: "4" });
  const r = await bumped.run();
  assert.equal(r.status, "failed");
  assert.ok(r.error instanceof WorkflowVersionMismatch);
  assert.deepEqual(r.error.recorded, { workflow: "gate-pipeline", version: "3", spec: 1 });
  assert.match(r.error.message, /gate-pipeline@3.*gate-pipeline@4/);
  // a versioned execution refuses an unversioned, non-empty journal
  const unversioned = new Execution(fn, {}, { journal: [{ kind: "effect", key: "a", result: 1 }], clock, activities: {}, version: "1" });
  assert.ok((await unversioned.run()).error instanceof WorkflowVersionMismatch);
  // an unversioned execution ignores a header
  const ignore = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: {} });
  assert.deepEqual(await ignore.run(), { status: "completed", result: 1 });
});

test("persist runs after every append and before the result reaches the workflow; a persist that throws takes its entry back out", async () => {
  const clock = fakeClock(0);
  const disk = [];
  const order = [];
  const fn = (ctx) => {
    const a = ctx.run("a", "a", {});
    order.push(`workflow saw a=${a} with ${disk.length} on disk`);
    ctx.now("n");
    return a;
  };
  const e = new Execution(fn, {}, { journal: [], clock, activities: { a: () => 7 }, persist: (entry) => disk.push(entry), version: "1" });
  await e.run();
  assert.deepEqual(disk, e.journal);
  assert.deepEqual(order, ["workflow saw a=7 with 2 on disk"]);
  // A persist that throws leaves the durable state UNKNOWN (an fsync can fail
  // after the bytes landed), so the Execution is poisoned: every later run()
  // and signal() refuses, and only a fresh Execution over the journal re-read
  // from disk may continue — never this one, which could append a duplicate
  // of an entry that did land.
  const flaky = new Execution(fn, {}, { journal: [], clock, activities: { a: () => 7 }, persist: () => { throw new Error("disk full"); } });
  const r = await flaky.run();
  assert.equal(r.status, "failed");
  assert.equal(r.error.message, "disk full");
  assert.equal(r.error.poisoned, true);
  assert.equal((await flaky.run()).error, r.error, "poisoned: the same refusal, no second attempt");
  assert.throws(() => flaky.signal("approval:x", 1), /disk full/);
  const reopened = new Execution(fn, {}, { journal: [], clock, activities: { a: () => 7 }, persist: () => {} });
  assert.deepEqual(await reopened.run(), { status: "completed", result: 7 });
  // The run that HIT the failure is poisoned too, even when the workflow
  // swallows the throw (the pipeline wraps its dispatches in try/catch) and
  // goes on to return a verdict: that verdict was computed over a journal the
  // disk may not match, and nothing further is journaled.
  let launched = 0;
  const appended = [];
  const swallow = async (ctx) => {
    let verdict;
    try {
      verdict = await ctx.run("dispatch", "launch", {});
    } catch {
      verdict = "escalated";
    }
    ctx.now("after");
    return verdict;
  };
  const once = new Execution(swallow, {}, { journal: [], clock, activities: { launch: () => `run-${++launched}` }, persist: (x) => { if (appended.push(x) === 1) throw new Error("EIO"); } });
  const hit = await drive(once, { clock });
  assert.equal(hit.status, "failed");
  assert.equal(hit.error.message, "EIO");
  assert.equal(once.status, "failed");
  assert.equal(appended.length, 1, "nothing is journaled after the poison");
  assert.equal(launched, 1);
  // a signal delivery persists too
  const s = new Execution(fn, {}, { journal: [], clock, activities: { a: () => 7 }, persist: (x) => disk.push(x) });
  s.signal("approval:x", 1);
  assert.deepEqual(disk[disk.length - 1], { kind: "signal", key: "signal:approval:x", payload: 1 });
});

test("a signal delivered to a versioned execution BEFORE its first run opens the journal with the header, never as an unversioned journal", async () => {
  const clock = fakeClock(0);
  const fn = (ctx) => ctx.awaitSignal("k", "run:1").payload;
  const e = new Execution(fn, {}, { journal: [], clock, activities: {}, workflow: "w", version: "1" });
  e.signal("run:1", "done");
  assert.deepEqual(e.journal.map((x) => x.kind), ["version", "signal"]);
  assert.deepEqual(await e.run(), { status: "completed", result: "done" });
  // and through drive(), which delivers an undated signal before the first run
  const d = new Execution(fn, {}, { journal: [], clock, activities: {}, workflow: "w", version: "1" });
  const r = await drive(d, { clock, signals: [{ name: "run:1", payload: "driven" }] });
  assert.equal(r.status, "completed");
  assert.equal(r.result, "driven");
});

test("a replayed failure keeps the name and code a workflow branches on; a falsy throw is still a failure", async () => {
  const clock = fakeClock(0);
  const fn = async (ctx) => {
    try {
      await ctx.run("k", "bad", {});
      return "no";
    } catch (e) {
      return { name: e.name, code: e.code, message: e.message, replayed: !!e.replayed };
    }
  };
  const bad = () => { throw Object.assign(new TypeError("typed"), { code: "E_TYPED" }); };
  const e = new Execution(fn, {}, { journal: [], clock, activities: { bad } });
  assert.deepEqual((await e.run()).result, { name: "TypeError", code: "E_TYPED", message: "typed", replayed: false });
  assert.deepEqual(e.journal, [{ kind: "effect", key: "k", threw: true, error: "typed", name: "TypeError", code: "E_TYPED" }]);
  const again = new Execution(fn, {}, { journal: e.journal.slice(), clock, activities: {} });
  assert.deepEqual((await again.run()).result, { name: "TypeError", code: "E_TYPED", message: "typed", replayed: true });
  for (const act of [() => { throw null; }, async () => { throw undefined; }]) {
    const f = new Execution(fn, {}, { journal: [], clock, activities: { bad: act } });
    const out = (await f.run()).result;
    assert.equal(out.replayed, false);
    assert.match(out.message, /activity (threw|rejected)/);
    assert.equal(f.journal[0].threw, true);
  }
});

test("the constructor refuses what the model cannot run without", () => {
  assert.throws(() => new Execution(null, {}, { clock: fakeClock() }), /function of \(ctx, input\)/);
  assert.throws(() => new Execution(() => 1, {}, {}), /injected clock/);
  assert.throws(() => new Execution(() => 1, {}, { clock: fakeClock(), journal: "nope" }), /array/);
  const e = new Execution((ctx) => ctx.run("k", "missing", {}), {}, { clock: fakeClock() });
  return e.run().then((r) => assert.match(String(r.error), /no activity missing/));
});
