# lib.sh — shared shell helpers for the spor-orchestrator scripts.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Sourced by fleet-status.sh, watch-fleet.sh, and link-live-skill.sh to keep
# three concerns they'd otherwise each hand-copy from drifting apart the way
# the skill's two directory copies did (task-spor-orchestrator-scripts-shared-lib,
# task-spor-orchestrator-skill-copies-reconcile):
#   - the `.agents? // .` jq shape defense for `claude agents --json` (today
#     a bare array; a wrong assumption here fails SILENT — the 2026-07-16
#     watcher looped to timeout while 4 agents sat idle);
#   - matching a `claude agents --json` entry to a spor node id by `.name`;
#   - the status-not-state convention (`state` sticks at "working" after an
#     agent finishes — inc-spor-orchestration-watcher-stuck-state).
#
# Source with: `source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"`. Not
# meant to be run directly.

# fleet_agents_array <raw-claude-agents-json>
# Shape-defends `claude agents --json`'s output down to the bare entry
# array (today it already is one; `// .` covers a future {agents:[...]}
# wrapper). Echoes compact JSON, or nothing on parse failure. Callers
# iterate the result with plain `.[]?` — no shape clause needed downstream.
fleet_agents_array() {
  printf '%s' "$1" | jq -c '.agents? // .' 2>/dev/null
}

# fleet_agent_status <shaped-agents-json> <node-name>
# The status of the `claude agents --json` entry whose .name equals
# node-name — the copy-pasted node-id-matching lookup. Takes the ALREADY
# shape-defended array (see fleet_agents_array above). Echoes empty if the
# name isn't found.
fleet_agent_status() {
  printf '%s' "$1" | jq -r --arg n "$2" '.[]? | select(.name==$n) | .status' 2>/dev/null | head -1
}

# The three `claude agents --json` statuses that mean "still running" — as
# an anchored regex, for the one caller (link-live-skill.sh) that tests it
# from inside a jq filter rather than bash.
SPOR_FLEET_ACTIVE_STATUS_RE='^(working|busy|starting)$'

# fleet_status_active <status>
# True when status is one of the active states above. Always test `status`,
# never `state` (inc-spor-orchestration-watcher-stuck-state).
fleet_status_active() {
  case "$1" in
    working|busy|starting) return 0 ;;
    *) return 1 ;;
  esac
}
