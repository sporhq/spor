"use strict";
// Pure ranking metrics for the digest ranking eval (scripts/rank-eval/run.js).
//
// Graded relevance, from the digest-intent judge's per-node `relevance` labels:
// a node is `relevant` (worth the slot), `tangential` (on-topic but not useful)
// or `noise`. Gains are the standard 2/1/0 — a relevant node is worth two
// tangential ones, noise is worth nothing (never negative: nDCG is undefined
// with negative gains).
//
// No IO, no graph, no LLM — kept separate from run.js so the scoring math is
// unit-testable without the private eval corpus (test/rank-metrics.test.js).

const GAIN = { relevant: 2, tangential: 1, noise: 0 };

const gainOf = (label) => GAIN[label] ?? 0;

// Discounted cumulative gain over the first k ranks. Standard log2(rank+1)
// discount, rank being 1-based.
function dcg(gains, k) {
  let sum = 0;
  for (let i = 0; i < Math.min(k, gains.length); i++) sum += gains[i] / Math.log2(i + 2);
  return sum;
}

// nDCG@k of `order` (an array of node ids) against `labels` (id -> label).
//
// The ideal ranking is the whole LABELED POOL sorted by gain — not just the
// nodes `order` happens to contain. So a ranker that leaves a known-relevant
// node out of its top-k is penalized against a ranker that surfaces it, which
// is what lets this metric reward retrieval and not only reordering.
//
// Ids in `order` with no label are skipped (they can't be scored); ids in the
// pool that `order` never emits simply never contribute gain. Returns null when
// the pool has no gain at all (every node is noise) — an undefined nDCG, which
// callers must exclude from the mean rather than count as 0.
function ndcgAt(order, labels, k) {
  const gains = order.filter((id) => labels[id] != null).map((id) => gainOf(labels[id]));
  const ideal = Object.values(labels).map(gainOf).sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  if (idcg === 0) return null;
  return dcg(gains, k) / idcg;
}

// Precision@k — the share of the first k emitted-and-labeled slots holding a
// node the judge called `relevant`. Divided by k (not by the number of labeled
// hits), so emitting fewer than k nodes cannot inflate it.
//
// Returns null when the pool holds no relevant node at all: no ranking can
// score above 0, so averaging it in would only measure the case mix.
function precisionAt(order, labels, k) {
  if (!Object.values(labels).some((l) => l === "relevant")) return null;
  const scored = order.filter((id) => labels[id] != null).slice(0, k);
  return scored.filter((id) => labels[id] === "relevant").length / k;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

module.exports = { GAIN, gainOf, dcg, ndcgAt, precisionAt, mean };
