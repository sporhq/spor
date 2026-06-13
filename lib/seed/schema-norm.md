---
id: schema-norm
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Seed schema for norm nodes
summary: Node schema for the norm type — a standing convention or constraint; rides along in every project-relevant compile (always_on; the ride-along is project-scoped and capped by the compiler, never an unconditional injection). Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `norm` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "norm",
  "description": "a standing convention or constraint; rides along in every project-relevant compile (always_on; project-scoped and capped by the compiler)",
  "prefix": [
    "norm-"
  ],
  "always_on": true
}
```
