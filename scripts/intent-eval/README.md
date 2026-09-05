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
down to **6.8%** — which clears the hard harm rule but is still *over* the 6%
budget, so the gate's own verdict on it is FAIL (see [Results](#results)). The
harness that produced those numbers then lived in a scratchpad, so the next
person to touch the prompt had nothing to re-score against
(`task-spor-recalibrate-digest-intent-prompt`). This is that harness, committed.

> **Verdict: the gate FAILS, and no prompt revision has scored inside budget.**
> Every scored row below is a FAIL, `gateVerdict` returns `pass: false`,
> `--strict` exits 1, and both committed `runs/*.json` record `gate.pass:
> false`. What the current prompt *does* clear is the hard HARM rule — 0 of 29
> good digests lost — which is a different and much narrower claim; quoting it
> as "the gate is met" is the overclaim this file exists to stop making. (It was
> made: the harness's first commit message, `f80e23b`, says "the calibration
> gate is met". That is superseded by `53c00bb`, by this file, and — so that
> prose cannot drift back — by `test/intent-metrics.test.js`, which asserts
> `gate.pass === false` against the committed run artifacts and re-derives the
> verdict from their recorded scores.)

**The gate is not met, and the second measurement is why that is now a
conclusion rather than a caveat.** A materially different prompt — the
retrieval-judging rules swapped out for prompt-judging ones
(`candidates/2026-09-05-prompt-level.md`) — moves 13 of the 77 verdicts, flips
every one of the shipped prompt's four warranted suppressions to WARRANTED, and
lands on **4/59 again**, on four different cases. Two independent draws at the
same rate is evidence the ~6.8% is the classifier's rate at this budget, not
four fixable misreads that a better prompt removes.

## Running it

The labeled corpus is not in this repo and cannot be: it is ~7MB of real prompts
and digests off a working box, and this repo is public. It lives in the private
server repo at `evals/digest-intent-2026-07-06` (the same corpus `rank-eval`
takes `--labels` from).

```bash
# live: score the template in this checkout against the shipped default backend
node scripts/intent-eval/run.js --labels ~/repos/spor-server/evals/digest-intent-2026-07-06

# a candidate prompt: a template file (candidates/ holds the ones already scored)
node scripts/intent-eval/run.js --labels <dir> \
  --template scripts/intent-eval/candidates/2026-09-05-prompt-level.md --label candidate

# or a whole other checkout of this repo
node scripts/intent-eval/run.js --labels <dir> --engine-root <other-checkout> --label candidate

# iterate cheaply on a handful of cases (a sub-population can never pass the gate)
node scripts/intent-eval/run.js --labels <dir> --only a24a81014e21,8b11a30d5ec6

# a cheaper/faster backend, same stdin->stdout contract as SPOR_DIGEST_INTENT_CMD
node scripts/intent-eval/run.js --labels <dir> --cmd 'scripts/distill-gemini.sh'

# re-score a recorded run — no backend calls, so every number below is re-derivable
node scripts/intent-eval/run.js --labels <dir> --replay scripts/intent-eval/runs/2026-09-05-shipped-haiku.jsonl

# a replay of a CANDIDATE's run must name that candidate: the records carry the
# template sha they were produced under, and replaying them against a different
# prompt is refused rather than scored under the wrong prompt's name
node scripts/intent-eval/run.js --labels <dir> \
  --template scripts/intent-eval/candidates/2026-09-05-prompt-level.md \
  --replay scripts/intent-eval/runs/2026-09-05-prompt-level-candidate.jsonl
```

A live run is 77 backend calls (~3min at `--concurrency 8`); `--out` preserves
the per-case decisions for `--replay`, `--json` the summary, `--strict` exits 1
when the gate fails. `npm test` covers the scoring math and the population
selection (`test/intent-metrics.test.js`); the harness itself needs the corpus
and refuses with a clear message when `--labels` is missing.

### A run that measured nothing must never read as a passing one

Both harm metrics count *suppressions*, so **every** way of not obtaining a
decision scores as the fail-open inject and pushes them toward zero. An
unmeasured run is therefore indistinguishable, on the harm numbers alone, from a
perfect one — and that is a gate that certifies itself. Three guards, one per
way it happens:

- **a missing replay record.** `--replay` must COVER the population it is scored
  against: a file missing any selected case, or carrying a record with no
  boolean `inject`, is refused with exit 2 and never scored. A truncated, empty
  or wrong-corpus replay would otherwise report a spotless PASS and exit 0 under
  `--strict` having classified nothing.
