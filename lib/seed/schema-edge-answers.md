---
id: schema-edge-answers
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: Seed schema for answers edges
summary: Edge schema for the answers type — this node answers that question; high traversal weight so the asker's next compile pulls the answer through lineage. Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-10
---

Seed schema for the `answers` edge type (answer node → question), shipped
with the plugin as a registry default (QUEUE.md §2). The answer loop is
lineage, not messaging: an answer session writes a decision (or any) node
with an `answers` edge, and the asker's next compile picks it up through
the question's neighborhood. Weighted high because an answer IS knowledge.

```json
{
  "edge_type": "answers",
  "description": "this node answers that question",
  "weight": 0.7,
  "inverse_label": "answered-by"
}
```
