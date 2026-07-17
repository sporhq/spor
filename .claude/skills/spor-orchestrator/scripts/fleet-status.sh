#!/bin/bash
# fleet-status.sh [<node-id> ...] — one-shot triangulated fleet view.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# For each node (default: every currently-listed agent whose name looks like a
# node id), joins the three signals the supervisor loop cares about:
#   session   — `claude agents --json` status (bare array; status, not state)
#   graph     — the node's frontmatter status via `spor get`
#   verdict   — RUNNING / FINISHED (resolved, gate+merge it) / RECOVER
#               (session gone or idle but node NOT resolved) / DONE
#
# Scope: this "unresolved = RECOVER" verdict assumes a SELF-RESOLVING agent —
# one dispatched with agent-prompt.md/infra-agent-prompt.md, whose own
# contract is to resolve its node before it exits. A Codex-harness
# implementer (assets/codex-agent-prompt.md) is explicitly forbidden from
# resolving its own node, and it runs via the `codex` CLI (not `claude --bg`)
# so it never appears in `claude agents --json` at all — its session lookup
# always comes back empty, which this script's case logic treats the same as
# "idle"/"gone". Concretely: while the node is still unresolved, that makes
# every check RECOVER regardless of whether the codex process is still
# running or already finished — the script cannot tell those apart for a
# Codex node, so don't trust a RECOVER verdict on one. Once the orchestrator
# has resolved the node (after reading a MERGE-READY report — see SKILL.md
# "The Codex implementer" — do that BEFORE re-checking here), this script
# again reports correctly: `gs=resolved` short-circuits to FINISHED
# regardless of the (still-empty) session lookup.
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
