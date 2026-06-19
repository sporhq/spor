---
id: task-unblock
type: task
project: meridian
title: Land the migration the rewrite waits on
summary: The schema migration the gated rewrite cannot start without.
status: open
priority: p2
date: 2026-05-01
edges:
  - {type: blocks, to: task-gated}
---
Lands first so the rewrite can proceed.
