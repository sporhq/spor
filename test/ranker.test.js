// lib/kernel/ranker.js — the content arm's tf-idf index and cosine ranker
// (task-spor-compile-explicit-pipeline-and-ranker-extraction). The scores
// themselves are pinned by the conformance corpus (conformance/cases/
// ranker-tfidf.json); these are the properties that must hold for ANY corpus.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ranker = require(path.join(__dirname, "..", "lib", "kernel", "ranker.js"));
const kgraph = require(path.join(__dirname, "..", "lib", "kernel", "graph.js"));

const doc = (id, title, summary = "", body = "") => ({ id, title, summary, body });
const CORPUS = [
  doc("dec-a", "Vendor neutral price book", "The price book prices vendor-neutral.", "Composed bundles live in the price book."),
  doc("dec-b", "Bundle discounts compose", "Composed bundle discounts stack.", "A composed bundle inherits each plan discount."),
  doc("dec-c", "constructor toString valueOf", "Object prototype keys as words.", "constructor hasOwnProperty __proto__ isPrototypeOf"),
  doc("dec-d", "", "", ""),
  doc("dec-e", "Deploy pipeline", "Fly deploy through swamp workflows.", "The deploy workflow rolls machines."),
];
const QUERIES = ["price book vendor", "composed bundle discount", "constructor toString", "deploy swamp", "zzqx", ""];

test("ranker: every norm and every sim is finite, and sims sit in [0, 1]", () => {
  const index = ranker.buildIndex(CORPUS);
  for (const d of index.docs) assert.ok(Number.isFinite(d.norm) && d.norm >= 0, `${d.id} norm ${d.norm}`);
  for (const q of QUERIES) {
    for (const r of ranker.rankAgainst(index, q, new Set())) {
      assert.ok(Number.isFinite(r.sim) && r.sim >= 0 && r.sim <= 1 + 1e-9, `${q} -> ${r.id} ${r.sim}`);
    }
  }
});

test("ranker: a zero-norm doc scores 0 and an unknown/empty query ranks every doc at 0", () => {
  const index = ranker.buildIndex(CORPUS);
  assert.equal(index.docs[index.docIndex["dec-d"]].norm, 0);
  for (const q of ["zzqx wibble", ""]) {
    const ranked = ranker.rankAgainst(index, q, new Set());
    assert.equal(ranked.length, CORPUS.length);
    assert.ok(ranked.every((r) => r.sim === 0));
    assert.deepEqual(ranked.map((r) => r.id), CORPUS.map((d) => d.id), "ties keep index order");
  }
});

test("ranker: prototype-key tokens are ordinary terms (no NaN, no inherited postings)", () => {
  const index = ranker.buildIndex(CORPUS);
  assert.equal(index.df.constructor, 1);
  assert.equal(Object.getPrototypeOf(index.df), null);
  assert.equal(Object.getPrototypeOf(index.postings), null);
  assert.equal(ranker.rankAgainst(index, "constructor toString", new Set())[0].id, "dec-c");
  // a proto-key query term the corpus never saw must miss, not hit a member
  const plain = ranker.buildIndex([doc("dec-x", "pricing"), doc("dec-y", "deploy")]);
  assert.ok(ranker.rankAgainst(plain, "valueOf hasOwnProperty", new Set()).every((r) => r.sim === 0));
});

test("ranker: excludeIds drops ids from the ranking and nothing else", () => {
  const index = ranker.buildIndex(CORPUS);
  const all = ranker.rankAgainst(index, "price book bundle", new Set());
  const some = ranker.rankAgainst(index, "price book bundle", new Set(["dec-a"]));
  assert.deepEqual(some, all.filter((r) => r.id !== "dec-a"));
});

test("ranker: indexNode scores the changed doc exactly as a rebuild would", () => {
  const updated = doc("dec-b", "Bundle discounts are flat", "Plan discounts never stack.", "One flat discount per plan in the price book.");
  const created = doc("dec-f", "Wibble pricing", "A wibble is priced like a bundle.", "wibble price book");
  const inc = ranker.buildIndex(CORPUS);
  ranker.indexNode(inc, updated, CORPUS[1]);
  ranker.indexNode(inc, created, null);
  const rebuilt = ranker.buildIndex([CORPUS[0], updated, ...CORPUS.slice(2), created]);
  assert.equal(inc.N, rebuilt.N);
  assert.deepEqual({ ...inc.df }, { ...rebuilt.df });
  // The changed docs match a rebuild bit-for-bit only when scored against the
  // same df/N; the created doc is (it was indexed last).
  assert.equal(inc.docs[inc.docIndex["dec-f"]].norm, rebuilt.docs[rebuilt.docIndex["dec-f"]].norm);
  // The ranking's winner for each changed doc's own vocabulary is the same.
  for (const q of ["flat discount never stack", "wibble"]) {
    assert.equal(ranker.rankAgainst(inc, q, new Set())[0].id, ranker.rankAgainst(rebuilt, q, new Set())[0].id, q);
  }
  // Old terms of the updated doc left the index.
  assert.ok(!ranker.rankAgainst(inc, "inherits", new Set()).some((r) => r.id === "dec-b" && r.sim > 0));
});

const SEED = path.join(__dirname, "..", "lib", "seed");
const seedFiles = () => Object.fromEntries(fs.readdirSync(SEED).filter((f) => f.endsWith(".md")).sort()
  .map((f) => [f, fs.readFileSync(path.join(SEED, f), "utf8")]));

test("ranker: graph.js re-exports the same rankAgainst and buildGraph exposes the index fields", () => {
  assert.equal(kgraph.rankAgainst, ranker.rankAgainst);
  const g = kgraph.buildGraph({
    "dec-a.md": "---\nid: dec-a\ntype: decision\ntitle: Price book\nsummary: prices\n---\nbody\n",
    "corr-x.md": "---\nid: corr-x\ntype: correction\ntitle: c\ntarget: global\n---\nnever indexed\n",
  }, { seedSchemas: kgraph.parseSeedSchemas(seedFiles()) });
  for (const k of ["docs", "df", "N", "postings", "docIndex"]) assert.ok(k in g, k);
  assert.deepEqual(g.docs.map((d) => d.id), ["dec-a"], "only traversable nodes are indexed");
});
