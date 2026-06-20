// Seed status-vocabulary enforcement on the CREATE path
// (issue-spor-node-create-bypasses-status-vocabulary).
//
// The status-vocabulary MEMBERSHIP check used to live only in each seed
// schema's transitions() gate, which the server runs on UPDATE only. So a node
// could be BORN (created) with an off-vocabulary status that no write rejected,
// until a later re-validating write hit the update-path gate and failed
// transition_denied. The fix moves membership into the schema's validate()
// hook, which the server runs on EVERY write (create AND update,
// store.validateIncoming -> sandboxFor(schema).call("validate", [node])).
//
// This suite drives the seed schemas through the SAME sandbox the server uses
// (lib/sandbox.js sandboxFor, parity-shared with the server's wasm engine),
// asserting that validate() and transitions() now agree on the enum, while the
// completion-resolver gate stays in transitions() (update only) — so create
// rejects an off-vocabulary status but still permits a vocabulary-valid
// terminal status (the completion gate is a transition concern).
//
// Run: node --test

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { sandboxFor } = require(path.join(__dirname, "..", "lib", "sandbox.js"));

const SLACK = { timeoutMs: 5000 };

function schemaFor(key) {
  const s = graph.loadSeedSchemas().find((x) => x.key === key);
  assert.ok(s, `seed schema for '${key}' not found`);
  return s;
}
const callValidate = (key, node) => sandboxFor(schemaFor(key)).call("validate", [node], SLACK);
const callTransitions = (key, cur, prop, view) =>
  sandboxFor(schemaFor(key)).call("transitions", [cur, prop, view || {}], SLACK);

// The simple vocabulary types: validate() rejects exactly the off-vocabulary
// statuses, accepts every valid one and the status-less (live) case.
const CASES = {
  task: { valid: ["open", "active", "done", "abandoned"], bad: ["in_progress", "doing", "closed", "dismissed", "wip"] },
  issue: { valid: ["open", "active", "resolved"], bad: ["in_progress", "done", "closed", "dismissed", "fixed"] },
  decision: { valid: ["active", "superseded", "rejected"], bad: ["dismissed", "declined", "open", "done"] },
  question: { valid: ["open", "answered"], bad: ["resolved", "closed", "answered!", "done"] },
  "capture-pending": { valid: ["merged", "rejected"], bad: ["dismissed", "resolved", "closed", "pending", "done"] },
};

for (const [key, { valid, bad }] of Object.entries(CASES)) {
  test(`seed schema-${key}: validate() accepts status-less + every valid status (create path)`, () => {
    assert.deepEqual(callValidate(key, { id: `${key}-x` }), [], "status-less (live) must pass at the door");
    assert.deepEqual(callValidate(key, { id: `${key}-x`, status: "" }), [], "empty status must pass");
    for (const s of valid) {
      assert.deepEqual(callValidate(key, { id: `${key}-x`, status: s }), [], `valid status '${s}' must pass`);
      // case-insensitive, mirroring the gate's toLowerCase()
      assert.deepEqual(callValidate(key, { id: `${key}-x`, status: s.toUpperCase() }), [], `'${s.toUpperCase()}' must pass`);
    }
  });

  test(`seed schema-${key}: validate() rejects off-vocabulary status on CREATE — and agrees with transitions()`, () => {
    for (const s of bad) {
      const verr = callValidate(key, { id: `${key}-x`, status: s });
      assert.equal(verr.length, 1, `validate() must reject off-vocab '${s}'`);
      assert.match(verr[0], /invalid .* status/i);
      // the two paths AGREE: what validate() rejects on create, transitions()
      // also denies on update (the bug was that ONLY transitions() saw it).
      const verdict = callTransitions(key, null, { id: `${key}-x`, status: s }, {});
      assert.equal(verdict.allow, false, `transitions() must also deny off-vocab '${s}'`);
    }
  });
}

// The surgical split: a vocabulary-valid TERMINAL status passes validate()
// (membership is fine) even with no resolver — the completion-resolver gate is
// a transition property, enforced in transitions() on update, NOT at the door.
// This is what keeps create from inheriting the completion gate (the deliberate
// scope of the fix).
test("seed schema-task: validate() accepts 'done' (vocabulary); completion gate stays in transitions()", () => {
  assert.deepEqual(callValidate("task", { id: "task-x", status: "done" }), [], "done is a valid task status");
  // transitions() still requires a resolving resolver for done.
  const noResolver = callTransitions("task", { status: "active" }, { id: "task-x", status: "done" }, { resolvers: [], non_resolving_statuses: [] });
  assert.equal(noResolver.allow, false, "done without a resolver is denied by transitions()");
  const withResolver = callTransitions("task", { status: "active" }, { id: "task-x", status: "done" },
    { resolvers: [{ id: "art-x", type: "artifact", status: "" }], non_resolving_statuses: [] });
  assert.equal(withResolver.allow, true, "done WITH a resolving resolver is allowed by transitions()");
});

test("seed schema-issue: validate() accepts 'resolved' (vocabulary); resolver gate stays in transitions()", () => {
  assert.deepEqual(callValidate("issue", { id: "issue-x", status: "resolved" }), [], "resolved is a valid issue status");
  const noResolver = callTransitions("issue", { status: "active" }, { id: "issue-x", status: "resolved" }, { resolvers: [] });
  assert.equal(noResolver.allow, false, "resolved without a resolver is denied by transitions()");
  const withResolver = callTransitions("issue", { status: "active" }, { id: "issue-x", status: "resolved" },
    { resolvers: [{ id: "dec-x", type: "decision", status: "" }] });
  assert.equal(withResolver.allow, true, "resolved WITH a resolver is allowed by transitions()");
});
