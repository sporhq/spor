# syntax=docker/dockerfile:1
# E2E runner image (task-spor-e2e-claude-version-matrix-sandbox).
#
# Runs the local-mode E2E suite (test/e2e-claude.test.js) against a PINNED Claude Code
# version, fully self-contained: the fake Anthropic API, the claude binary, the Spor plugin,
# and the scratch graph all live INSIDE the container. Two payoffs:
#   1. A version matrix is just `--build-arg CLAUDE_VERSION=<ver>` (see docker-matrix.sh).
#   2. Leak-safe: tear the container down and the claude daemon + any background agents die
#      with it (issue-spor-server-dispatch-e2e-bg-agent-leak) — nothing strands on the host.
# The fake serves a dummy key, so the run is offline (only the in-container 127.0.0.1 fake).
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

# git is the plugin's only non-node dependency, and the tests git-init scratch repos.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Keep Claude Code from phoning home during the build's `claude --version` and at runtime.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# The matrix axis: pin the Claude Code version under test. Installed at BUILD time so the
# image is self-contained; `claude --version` both warms and verifies the install.
ARG CLAUDE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && claude --version

# The zero-dep plugin + the test suite. Run as the non-root `node` user the base image ships
# (uid 1000): Claude Code declines to run bypass-permissions as root, which Tier 1 needs.
WORKDIR /spor
COPY . /spor
RUN chown -R node:node /spor
USER node
ENV HOME=/home/node

# Default: run the local-mode E2E suite against the in-image claude (on PATH == the pinned
# version, so no SPOR_E2E_CLAUDE needed). Override CMD for a subset or an interactive shell.
CMD ["npm", "run", "test:e2e"]
