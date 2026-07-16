# OpenCode adapter

OpenCode has no command-hook system — plugins are in-process JS — so this
adapter is a single zero-dependency plugin file (`spor.js`) that launches
`bin/spor-hook.js` with Claude-shaped payloads. Same core, same
fail-open behavior as every other host.

## Install

```sh
SPOR_ROOT=~/tools/spor
mkdir -p ~/.config/opencode/plugins
ln -s "$SPOR_ROOT/adapters/opencode/spor.js" ~/.config/opencode/plugins/spor.js
```

The symlink is resolved to locate the core; if you copy the file instead,
`export SPOR_ROOT=...` (the plugin also reads legacy `SUBSTRATE_ROOT` as a
fallback). Project-local installs go in `.opencode/plugins/`. Environment
is the usual set (legacy `SUBSTRATE_*` names are still read):

```sh
export SPOR_SERVER=https://spor.example.com   # remote mode
export SPOR_TOKEN=spor_pat_...
# Distiller backend (prompt on stdin -> response on stdout); without the
# claude CLI installed, route through opencode itself:
export SPOR_DISTILL_CMD='opencode run "$(cat)"'
# Capture-nudge backend — same contract, runs synchronously, so prefer a fast
# model. SPOR_NUDGE=0 disables it; see adapters/README.md for the bounds.
export SPOR_NUDGE_CMD='opencode run "$(cat)"'
```

## Behavior mapping

| Spor engine | OpenCode surface | Notes |
|---|---|---|
| session-start (briefing) | `chat.message`, first message of a session | briefing appended as a synthetic text part |
| prompt-context (digest) | `chat.message`, every message | digest appended as a synthetic text part; the >=6-words / not-a-command gate runs in the engine |
| post-tool (journal) | `tool.execute.after` for `write`/`edit` | journals `args.filePath` |
| distill (capture) | `event` bus, `session.idle` + `--debounce` | `session.idle` fires every turn, so the plugin exports the session via the SDK (`client.session.messages`) as a Claude-shaped transcript and spools it; a detached watcher distills once the session has been quiet for `SPOR_DEBOUNCE` seconds (default 900) |

## Caveats

- Parts injection (`chat.message` pushing a synthetic text part) is the
  community-established pattern but not a stability-guaranteed API surface;
  if an OpenCode release changes the Part shape, the plugin degrades to
  injecting nothing (fail open).
- The transcript handed to the distiller is rebuilt from the SDK on each
  idle event, so the debounced distill always sees the full final session.
- MCP: add the Spor server to `opencode.json` for on-demand graph
  access (`spor install opencode --mcp` writes this automatically):

  ```json
  { "mcp": { "spor": { "type": "remote", "url": "https://spor.example.com/mcp", "headers": { "Authorization": "Bearer {env:SPOR_TOKEN}" } } } }
  ```
