---
id: schema-edge-governed-by
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for governed-by edges
summary: Edge schema for the governed-by type — target is the norm/policy this node falls under. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `governed-by` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "governed-by",
  "description": "target is the norm/policy this node falls under",
  "weight": 0.95
}
```
