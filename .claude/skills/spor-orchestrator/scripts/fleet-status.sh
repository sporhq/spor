#!/bin/bash
# fleet-status.sh [<node-id> ...] — one-shot triangulated fleet view.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# For each node (default: every node with a currently-active `spor runs`
# record — launching/running), joins the two signals the supervisor loop
# cares about:
#   run     — the newest `spor runs --node <id> --json` record's `state`
#   graph   — the node's frontmatter status via `spor get`
#   verdict — RUNNING (run record still launching/running — including a node
#             already resolved whose run hasn't gone terminal: NOT
#             merge-ready yet, the implementer resolves a beat before its
#             final commit lands) / FINISHED (resolved AND the run is over,
#             gate+merge it) / RECOVER (run over or absent, node NOT
#             resolved) / DONE
#
# Scope: this "unresolved = RECOVER" verdict assumes a SELF-RESOLVING agent —
# one dispatched with agent-prompt.md/infra-agent-prompt.md, whose own
# contract is to resolve its node before it exits. A Codex-harness
# implementer (assets/codex-agent-prompt.md) is explicitly forbidden from
# resolving its own node, so once its run record reads terminal (state=done)
# an unresolved node is RECOVER here even though the work may be finished —
# don't trust that verdict on a Codex node. Once the orchestrator has
# resolved the node (after reading a MERGE-READY report — see SKILL.md "The
# Codex implementer" — do that BEFORE re-checking here), this script again
# reports correctly: `gs=resolved` short-circuits to FINISHED regardless of
# run state.
#
# Every dispatch launches SUPERVISED (task-spor-deprecate-native-bg-dispatch):
# there is no `claude agents --json` listing here at all — the run record is
# the whole signal, for Claude and Codex alike. See lib.sh for the shared
# helpers.
set -u
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

if [ $# -ge 1 ]; then
  NODES=("$@")
else
  mapfile -t NODES < <(spor runs --json --limit 200 2>/dev/null \
    | jq -r --arg re "$SPOR_RUN_ACTIVE_STATE_RE" '.runs[]? | select((.state // "") | test($re)) | .node_id // empty' \
    | sort -u)
fi
printf '%-70s %-12s %-10s %s\n' NODE RUN GRAPH VERDICT
for n in "${NODES[@]}"; do
  run=$(fleet_run_json "$n")
  st=$(fleet_run_state "$run")
  gs=$(spor get "$n" --json 2>/dev/null | jq -r '.frontmatter.status // "open"')
  case "$gs" in
    resolved|done|answered)
      # A resolved node is merge-ready only once its run is ALSO over — an
      # implementer resolves its node a beat before its final commit lands,
      # so gating or merging here would judge an incomplete branch.
      if fleet_run_active "$st"; then
        v="RUNNING (node $gs, run still $st — wait for the run record to go terminal before gate+merge)"
      else
        v=FINISHED
      fi ;;
    *)
      if fleet_run_active "$st"; then v=RUNNING; else v="RECOVER (run ${st:-none}, node $gs)"; fi ;;
  esac
  printf '%-70s %-12s %-10s %s\n' "$n" "${st:-—}" "$gs" "$v"
done
