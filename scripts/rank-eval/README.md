# Digest ranking eval

Scores the `UserPromptSubmit` digest compiler's node **ordering** against the
per-node relevance labels produced by the digest-intent judge
(`art-spor-digest-noise-eval-2026-06-25`). Built for
`task-spor-improve-digest-ranking-relevance`; the measured outcome is
`dec-spor-digest-ranking-at-practical-ceiling`.

The fire-gate eval asked *should a digest fire at all* — a semantic question that
cannot be answered on the prompt path (`dec-spor-digest-noise-needs-async-semantic-intent`).
This asks the narrower question the deterministic ranker **can** answer: given
that a digest fires, are its best nodes at the top?

## Running it

The labeled corpus is not in this repo — it lives in the private server repo at
`evals/digest-intent-2026-07-06`, and replay needs a checkout of the graph whose
history the labels were taken against (`~/repos/bcdr-substrate`).

```bash
node scripts/rank-eval/run.js --labels ~/repos/spor-server/evals/digest-intent-2026-07-06
node scripts/rank-eval/run.js --labels <dir> --engine-root <other-checkout> --label variant --json out.json
```

`--engine-root` points at any checkout of this repo, so a candidate engine is
A/B'd against the identical case + snapshot set. A run is ~30s (77 cases, 68
snapshots). `npm test` covers the pure scoring math and the label join
(`test/rank-metrics.test.js`); the harness itself needs the corpus and self-skips
nowhere — it exits non-zero with a clear message if `--labels` is missing.

## Method

The digest is a pure function of `(prompt, graph@T)`, and the graph repo commits
per node, so each case is re-run against the exact snapshot it was labeled at
(`snap_sha`, taken from the replay record rather than re-resolved from the
timestamp). The real hook binary is driven in forced local mode with a scratch
`HOME`, so the shipped gates + compile + microDigest all apply and a configured
dev box cannot put the run in remote mode against the live team graph.

**The label join is the delicate part.** The judge recorded `node_relevance` as a
*positional* array with no node ids, so a label is only recoverable by re-parsing
the digest text the judge was shown and zipping. Two arms were judged per case,
in two different render formats: arm A (`actual`, the live server digest, in
compile's full format) and arm B (`current`, the local replay, in microDigest's
compact format). Both are labeled per `(prompt, node)`, so their labels pool —
the union is ~7.6 nodes/case against arm B's 5, which is what lets the eval
reward *surfacing* a known-relevant node arm B missed rather than only reordering
arm B's five.

Two independent checks say the join is sound: the arms overlap on 315 nodes and
agree on **98.7%** of them (a broken positional join would disagree at random),
and **99.7%** of emitted nodes carry a label.

Cases are dropped, never truncated to fit, when the parsed line count disagrees
with the label count or the prompt is unrecoverable — `cases.jsonl` was
re-extracted after the judge ran, costing 21 of the 150 judged cases their
prompt. Of 150 judged: 77 usable, 52 fired no digest in either arm, 21 lost their
prompt. `run.js` prints the full drop accounting every run.

Scoring is nDCG@5 (gains: relevant 2, tangential 1, noise 0) and precision@3.
The **ideal ranking is the whole labeled pool**, not just what the engine emitted,
so leaving a known-relevant node out is penalized — the metric sees retrieval,
not only ordering.

## What it measured

Baseline, the shipped ranker (77 cases; nDCG over 68, P@3 over 51):

| | nDCG@5 | P@3 |
|---|---|---|
| all cases | 0.7815 | 0.7190 |
| warranted only (n=58) | 0.8524 | 0.7200 |

**Warranted-only is the metric that matters.** On `warranted: false` cases the
whole pool is noise by construction — the prompt merited no digest — so no
re-ranking can score there. Those cases measure the *intent gate*, which is a
different piece of work.

The ceiling, and every lever tried (see the decision node for the full argument):

| variant | nDCG@5 (all) | nDCG@5 (warranted) |
|---|---|---|
| **baseline** | **0.7815** | **0.8524** |
| *oracle: perfect reorder of what's retrieved* | *0.8287 (+0.047)* | *0.8885 (+0.036)* |
| content-similarity blend, weight 0.5 / 1 / 2 | 0.7601 / 0.7524 / 0.7455 | 0.8182 / 0.8064 / 0.8014 |
| demote capture-pending (94% noise) | 0.7839 (+0.002) | 0.8531 (+0.001) |
| node-type prior, *fit on the test data* | 0.7755 | 0.8399 |
| CONTENT_TOP_K 6 / 8 | 0.7815 (no change) | 0.8524 |
| QUERY_SEEDS 5 / 8 | 0.7702 / 0.7671 | 0.8407 / 0.8370 |

A **perfect oracle** re-ranker gains only +0.036 on warranted cases: the ordering
is already near its ceiling, and 3× more of the loss (0.1115) is retrieval —
which nodes get selected at all — which pooled labels cannot score, since a node
neither arm surfaced has no label.

No lever beat the baseline. Adding query similarity to the ordering *hurts
monotonically*, which refutes the hypothesis this task was filed on ("the content
arm over-weights lexical overlap"): the digest concatenates the arms, so the
content arm is subordinate, not over-weighted, and `CONTENT_TOP_K` not moving the
metric at all shows content picks never reach the top 5. Boosting the structure-
blind arm degrades a better structural signal — the same result
`art-experiment-scale` found when structure-blind RAG missed a lineage-only
constraint entirely.

So `lib/kernel/graph.js` is deliberately **unchanged**. The harness is the
deliverable: any future ranking idea can be scored against real labels in ~30s
instead of shipped on a hunch.

## Limits worth knowing before trusting a future run

- **Pooling bias.** Labels exist only for nodes one of the two arms actually
  showed. A change that surfaces a genuinely better *unlabeled* node scores as
  neutral, so the eval cannot reward true retrieval improvements — the direction
  with the most headroom. Re-judging is the only fix.
- **Small n.** 58 warranted cases, ~460 labeled slots. Differences below ~0.01
  nDCG are noise; the capture-pending demote's +0.002 is not a result.
- **Arm A is a different pipeline.** The server digest adds a team-first merge and
  serve-time corrections, so chasing the pool nodes only arm A found partly means
  converging on the server's output rather than on relevance.
- **The graph is one team's.** Every case comes from `bcdr-substrate`; the tuning
  it supports is not obviously portable to a different graph's topology.
