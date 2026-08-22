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
# score against the committed pooled labels (see "Retrieval pooling" below) —
# this is how every baseline number in this file is now reported:
node scripts/rank-eval/run.js --labels <dir> --pooled-labels scripts/rank-eval/pooled-labels/labels.jsonl
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

## Retrieval pooling (issue-spor-digest-rank-eval-retrieval-blind)

The original two-arm label pool (arm A `actual`, arm B `current`) still has a
blind spot the metric can't see past: a label exists only for a node one of
those two arms actually showed. A candidate retriever that surfaces a
genuinely better node **neither arm ever showed the judge** emits an id with no
label — `ndcgAt` correctly skips unlabeled ids rather than scoring them as
noise, but that means the retrieval win is invisible: the candidate scores
*identically* to a baseline that never surfaced the node at all, not higher.
`test/rank-metrics.test.js` has a unit test that pins this down precisely (both
the bug, against the arms-only pool, and the fix, against the pooled one).

**The fix is a re-judging pass over a POOLED candidate set**, not another pass
over the existing labels (they only ever describe what the two original arms
showed). `run.js --pool` runs the shipped engine plus four deliberately-different
retrieval variants against every case — each tweaks one retrieval lever via the
`CAND_*` env passthrough onto an `opts` field `compile()`/`structuralWalk()` now
accept (`contentTopK`, `querySeeds`, `maxHops`; byte-identical to the shipped
constants when unset, so this is not a kernel behavior change):

| variant | lever | why it surfaces different nodes |
|---|---|---|
| `content-widened` | `CONTENT_TOP_K` 4 → 8 | more lexical-similarity picks |
| `structural-only` | `CONTENT_TOP_K` → 0 | content arm off; an approximation, since the seeds themselves are still top content hits |
| `wider-walk` | `QUERY_SEEDS` 3→6, `MAX_HOPS` 3→4 | a genuinely different structural candidate SET |
| `narrow-walk` | `QUERY_SEEDS`→1, `MAX_HOPS`→1 | thins the structural set enough that nodes the shipped walk's 5-node cap crowded out can reach the top 5 |

(The first two rarely matter in practice — the microDigest window is only 5
nodes and structural hits usually fill it, so a content-arm tweak alone rarely
changes what's *in* the top 5, matching "no lever beat the baseline" below. The
walk-shape variants are what actually swap which nodes compete for those
slots.)

