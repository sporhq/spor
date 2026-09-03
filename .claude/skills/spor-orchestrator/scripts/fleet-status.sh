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
#               for a `--bg` agent; for a node NOT listed there (a supervised
#               `claude -p` run — the default since c1ab5b6 — or a Codex run)
#               the newest `spor runs --node <id>` state as `run:<state>`
#   graph     — the node's frontmatter status via `spor get`
#   verdict   — RUNNING / FINISHED (resolved, gate+merge it) / RECOVER
#               (session gone or idle but node NOT resolved) / DONE
#
# A RECOVER verdict (session idle, node unresolved) can also mean the agent
# idled awaiting the orchestrator's SendMessage reply to a blocking question —
# a reply resumes it. Check inbound cross-session messages before recovering
# (SKILL.md "Talking to the fleet").
#
# Scope: this "unresolved = RECOVER" verdict assumes a SELF-RESOLVING agent —
# one dispatched with agent-prompt.md/infra-agent-prompt.md, whose own
# contract is to resolve its node before it exits. A Codex-harness
# implementer (assets/codex-agent-prompt.md) is explicitly forbidden from
# resolving its own node, so once its run record reads terminal
# (`run:done`) an unresolved node is RECOVER here even though the work may
# be finished — don't trust that verdict on a Codex node. Once the
# orchestrator has resolved the node (after reading a MERGE-READY report —
# see SKILL.md "The Codex implementer" — do that BEFORE re-checking here),
# this script again reports correctly: `gs=resolved` short-circuits to
# FINISHED regardless of the session lookup.
set -u
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

out=$(fleet_agents_array "$(claude agents --json 2>/dev/null)")
if [ $# -ge 1 ]; then NODES=("$@"); else
  mapfile -t NODES < <(printf '%s' "$out" | jq -r '.[]? | (.name // empty) | strings | select(test("^(task|issue|inc|question)-"))')
fi
printf '%-70s %-10s %-10s %s\n' NODE SESSION GRAPH VERDICT
for n in "${NODES[@]}"; do
  st=$(fleet_node_status "$out" "$n")
  gs=$(spor get "$n" --json 2>/dev/null | jq -r '.frontmatter.status // "open"')
  case "$gs" in
    resolved|done|answered)
      case "$st" in ""|idle|run:*) v=FINISHED ;; *) v="FINISHED (session still $st — reap with: claude stop)";; esac ;;
    *)
      if fleet_status_active "$st"; then v=RUNNING; else v="RECOVER (session ${st:-gone}, node $gs)"; fi ;;
  esac
  printf '%-70s %-10s %-10s %s\n' "$n" "${st:-—}" "$gs" "$v"
done
