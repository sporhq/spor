---
id: schema-edge-assigned
type: schema
kind: edge-schema
schema_version: 2026.06.10.1
title: Seed schema for assigned edges
summary: Edge schema for the assigned type — work is assigned to a person; the traversal key for per-person views and queues. Seed-pack default; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `assigned` edge type (work node → person), shipped
with the plugin as a registry default (QUEUE.md §2). Per-person views
("what am I blocking") traverse it from the `$viewer` binding; per-person
queues will filter on it.

```json
{
  "edge_type": "assigned",
  "description": "work assigned to this person",
  "weight": 0.5
}
```
