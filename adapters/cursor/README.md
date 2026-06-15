# Cursor adapter (partial)

Cursor's hooks use different field names from the Claude Code contract
(`conversation_id`, `workspace_roots`, flat snake_case outputs); the
dispatcher maps both directions. Fidelity is partial by Cursor's design:
`sessionStart` can inject context, but `beforeSubmitPrompt` can only
allow/block — there is **no per-prompt digest** on Cursor.

## Install

```sh
SPOR_ROOT=~/tools/spor
sed "s|__SPOR_ROOT__|$SPOR_ROOT|g" \
  "$SPOR_ROOT/adapters/cursor/hooks.json" > ~/.cursor/hooks.json
```

(Or merge into an existing `~/.cursor/hooks.json` / project
`.cursor/hooks.json`.) Environment is the usual set: `SPOR_SERVER`,
`SPOR_TOKEN`, and `SPOR_DISTILL_CMD` if the claude CLI isn't installed
(`cursor-agent -p` works: prompt on stdin, response on stdout) — set
`SPOR_NUDGE_CMD` to the same value for the capture nudge, or `SPOR_NUDGE=0`
to skip it; legacy `SUBSTRATE_*` names are still read.

## Event mapping

| Spor engine | Cursor event | Notes |
|---|---|---|
| session-start (briefing) | `sessionStart` | output mapped to Cursor's flat `{additional_context}` |
| prompt-context (digest) | — | not possible: `beforeSubmitPrompt` is allow/block only |
| post-tool (journal) | `afterFileEdit` | bare `file_path` synthesized into a `tool_input`; keyed by `conversation_id` |
| distill (capture) | `sessionEnd` | true session end (no debounce needed); uses the payload's `transcript_path` — enable transcripts in Cursor settings, or the distiller exits silently |

To partly compensate for the missing per-prompt digest, the standing
briefing still lands at sessionStart, and `spor-hook agents-md` keeps
an AGENTS.md section that Cursor reads natively alongside `.cursor/rules`.
