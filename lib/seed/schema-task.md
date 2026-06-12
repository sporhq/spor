---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.10.3
title: Seed schema for task nodes
summary: Node schema for the task type — active or planned work. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `task` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "task",
  "description": "active or planned work",
  "prefix": [
    "task-"
  ],
  "queueable": true
}
```