- **a case with no decision** — gate criterion `cases with no verdict`, rule 0.
  The test is a *positive* one: a case counts as measured only when it carries
  one of the two words the classifier is allowed to reach. It has to be, because
  the classifier's failures are silent — `classifyDigestIntent` returns `null`
  both when the backend died and when haiku answered ambiguously, and neither
  raises, so those records carry no error field to count. Counting error strings
  certified exactly the run the criterion exists to catch: 77 dead backend calls
  score as 77 injects, zero suppressions, zero errors, gate PASS.
- **a narrowed population** — gate criterion `population cases not scored`, rule
  0. The same arithmetic one level up: `--limit`/`--only` score a subset, and the
  cases never looked at are precisely the ones that could have carried the
  suppressions. `--limit 1` was otherwise a spotless PASS. Sub-population runs
  are still useful — they are how you iterate on a prompt — they just cannot
  certify one.

### …and a measurement of one prompt must never be reported as another's

A replay reads its decisions from a file while the template is resolved
*separately*, from `--template` or the checkout. Nothing joined the two, so
`--template <candidate> --replay <shipped>.jsonl` scored the shipped prompt's
answers and printed the candidate's filename and sha over them — a real number
attributed to an innocent file, and the report is exactly what gets quoted as
"prompt X scores Y".

Every record now carries the `template_sha` its decision was produced under, so
the join exists and is checked:

- **a different prompt** — refused, exit 2, naming both shas. A disagreement is
  not a bad score, it is an unanswerable question.
- **two prompts spliced into one file** — refused the same way. A run is of one
  prompt.
- **no sha at all** (a record predating stamping) — *scored*, because
  reproducing an old run is useful, but it is bound to no prompt and so cannot
  certify one: gate criterion `decisions not bound to prompt`, rule 0.

The two committed runs carry the sha their own `--json` summary recorded, and
`test/intent-metrics.test.js` asserts each record file binds to its summary's
`tplSha`.

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
   which is a note on the sample's *resolution* and is printed on a FAILING
   criterion: the gate compares against the budget it was given, and "over by
   less than one case" is a reason to widen the sample, never a pass. It is also
   no longer the interesting fact about this row — see Results.
3. **noise removed** — what the gate buys. A classifier that suppresses nothing
   passes 1 and 2 trivially and is worth no backend call.

