# Digest-intent classifier eval (the fire gate)

Scores the async digest-intent classifier — `prompts/client/digest-intent.md`,
run off the prompt path by `scripts/engines/digest-worker.js` — against the
`warranted` labels of `art-spor-digest-noise-eval-2026-06-25`.

This is the pre-ship gate `dec-spor-digest-async-intent-gate-implementation`
deferred: `SPOR_DIGEST_ASYNC` does not go default-on until the classifier is
scored against those labels. Its sibling `scripts/rank-eval/` asks the narrower
question — given that a digest fires, are its best nodes at the top? This one
asks whether it should have fired at all, which is the semantic question that
cannot be answered on the prompt path (`dec-spor-digest-noise-needs-async-semantic-intent`).

The first scoring run (2026-07-06,
`dec-spor-digest-intent-classifier-scored-prompt-recalibrated`) found the
then-shipped prompt suppressed **51%** of warranted digests and recalibrated it
down to **6.8%** — which clears the hard harm rule but is still fractionally
*over* the 6% budget, so the gate's own verdict on it is FAIL (see
[Results](#results)). The harness that produced those numbers then lived in a
scratchpad, so the next person to touch the prompt had nothing to re-score
against (`task-spor-recalibrate-digest-intent-prompt`). This is that harness,
committed.

## Running it

The labeled corpus is not in this repo and cannot be: it is ~7MB of real prompts
and digests off a working box, and this repo is public. It lives in the private
server repo at `evals/digest-intent-2026-07-06` (the same corpus `rank-eval`
takes `--labels` from).

```bash
# live: score the template in this checkout against the shipped default backend
node scripts/intent-eval/run.js --labels ~/repos/spor-server/evals/digest-intent-2026-07-06

# a candidate prompt: point --engine-root at any checkout of this repo
node scripts/intent-eval/run.js --labels <dir> --engine-root <other-checkout> --label candidate

# a cheaper/faster backend, same stdin->stdout contract as SPOR_DIGEST_INTENT_CMD
node scripts/intent-eval/run.js --labels <dir> --cmd 'scripts/distill-gemini.sh'

# re-score a recorded run — no backend calls, so every number below is re-derivable
node scripts/intent-eval/run.js --labels <dir> --replay scripts/intent-eval/runs/2026-09-05-shipped-haiku.jsonl
```

A live run is 77 backend calls (~3min at `--concurrency 8`); `--out` preserves
the per-case decisions for `--replay`, `--json` the summary, `--strict` exits 1
when the gate fails. `npm test` covers the scoring math and the population
selection (`test/intent-metrics.test.js`); the harness itself needs the corpus
and refuses with a clear message when `--labels` is missing.

`--replay` must COVER the population it is scored against: a file missing any
selected case (or carrying a record with no decision) is refused with exit 2,
never scored. Both harm metrics count *suppressions*, so an unclassified case
scores as the fail-open inject and moves them toward zero — a truncated, empty
or wrong-corpus replay would otherwise report a spotless PASS and exit 0 under
`--strict` having classified nothing. The same reasoning is why a *live* run's
backend failures are a gate criterion of their own (`cases with no verdict`,
rule 0) rather than only a line in the report: a run that did not measure the
classifier cannot pass a gate on it, however good its harm numbers look.

## Method

**The classifier is not re-implemented here.** Each case fills the REAL template
with its `(SLUG, PROMPT, DIGEST)` and calls the shipped `classifyDigestIntent`
in its own process (`classify-one.js` — the shipped classifier is synchronous,
so concurrency comes from processes rather than from a second copy of the
backend call). Backend selection, timeout, the `journal/llm-calls` record and
the verdict parse are therefore the shipping ones, and a change to any of them
moves this eval. The scratchpad harness this was committed from carried its own
copy of the verdict regex; that drift hazard is the thing worth not
re-introducing. The one deliberate substitution is the graph home — a scratch
dir, never the live graph.

**Population.** The classifier only ever runs on a FIRED digest, so it is scored
on the judged cases where the current engine fires: **77 fired user-prompt
cases** (59 warranted, 18 noise) out of 150 judged — 52 fired no digest, and 21
are `source=sdk`/spor-server headless backend-persona invocations that the
re-extracted case set drops. Those 21 are not user prompts and are handled by a
separate deterministic guard (`issue-spor-digest-fires-on-headless-backend-personas`),
not by a semantic classifier; the run prints them as skipped rather than
dropping them silently.

**What is measured**, in the order the asymmetry demands (see `metrics.js`):

1. **good digests lost** — a warranted prompt whose actual digest the judge
   rated genuinely good (helpful/mixed, score ≥ 4, top slot relevant),
   suppressed. The rule is **zero**. Fail-open does not protect against this: it
   covers backend failure, not haiku confidently answering UNWARRANTED on a
   clearly-warranted prompt.
2. **warranted suppressed** — the looser rate, against the ~6% budget the async
   design assumed. Reported alongside the size of one case (1.7pp at n=59),
   because a verdict that reads "over budget" by less than that is measuring the
   sample, not the prompt. That note is reported *on a failing criterion*: the
   gate compares against the budget it was given, and "over by less than the
   sample can resolve" is a reason to widen the sample, not a pass.
3. **noise removed** — what the gate buys. A classifier that suppresses nothing
   passes 1 and 2 trivially and is worth no backend call.

Plus one criterion that is about the RUN rather than the classifier: **cases
with no verdict** must be 0. Backend failures fail open to inject, which is
correct in production and flattering here — they subtract from both harm
metrics — so a run carrying any of them fails the gate outright.

The full-population fire table (all 129 judged user-prompt cases, fired and not)
is the basis the min-sim sweep reported on, so `engine+classifier` is directly
comparable to it and to the current always-inject engine.

## Results

| prompt | good lost | warranted suppressed | noise removed | fire-table F1 | gate |
|---|---|---|---|---|---|
| shipped 2026-07-06 (pre-recalibration) | **12/29 (41%)** | 30/59 (51%) | 18/18 (100%) | 0.604 | **FAIL** |
| recalibrated, 2026-07-06 run | 0/29 (0%) | 4/59 (6.8%) | 12/18 (67%) | 0.859 | FAIL (budget) |
| **shipped @ 2026-09-05** (`runs/2026-09-05-shipped-haiku.jsonl`) | **0/29 (0%)** | 4/59 (6.8%) | 14/18 (78%) | **0.873** | FAIL (budget) |
| current engine (always inject on fire) | 0 | 0 | 0/62 (0%) | 0.819 | n/a |
| min-sim 0.08 sweep | — | — | — | 0.732 | n/a |
| no-LLM intent regex | — | — | — | 0.596 | n/a |

**The shipped prompt does not pass this gate.** 4/59 = 6.78% against a 6.00%
budget is OVER, `gateVerdict` returns `pass: false`, and `--strict` exits 1 —
including on the committed `runs/2026-09-05-*.json`, whose recorded `gate.pass`
is `false`. What it *does* pass is the criterion the asymmetry is drawn on: 0 of
29 good digests lost. Those are different claims and the second is not the
first. The 0.78pp overage is smaller than one case (1.7pp at n=59), which is
worth knowing — it means the sample cannot tell 6.8% from 6.0% — but "the
measurement is too coarse to convict at the budget" is not "it met the budget",
and the harness deliberately reports it as a note on a FAILING row rather than
excusing the row. Closing it needs a bigger judged population, an argued change
to the budget itself, or a prompt that suppresses fewer warranted cases; the
held-out window below is the natural place for the first.

The 2026-09-05 row is an independent re-run of the recalibrated prompt through
this harness: same rates, and *not* the same four cases (two of the four
warranted suppressions differ from July's), which is what ~7% at n=59 looks like
— sampling around the budget rather than four reproducibly-misread prompts. The
harness reproduces both preserved 2026-07-06 runs exactly under `--replay`.

The raw 6.8% also overstates the cost, which is why the run prints what each
suppression was of. All four were digests the JUDGE rated 1–2 with a
tangential-or-noise top slot ("both digests miss the actual topic entirely"):

```
a24a81014e21  spor          65w  judge: mixed  score 2  top slot tangential
8b11a30d5ec6  spor-web      12w  judge: noisy  score 1  top slot noise
c531f2df1351  spor          31w  judge: mixed  score 2  top slot tangential
2c9eea3d80e6  spor-server   69w  judge: noisy  score 1  top slot noise
```

`warranted` is a label on the PROMPT — it says a digest *would have been* worth
having, not that the one the engine actually built was. Suppressing a digest the
judge scored 1/noise costs the reader nothing; that is exactly the distinction
the `good digests lost` rule is drawn on, and on it the run is 0/29.

## Cost — the other half of the default-on decision

A live run reports backend spend from the `llm-calls` records:

```
calls 77 (0 failed)   cost/call $0.0798   total $6.14
latency median 14223ms  p90 23597ms   tokens in/out 10/800
```

Nearly all of that is **CLI session boot, not classification**: a single call
carries ~36.7k cache-creation + ~17.6k cache-read tokens around a 4.6KB prompt
and a one-word answer. The classification itself is worth roughly a tenth of a
cent; `claude -p` charges ~8¢ for it. So the shipped DEFAULT backend is the
wrong one to flip a global default onto — with `digest.intentMaxCalls` at 20,
default-on would bill ~$1.60/session for noise removal. A direct-API or
`scripts/distill-gemini.sh`-style backend through the existing
`SPOR_DIGEST_INTENT_CMD` seam is what makes the flip affordable; `--cmd` scores
one without touching the engine.

## What still gates `digest.async` default-on

Three things, and the first is the gate itself:

- **the budget criterion**, still OVER at 6.8% vs 6.0% — by less than one case,
  but over. The recalibration bought the part that mattered most (41% → 0% of
  good digests lost, and a fire-table F1 above the current engine's), and the
  residual is a sample too small to resolve the difference. It is not resolved
  by asserting it is.
- **held-out re-validation.** The recalibrated prompt was iterated against this
  judged set and is now re-scored against it again. That is a reproduction, not
  an overfitting guard; a fresh transcript window has to be extracted and judged
  (`task-spor-digest-intent-heldout-revalidation`) — and it is the same window
  that would give the budget criterion a denominator it can actually resolve.
- **the cost call above**, which is really a backend-default question.

So `digest.async` stays default-off, and the flip is gated on all three rather
than on cost alone.
