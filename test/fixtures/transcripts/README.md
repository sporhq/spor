# Real transcript corpus (task-spor-dispatch-transcript-classifier-real-fixture-corpus)

`lib/shell/agent-dispatch-runner.js`'s `transcriptOutcome()` reads Claude Code
session transcript JSONL and decides whether a dispatched run finished cleanly
or vanished. Its input is a moving external format — a new Claude Code version
can add a bookkeeping record type or shift where the end-of-turn marker sits at
any time. `test/dispatch-runs.test.js` covers the classifier's *logic* with
hand-built synthetic records, but a synthetic fixture only ever encodes what its
author already believed the format to be. That is exactly how a defect
affecting 52 real sessions (cleanly-finished runs reported as vanished) went
undetected until the classifier was run over the real transcript corpus
(inc-spor-dispatch-session-vanished-2026-07-18) — see the allowlist comment
above `TURN_RECORD_TYPES` in `agent-dispatch-runner.js`.

This directory is the fix for that blind spot: a small corpus of REAL
transcript tails, anonymized, checked into the public repo, classified by
`test/transcript-corpus.test.js` against `manifest.json`'s expectations. It
augments the synthetic suite — it does not replace it.

## What's anonymized, and why it's still "real"

`transcriptOutcome()` only reads a record's `type`, `subtype`, and (for the
human-readable reason) `timestamp` and the SHAPE of `message.content` — never
prompt text, file contents, or tool arguments. `anonymize.js` in this directory
strips everything else: prompt/message text becomes `"[redacted]"`, `cwd`
becomes `/workspace/demo-repo`, `gitBranch` becomes `demo-branch`,
`sessionId` becomes a fixed placeholder, and linkage-only fields (`uuid`,
`parentUuid`, tool-use `input`, hook command strings, …) are dropped outright.
What survives is exactly the record-type/marker STRUCTURE the classifier reads
— the one thing a synthetic fixture can't manufacture faithfully — with none of
the content that made the source session identifiable.

## Adding a tail when a new Claude Code version ships

The corpus ages into the exact blind spot it exists to prevent if it's never
extended, so add a tail whenever you notice a new Claude Code version's
transcripts carry a bookkeeping record type or shape you haven't seen before
(a new `system.subtype`, a renamed title/bookkeeping record, …):

1. Find a real transcript on that version under `~/.claude/projects/**/*.jsonl`
   (a top-level `<sessionId>.jsonl`, or a `subagents/agent-*.jsonl` — both carry
   the identical record shape the classifier reads). Confirm its version with
   `grep -o '"version":"[^"]*"' <file> | head -1`.
2. Anonymize its tail:
   ```
   node test/fixtures/transcripts/anonymize.js <path/to/session.jsonl> 40 > test/fixtures/transcripts/<descriptive-name>.jsonl
   ```
   The count (default 40) is how many trailing lines to consider — a full
   session is irrelevant; only the end says how the run finished. Pick a name
   that says what state it should classify as and why it's interesting
   (`done-2.1.NNN-<what's notable>.jsonl`, `vanished-2.1.NNN-<what's
   notable>.jsonl`).
3. Read the anonymized file back before committing it. Confirm by eye there is
   no prompt text, file content, path, or identifier left — `anonymize.js`
   strips the known-sensitive fields, but a new Claude Code record type it
   hasn't seen may carry a freeform field it doesn't yet know to scrub; add a
   case to `scrubRecord()` for it if so.
4. Run it through the real classifier and note what it returns:
   ```
   node -e 'console.log(require("./lib/shell/agent-dispatch-runner.js").transcriptOutcome(require("fs").readFileSync("test/fixtures/transcripts/<file>.jsonl","utf8")))'
   ```
5. Add an entry to `manifest.json` with that exact `state` /
   `termination_class` / `termination_signal` as `expected`, and a one-line
   `note` on what makes this tail worth keeping. `test/transcript-corpus.test.js`
   picks it up automatically — no test code changes needed.

If a harness change makes an EXISTING fixture's expected outcome change, that
diff is the whole point — it is the signal that something in the transcript
format shifted under the classifier, exactly what a synthetic suite would have
missed. Update `manifest.json` deliberately, and only after confirming the new
outcome is the classifier working as intended and not the format shift
uncovering an actual regression.