Every candidate id no existing label covers — from any of the five arms
(shipped + 4 variants) — is dumped to `--pool-out`
(`scripts/rank-eval/pooled-labels/candidates.jsonl` by default) with the node's
title/summary and the case's prompt + preceding context, the same material the
original judge saw. `pool-judge.js` then re-judges every candidate, **keyed by
node id** (not position — the positional-join fragility "THE JOIN" above
describes doesn't apply to a fresh judging pass that already has ids), using
the same relevant/tangential/noise rubric, batched one LLM call per case:

```bash
node scripts/rank-eval/run.js --labels <dir> --pool
node scripts/rank-eval/pool-judge.js --candidates scripts/rank-eval/pooled-labels/candidates.jsonl \
  --out scripts/rank-eval/pooled-labels/labels.jsonl
```

`pool-judge.js` needs no raw `ANTHROPIC_API_KEY` — its default backend is the
same headless `claude -p --model haiku` invocation the rest of the plugin's LLM
call sites use (`--cmd` swaps in a different backend, same stdin/stdout
contract as `SPOR_NUDGE_CMD`). `mergePooledLabels` (`labels.js`) merges the
result into each case's label pool — filling in ids the original arms never
covered, never overriding an original label — and `--pooled-labels
<labels.jsonl>` on a plain (non-`--pool`) run scores against it, which is how
every number in this file is now reported.

The committed pooled label set (`scripts/rank-eval/pooled-labels/`) is
`candidates.jsonl` (the 100-candidate dump across 60 of the 77 cases — 17 cases'
five arms agreed on everything already labeled), `labels.jsonl` (100 fresh
id-keyed labels: 23 relevant, 46 tangential, 31 noise), and `provenance.json`
(judge model, date, case/candidate counts). Snapshot materialization stayed
bounded-batch throughout (the disk-exhaustion guard from
`art-res-inc-spor-dev-box-disk-full-2026-06-17` — see "INODE SAFETY" in
`run.js` — is untouched by pooling; it just runs more hook invocations per
batch).

## What it measured

Baseline, the shipped ranker, against the **original arms-only labels** (77
cases; nDCG over 68, P@3 over 51) — this is the measurement
`dec-spor-digest-ranking-at-practical-ceiling` and the lever table below are
based on:

| | nDCG@5 | P@3 |
|---|---|---|
| all cases | 0.7815 | 0.7190 |
| warranted only (n=58) | 0.8524 | 0.7200 |

Re-reported against the **pooled labels** (`scripts/rank-eval/pooled-labels/`,
2026-08-22) — the comparable floor for future retrieval changes
(`node scripts/rank-eval/run.js --labels <dir> --pooled-labels
scripts/rank-eval/pooled-labels/labels.jsonl`):

| | nDCG@5 | P@3 |
|---|---|---|
| all cases | 0.7226 | 0.6918 |
| warranted only (n=58) | 0.7990 | — |

The pooled score is **lower**, not higher, than the arms-only one — expected,
not a regression: pooling doesn't just add new relevant nodes to reward, it
also gives some of the shipped ranker's own previously-unlabeled emissions a
real (often `tangential`/`noise`) label for the first time, so emissions that
used to be silently free of penalty (unlabeled, filtered out of the gain sum)
now count against it. Label coverage of emitted nodes moved from 99.7% to
100.0%. This is the more honest number; treat the arms-only 0.7815/0.8524 as
the historical figure the ceiling argument below was made against, not a
target to reproduce. (The LLM judge is not perfectly deterministic case-to-case
— re-running `pool-judge.js` from scratch will land within roughly ±0.01 of
these figures, not reproduce them bit-for-bit; the numbers here are pinned to
the exact committed `labels.jsonl`.)

**Warranted-only is the metric that matters.** On `warranted: false` cases the
whole pool is noise by construction — the prompt merited no digest — so no
re-ranking can score there. Those cases measure the *intent gate*, which is a
different piece of work.

The ceiling, and every lever tried, all measured against the **original
arms-only labels** (see the decision node for the full argument — a future
re-run of this table against the pooled labels would need to redo the lever
sweep, which this issue was not scoped to do):

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
which nodes get selected at all. At the time this table was measured, a node
neither arm surfaced had no label and pooled labels couldn't score it either —
that gap is what "Retrieval pooling" above now closes, though the lever sweep
itself was measured before the fix and hasn't been redone against pooled
labels (see "Limits" below).

No lever beat the baseline. Adding query similarity to the ordering *hurts
monotonically*, which refutes the hypothesis this task was filed on ("the content
arm over-weights lexical overlap"): the digest concatenates the arms, so the
content arm is subordinate, not over-weighted, and `CONTENT_TOP_K` not moving the
metric at all shows content picks never reach the top 5. Boosting the structure-
blind arm degrades a better structural signal — the same result
`art-experiment-scale` found when structure-blind RAG missed a lineage-only
constraint entirely.

So `lib/kernel/graph.js`'s shipped ranking behavior is deliberately
**unchanged** (the `contentTopK`/`querySeeds`/`maxHops` opts it gained for the
pooling harness are eval-only levers, byte-identical to the shipped constants
whenever a real caller leaves them unset). The harness is the deliverable: any
future ranking idea can be scored against real labels in ~30s instead of
shipped on a hunch.

## Limits worth knowing before trusting a future run

- **Pooling bias — RESOLVED** (`issue-spor-digest-rank-eval-retrieval-blind`).
  Labels used to exist only for nodes one of the two original arms actually
  showed, so a change that surfaced a genuinely better *unlabeled* node scored
  as neutral — the eval couldn't reward true retrieval improvements, the
  direction with the most headroom. `run.js --pool` + `pool-judge.js` now
  re-judge a pooled candidate set from four deliberately-different retrieval
  variants, keyed by node id, and the committed
  `scripts/rank-eval/pooled-labels/` set + `--pooled-labels` scoring close the
  gap (see "Retrieval pooling" above). The residual: pooling covers only the
  five variants actually run — a retriever using a genuinely different
  *mechanism* (not a lever tweak on this same compiler) can still surface an
  unlabeled node, so this narrows the blind spot rather than eliminating the
  category.
- **Small n.** 58 warranted cases, ~460 labeled slots. Differences below ~0.01
  nDCG are noise; the capture-pending demote's +0.002 is not a result.
- **Arm A is a different pipeline.** The server digest adds a team-first merge and
  serve-time corrections, so chasing the pool nodes only arm A found partly means
  converging on the server's output rather than on relevance.
- **The graph is one team's.** Every case comes from `bcdr-substrate`; the tuning
  it supports is not obviously portable to a different graph's topology.
