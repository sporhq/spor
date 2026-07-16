#!/bin/bash
# fleet-status.sh [<node-id> ...] — one-shot triangulated fleet view.
#
# For each node (default: every currently-listed agent whose name looks like a
# node id), joins the three signals the supervisor loop cares about:
#   session   — `claude agents --json` status (bare array; status, not state)
#   graph     — the node's frontmatter status via `spor get`
#   verdict   — RUNNING / FINISHED (resolved, gate+merge it) / RECOVER
#               (session gone or idle but node NOT resolved) / DONE
set -u
out=$(claude agents --json 2>/dev/null)
if [ $# -ge 1 ]; then NODES=("$@"); else
  mapfile -t NODES < <(printf '%s' "$out" | jq -r '(.agents? // .) | .[]? | (.name // empty) | strings | select(test("^(task|issue|inc|question)-"))')
fi
printf '%-70s %-10s %-10s %s\n' NODE SESSION GRAPH VERDICT
for n in "${NODES[@]}"; do
  st=$(printf '%s' "$out" | jq -r --arg n "$n" '(.agents? // .) | .[]? | select(.name==$n) | .status' 2>/dev/null | head -1)
  gs=$(spor get "$n" --json 2>/dev/null | jq -r '.frontmatter.status // "open"')
  case "$gs" in
    resolved|done|answered)
      case "$st" in ""|idle) v=FINISHED ;; *) v="FINISHED (session still $st — reap with: claude stop)";; esac ;;
    *)
      case "$st" in working|busy|starting) v=RUNNING ;; *) v="RECOVER (session ${st:-gone}, node $gs)";; esac ;;
  esac
  printf '%-70s %-10s %-10s %s\n' "$n" "${st:-—}" "$gs" "$v"
done
