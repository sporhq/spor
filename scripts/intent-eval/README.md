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
down to **6.8%** — over the 6% budget. A second prompt measured 6.8% again on
disjoint cases, and that was read as the rate being real. The harness that
produced those numbers lived in a scratchpad, so the next person to touch the
prompt had nothing to re-score against
(`task-spor-recalibrate-digest-intent-prompt`). This is that harness, committed
— and the third prompt, scored with it, is the one that ships.

> **Verdict: the shipped prompt PASSES the gate** — twice, on two independent
> live draws: 1/59 (1.7%) and 2/59 (3.4%) warranted suppressed, 0/29 good
> digests lost on both, 10/18 noise removed on both. `gateVerdict` returns
> `pass: true`, `--strict` exits 0 on both committed `runs/2026-09-05-conjunctive-haiku*.json`,
> and `test/intent-metrics.test.js` asserts that the runs carrying the shipped
> file's sha record a PASS (and that the superseded prompts' runs record their
> FAIL). Edit the prompt and its sha changes, no committed run certifies it, and
> that test fails: a prompt edit ships WITH its measurement.

**What changed the answer.** The two 6.8% prompts failed for *different*
reasons: the 2026-07-06 prompt judged the RETRIEVAL (it suppressed substantive
prompts whose digest merely missed the topic), the `prompt-level` candidate
judged the PROMPT (it suppressed short steering turns whose digest was in fact
on point). Their four warranted suppressions were disjoint, while 11 of their
noise suppressions were shared. The shipped prompt makes that explicit: two
tests, the prompt and the context, and UNWARRANTED only when BOTH fail. The
conjunction gives up the noise that only one test catches (14/18 → 10/18) and
buys back the warranted cases the other test was protecting. This is a
principled narrowing, not a per-case tune — no case id was consulted in writing
it, and it was scored twice on the whole population before it shipped.

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
node scripts/intent-eval/run.js --labels <dir> --replay scripts/intent-eval/runs/2026-09-05-conjunctive-haiku.jsonl

# a replay of a CANDIDATE's (or a superseded prompt's) run must name that
# template: the records carry the sha they were produced under, and replaying
# them against a different prompt is refused rather than scored under its name
node scripts/intent-eval/run.js --labels <dir> \
  --template scripts/intent-eval/candidates/2026-07-06-retrieval-judging.md \
  --replay scripts/intent-eval/runs/2026-09-05-retrieval-judging-superseded.jsonl
```

A live run is 77 backend calls (~3min at `--concurrency 8`); `--out` preserves
the per-case decisions for `--replay`, `--json` the summary, `--strict` exits 1
when the gate fails. `npm test` covers the scoring math, the population
selection and the committed artifacts (`test/intent-metrics.test.js`); the
harness itself needs the corpus and refuses with a clear message when
`--labels` is missing.

**Shipping a prompt edit.** Score it live at least twice with `--out` and
`--json` into `runs/` (the backend is not deterministic; one lucky draw is not a
measurement), commit the runs beside the edit, and move the prompt it replaces
into `candidates/` byte-for-byte with its runs renamed for it. The suite
enforces the first half: the runs carrying the shipped file's sha must pass.

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

Every committed run carries the sha its own `--json` summary recorded, and
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
   less than one case" is a reason to widen the sample, never a pass.
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
| retrieval-judging, 2026-07-06 run | 0/29 (0%) | 4/59 (6.8%) | 12/18 (67%) | 0.859 | FAIL (budget) |
| retrieval-judging @ 2026-09-05 (`candidates/2026-07-06-retrieval-judging.md`, `runs/2026-09-05-retrieval-judging-superseded.jsonl`, tpl `23c700dcc195`; shipped 2026-07-06 → 2026-09-05) | 0/29 (0%) | 4/59 (6.8%) | 14/18 (78%) | 0.873 | FAIL (budget) |
| prompt-level candidate @ 2026-09-05 (`candidates/2026-09-05-prompt-level.md`, `runs/2026-09-05-prompt-level-candidate.jsonl`, tpl `c724fed604ec`) | 0/29 (0%) | 4/59 (6.8%) | 13/18 (72%) | 0.866 | FAIL (budget) |
| **conjunctive — SHIPPED**, draw 1 (`runs/2026-09-05-conjunctive-haiku.jsonl`, tpl `54377e57d385`) | **0/29 (0%)** | **1/59 (1.7%)** | 10/18 (56%) | 0.872 | **PASS** |
| **conjunctive — SHIPPED**, draw 2 (`runs/2026-09-05-conjunctive-haiku-draw2.jsonl`, tpl `54377e57d385`) | **0/29 (0%)** | **2/59 (3.4%)** | 10/18 (56%) | 0.864 | **PASS** |
| current engine (always inject on fire) | 0 | 0 | 0/62 (0%) | 0.819 | n/a |
| min-sim 0.08 sweep | — | — | — | 0.732 | n/a |
| no-LLM intent regex | — | — | — | 0.596 | n/a |

**The shipped prompt passes this gate on both draws.** It clears the hard harm
rule (0/29) and the budget row (1.7% and 3.4% against 6.0%), keeps the
fire-table F1 above the current always-inject engine's (0.864–0.872 vs 0.819),
and pays for it in noise: 10/18 removed where the retrieval-judging prompt
removed 14/18. That trade is the one the asymmetry says to make.

### Why two draws, and what they say

The backend is not deterministic, so a single passing run could be a lucky
draw. The two draws disagree on exactly one warranted case (`63ce34486328`,
suppressed on draw 2 only — one of the two near-identical, oppositely-labeled
spor-web prompts discussed below) and on none of the noise; both are inside
budget with headroom of at least one case. A third, held-out measurement is
still what a *durable* default-on wants (see below) — two draws on the set the
prompt family was developed against are a reproduction, not an overfitting
guard.

### Why the earlier prompts sat at 6.8%, and why that was not "the rate"

The 0.78pp overage is smaller than one case (1.7pp at n=59), and the honest
first reading was "the sample cannot tell 6.8% from 6.0%". The `prompt-level`
candidate was built to settle it: a *materially* different prompt — the two
retrieval-judging rules replaced by prompt-judging ones — that moved 13 of the
77 verdicts, flipped all four of the retrieval-judging prompt's warranted
suppressions, and scored 4/59 again on a disjoint four:

```
retrieval-judging  a24a81014e21  8b11a30d5ec6  c531f2df1351  2c9eea3d80e6
prompt-level       dce0f07641c4  649a7eaff80e  c651092aba77  63ce34486328
```

That was read as two independent draws agreeing on a rate. It was actually two
prompts each carrying one failure mode: the retrieval-judging one suppresses a
substantive prompt whose digest missed the topic; the prompt-level one
suppresses a short steering turn whose digest was on point. Disjoint warranted
suppressions with 11 of 18 noise suppressions in common is precisely the
signature of two tests worth conjoining — and on the recorded decisions, the
AND of the two runs scores 0/59 warranted and 11/18 noise. The shipped prompt
asks haiku for that conjunction directly and lands at 1–2/59 and 10/18 live.

The label noise in the population is real and still bounds what can be read
from it. Two near-identical spor-web prompts are labeled oppositely:

```
63ce34486328  warranted  "The nav bar is just joined up words spor\nRecordQueuePeople + AIContextIntegrations"
3724b9597c2b  noise      "The nav bar is just joined up words spor\nRecordQueuePeople + AIContextIntegrations\n\nBrowse each page … fix them … commit and push to main"
```

The first is the one warranted case the two draws disagree on. At that
resolution, "1/59 vs 2/59" is not a difference; "1–2/59 vs 4/59" is.

### What the suppressions actually cost

The raw rate overstates the cost, which is why the run prints what each
suppression was of. Every warranted suppression on both draws is a digest the
JUDGE rated 1–2 with a noise-or-tangential top slot:

```
draw 1   8b11a30d5ec6  spor-web  12w  judge: noisy  score 1  top slot noise
draw 2   8b11a30d5ec6  spor-web  12w  judge: noisy  score 1  top slot noise
         63ce34486328  spor-web  12w  judge: mixed  score 2  top slot tangential
