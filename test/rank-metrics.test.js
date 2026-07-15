// scripts/rank-eval/metrics.js — the digest ranking eval's scoring math, and
// scripts/rank-eval/labels.js's positional label join
// (task-spor-improve-digest-ranking-relevance). The harness itself needs the
// private eval corpus and a graph checkout, so it can't run here; these are the
// pure pieces, and they are the ones a wrong answer would silently ride on.
const test = require("node:test");
const assert = require("node:assert");
const m = require("../scripts/rank-eval/metrics.js");
const { microIds, fullIds, zip } = require("../scripts/rank-eval/labels.js");

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);

test("gainOf: graded relevance, unknown labels score 0", () => {
  assert.strictEqual(m.gainOf("relevant"), 2);
  assert.strictEqual(m.gainOf("tangential"), 1);
  assert.strictEqual(m.gainOf("noise"), 0);
  assert.strictEqual(m.gainOf("bogus"), 0);
  assert.strictEqual(m.gainOf(undefined), 0);
});

test("dcg: log2(rank+1) discount, truncated at k", () => {
  close(m.dcg([2], 5), 2, "single gain at rank 1 is undiscounted");
  close(m.dcg([0, 2], 5), 2 / Math.log2(3), "rank 2 discounted by log2(3)");
  close(m.dcg([2, 2], 1), 2, "k truncates");
  assert.strictEqual(m.dcg([], 5), 0);
});

test("ndcgAt: perfect order scores 1, reversed scores less", () => {
  const labels = { a: "relevant", b: "tangential", c: "noise" };
  assert.strictEqual(m.ndcgAt(["a", "b", "c"], labels, 5), 1);
  assert.ok(m.ndcgAt(["c", "b", "a"], labels, 5) < 1);
  // ordering is what's measured: same set, better order scores strictly higher
  assert.ok(m.ndcgAt(["a", "b", "c"], labels, 5) > m.ndcgAt(["b", "a", "c"], labels, 5));
});

test("ndcgAt: the ideal is the whole POOL, so missing a relevant node is penalized", () => {
  // The property the harness leans on: a ranker that never emits a known-relevant
  // node must score below one that emits it, even though both emitted orders are
  // internally perfect. This is what lets the eval see retrieval, not just order.
  const labels = { a: "relevant", b: "tangential" };
  assert.strictEqual(m.ndcgAt(["a", "b"], labels, 5), 1);
  assert.ok(m.ndcgAt(["b"], labels, 5) < 1);
});

test("ndcgAt: unlabeled ids are skipped, not scored as noise", () => {
  const labels = { a: "relevant", b: "tangential" };
  // `x` is unlabeled: it must not occupy a discounted slot, or a ranker would be
  // penalized for emitting nodes the judge simply never saw.
  assert.strictEqual(m.ndcgAt(["a", "x", "b"], labels, 5), 1);
});

test("ndcgAt: an all-noise pool is undefined (null), not 0", () => {
  // Averaging these in would measure the case mix rather than the ranker.
  assert.strictEqual(m.ndcgAt(["a", "b"], { a: "noise", b: "noise" }, 5), null);
});

test("precisionAt: divided by k, so emitting fewer than k cannot inflate it", () => {
  const labels = { a: "relevant", b: "noise", c: "relevant" };
  close(m.precisionAt(["a", "b", "c"], labels, 3), 2 / 3, "2 of 3 relevant");
  close(m.precisionAt(["a"], labels, 3), 1 / 3, "one relevant hit out of k=3 slots");
  close(m.precisionAt(["a", "c", "b"], labels, 3), 2 / 3, "order within k doesn't matter");
  assert.strictEqual(m.precisionAt(["b"], { b: "noise" }, 3), null, "no relevant in pool => undefined");
});

test("mean: empty is null, not NaN or 0", () => {
  assert.strictEqual(m.mean([]), null);
  close(m.mean([1, 2]), 1.5, "mean");
});

test("microIds / fullIds: parse each arm's render format, anchored at line start", () => {
  const micro = "Spor context (top matches):\n- dec-foo: Title — summary\n- task-bar: T — s\n";
  assert.deepStrictEqual(microIds(micro), ["dec-foo", "task-bar"]);
  const full = "header:\n\n- **dec-foo — Title** (decision, spor, 2026-01-01): summary\n- **art-baz — T** (artifact): s\n";
  assert.deepStrictEqual(fullIds(full), ["dec-foo", "art-baz"]);
  // an id mentioned inside a summary is not a slot
  assert.deepStrictEqual(microIds("- dec-foo: see also task-bar: nope\n"), ["dec-foo"]);
  assert.deepStrictEqual(microIds(""), []);
  assert.deepStrictEqual(microIds(null), []);
  // the formats must not cross-match, or labels would zip onto the wrong arm
  assert.deepStrictEqual(fullIds(micro), []);
  assert.deepStrictEqual(microIds(full), []);
});

test("zip: refuses to align when the counts disagree", () => {
  // The judge sometimes returned more labels than the digest had lines. A
  // truncating zip would silently mislabel every node after the first gap, so
  // the case is dropped instead.
  assert.deepStrictEqual(zip(["a", "b"], ["relevant", "noise"]), [["a", "relevant"], ["b", "noise"]]);
  assert.strictEqual(zip(["a"], ["relevant", "noise"]), null);
  assert.strictEqual(zip(["a", "b"], ["relevant"]), null);
  assert.strictEqual(zip([], []), null);
  assert.strictEqual(zip(["a"], undefined), null);
});
