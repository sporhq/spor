---
id: schema-edge-stewards
type: schema
kind: edge-schema
schema_version: 2026.06.10.1
title: Seed schema for stewards edges
summary: Edge schema for the stewards type — a person stewards an area, spec, or norm; the routing key for Tier-2 questions. Seed-pack default; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `stewards` edge type (person → node they steward),
shipped with the plugin as a registry default (QUEUE.md §2). Tier-2
question routing walks these edges to decide who gets asked what, and
per-person queues filter on them alongside `assigned` (the queue's
`assignee` parameter — task-cc-queue-assignee-filtering).

```json
{
  "edge_type": "stewards",
  "description": "person stewards this area — question-routing key",
  "weight": 0.4
}
```
