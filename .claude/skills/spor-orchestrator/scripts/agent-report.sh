#!/bin/bash
# agent-report.sh <node-id> [--findings] — print a dispatched agent's final
# report without hand-rolling the run-record lookup.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Every dispatch launches SUPERVISED (task-spor-deprecate-native-bg-dispatch)
# and writes its final message to a durable `report_path` file the run
# record carries — Claude and Codex alike, so there is no per-harness branch
# here anymore (a Codex-harness implementer never had a session transcript to
# read in the first place; this is the same lookup `spor dispatch` printed at
# launch time). This prints that file's contents. With --findings, prints
# only the "## FINDINGS FOR THE ORCHESTRATOR" block onward.
#
# Accepts a node id, not a session id — `spor runs --node <id> --json` finds
# the newest run.
set -u
node="${1:?usage: agent-report.sh <node-id> [--findings]}"
mode="${2:-}"
rp=$(spor runs --node "$node" --json 2>/dev/null | jq -r '.runs[0].report_path // empty')
[ -n "$rp" ] || { echo "no run record with a report_path found for node $node" >&2; exit 1; }
[ -f "$rp" ] || { echo "report file $rp does not exist yet (the run may still be in progress)" >&2; exit 1; }
if [ "$mode" = "--findings" ]; then
  awk '/FINDINGS FOR THE ORCHESTRATOR/{found=1} found' "$rp"
else
  cat "$rp"
fi
