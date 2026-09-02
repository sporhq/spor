---
id: profile-codex-review
type: profile
repo: acme-checkout
title: Cross-model adversarial reviewer
summary: The review lane Acme's agent-review gate routes to — a different model from the implementer, run under a supervised harness so its structured verdict comes back on a report the runner can read.
date: 2026-08-26
harness: codex
status: active
---

Deliberately a different model from the lane that writes the code: a reviewer
that shares the implementer's blind spots is a rubber stamp. Supervised by
requirement, not preference — an agent-review gate reads its verdict off the
run's final report, so a native-background launch would have no verdict channel
and the gate would fail every time.

This node names a harness and nothing else. What `codex` actually executes is
bound on each machine (`dispatch.harness.codex`), never here: a graph write must
never define what a machine runs.
