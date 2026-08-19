#!/bin/bash
# watch-fleet.sh <node-id> [<node-id> ...] — block until any tracked agent finishes.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Exits 0 printing "AGENT_DONE <node> status=<s>" the moment any named agent's
# status leaves working/busy/starting, "NODE_RESOLVED <node>" if the node
# resolved on the graph even while the session lingers (trust the graph over
# the process table), or "AGENT_STALLED <node> idle_secs=<n> session=<sid>"
# when a busy agent's session transcript hasn't moved for WATCH_STALL seconds
# (default 1800) — the early-warning for a wedged agent. Exits 2 on timeout
# with a status dump.
#
# Run it via the Bash tool with run_in_background: true; its exit re-invokes
# the orchestrator. Poll cadence 90s, ~45min ceiling.
#
# Paid-for gotchas encoded here:
# - `claude agents --json` emits a BARE ARRAY (defend against a future
#   {agents:[...]} wrapper with `.agents? // .`). A wrong shape here fails
#   SILENT — the 2026-07-16 watcher looped to timeout while 4 agents sat idle.
# - Watch `status`, never `state` alone — `state` sticks at "working" after
#   the agent finishes (inc-spor-orchestration-watcher-stuck-state).
# - An agent can vanish from the list entirely when it exits; treat a node
#   that WAS seen and is now absent as done.
# - AGENT_STALLED is a NOTIFICATION, not a verdict: the transcript-mtime proxy
#   can't tell a wedged agent from one legitimately awaiting a long background
#   task (the 2026-08-05 hung-test deadlock looked exactly like the latter —
#   a `node --test` child at ~0 CPU for 44min while the agent waited for its
#   completion notification). On firing, the orchestrator should inspect the
#   agent's child processes and last transcript message before intervening
#   (kill the hung child, or re-arm with a longer WATCH_STALL / WATCH_STALL=0
#   if the wait is genuine). The stall check only runs while the session is
#   working/busy/starting — a finished agent exits via AGENT_DONE instead.
#
# Scope: like fleet-status.sh, this polls `claude agents --json` and treats
# an unresolved node as not-yet-done — correct only for a SELF-RESOLVING
# agent (agent-prompt.md/infra-agent-prompt.md). A Codex-harness implementer
# (assets/codex-agent-prompt.md) never appears in `claude agents --json` (it
# runs via the `codex` CLI) and is contractually forbidden from resolving its
# own node, so don't pass this script a Codex node id expecting a meaningful
# result — track its completion by watching the process/job you spawned for
# it and reading its final report instead (see SKILL.md "The Codex
# implementer").
set -u
[ $# -ge 1 ] || { echo "usage: watch-fleet.sh <node-id> [...]" >&2; exit 1; }
NODES=("$@")
INTERVAL="${WATCH_INTERVAL:-90}"
ROUNDS="${WATCH_ROUNDS:-30}"
STALL="${WATCH_STALL:-1800}"   # seconds of transcript silence before AGENT_STALLED; 0 disables
declare -A seen
declare -A tpath
for i in $(seq 1 "$ROUNDS"); do
  sleep "$INTERVAL"
  out=$(claude agents --json 2>/dev/null)
  for n in "${NODES[@]}"; do
    st=$(printf '%s' "$out" | jq -r --arg n "$n" '(.agents? // .) | .[]? | select(.name==$n) | .status' 2>/dev/null | head -1)
    if [ -n "$st" ]; then
      seen[$n]=1
      case "$st" in working|busy|starting) ;; *) echo "AGENT_DONE $n status=$st"; exit 0 ;; esac
    elif [ "${seen[$n]:-}" = "1" ]; then
      echo "AGENT_DONE $n status=gone"; exit 0
    fi
  done
  # Stall check: a busy session whose transcript file hasn't been touched for
  # STALL seconds is likely wedged (hung child process, lost notification).
  # Transcript mtime is the activity proxy — every tool result, message, and
  # notification appends a JSONL line, so a live agent touches it constantly.
  if [ "$STALL" -gt 0 ]; then
    for n in "${NODES[@]}"; do
      row=$(printf '%s' "$out" | jq -r --arg n "$n" '(.agents? // .) | .[]? | select(.name==$n) | "\(.status) \(.sessionId // .id)"' 2>/dev/null | head -1)
      [ -n "$row" ] || continue
      st=${row%% *}; sid=${row#* }
      case "$st" in working|busy|starting) ;; *) continue ;; esac
      if [ -z "${tpath[$n]:-}" ]; then
        tpath[$n]=$(find "$HOME/.claude/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -1)
      fi
      tp=${tpath[$n]:-}
      [ -n "$tp" ] && [ -f "$tp" ] || continue
      idle=$(( $(date +%s) - $(stat -c %Y "$tp" 2>/dev/null || echo "$(date +%s)") ))
      if [ "$idle" -ge "$STALL" ]; then
        echo "AGENT_STALLED $n idle_secs=$idle session=$sid"
        exit 0
      fi
    done
  fi
  # Cheap authoritative cross-check: the graph. A resolved node = finished — BUT
  # only trust it once the SESSION is also idle/gone. An implementer can resolve
  # the node a beat before its final commit lands (or while a review runs), so a
  # resolved node whose session is still working/busy is NOT merge-ready yet:
  # firing here would hand the orchestrator an empty branch (the 2026-07-16
  # share-cli / connection-scoped premature-resolve stalls).
  inflight=$(spor next --json 2>/dev/null | jq -r '[.items[]? | select(.in_flight==true) | .id] | join("\n")')
  for n in "${NODES[@]}"; do
    [ "${seen[$n]:-}" = "1" ] || continue
    printf '%s\n' "$inflight" | grep -qxF -- "$n" && continue
    cur=$(printf '%s' "$out" | jq -r --arg n "$n" '(.agents? // .) | .[]? | select(.name==$n) | .status' 2>/dev/null | head -1)
    case "$cur" in working|busy|starting) continue ;; esac   # still committing — wait
    st=$(spor get "$n" --json 2>/dev/null | jq -r '.frontmatter.status // empty')
    case "$st" in resolved|done|answered) echo "NODE_RESOLVED $n status=$st"; exit 0 ;; esac
  done
done
echo "TIMEOUT after $((INTERVAL * ROUNDS / 60))min — current fleet:"
claude agents --json 2>/dev/null | jq -r '(.agents? // .) | .[]? | "\(.name)  status=\(.status // "?")"'
exit 2
