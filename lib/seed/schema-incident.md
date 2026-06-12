---
id: schema-incident
type: schema
kind: node-schema
schema_version: 2026.06.12.1
title: Seed schema for incident nodes
summary: Node schema for the incident type — something that went wrong in operation; queueable, so live incidents join the decision queue. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `incident` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`queueable: true` (2026.06.12.1): same rationale as schema-issue —
discovered work stays continuously visible in the decision queue until a
terminal status retires it. Backward-readable: the flag changes registry
behavior, not node shape, so no upgrade chain.

```json
{
  "node_type": "incident",
  "description": "something that went wrong in operation",
  "prefix": [
    "inc-"
  ],
  "queueable": true
}
```
