---
id: schema-finding
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Seed schema for finding nodes
summary: Node schema for the finding type — a gardener observation about another node (stale anchors, cold work), filed as a queue item for a human to act on. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `finding` node type, shipped with the plugin as a
registry default (QUEUE.md §2/§6). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "finding",
  "description": "a gardener observation about another node (stale anchors, cold work), filed as a queue item for a human to act on",
  "prefix": ["find-"],
  "queueable": true,
  "capturable": false
}
```
