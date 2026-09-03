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
#     agent finishes — inc-spor-orchestration-watcher-stuck-state);
#   - the `spor runs` fallback for a node with NO listed session: since spor
#     c1ab5b6 (dec-spor-claude-code-supervised-by-default) a claude-code
#     dispatch without `--bg` is a supervised `claude -p` run that never
#     enters `claude agents --json` (a Codex run never did), so "not listed"
#     is not "gone" — the run record is the second place to look
#     (task-spor-claude-bg-prose-sweep-after-supervised-default).
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

# fleet_run_status <node-name>
# The SUPERVISED-run fallback: the newest `spor runs --node <id>` record's
# state, echoed as a synthetic status `run:<state>` so callers can print and
# test it beside a session status. Empty when there is no run record (or no
# `spor`). A supervised run (`claude -p` under the supervisor, or codex/
# opencode/copilot) has no `claude agents` entry, so this is the only
# liveness signal for it; its state goes terminal on its own when the
# supervisor exits (done/failed/failed_launch/vanished).
fleet_run_status() {
  local st
  st=$(spor runs --node "$1" --json 2>/dev/null | jq -r '.runs[0].state // empty' 2>/dev/null)
  [ -n "$st" ] && printf 'run:%s' "$st"
}

# fleet_node_status <shaped-agents-json> <node-name>
# Session status if the node is listed in `claude agents --json` (a `--bg`
# agent), else the `run:<state>` fallback above, else empty (genuinely gone:
# no session AND no run record).
fleet_node_status() {
  local st
  st=$(fleet_agent_status "$1" "$2")
  [ -n "$st" ] || st=$(fleet_run_status "$2")
  printf '%s' "$st"
}

# fleet_status_active <status>
# True when status is one of the active states above, or a `run:<state>`
# fallback whose state is not yet terminal. Always test `status`, never
# `state` (inc-spor-orchestration-watcher-stuck-state).
fleet_status_active() {
  case "$1" in
    working|busy|starting) return 0 ;;
    run:done|run:failed|run:failed_launch|run:vanished) return 1 ;;
    run:*) return 0 ;;
    *) return 1 ;;
  esac
}
