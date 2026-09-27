#!/bin/bash
# watch-fleet.sh <node-id> [<node-id> ...] — block until any tracked agent finishes.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Exits 0 printing "AGENT_DONE <node> status=<state>" the moment any named
# node's `spor runs --node <id> --json` record goes terminal
# (done/failed/failed_launch/vanished), or "NODE_RESOLVED <node> status=<s>"
# if the node resolved on the graph while its run record is absent or already
# terminal (trust the graph as a backstop over a run record that never
# existed or has nothing more to tell us), or "AGENT_STALLED <node>
# idle_secs=<n> session=<sid>" when a still-running node's log file hasn't
# been touched for WATCH_STALL seconds (default 1800) — the early-warning for
# a wedged agent. Exits 2 on timeout with a status dump.
#
# Run it via the Bash tool with run_in_background: true; its exit re-invokes
# the orchestrator. Poll cadence 90s, ~45min ceiling.
#
# Every dispatch launches SUPERVISED (task-spor-deprecate-native-bg-dispatch):
# there is no `claude agents --json` listing to poll and no session to check
# `status`/`state` drift on — the run record's own `state` is the only
# liveness signal there is, and it goes terminal exactly once, when the
# supervisor's child exits. So a run still `launching`/`running` is
# unambiguously still going; anything else means it is over. See lib.sh for
# the shared run-record helpers this script and fleet-status.sh share.
#
# Paid-for gotchas this still carries:
# - AGENT_DONE status=<terminal> with the node UNRESOLVED is ambiguous:
#   finished-without-resolving (-> Recover) *or* the agent deferred a blocker
#   and said so in its final report (read it before treating it as failed —
#   SKILL.md "Recover"). A dispatched agent has no live channel back to you,
#   so there is no "idled awaiting your reply" case anymore — everything it
#   has to say is in the report file.
# - AGENT_STALLED is a NOTIFICATION, not a verdict: the log-mtime proxy can't
#   tell a wedged agent from one legitimately awaiting a long background task
#   (the 2026-08-05 hung-test deadlock: a `node --test` child at ~0 CPU for
#   44min while the agent waited for its completion notification — the log
#   itself goes quiet the same way whether the agent is wedged or genuinely
#   waiting). On firing, inspect the agent's child processes and the tail of
#   its report/log before intervening (kill the hung child, or re-arm with a
#   longer WATCH_STALL / WATCH_STALL=0 if the wait is genuine).
set -u
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

[ $# -ge 1 ] || { echo "usage: watch-fleet.sh <node-id> [...]" >&2; exit 1; }
NODES=("$@")
INTERVAL="${WATCH_INTERVAL:-90}"
ROUNDS="${WATCH_ROUNDS:-30}"
STALL="${WATCH_STALL:-1800}"   # seconds of log silence before AGENT_STALLED; 0 disables
for i in $(seq 1 "$ROUNDS"); do
  sleep "$INTERVAL"
  for n in "${NODES[@]}"; do
    run=$(fleet_run_json "$n")
    st=$(fleet_run_state "$run")
    if fleet_run_active "$st"; then
      if [ "$STALL" -gt 0 ]; then
        log=$(fleet_run_log "$run")
        [ -n "$log" ] && [ -f "$log" ] || continue
        idle=$(( $(date +%s) - $(stat -c %Y "$log" 2>/dev/null || echo "$(date +%s)") ))
        if [ "$idle" -ge "$STALL" ]; then
          echo "AGENT_STALLED $n idle_secs=$idle session=$(fleet_run_session "$run")"
          exit 0
        fi
      fi
      continue
    fi
    if [ -n "$st" ]; then
      echo "AGENT_DONE $n status=$st"
      exit 0
    fi
    # No run record at all for this node (not yet started, or aged out past
    # dispatch.runRetentionMs) — the graph is the only remaining signal.
    gs=$(spor get "$n" --json 2>/dev/null | jq -r '.frontmatter.status // empty')
    case "$gs" in resolved|done|answered) echo "NODE_RESOLVED $n status=$gs"; exit 0 ;; esac
  done
done
echo "TIMEOUT after $((INTERVAL * ROUNDS / 60))min — current fleet:"
for n in "${NODES[@]}"; do
  run=$(fleet_run_json "$n")
  echo "  $n  state=$(fleet_run_state "$run")"
done
exit 2
