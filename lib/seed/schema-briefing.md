---
id: schema-briefing
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Seed schema for briefing nodes
summary: Node schema for the briefing type — a compiled briefing; output of this system, never traversed. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `briefing` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

```json
{
  "node_type": "briefing",
  "description": "a compiled briefing; output of this system, never traversed",
  "prefix": [
    "brief-"
  ],
  "traversable": false,
  "capturable": false
}
```
