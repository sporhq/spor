---
id: schema-edge-resolves
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for resolves edges
summary: Edge schema for the resolves type — this node fixes/closes the target. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `resolves` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "resolves",
  "description": "this node fixes/closes the target",
  "weight": 0.9
}
```
