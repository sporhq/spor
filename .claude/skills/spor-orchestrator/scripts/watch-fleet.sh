#!/bin/bash
# watch-fleet.sh <node-id> [<node-id> ...] — block until any tracked agent finishes.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Exits 0 printing "AGENT_DONE <node> status=<s>" the moment any named agent's
# status leaves working/busy/starting, or "NODE_RESOLVED <node>" if the node
# resolved on the graph even while the session lingers (trust the graph over
# the process table). Exits 2 on timeout with a status dump.
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
set -u
[ $# -ge 1 ] || { echo "usage: watch-fleet.sh <node-id> [...]" >&2; exit 1; }
NODES=("$@")
INTERVAL="${WATCH_INTERVAL:-90}"
ROUNDS="${WATCH_ROUNDS:-30}"
declare -A seen
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
