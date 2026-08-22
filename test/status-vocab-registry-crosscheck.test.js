// Cross-check: test/helpers/status-vocab.js's hand-written `valid` lists vs
// the declarative registry surface (task-spor-assert-hand-lists-against-
// declarative-vocab, following task-spor-registry-declarative-terminal-
// status-policy).
//
// test/helpers/status-vocab.js is DELIBERATELY hand-written (see its own
// header): reading a seed schema's payload back into the test that is
// supposed to catch a bug in that same schema would make the suites
// tautological. But now that status.vocabulary is also DECLARED as registry
// data (dec-spor-completion-policy-declared-not-enforced), the hand list and
// the declaration are two independent surfaces of the same seed schema that
// can silently drift — a schema's vocabulary changes and nobody updates the
// hand list, or vice versa, and neither the hand-list-driven tests nor the
// registry-declaration tests would notice, because each only checks itself.
//
// This suite is that missing check: it compares the hand list to
// registry.statusVocabulary(type) and fails loudly, naming which side is
// stale, on any divergence — in either direction.
//
// Run: node --test

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { Registry } = require(path.join(__dirname, "..", "lib", "kernel", "registry.js"));
const { STATUS_VOCAB } = require(path.join(__dirname, "helpers", "status-vocab.js"));

function buildRegistry() {
  const reg = new Registry();
  for (const s of graph.loadSeedSchemas()) reg.add(s, "seed");
  return reg;
}

test("test/helpers/status-vocab.js's valid lists match each seed schema's declared status.vocabulary", () => {
  const reg = buildRegistry();

  for (const [type, { valid }] of Object.entries(STATUS_VOCAB)) {
    const declared = reg.statusVocabulary(type);
    assert.ok(declared.size > 0,
      `schema-${type} declares no status.vocabulary, but test/helpers/status-vocab.js hand-lists valid ` +
      `statuses for it — either the seed schema dropped its declaration, or this type no longer belongs ` +
      `in STATUS_VOCAB`);

    const hand = new Set(valid.map((s) => s.toLowerCase()));
    const missingFromHand = [...declared].filter((s) => !hand.has(s)).sort();
    const missingFromDeclared = [...hand].filter((s) => !declared.has(s)).sort();

    assert.deepEqual(missingFromHand, [],
      `schema-${type}'s declared status.vocabulary has '${missingFromHand.join(", ")}' that ` +
      `test/helpers/status-vocab.js's '${type}.valid' is missing — update the hand list`);
    assert.deepEqual(missingFromDeclared, [],
      `test/helpers/status-vocab.js's '${type}.valid' lists '${missingFromDeclared.join(", ")}' but ` +
      `schema-${type}'s declared status.vocabulary does not include it — the seed schema changed, or ` +
      `the hand list is stale`);
  }
});

// The reverse direction: every seed node-schema that DOES declare a closed
// status.vocabulary must be represented in STATUS_VOCAB, so a newly
// vocabulary-gated type doesn't silently sit outside this cross-check.
test("every seed node-schema with a declared status.vocabulary has an entry in test/helpers/status-vocab.js", () => {
  const reg = buildRegistry();
  const nodeSchemas = graph.loadSeedSchemas().filter((s) => s.kind === "node-schema");

  for (const s of nodeSchemas) {
    if (reg.statusVocabulary(s.key).size === 0) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(STATUS_VOCAB, s.key),
      `${s.id} declares a closed status.vocabulary but test/helpers/status-vocab.js has no '${s.key}' entry ` +
      `— add one so drift on this type is caught mechanically`);
  }
});
