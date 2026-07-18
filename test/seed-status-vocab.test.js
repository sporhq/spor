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
const { STATUS_VOCAB } = require(path.join(__dirname, "helpers", "status-vocab.js"));

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
const { artifact: ARTIFACT_CASE, ...CASES } = STATUS_VOCAB;

// artifact is validate()-ONLY: the type has no transitions() gate (the delivery
// stages are not a state machine — a change may be born `merged`), so it cannot
// join the CASES loop above, which asserts the two paths agree. Its door is the
// only status gate it has (issue-spor-off-vocab-artifact-statuses).
// The off-vocabulary statuses below include the exact ones the live-graph
// census found (13 complete, 6 shipped, 1 landed, 1 resolved, 1 open) — the
// drift this door exists to stop recurring. They read as neither live nor
// terminal, so the artifacts carrying them never retired from queue liveness.
const ARTIFACT_VALID = ARTIFACT_CASE.valid;
const ARTIFACT_BAD = ARTIFACT_CASE.bad;

test("seed schema-artifact: validate() accepts status-less + every valid status", () => {
  assert.deepEqual(callValidate("artifact", { id: "art-x" }), [], "status-less (a plain reference doc) must pass");
  assert.deepEqual(callValidate("artifact", { id: "art-x", status: "" }), [], "empty status must pass");
  for (const s of ARTIFACT_VALID) {
    assert.deepEqual(callValidate("artifact", { id: "art-x", status: s }), [], `valid status '${s}' must pass`);
    assert.deepEqual(callValidate("artifact", { id: "art-x", status: s.toUpperCase() }), [], `'${s.toUpperCase()}' must pass`);
  }
});

test("seed schema-artifact: validate() rejects the off-vocabulary statuses the census found", () => {
  for (const s of ARTIFACT_BAD) {
    const errs = callValidate("artifact", { id: "art-x", status: s });
    assert.equal(errs.length, 1, `validate() must reject off-vocab '${s}'`);
    assert.match(errs[0], /invalid artifact status/i);
    assert.match(errs[0], new RegExp(s), "the reason names the rejected value");
  }
});

// `active` is the load-bearing case: 79 live-graph artifacts and 37 in the
// conformance corpus carry it (living/current reference docs). It is admitted,
// not normalized — an edge write re-validates the whole node, so rejecting it
// would 422 every future mutation of those nodes.
test("seed schema-artifact: 'active' and 'done' are in-vocabulary (non-delivery lifecycle values)", () => {
  assert.deepEqual(callValidate("artifact", { id: "art-x", status: "active" }), [],
    "active (a living doc) must pass — the conformance corpus and live graph depend on it");
  assert.deepEqual(callValidate("artifact", { id: "art-x", status: "done" }), [],
    "done (a finished doc) must pass — it is already declared terminal for this type");
});

test("seed schema-artifact: the type is gated on membership only — no transitions() hook", () => {
  const sb = sandboxFor(schemaFor("artifact"));
  assert.deepEqual(sb.names, ["validate"],
    "artifact exports validate() only: the stages are not a state machine, so nothing gates ORDER");
});

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

test("seed schema-issue: validate() accepts 'resolved' (vocabulary); resolving-resolver gate stays in transitions()", () => {
  assert.deepEqual(callValidate("issue", { id: "issue-x", status: "resolved" }), [], "resolved is a valid issue status");
  // transitions() requires a RESOLVING resolver for resolved, mirroring
  // schema-task's done gate (task-spor-schema-issue-resolved-gate-tightening,
  // dec-spor-definition-of-done-org-policy).
  const noResolver = callTransitions("issue", { status: "active" }, { id: "issue-x", status: "resolved" },
    { resolvers: [], non_resolving_statuses: ["in-review", "approved"] });
  assert.equal(noResolver.allow, false, "resolved without a resolver is denied by transitions()");
  const withResolver = callTransitions("issue", { status: "active" }, { id: "issue-x", status: "resolved" },
    { resolvers: [{ id: "dec-x", type: "decision", status: "" }], non_resolving_statuses: ["in-review", "approved"] });
  assert.equal(withResolver.allow, true, "resolved WITH a resolving resolver is allowed by transitions()");
  // a resolver still in review does NOT satisfy the gate — the write-time mirror
  // of the read-time retirement rule (dec-spor-definition-of-done-org-policy).
  const inReview = callTransitions("issue", { status: "active" }, { id: "issue-x", status: "resolved" },
    { resolvers: [{ id: "art-pr", type: "artifact", status: "in-review" }], non_resolving_statuses: ["in-review", "approved"] });
  assert.equal(inReview.allow, false, "an in-review resolver does not allow resolved");
});

// The question placeholder gate (2026.07.05.1,
// issue-spor-ask-question-template-placeholder-validation): validate() rejects
// a PRESENT title/summary/body that is ONLY an unfilled template token — the
// question-question incident, a docs example run verbatim ('<question>' in
// every text field) that minted an information-free routed ask. Whole-field
// match only; absent fields and real content around a token still pass.
test("seed schema-question: validate() rejects unfilled template placeholders in text fields", () => {
  // the observed incident: every field the literal placeholder
  const errs = callValidate("question", {
    id: "question-x", title: "<question>", summary: "<question>", body: "<question>",
  });
  assert.equal(errs.length, 3, "each placeholder field is its own error");
  for (const e of errs) assert.match(e, /unfilled template placeholder/);
  // every placeholder shape, in any single field
  for (const p of ["<question>", "{{question}}", "{slug}", "[node-id]", "  <text here>  ", "<>"]) {
    const one = callValidate("question", { id: "question-x", title: p });
    assert.equal(one.length, 1, `placeholder title '${p}' must be rejected`);
  }
  // placeholder errors and status errors accumulate (validate no longer
  // short-circuits on the vocabulary check)
  const both = callValidate("question", { id: "question-x", status: "closed", title: "<question>" });
  assert.equal(both.length, 2, "off-vocab status AND placeholder title are both reported");
});

test("seed schema-question: validate() passes real questions, absent fields, and tokens inside real text", () => {
  // bare probe node (no text fields) — shape requirements are the core
  // validator's concern, not the schema hook's
  assert.deepEqual(callValidate("question", { id: "question-x" }), []);
  // ordinary short question
  assert.deepEqual(callValidate("question", { id: "question-x", title: "Why OKLCH?" }), []);
  // a token inside real content is fine
  assert.deepEqual(callValidate("question", {
    id: "question-x",
    title: "Should <question> placeholders be rejected at the door?",
    body: "The docs show `spor ask \"<question>\"` — should the literal token be valid input?",
  }), []);
  // angle brackets as comparison operators, not a placeholder
  assert.deepEqual(callValidate("question", { id: "question-x", title: "Is n < 5 or n > 9 here?" }), []);
});
