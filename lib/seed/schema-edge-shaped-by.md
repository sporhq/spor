---
id: schema-edge-shaped-by
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for shaped-by edges
summary: Edge schema for the shaped-by type — briefing to the corrections applied; provenance only, carries no traversal weight. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `shaped-by` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "shaped-by",
  "description": "briefing to the corrections applied; provenance only, carries no traversal weight",
  "capturable": false
}
```
