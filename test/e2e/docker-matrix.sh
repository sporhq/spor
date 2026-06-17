#!/usr/bin/env bash
# Build + run the local-mode E2E suite in a container against one or more pinned Claude Code
# versions (task-spor-e2e-claude-version-matrix-sandbox).
#
# Each version runs in its own container holding the fake Anthropic API + claude + plugin +
# scratch graph, so `docker run --rm` teardown reaps the claude daemon and any background
# agents — no host leak (issue-spor-server-dispatch-e2e-bg-agent-leak). The fake serves a
# dummy key, so no API key/secret is needed.
#
# Usage:
#   test/e2e/docker-matrix.sh                 # defaults to the npm `latest` dist-tag
#   test/e2e/docker-matrix.sh 2.1.179 2.1.178 # an explicit matrix
# Exit non-zero if any version's suite fails.
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root == docker build context
DOCKERFILE="test/e2e/Dockerfile"

# Default to the `latest` dist-tag when no versions are given.
if [ "$#" -eq 0 ]; then
  set -- latest
fi

fails=0
for version in "$@"; do
  tag="spor-e2e:${version}"
  echo "==================================================================="
  echo "=== build $tag (Claude Code ${version}) ==="
  echo "==================================================================="
  docker build -f "$DOCKERFILE" --build-arg "CLAUDE_VERSION=${version}" -t "$tag" .

  echo "=== run E2E suite in $tag ==="
  if docker run --rm "$tag"; then
    echo "PASS  ${version}"
  else
    echo "FAIL  ${version}"
    fails=$((fails + 1))
  fi
done

echo "==================================================================="
echo "=== matrix complete: $# version(s), ${fails} failed ==="
[ "$fails" -eq 0 ]
