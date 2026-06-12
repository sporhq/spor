---
id: schema-edge-blocks
type: schema
kind: edge-schema
schema_version: 2026.06.10.3
title: Seed schema for blocks edges
summary: Edge schema for the blocks type — target cannot proceed until this node does. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `blocks` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "blocks",
  "description": "target cannot proceed until this node does",
  "weight": 0.7,
  "inverse_label": "blocked-by"
}
```
