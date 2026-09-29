// lib/kernel/ranker.js — the content arm's tf-idf index and cosine ranker
// (task-spor-compile-explicit-pipeline-and-ranker-extraction).
//
// Pure: no fs, no clock. The index lives on the graph object as the five
// fields buildGraph has always exposed — `docs` ([{id, norm}]), `df` (term ->
// document frequency), `N` (doc count), `postings` (term -> {docs: Int32Array,
// w: Float64Array}) and `docIndex` (id -> slot in `docs`) — so every consumer
// that reads them (the server's gardener/capture near-dup passes) is untouched.
// This module owns how they are built, patched and scored; graph.js decides
// WHICH nodes are indexed (traversable ones) and compile() decides what a
// ranking is used for.
//
// Every accumulator keyed by a term is null-prototype: a token equal to an
// Object.prototype key ("constructor", "toString", …) must count as an
// ordinary term, not collide with the inherited member (which made
// `m[t] ?? 0` keep a function, corrupting the count into a string and
// ultimately yielding a NaN tf-idf weight / NaN doc norm —
// issue-cc-gardener-near-dup-unnormalized-cosine). The ranker corpus
// (conformance/cases/ranker-*.json) pins that, and the scores themselves.

// The tokenizer (Unicode fold + Intl.Segmenter words, stopword/length filter)
// is its own kernel module, shared with every other client-side tokenize/slug
// site (task-spor-unicode-slugify-and-tokenizer).
const { tokens } = require("./tokenizer.js");

// The text a node is indexed on.
const docText = (n) => `${n.title ?? ""} ${n.summary ?? ""} ${n.body}`;

// term -> count over a token list.
const tf = (ts) => ts.reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), Object.create(null));

// tf -> tf-idf against a df/N snapshot. A term absent from df scores
// log(N/N) = 0 (a query word the corpus never saw carries no weight).
function makeVec(df, N) {
  return (tfm) => Object.fromEntries(Object.entries(tfm).map(([t, c]) => [t, c * Math.log(N / (df[t] ?? N))]));
}

// Append (docIndex, weight) to term t's posting list. The base lists are typed
// arrays sized exactly at build time (issue-cc-graph-vec-posting-lists); a list
// touched by an incremental write is promoted once to plain growable arrays
// (rankAgainst reads .length/index identically for both, and the Float64 values
// are unchanged, so scores stay bit-identical). The next full reload restores
// the compact typed-array form, bounding the memory give-back to terms touched
// since the last reload.
function pushPosting(postings, t, idx, w) {
  let p = postings[t];
  if (!p) { postings[t] = { docs: [idx], w: [w] }; return; }
  if (ArrayBuffer.isView(p.docs)) { p.docs = Array.from(p.docs); p.w = Array.from(p.w); }
  p.docs.push(idx); p.w.push(w);
}

// Remove every entry for `idx` from term t's posting list (an update may have
// the same doc index appear once). Promotes a typed-array list to plain arrays.
function removePosting(postings, t, idx) {
  const p = postings[t];
  if (!p) return;
  const docsArr = p.docs, wArr = p.w;
  const nd = [], nw = [];
  for (let k = 0; k < docsArr.length; k++) {
    if (docsArr[k] === idx) continue;
    nd.push(docsArr[k]); nw.push(wArr[k]);
  }
  if (nd.length === 0) delete postings[t];
  else { p.docs = nd; p.w = nw; }
}

// buildIndex(nodes) -> { docs, df, N, postings, docIndex } over `nodes` (an
// array, indexed in the order given).
//
// Precompute the corpus as an inverted index once per load: rankAgainst
// runs on every prompt, and recomputing 5k doc vectors per query costs
// ~100ms+ at scale, vs ~10ms with a sparse dot product over query terms.
//
// The vectors live as per-term posting lists of typed arrays rather than a
// string-keyed plain object per doc (issue-cc-graph-vec-posting-lists): at
// 50k nodes the old per-doc objects cost ~328MB of heap in per-property
// overhead. postings[term] = { docs: Int32Array of indices into `docs`, w:
// Float64Array of aligned tf-idf weights }; df already supplies each term's
// posting-list length. Weights stay Float64 so cosines are bit-for-bit what
// the old object path produced (norm-cc-byte-identical-refactor).
function buildIndex(nodes) {
  const docs = nodes.map((n) => ({ id: n.id, tf: tf(tokens(docText(n))) }));
  const df = Object.create(null);
  for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] ?? 0) + 1;
  const N = docs.length;

  const vec = makeVec(df, N);
  const postings = Object.create(null); // a proto-key query token absent from the corpus must miss, not return an inherited member
  const cursor = Object.create(null);
  for (const t of Object.keys(df)) {
    postings[t] = { docs: new Int32Array(df[t]), w: new Float64Array(df[t]) };
    cursor[t] = 0;
  }
  // docIndex (task-cc-spor-tier-2-scale, §4.1): id -> position in `docs`, so the
  // incremental updater can find a node's doc slot in O(1) instead of scanning.
  const docIndex = Object.create(null);
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    docIndex[d.id] = i;
    const dv = vec(d.tf); // transient; folded into the posting lists below
    let nn = 0;
    for (const t of Object.keys(dv)) {
      const x = dv[t];
      nn += x * x; // same products, same order as the old Object.values(d.vec)
      const p = postings[t], k = cursor[t]++;
      p.docs[k] = i;
      p.w[k] = x;
    }
    d.norm = Math.sqrt(nn);
    delete d.tf; // dead after this; rankAgainst reads only postings + d.norm
  }
  return { docs, df, N, postings, docIndex };
}