```

`warranted` is a label on the PROMPT — it says a digest *would have been* worth
having, not that the one the engine actually built was. Suppressing a digest the
judge scored 1/noise costs the reader nothing; that is exactly the distinction
the `good digests lost` rule is drawn on.

The harness reproduces both preserved 2026-07-06 runs exactly under `--replay`.

## Cost — the other half of the default-on decision

A live run reports backend spend from the `llm-calls` records:

```
draw 1   calls 77 (0 failed)   cost/call $0.0828   total $6.37   latency median 15.8s  p90 24.7s
draw 2   calls 77 (0 failed)   cost/call $0.0102   total $0.79   latency median 15.2s  p90 24.4s
```

Nearly all of the first draw's spend is **CLI session boot, not
classification**: a single call carries ~36.7k cache-creation + ~17.6k
cache-read tokens around a 4.6KB prompt and a one-word answer. The second draw,
run minutes later, hit that cache and cost an eighth as much per call — so the
billed cost of the shipped default depends on how warm the CLI's prompt cache is,
and the *latency* (~15s median, all boot) does not improve either way. The
classification itself is worth roughly a tenth of a cent. So the shipped DEFAULT
backend is still the wrong one to flip a global default onto — with
`digest.intentMaxCalls` at 20, default-on bills up to ~$1.60/session for noise
removal on a cold cache. A direct-API or `scripts/distill-gemini.sh`-style
backend through the existing `SPOR_DIGEST_INTENT_CMD` seam is what makes the
flip affordable; `--cmd` scores one without touching the engine — and a
different backend is a different classifier, so it must be re-scored before it
ships as the default.

## What still gates `digest.async` default-on

The gate itself is cleared. Two things remain, and neither is prompt work:

- **held-out re-validation.** Every prompt in the Results table was scored
  against the same judged set the first was iterated on, and the shipped one was
  designed from the failure pattern of the two before it on that set. Two draws
  there are a reproduction, not an overfitting guard, and the set is small
  enough that its own label inconsistencies are the size of a case. A fresh
  transcript window has to be extracted and judged
  (`task-spor-digest-intent-heldout-revalidation`); the shipped prompt must pass
  the same gate there before the default flips.
- **the cost call above**, which is really a backend-default question, and
  which re-opens the gate for whatever backend is chosen.

So `digest.async` stays default-off on those two, and the honest summary of
`task-spor-recalibrate-digest-intent-prompt` is: the harness is committed, the
prompt was recalibrated, and **the shipped prompt scores inside budget on two
independent draws** — the item's inside-budget condition is met, and the flip
is deferred for the reasons above, not for want of a passing prompt.
