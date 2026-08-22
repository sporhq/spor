// The declarative completion policy vs. the hooks that enforce it
// (task-spor-registry-declarative-terminal-status-policy).
//
// Each seed node-schema now DECLARES, as registry data, the completion policy
// its sandboxed hooks enforce: `status.vocabulary` (the closed enum the
// `validate()` door gates membership on), `status.completion` (the single
// SUCCESS terminal value — task `done`, issue `resolved`, question `answered`,
// as opposed to the give-up outcomes `abandoned`/`rejected`), and
// `status.resolver_required` (whether that value additionally needs a live
// resolving decision/artifact, task-cc-terminal-status-requires-resolver).
//
// Read surfaces consume the declaration instead of hand-mirroring hook source:
// spor-server's gardener derives its finding remedies' terminal status and its
// resolver-required table from it, having previously kept three hand-maintained
// tables that could — and did — name a status the write door then refused
// (issue-spor-gardener-terminal-status-fallback-off-vocab,
// issue-spor-resolved-open-finding-remedy-always-409s).
//
// A declaration that drifts from its hook is worse than no declaration: the
// reader is confidently wrong. So this suite drives every seed node-schema's
// hooks through the SAME sandbox the server uses (lib/sandbox.js sandboxFor,
// parity-shared with the server's wasm engine) and fails if the two disagree in
// EITHER direction — a closed vocabulary with no declaration, a declaration
// whose values the door rejects, a `completion` the transitions() gate refuses,
// or a `resolver_required` flag that does not match what the gate actually
// demands.
//
// Unlike test/helpers/status-vocab.js (a deliberately hand-written vocabulary,
// so a schema bug and its test can't drift together), reading the payload back
// here is the POINT: the assertion is payload-vs-hook agreement, two
// independent surfaces of the same file, not payload-vs-itself.
//
// Run: node --test

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { sandboxFor } = require(path.join(__dirname, "..", "lib", "sandbox.js"));
const { Registry } = require(path.join(__dirname, "..", "lib", "kernel", "registry.js"));

const SLACK = { timeoutMs: 5000 };

// A status no vocabulary would ever contain, used to probe whether a type's
// door is closed (rejects the unknown) or open (accepts anything).
const OFF_VOCAB_PROBE = "zzz-not-a-real-status";

// Whether a status is REJECTED BY THE STATUS GATE, differentially: some doors
// also validate node shape (schema-lens demands a `## query` block), so a bare
// probe node fails them for reasons that have nothing to do with status. Only
// the errors a status ADDS over the status-less baseline are this suite's
// business.
function statusRejected(h, key, status) {
  const base = h.validate({ id: `${key}-probe` }).length;
  return h.validate({ id: `${key}-probe`, status }).length > base;
}

const nodeSchemas = () => graph.loadSeedSchemas().filter((s) => s.kind === "node-schema");
const statusOf = (s) => (s.payload && s.payload.status) || {};
const declaredVocab = (s) => (Array.isArray(statusOf(s).vocabulary) ? statusOf(s).vocabulary : null);

// A resolving decision resolver — what a resolver-required completion gate
// wants to see on the view.
const RESOLVER_VIEW = { resolvers: [{ id: "dec-x", type: "decision", status: "" }], non_resolving_statuses: [] };
const BARE_VIEW = { resolvers: [], non_resolving_statuses: [] };

// sandboxFor() returns null for a schema with no attached ```js block at all
// (the purely declarative types: norm, person, lens, …) — those have no hooks
// to agree with, so they must declare no completion policy either.
function hooks(schema) {
  const sb = sandboxFor(schema);
  if (!sb) return { names: [], validate: () => [], transitions: () => ({ allow: true }) };
  return {
    names: sb.names,
    validate: (node) => sb.call("validate", [node], SLACK),
    transitions: (cur, prop, view) => sb.call("transitions", [cur, prop, view || {}], SLACK),
  };
}

// ---- vocabulary: declared iff the door is closed, and it says the same thing ----

test("every seed node-schema with a closed validate() door declares status.vocabulary", () => {
  for (const s of nodeSchemas()) {
    const h = hooks(s);
    if (!h.names.includes("validate")) {
      assert.equal(declaredVocab(s), null,
        `${s.id} declares status.vocabulary but has no validate() hook to enforce it`);
      continue;
    }
    if (statusRejected(h, s.key, OFF_VOCAB_PROBE)) {
      assert.ok(declaredVocab(s),
        `${s.id}'s validate() gates status membership but the payload declares no status.vocabulary ` +
        `— a reader (the gardener's remedies, spor schema) cannot know the enum without parsing hook source`);
    } else {
      assert.equal(declaredVocab(s), null,
        `${s.id} declares status.vocabulary but its validate() accepts an off-vocabulary status ` +
        `— the declaration would advertise a gate that does not exist`);
    }
  }
});

