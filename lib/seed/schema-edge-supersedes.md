---
id: schema-edge-supersedes
type: schema
kind: edge-schema
schema_version: 2026.06.10.3
title: Seed schema for supersedes edges
summary: Edge schema for the supersedes type — this node replaces the target; target is stale. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `supersedes` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "supersedes",
  "description": "this node replaces the target; target is stale",
  "weight": 1,
  "aliases": ["supercedes"],
  "inverse_label": "superseded-by"
}
```
