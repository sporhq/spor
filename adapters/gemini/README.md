# Gemini CLI adapter

Gemini CLI's hooks use the same JSON-over-stdin payloads and the same
`hookSpecificOutput.additionalContext` envelope as Claude Code (it even ships
a `CLAUDE_PROJECT_DIR` compatibility alias), so this adapter is a manifest
over `bin/spor-hook.js`. The only real differences: the per-prompt event is
called `BeforeAgent` (the dispatcher echoes that name back in the envelope),
the post-tool event is `AfterTool`, and timeouts are in milliseconds.

## Install

Either install as an extension or paste the hooks into settings.

**As settings** — resolve the placeholder and merge into
`~/.gemini/settings.json` (or project `.gemini/settings.json`):

```sh
SPOR_ROOT=~/tools/spor
sed "s|__SPOR_ROOT__|$SPOR_ROOT|g" \
  "$SPOR_ROOT/adapters/gemini/hooks/hooks.json"
# merge the printed "hooks" object into your settings.json
```

**As an extension** — copy `adapters/gemini/` (with the placeholder resolved)
into `~/.gemini/extensions/spor/`.

Then approve the hooks (`/hooks panel`) and set the environment:

```sh
export SPOR_SERVER=https://spor.example.com   # remote mode
export SPOR_TOKEN=spor_pat_...
# Distiller backend (prompt on stdin, response on stdout):
export SPOR_DISTILL_CMD='gemini --model gemini-2.5-flash'
# Capture-nudge backend (same contract; runs synchronously, so pick a fast
# model). SPOR_NUDGE=0 disables it; see adapters/README.md for the bounds.
export SPOR_NUDGE_CMD='gemini --model gemini-2.5-flash'
```

(Legacy `SUBSTRATE_*` names are still read.)

## Event mapping

| Spor engine | Gemini event | Notes |
|---|---|---|
| session-start (briefing) | `SessionStart` | identical payload |
| prompt-context (digest) | `BeforeAgent` | payload carries `prompt`; envelope event name echoed from `hook_event_name` |
| post-tool (journal) | `AfterTool`, matcher `write_file\|replace` | both tools carry `tool_input.file_path` |
| distill (capture) | `SessionEnd` | payload carries `transcript_path` |

## Caveats

- Gemini transcripts are not Claude's JSONL shape; the distiller falls back
  to a generic extractor (every nested `.text` string).
- Hook stdout must be pure JSON on Gemini; `bin/spor-hook.js` already
  discards engine stderr and emits either one JSON object or nothing.
- For on-demand graph access, add the Spor MCP server to settings:

  ```json
  { "mcpServers": { "spor": { "httpUrl": "https://spor.example.com/mcp", "headers": { "Authorization": "Bearer $SPOR_TOKEN" } } } }
  ```

- `GEMINI.md` users: point `contextFileName` at `AGENTS.md` and run
  `spor-hook agents-md` to get the standing briefing without hooks.
