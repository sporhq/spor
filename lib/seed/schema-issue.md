---
id: schema-issue
type: schema
kind: node-schema
schema_version: 2026.06.12.1
title: Seed schema for issue nodes
summary: Node schema for the issue type — a defect/finding and its resolution lineage; queueable, so open issues join the decision queue. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `issue` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`queueable: true` (2026.06.12.1): discovered work must stay continuously
visible — without it, triaging a capture into an issue silently removed the
work from the decision queue (issue-cc-issues-not-queueable). Backward-
readable: the flag changes registry behavior, not node shape, so no upgrade
chain.

```json
{
  "node_type": "issue",
  "description": "a defect/finding and its resolution lineage",
  "prefix": [
    "issue-"
  ],
  "queueable": true
}
```
