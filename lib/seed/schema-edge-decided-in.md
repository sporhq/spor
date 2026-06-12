---
id: schema-edge-decided-in
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for decided-in edges
summary: Edge schema for the decided-in type — the choice in this node was made in the target. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `decided-in` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "decided-in",
  "description": "the choice in this node was made in the target",
  "weight": 0.9
}
```
