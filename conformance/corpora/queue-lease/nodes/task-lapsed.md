---
id: task-lapsed
type: task
project: alpha
title: Reassign the stalled migration
summary: Work whose reservation grace window has been exceeded — the lease entry has expired past now, so it escalates back to the full pool for everyone.
status: open
date: 2026-06-01
edges:
  - {type: assigned, to: person-holder}
---
Grace window exceeded: the durable assigned edge remains but no in-force lease, so it is full pool.
