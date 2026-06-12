---
id: schema-edge-relates-to
type: schema
kind: edge-schema
schema_version: 2026.06.10.3
title: Seed schema for relates-to edges
summary: Edge schema for the relates-to type — weak association. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `relates-to` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

```json
{
  "edge_type": "relates-to",
  "description": "weak association",
  "weight": 0.5,
  "aliases": ["related-to"]
}
```
