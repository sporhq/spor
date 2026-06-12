# GitHub Copilot CLI adapter (partial)

Copilot's hook payloads are camelCase (`sessionId`, `toolName`, `toolArgs`,
`transcriptPath`); the dispatcher maps them. Fidelity is partial by
Copilot's design: `userPromptSubmitted` is observe-only and `sessionStart`
supports **no output at all** — so there is no ambient injection on Copilot.
The standing briefing rides the AGENTS.md floor instead (Copilot reads
AGENTS.md natively), refreshed by the sessionStart hook so the *next*
session start picks up briefing changes. Capture is full fidelity.

## Install

```sh
SPOR_ROOT=~/tools/spor
mkdir -p ~/.copilot/hooks
sed "s|__SPOR_ROOT__|$SPOR_ROOT|g" \
  "$SPOR_ROOT/adapters/copilot/spor.json" > ~/.copilot/hooks/spor.json
```

(Per-repo installs go in `.github/hooks/spor.json` — that is also the
only location the Copilot cloud coding agent loads.) Environment is the
usual set: `SPOR_SERVER`, `SPOR_TOKEN`, and `SPOR_DISTILL_CMD`
(e.g. `copilot -p "$(cat)"`) if the claude CLI isn't installed; legacy
`SUBSTRATE_*` names are still read.

## Event mapping

| Spor engine | Copilot event | Notes |
|---|---|---|
| session-start (briefing) | `sessionStart` → `agents-md` | sessionStart supports no output, so the hook refreshes the AGENTS.md Spor section (cwd read from the payload) |
| prompt-context (digest) | — | not possible: `userPromptSubmitted` is observe-only |
| post-tool (journal) | `postToolUse` | `toolArgs.path`/`toolArgs.file_path` journaled; calls without a file path are skipped |
| distill (capture) | `agentStop` + `--debounce 900` | turn-scoped, carries `transcriptPath`; debounced like Codex |

For on-demand graph access, add the Spor MCP server to
`~/.copilot/mcp-config.json`:

```json
{ "mcpServers": { "spor": { "type": "http", "url": "https://spor.example.com/mcp", "headers": { "Authorization": "Bearer $SPOR_TOKEN" } } } }
```
