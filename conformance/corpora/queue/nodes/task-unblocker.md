---
id: task-unblocker
type: task
project: alpha
title: Land the schema migration
summary: Migration that the indexer rewrite cannot start without.
status: open
priority: p2
date: 2026-05-01
edges:
  - {type: blocks, to: task-blocked}
---
The indexer rewrite reads the new schema, so this lands first.