test("every declared status.vocabulary value passes that type's own validate() door", () => {
  for (const s of nodeSchemas()) {
    const vocab = declaredVocab(s);
    if (!vocab) continue;
    const h = hooks(s);
    for (const status of vocab) {
      assert.ok(!statusRejected(h, s.key, status),
        `${s.id} declares '${status}' in status.vocabulary but its own validate() rejects it`);
      // case-insensitive, mirroring every gate's toLowerCase()
      assert.ok(!statusRejected(h, s.key, status.toUpperCase()),
        `${s.id}: '${status.toUpperCase()}' must pass — the gates lowercase before comparing`);
    }
    // and the door is genuinely closed AROUND that set
    assert.ok(statusRejected(h, s.key, OFF_VOCAB_PROBE),
      `${s.id} declares a vocabulary but accepts a status outside it`);
  }
});

// ---- completion: a real, writable success value ----

test("every declared status.completion is a vocabulary member its validate() accepts", () => {
  for (const s of nodeSchemas()) {
    const completion = statusOf(s).completion;
    if (completion == null) continue;
    const vocab = declaredVocab(s);
    assert.ok(vocab, `${s.id} declares status.completion '${completion}' but no status.vocabulary`);
    assert.ok(vocab.some((v) => v.toLowerCase() === String(completion).toLowerCase()),
      `${s.id}'s status.completion '${completion}' is not in its own status.vocabulary`);
    assert.ok(!statusRejected(hooks(s), s.key, completion),
      `${s.id}'s own validate() rejects its declared status.completion '${completion}'`);
  }
});

// ---- resolver_required: exactly what the transitions() gate demands ----

test("status.resolver_required matches what each type's transitions() gate actually demands", () => {
  for (const s of nodeSchemas()) {
    const completion = statusOf(s).completion;
    if (completion == null) {
      assert.notEqual(statusOf(s).resolver_required, true,
        `${s.id} declares resolver_required with no status.completion to gate`);
      continue;
    }
    const h = hooks(s);
    const required = statusOf(s).resolver_required === true;
    if (!h.names.includes("transitions")) {
      assert.equal(required, false,
        `${s.id} declares resolver_required: true but has no transitions() hook to enforce it`);
      continue;
    }
    const proposed = { id: `${s.key}-probe`, status: completion };
    const bare = h.transitions({ status: "active" }, proposed, BARE_VIEW);
    const withResolver = h.transitions({ status: "active" }, proposed, RESOLVER_VIEW);
    // With a live resolving decision resolver, the declared completion must be
    // reachable either way — otherwise the declared value is not the success
    // value at all.
    assert.equal(withResolver.allow, true,
      `${s.id}'s transitions() refuses its own declared status.completion '${completion}' ` +
      `even with a resolving decision resolver`);
    if (required) {
      assert.equal(bare.allow, false,
        `${s.id} declares resolver_required: true but its transitions() allows '${completion}' with no resolver`);
    } else {
      assert.equal(bare.allow, true,
        `${s.id} declares no resolver requirement but its transitions() denies '${completion}' without a resolver ` +
        `— the gate is stricter than the declaration says`);
    }
  }
});

// ---- the declaration reaches readers through the registry, not hook source ----

test("the registry accessors expose the seed completion policy the gardener derives from", () => {
  const reg = new Registry();
  for (const s of graph.loadSeedSchemas()) reg.add(s, "seed");

  assert.equal(reg.completionStatus("task"), "done");
  assert.equal(reg.completionStatus("issue"), "resolved");
  assert.equal(reg.completionStatus("question"), "answered");
  assert.equal(reg.requiresCompletionResolver("task"), true);
  assert.equal(reg.requiresCompletionResolver("issue"), true);
  assert.equal(reg.requiresCompletionResolver("question"), false,
    "a question's `answered` takes any live answers edge — no completion-resolver gate");

  // The types whose closed vocabulary has no single mechanical success value:
  // a reader must get null here rather than a generic fallback its door refuses
  // (issue-spor-gardener-terminal-status-fallback-off-vocab).
  for (const t of ["decision", "artifact", "correction", "capture-pending"]) {
    assert.equal(reg.completionStatus(t), null, `${t} must declare no single completion status`);
    assert.ok(reg.statusVocabulary(t).size > 0, `${t}'s closed vocabulary must be readable off the registry`);
    assert.ok(!reg.statusVocabulary(t).has("resolved"),
      `${t}'s vocabulary must not contain the generic 'resolved' — that is why it has no mechanical remedy`);
  }

  // Open-vocabulary types: no declaration, so the generic terminal fallback
  // stays legitimate for them.
  for (const t of ["norm", "incident"]) {
    assert.equal(reg.statusVocabulary(t).size, 0, `${t} has no closed status vocabulary`);
    assert.equal(reg.completionStatus(t), null);
  }
});
