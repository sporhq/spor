# Scored candidate templates

Prompt variants that were run through `../run.js` against the full judged
population and **did not ship**. They are here byte-for-byte as measured — no
header comment, no edits — because the `template_sha` printed by a run is a hash
of the file, and a file that no longer hashes to it is not the thing that was
scored. Each has a row in `../README.md`'s Results table and a recorded run
under `../runs/`.

Score one directly (the shipped classifier still does the calling — only the
template text is substituted):

```bash
node scripts/intent-eval/run.js --labels <corpus> \
  --template scripts/intent-eval/candidates/<file>.md --label <name>
```

## `2026-09-05-prompt-level.md` — sha `c724fed604ec`

The shipped prompt with its two *retrieval-judging* rules replaced by two
*prompt-judging* ones. Out: the lexical-false-match bullet and the "plainly
self-contained request" bullet — between them they produced every one of the
shipped prompt's four warranted suppressions, all on substantive prompts
(scoping WorkOS, a Fly/Tailscale feasibility question, a per-tenant-subdomain
design discussion) whose *digest* merely missed the topic. In: an explicit
"judge the PROMPT, not the retrieval" instruction, plus a mid-conversation
continuation bullet and a supplied-fact bullet — the two classes that actually
dominate the judged noise (`Continue`, "Yeah I'm going with B too", "you can
receive email at X").

It worked, on its own terms: all four of the shipped prompt's suppressions
flipped to WARRANTED. It still scored **4/59**, on four *different* cases, and
bought slightly less noise (13/18 vs 14/18, fire-table F1 0.866 vs 0.873). So
the shipped prompt stays, and the candidate's value is the measurement — see
`../README.md` "Results": two materially different prompts, 13 of 77 verdicts
apart, landing on the same rate is what tells you the rate is real.
