---
id: schema-feature
type: schema
kind: node-schema
schema_version: 2026.06.11.1
project: meridian
title: feature — Meridian-defined node type
summary: Org-defined vocabulary - the feature type exists only in this fixture's registry, authored by the org itself (a customer-facing capability moving discovery to shipped).
status: active
date: 2026-06-10
---

Meridian's own vocabulary: a customer-facing capability moving discovery to shipped. Defined as registry data, no platform code.

```json
{
  "node_type": "feature",
  "description": "a customer-facing capability moving discovery to shipped",
  "prefix": ["feat-"],
  "traversable": true,
  "display": {
    "name": "Feature",
    "hue": 262,
    "statuses": { "planned": "queued", "near-release": "warning", "released": "positive" }
  }
}
```
