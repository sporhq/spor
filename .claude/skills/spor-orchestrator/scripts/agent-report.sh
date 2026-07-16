#!/bin/bash
# agent-report.sh <session-id> [--findings] — print a dispatched agent's final
# report without the TUI noise.
#
# `claude logs <id>` replays raw terminal frames (escape codes, spinners) —
# unreadable and huge. The clean source is the session transcript JSONL under
# ~/.claude/projects/<munged-cwd>/<session-id>.jsonl: this prints the LAST
# assistant text message (the agent's final report). With --findings, prints
# only the "## FINDINGS FOR THE ORCHESTRATOR" block (falling back to the last
# message that contains one — the very last turn is sometimes a postscript).
#
# Accepts a full session UUID or its 8-char prefix.
set -u
sid="${1:?usage: agent-report.sh <session-id> [--findings]}"
mode="${2:-}"
f=$(ls "$HOME"/.claude/projects/*/"$sid"*.jsonl 2>/dev/null | head -1)
[ -n "$f" ] || { echo "no transcript found for session $sid" >&2; exit 1; }
if [ "$mode" = "--findings" ]; then
  jq -rs '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text]
          | map(select(test("FINDINGS FOR THE ORCHESTRATOR"))) | last // empty' "$f" \
    | sed -n '/FINDINGS FOR THE ORCHESTRATOR/,$p'
else
  jq -rs '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text] | last // empty' "$f"
fi
