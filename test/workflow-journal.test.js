// THE WORKFLOW JOURNAL in the execution store (lib/shell/execution-store.js
// `openWorkflowJournal`, task-spor-gate-pipeline-as-workflow-kernel): the
// replay kernel's persisted step log, kept beside the execution record under
// the server's own layout. Three claims:
//   1. the handle the store opens binds the kernel's `persist` so every
//      append lands on disk BEFORE the workflow acts on it, and a fresh
//      handle re-reads the identical sequence — so a crashed worker's
//      successor replays the same journal with no activity re-executed;
//   2. framing: a torn final fragment is discarded on read and repaired on
//      the next append, while a corrupt interior line is a hard error — a
//      journal with a hole in it is never read as a shorter one;
//   3. the segment guards the rest of the store applies hold here too.
// No network, no graph, no clock: scratch dirs only.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../lib/shell/execution-store.js");
const { Execution, fakeClock, journalVersion } = require("../lib/kernel/workflow.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `spor-wfjournal-${p}-`));
const EXEC = "exec-0123456789abcdef";

test("layout: the journal sits beside the record under exec/, and an absent one reads as empty", () => {
  const home = tmp("layout");
  assert.equal(store.workflowJournalPath(home, "local", EXEC), path.join(home, "journal", "executions", "local", "exec", `${EXEC}.workflow.jsonl`));
  assert.deepEqual(store.readWorkflowJournal(home, "local", EXEC), []);
  assert.deepEqual(store.readWorkflowJournal(home, "../x", EXEC), [], "a bad tenant segment reads as nothing, never a traversal");
  assert.throws(() => store.appendWorkflowEntry(home, "../x", EXEC, { kind: "now", key: "k", at: 1 }), /invalid tenant segment/);
  assert.throws(() => store.appendWorkflowEntry(home, "local", "a/b", { kind: "now", key: "k", at: 1 }), /invalid execution id/);
  assert.throws(() => store.appendWorkflowEntry(home, "local", EXEC, { key: "k" }), /object with a `kind`/);
});

test("a kernel execution over the store's handle persists every step before the workflow acts on it, and a successor replays the identical journal with no activity", async () => {
  const home = tmp("replay");
  const clock = fakeClock(1000);
  let dispatches = 0;
  const onDisk = () => store.readWorkflowJournal(home, "local", EXEC);
  const observed = [];
  const activities = {
    read: () => ({ head: "abc123" }),
    dispatch: async () => ({ run_id: `run-${++dispatches}` }),
    write: ({ id }) => ({ id }),
  };
  const fn = async (ctx) => {
    const change = await ctx.run("read", "read", {});
    observed.push(`after read: ${onDisk().length} on disk`);
    const run = await ctx.run("dispatch", "dispatch", { head: change.head });
    observed.push(`after dispatch: ${onDisk().length} on disk`);
    const ended = ctx.awaitSignal("ended", `run:${run.run_id}`);
    const fact = await ctx.run("fact", "write", { id: `art-${change.head}`, verdict: ended.payload.verdict });
    return { fact: fact.id, verdict: ended.payload.verdict };
  };
  const h1 = store.openWorkflowJournal(home, "local", EXEC);
  const e1 = new Execution(fn, {}, { journal: h1.journal, persist: h1.persist, clock, activities, workflow: "gate-pipeline", version: "1" });
  const first = await e1.run();
  assert.equal(first.status, "suspended");
  assert.equal(first.detail.name, "run:run-1");
  assert.deepEqual(observed, ["after read: 2 on disk", "after dispatch: 3 on disk"], "the version header plus each effect is durable before the workflow sees the result");
  assert.deepEqual(onDisk(), h1.journal);

  // The worker dies. A successor opens the journal fresh, delivers the run's
  // terminal signal, and completes with the dispatch activity POISONED: the
  // run it awaits is the one already launched, never a second.
  const h2 = store.openWorkflowJournal(home, "local", EXEC);
  assert.deepEqual(h2.journal, h1.journal);
  assert.deepEqual(journalVersion(h2.journal), { workflow: "gate-pipeline", version: "1", spec: 1 });
  const e2 = new Execution(fn, {}, { journal: h2.journal, persist: h2.persist, clock, activities: { ...activities, read: () => { throw new Error("re-executed read"); }, dispatch: () => { throw new Error("re-executed dispatch"); } }, workflow: "gate-pipeline", version: "1" });
  e2.signal("run:run-1", { verdict: "passed" });
  const done = await e2.run();
  assert.deepEqual(done, { status: "completed", result: { fact: "art-abc123", verdict: "passed" } });
  assert.equal(dispatches, 1);
  const final = onDisk();
  assert.deepEqual(final.map((x) => [x.kind, x.key]), [
    ["version", undefined],
    ["effect", "read"],
    ["effect", "dispatch"],
    ["signal", "signal:run:run-1"],
    ["await", "ended"],
    ["effect", "fact"],
  ]);
  // and a third reader replays to the same answer with nothing but the file
  const h3 = store.openWorkflowJournal(home, "local", EXEC);
  const e3 = new Execution(fn, {}, { journal: h3.journal, persist: h3.persist, clock, activities: {}, workflow: "gate-pipeline", version: "1" });
  assert.deepEqual(await e3.run(), done);
  assert.deepEqual(onDisk(), final, "a pure replay appends nothing");
});

test("framing: a torn final fragment is dropped on read and repaired by the next append; a corrupt interior line is a hard error", () => {
  const home = tmp("framing");
  store.appendWorkflowEntry(home, "local", EXEC, { kind: "now", key: "t0", at: 1 });
  store.appendWorkflowEntry(home, "local", EXEC, { kind: "effect", key: "a", result: 1 });
  const abs = store.workflowJournalPath(home, "local", EXEC);
  fs.appendFileSync(abs, '{"kind":"effect","key":"b","res');
  assert.deepEqual(store.readWorkflowJournal(home, "local", EXEC).map((x) => x.key), ["t0", "a"]);
  store.appendWorkflowEntry(home, "local", EXEC, { kind: "effect", key: "b", result: 2 });
  assert.deepEqual(store.readWorkflowJournal(home, "local", EXEC).map((x) => x.key), ["t0", "a", "b"]);
  // a complete unframed final row (no trailing newline) is kept, and the next append frames it
  fs.writeFileSync(abs, '{"kind":"now","key":"t0","at":1}\n{"kind":"effect","key":"a","result":1}');
  assert.deepEqual(store.readWorkflowJournal(home, "local", EXEC).map((x) => x.key), ["t0", "a"]);
  store.appendWorkflowEntry(home, "local", EXEC, { kind: "effect", key: "b", result: 2 });
  assert.deepEqual(store.readWorkflowJournal(home, "local", EXEC).map((x) => x.key), ["t0", "a", "b"]);
  // a hole in the middle
  fs.writeFileSync(abs, '{"kind":"now","key":"t0","at":1}\nnot json\n{"kind":"effect","key":"a","result":1}\n');
  assert.throws(() => store.readWorkflowJournal(home, "local", EXEC), /corrupt at line 2/);
});

test("the workflow journal and the event log are separate files: a workflow entry never lands in the authoritative event log", () => {
  const home = tmp("separate");
  store.appendWorkflowEntry(home, "local", EXEC, { kind: "effect", key: "a", result: 1 });
  assert.deepEqual(store.readEvents(home, "local", EXEC), []);
  assert.equal(fs.existsSync(store.eventsPath(home, "local", EXEC)), false);
});
