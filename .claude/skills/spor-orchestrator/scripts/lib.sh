# lib.sh — shared shell helpers for the spor-orchestrator scripts.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Sourced by fleet-status.sh, watch-fleet.sh, agent-report.sh, and
# link-live-skill.sh to keep them from hand-copying the same lookup and
# drifting apart the way the skill's two directory copies once did
# (task-spor-orchestrator-scripts-shared-lib,
# task-spor-orchestrator-skill-copies-reconcile).
#
# Every dispatch launches SUPERVISED (task-spor-deprecate-native-bg-dispatch):
# `--bg` is refused, there is no `claude agents --json` listing, and no
# `claude attach`/`claude stop`/`SendMessage` channel to a dispatched agent —
# it is a one-shot process that runs to completion and exits. The single
# source of truth for "is this node's agent still running, and what happened"
# is the durable RUN RECORD `spor dispatch` mints at launch: `spor runs
# --node <id> --json` follows it to a terminal state, and every harness
# (Claude and Codex both) writes its final message to the `report_path` the
# record carries. These helpers read run records only — never a harness
# listing, never a session transcript.
#
# Source with: `source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"`. Not
# meant to be run directly.

# fleet_run_json <node-id>
# The newest `spor runs --node <id> --json` record for this node, or empty on
# any error/no record. Callers that need more than one field should call this
# once and jq the result, rather than re-shelling out per field.
fleet_run_json() {
  spor runs --node "$1" --json 2>/dev/null | jq -c '.runs[0] // empty' 2>/dev/null
}

# fleet_run_state <shaped-run-json>
# The raw `state` field (launching/running/done/failed/failed_launch/
# vanished), or empty if there is no run record at all yet (never dispatched,
# or aged out of dispatch.runRetentionMs).
fleet_run_state() {
  printf '%s' "$1" | jq -r '.state // empty' 2>/dev/null
}

# The two non-terminal `spor runs` states — as an anchored regex, for the one
# caller (link-live-skill.sh) that tests it from inside a jq filter rather
# than bash.
SPOR_RUN_ACTIVE_STATE_RE='^(launching|running)$'

# fleet_run_active <state>
# True while a run is still launching/running; false once it reaches any
# terminal state (done/failed/failed_launch/vanished) or is empty (no run
# record for this node at all).
fleet_run_active() {
  case "$1" in
    launching|running) return 0 ;;
    *) return 1 ;;
  esac
}

# fleet_run_report <shaped-run-json> — the report_path field, or empty.
fleet_run_report() {
  printf '%s' "$1" | jq -r '.report_path // empty' 2>/dev/null
}

# fleet_run_log <shaped-run-json> — the log_path field, or empty. The
# staleness proxy for AGENT_STALLED: every stream event a supervised harness
# emits is appended here, so a live agent touches it constantly.
fleet_run_log() {
  printf '%s' "$1" | jq -r '.log_path // empty' 2>/dev/null
}

# fleet_run_session <shaped-run-json> — the session_id field, or empty.
# Informational only (there is no channel to reach it by).
fleet_run_session() {
  printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null
}