Plus three criteria that are about the RUN rather than the classifier — **cases
with no verdict**, **population cases not scored** and **decisions not bound to
prompt**, all rule 0. See
["A run that measured nothing"](#a-run-that-measured-nothing-must-never-read-as-a-passing-one)
above: every way of not obtaining a decision subtracts from both harm metrics,
so a run carrying any of them fails the gate outright however good it looks —
and a decision not tied to the prompt being reported certifies no prompt at all.

The full-population fire table (all 129 judged user-prompt cases, fired and not)
is the basis the min-sim sweep reported on, so `engine+classifier` is directly
comparable to it and to the current always-inject engine.

## Results

| prompt | good lost | warranted suppressed | noise removed | fire-table F1 | gate |
|---|---|---|---|---|---|
| shipped 2026-07-06 (pre-recalibration) | **12/29 (41%)** | 30/59 (51%) | 18/18 (100%) | 0.604 | **FAIL** |
| recalibrated, 2026-07-06 run | 0/29 (0%) | 4/59 (6.8%) | 12/18 (67%) | 0.859 | FAIL (budget) |
| **shipped @ 2026-09-05** (`runs/2026-09-05-shipped-haiku.jsonl`, tpl `23c700dcc195`) | **0/29 (0%)** | 4/59 (6.8%) | 14/18 (78%) | **0.873** | FAIL (budget) |
| prompt-level candidate @ 2026-09-05 (`runs/2026-09-05-prompt-level-candidate.jsonl`, `candidates/2026-09-05-prompt-level.md`, tpl `c724fed604ec`) | 0/29 (0%) | 4/59 (6.8%) | 13/18 (72%) | 0.866 | FAIL (budget) |
| current engine (always inject on fire) | 0 | 0 | 0/62 (0%) | 0.819 | n/a |
| min-sim 0.08 sweep | — | — | — | 0.732 | n/a |
| no-LLM intent regex | — | — | — | 0.596 | n/a |

**The shipped prompt does not pass this gate**, and neither does the candidate
built to. 4/59 = 6.78% against a 6.00% budget is OVER, `gateVerdict` returns
`pass: false`, and `--strict` exits 1 — including on both committed
`runs/2026-09-05-*.json`, whose recorded `gate.pass` is `false` and is asserted
to be by `test/intent-metrics.test.js`. What they *do*
pass is the criterion the asymmetry is drawn on: 0 of 29 good digests lost.
Those are different claims and the second is not the first.

### Why the budget row is a conclusion, not a coin-flip

The 0.78pp overage is smaller than one case (1.7pp at n=59), and the honest
first reading of that was "the sample cannot tell 6.8% from 6.0%". The
`prompt-level` candidate was built to settle it, and settled it the other way.

It is a *materially* different prompt: the two rules that judge the retrieval
(the lexical-false-match bullet, the "plainly self-contained request" bullet)
are replaced by an explicit "judge the PROMPT, not the retrieval" instruction
plus the two classes that actually dominate the judged noise — mid-conversation
continuations and supplied facts. It moves **13 of the 77 verdicts**. It does
exactly what it was built to do: all four of the shipped prompt's warranted
suppressions flip to WARRANTED.

And it scores **4/59**. A completely disjoint four:

```
shipped     a24a81014e21  8b11a30d5ec6  c531f2df1351  2c9eea3d80e6
candidate   dce0f07641c4  649a7eaff80e  c651092aba77  63ce34486328
```

Two independent draws at the same rate, with no case in common, is not a sample
too coarse to convict — it is two measurements agreeing that the rate is ~6.8%.
The four cases are *not* a stable set of misreads a better prompt removes; the
*rate* is what is stable. So the budget criterion is genuinely missed, the
`withinOneCase` note is a remark about resolution and not a defence, and
grinding the prompt further against this same judged set would be fitting to
its noise — which the labels demonstrably carry. Two near-identical spor-web
prompts are labeled oppositely:

```
63ce34486328  warranted  "The nav bar is just joined up words spor\nRecordQueuePeople + AIContextIntegrations"
3724b9597c2b  noise      "The nav bar is just joined up words spor\nRecordQueuePeople + AIContextIntegrations\n\nBrowse each page … fix them … commit and push to main"
```

Each prompt gets exactly one of that pair "right" and is charged for the other.
At four cases out of 59, a label noise floor like that is the same size as the
thing being measured. Closing this row wants a bigger judged population — the
held-out window below — or an argued change to the budget itself, not another
pass over these 77 cases.

### What the suppressions actually cost

The raw 6.8% still overstates the cost, which is why the run prints what each
suppression was of. For the shipped prompt all four were digests the JUDGE rated
1–2 with a tangential-or-noise top slot ("both digests miss the actual topic
entirely"):

```
a24a81014e21  spor          65w  judge: mixed  score 2  top slot tangential
8b11a30d5ec6  spor-web      12w  judge: noisy  score 1  top slot noise
c531f2df1351  spor          31w  judge: mixed  score 2  top slot tangential
2c9eea3d80e6  spor-server   69w  judge: noisy  score 1  top slot noise
```

`warranted` is a label on the PROMPT — it says a digest *would have been* worth
having, not that the one the engine actually built was. Suppressing a digest the
judge scored 1/noise costs the reader nothing; that is exactly the distinction
the `good digests lost` rule is drawn on, and on it both runs are 0/29. (The
candidate's four are milder still on the label but two of them scored 3/relevant,
which is another reason it did not ship.)

The harness reproduces both preserved 2026-07-06 runs exactly under `--replay`.

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

- **the budget criterion**, OVER at 6.8% vs 6.0% — and now measured twice, by
  two prompts that share none of their four failing cases, so it is a rate and
  not a fluke. Recalibration bought the part that mattered most (41% → 0% of
  good digests lost, and a fire-table F1 above the current engine's) and then
  stopped buying: the second attempt traded four suppressions for four others.
  Prompt work is not what closes this row.
- **held-out re-validation.** Both prompts were scored against the same judged
  set the first was iterated on. That is a reproduction, not an overfitting
  guard, and the set is small enough that its own label inconsistencies are the
  size of the overage. A fresh transcript window has to be extracted and judged
  (`task-spor-digest-intent-heldout-revalidation`); it is the same window that
  would give the budget criterion a denominator that can resolve it, which makes
  it the prerequisite for the first bullet rather than a parallel concern.
- **the cost call above**, which is really a backend-default question.

So `digest.async` stays default-off, and the flip is gated on all three rather
than on cost alone. The honest summary of
`task-spor-recalibrate-digest-intent-prompt`: the harness is committed and the
prompt was recalibrated and re-measured, but **no prompt revision scored inside
budget**, and the evidence now says none will on this population. The remaining
work is the held-out window, tracked separately.