// indexNode(index, node, old) — patch the index IN PLACE for one created
// (old == null) or updated node; the incremental twin of buildIndex (see
// graph.js applyNode for the fidelity/drift contract). The changed doc is
// scored against the now-current df/N exactly as a rebuild would score it;
// resident docs keep their last-build weights.
function indexNode(index, node, old) {
  const newTf = tf(tokens(docText(node)));
  const idx = old ? index.docIndex[node.id] : null;
  if (old && idx != null) {
    // UPDATE: reuse the doc slot. Remove the old term contributions, then add
    // the new — net df change is +1/-1 only for terms that entered or left.
    const oldTf = tf(tokens(docText(old)));
    for (const t of Object.keys(oldTf)) {
      if (index.df[t] != null && (index.df[t] -= 1) <= 0) delete index.df[t];
      removePosting(index.postings, t, idx);
    }
    for (const t of Object.keys(newTf)) index.df[t] = (index.df[t] ?? 0) + 1;
    // N is unchanged on an update.
    const dv = makeVec(index.df, index.N)(newTf);
    let nn = 0;
    for (const t of Object.keys(dv)) { const x = dv[t]; nn += x * x; pushPosting(index.postings, t, idx, x); }
    index.docs[idx].norm = Math.sqrt(nn);
  } else {
    // CREATE: append a new doc slot.
    for (const t of Object.keys(newTf)) index.df[t] = (index.df[t] ?? 0) + 1;
    index.N += 1;
    const i = index.docs.length;
    const dv = makeVec(index.df, index.N)(newTf);
    let nn = 0;
    for (const t of Object.keys(dv)) { const x = dv[t]; nn += x * x; pushPosting(index.postings, t, i, x); }
    index.docs.push({ id: node.id, norm: Math.sqrt(nn) });
    index.docIndex[node.id] = i;
  }
}

// rankAgainst(index, text, excludeIds) -> [{id, sim}] over every indexed doc
// not in excludeIds, cosine-desc (stable on ties: index order).
function rankAgainst(index, text, excludeIds) {
  const rootVec = makeVec(index.df, index.N)(tf(tokens(text)));
  // cos(query, doc) against the posting lists and norms precomputed in
  // buildIndex: sqrt(na)*sqrt(nb) === queryNorm*d.norm. Driving the dot from
  // the query's posting lists touches only docs that share a query term, and
  // each doc's score accumulates its query terms in Object.entries(rootVec)
  // order — bit-identical to a per-doc loop.
  let qn = 0;
  for (const x of Object.values(rootVec)) qn += x * x;
  const queryNorm = Math.sqrt(qn);
  const docs = index.docs;
  const scores = new Float64Array(docs.length);
  for (const [t, x] of Object.entries(rootVec)) {
    const p = index.postings[t];
    if (!p) continue;
    const pd = p.docs, pw = p.w;
    for (let k = 0; k < pd.length; k++) scores[pd[k]] += x * pw[k];
  }
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (excludeIds.has(d.id)) continue;
    // A non-finite or zero norm means the cosine is undefined (an empty doc, or
    // — pre-fix — a NaN norm from a proto-key token). Score it 0 rather than
    // falling back to the raw, unnormalized dot product, which would let such a
    // doc dominate every ranking (issue-cc-gardener-near-dup-unnormalized-cosine).
    const denom = queryNorm * d.norm;
    out.push({ id: d.id, sim: denom > 0 ? scores[i] / denom : 0 });
  }
  return out.sort((a, b) => b.sim - a.sim);
}

module.exports = { docText, tf, makeVec, buildIndex, indexNode, rankAgainst, pushPosting, removePosting };
