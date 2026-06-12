---
id: schema-capture-pending
type: schema
kind: node-schema
schema_version: 2026.06.10.3
title: Seed schema for capture-pending nodes
summary: Node schema for the capture-pending type — raw captured text that fit no schema; filed by the server for later triage. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `capture-pending` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "capture-pending",
  "description": "raw captured text that fit no schema; filed by the server for later triage",
  "prefix": [
    "cap-"
  ],
  "capturable": false,
  "queueable": true
}
```
