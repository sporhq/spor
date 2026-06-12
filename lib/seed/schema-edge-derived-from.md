---
id: schema-edge-derived-from
type: schema
kind: edge-schema
schema_version: 2026.06.10.3
title: Seed schema for derived-from edges
summary: Edge schema for the derived-from type — this node was produced from the target. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `derived-from` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "derived-from",
  "description": "this node was produced from the target",
  "weight": 0.9,
  "aliases": ["derives-from"]
}
```
