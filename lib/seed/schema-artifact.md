---
id: schema-artifact
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Seed schema for artifact nodes
summary: Node schema for the artifact type — a document, spec, module, or build product worth referencing. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `artifact` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "artifact",
  "description": "a document, spec, module, or build product worth referencing",
  "prefix": [
    "spec-",
    "art-"
  ]
}
```
