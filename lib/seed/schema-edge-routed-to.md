---
id: schema-edge-routed-to
type: schema
kind: edge-schema
schema_version: 2026.06.10.1
title: Seed schema for routed-to edges
summary: Edge schema for the routed-to type — a question is routed to this person for answering; written by the deterministic router, low traversal weight because routing is wiring, not knowledge lineage. Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-10
---

Seed schema for the `routed-to` edge type (question → person), shipped
with the plugin as a registry default (QUEUE.md §2). Written by the
server's deterministic router: the steward of the closest relevance-
neighborhood node wins; per-person queues filter on it.

```json
{
  "edge_type": "routed-to",
  "description": "question routed to this person for answering",
  "weight": 0.3
}
```
