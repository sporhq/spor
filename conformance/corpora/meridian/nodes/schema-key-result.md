---
id: schema-key-result
type: schema
kind: node-schema
schema_version: 2026.06.11.1
project: meridian
title: key-result — Meridian-defined node type
summary: Org-defined vocabulary - the key-result type exists only in this fixture's registry, authored by the org itself (a measurable key result under an objective).
status: active
date: 2026-06-10
---

Meridian's own vocabulary: a measurable key result under an objective. Defined as registry data, no platform code.

```json
{
  "node_type": "key-result",
  "description": "a measurable key result under an objective",
  "prefix": ["kr-"],
  "traversable": true,
  "display": {
    "name": "Key result",
    "statuses": { "on-track": "positive", "at-risk": "warning" }
  }
}
```
