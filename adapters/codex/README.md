# Codex CLI adapter

Codex's hooks are a near-clone of Claude Code's (same JSON-over-stdin payload
fields, same `hookSpecificOutput.additionalContext` envelope), so this adapter
is just a manifest over `bin/spor-hook`.

## Install

1. Clone this repo somewhere stable, e.g. `~/tools/spor`.
2. Resolve the path placeholder and install the manifest:

   ```sh
   SPOR_ROOT=~/tools/spor
   sed "s|__SPOR_ROOT__|$SPOR_ROOT|g" \
     "$SPOR_ROOT/adapters/codex/hooks.json" > ~/.codex/hooks.json
   ```

   (Or merge into an existing `~/.codex/hooks.json` / `[hooks]` table in
   `~/.codex/config.toml`. Per-repo installs go in `<repo>/.codex/hooks.json`.)

3. Approve the hooks in Codex's `/hooks` trust prompt on first run.
4. Environment (same variables as the Claude Code plugin):

   ```sh
   export SPOR_SERVER=https://your-spor-server   # remote mode
   export SPOR_TOKEN=spor_pat_...
   # Distiller backend — Codex hosts usually won't have the claude CLI.
   # Contract: prompt on stdin, response on stdout.
   export SPOR_DISTILL_CMD='codex exec -'
   ```

   (Legacy `SUBSTRATE_*` names are still read.) Without `SPOR_DISTILL_CMD`
   the distiller defaults to `claude -p --model haiku`, which is fine if the
   claude CLI is installed.

## Event mapping

| Spor engine | Codex event | Notes |
|---|---|---|
| session-start (briefing) | `SessionStart`, matcher `startup\|resume` | identical payload (`cwd`, `source`) |
| prompt-context (digest) | `UserPromptSubmit` | identical payload (`prompt`) |
| post-tool (journal) | `PostToolUse`, matcher `*` | dispatcher maps `tool_input.path` → `file_path`; calls with no file path are skipped |
| distill (capture) | `Stop` + `--debounce 900` | Codex has no `SessionEnd` and `Stop` fires at **turn** scope (and `async` hooks aren't supported) — so the hook spools the payload (incl. `transcript_path`) in milliseconds and a detached watcher distills once the session has been quiet for 15 minutes |

## Caveats

- Codex rollout transcripts are not Claude's JSONL shape; the distiller falls
  back to a generic extractor (every nested `.text` string). Works, but the
  role prefixes (`user:`/`assistant:`) are absent, so distill quality may be
  slightly lower than on Claude Code.
- A session resumed after a quiet period may distill twice; the second pass
  sees the first pass's facts in the graph index it dedups against, so
  duplicates are unlikely but not impossible.
- `SPOR_DISTILLING=1` is exported around the distill backend call, and
  the distill engine short-circuits on it — so a `codex exec` distiller that
  fires its own Stop hook cannot recurse.
- MCP: add the Spor server to `~/.codex/config.toml` for on-demand graph
  access (`query_graph`, `capture`, `my_queue`):

  ```toml
  [mcp_servers.spor]
  url = "https://your-spor-server/mcp"
  bearer_token_env_var = "SPOR_TOKEN"
  ```
