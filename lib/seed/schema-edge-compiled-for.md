---
id: schema-edge-compiled-for
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for compiled-for edges
summary: Edge schema for the compiled-for type — briefing to its task/query; provenance only, carries no traversal weight. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `compiled-for` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "compiled-for",
  "description": "briefing to its task/query; provenance only, carries no traversal weight",
  "capturable": false
}
```
