---
id: task-equal
type: task
project: infra
title: Document the connection-pool sizing
summary: Its one neighbor shares the EXACT same git updated_at — the strict-inequality boundary, so cold_neighbors does not count an equal-aged neighbor.
status: open
date: 2026-01-01
edges:
  - {type: relates-to, to: dec-equal}
---
The boundary case: dec-equal's injected updated_at equals this node's, and
cold_neighbors counts only STRICTLY newer neighbors, so the signal stays absent.
Locks that a neighbor moving in lockstep is not "context moving around it".
