# prompts/ — externalized LLM prompt templates

Every prompt Spor sends to its small-model tier (Haiku) lives here as
a `{{VAR}}` template, NOT inline in code, so the Opus review job
(`review/run-review.sh`, in the private spor-server repo) can improve prompts
by editing files and proving the change against the eval suite (`evals/run.js`,
also in spor-server) — no code edits, no restarts (templates are re-read per
call).

Conditional fragments stay in code: callers compute the final string for vars
like `{{PROJECT_FM}}` and substitute it (possibly empty). Templates are pure
text. `lib/template.js` is the substitution engine for JS callers. Every
recorded LLM call carries the template name + a sha256 prefix of its content,
so journal records are traceable to the exact prompt version that produced
them.

Layout: `client/` holds the templates the hook engines send from user
machines — the only templates in this (the client) repo. The server's capture
ingester has its own templates (`server/capture.md`, `server/capture-bounce.md`),
which live in the private spor-server repo, not here.

| Template | Caller | Vars |
|---|---|---|
| `client/distill-remote.md` | scripts/engines/distill.js (SessionEnd, remote fact-finder) | SLUG, INDEX, TOUCHED, CONVO |
| `client/distill-local.md` | scripts/engines/distill.js (SessionEnd, local node-emitter) | SLUG, DATE, INDEX, TOUCHED, CONVO |
| `client/nudge.md` | scripts/engines/post-tool.js (PostToolUse capture nudge) | SLUG, FILE, INDEX, CONTENT |

Editing rules (for the review job and humans alike):

- Keep every `{{VAR}}` the template currently uses; the callers always supply
  exactly these and nothing else. Adding a new var requires a code change.
- Keep the output contracts intact — `===FACT===`/`===NODE <id>.md===`/
  `===END===` blocks, the literal `NOTHING` and `NOFIT:` escapes — they are
  parsed by deterministic code (the server's capture.js,
  scripts/engines/distill.js).
- Never adopt a template change without an eval win: the eval harness
  (`evals/run.js`, in the private spor-server repo) must score the candidate
  above the current template for the affected source with no per-case
  regression first.
