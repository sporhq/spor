# Scored candidate templates

Prompt variants that were run through `../run.js` against the full judged
population and are **not the shipped prompt** — either they never shipped, or
they shipped and were superseded. They are here byte-for-byte as measured — no
header comment, no edits — because the `template_sha` printed by a run is a hash
of the file, and a file that no longer hashes to it is not the thing that was
scored. Each has a row in `../README.md`'s Results table and a recorded run
under `../runs/`, named for the template it scored — a run file whose name or
`label` says a different prompt is the same mis-attribution the `template_sha`
binding exists to stop (`2026-09-05-prompt-level-candidate.*` was once committed
as `…-recalibrated-haiku.*`, i.e. under the then-shipped prompt's name; and the
then-shipped prompt's own run was `…-shipped-haiku.*`, a name that stopped being
true the moment it was superseded — it is `…-retrieval-judging-superseded.*`
now).

Score one directly (the shipped classifier still does the calling — only the
template text is substituted):

```bash
node scripts/intent-eval/run.js --labels <corpus> \
  --template scripts/intent-eval/candidates/<file>.md --label <name>
```

Re-scoring its recorded run costs no backend call, and needs the same
`--template`: the records name the sha they were produced under, and replaying
them against another prompt is refused rather than scored under its name.

```bash
node scripts/intent-eval/run.js --labels <corpus> \
  --template scripts/intent-eval/candidates/2026-09-05-prompt-level.md \
  --replay scripts/intent-eval/runs/2026-09-05-prompt-level-candidate.jsonl
```

## `2026-07-06-retrieval-judging.md` — sha `23c700dcc195` — shipped 2026-07-06 → 2026-09-05

The recalibration of the first (51%-loss) prompt: asymmetric-cost,
default-WARRANTED, with four UNWARRANTED classes, two of which judge the
RETRIEVAL — a "plainly self-contained request" and a "clear lexical
false-match". It cleared the harm rule (0/29 good digests lost) and cut 14/18
noise, but suppressed 4/59 warranted (6.8%, over the 6% budget) — all four
substantive prompts (scoping WorkOS, a Fly/Tailscale feasibility question, a
per-tenant-subdomain design discussion) whose *digest* merely missed the topic.
Run: `../runs/2026-09-05-retrieval-judging-superseded.*`. Superseded by the
conjunctive prompt, which keeps its lexical-false-match test as TEST 2.

## `2026-09-05-prompt-level.md` — sha `c724fed604ec` — never shipped

The retrieval-judging prompt with its two *retrieval-judging* rules replaced by
two *prompt-judging* ones: an explicit "judge the PROMPT, not the retrieval"
instruction, plus a mid-conversation continuation bullet and a supplied-fact
bullet — the two classes that actually dominate the judged noise (`Continue`,
"Yeah I'm going with B too", "you can receive email at X").

It worked, on its own terms: all four of the retrieval-judging prompt's
suppressions flipped to WARRANTED. It still scored **4/59**, on four *different*
cases — short steering turns whose digest was on point — and bought slightly
less noise (13/18, fire-table F1 0.866 vs 0.873). Its value was the
measurement: disjoint warranted suppressions with 11 of 18 noise suppressions
in common is the signature of two tests worth conjoining, and the shipped
prompt is that conjunction, with this file's prompt-judging classes as TEST 1.
