---
id: task-near-question
type: task
project: alpha
title: Implement retention purge
summary: Spec-complete but for an open question in its 1-hop neighborhood (relates-to, not a blocker) — derives human.
status: open
date: 2026-06-10
edges:
  - {type: relates-to, to: question-open}
---
A live question in the neighborhood is a soft spec gap a human must close first; a non-blocking edge keeps it in the queue.
