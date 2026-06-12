---
id: workspace-pm
type: workspace
project: meridian
title: PM — discovery to shipped
summary: The funnel with promote actions, beside what already shipped.
status: active
date: 2026-06-10
edges:
  - {type: composes, to: lens-discovery-pipeline}
  - {type: composes, to: lens-release-radar}
---

The funnel with promote actions, beside what already shipped.

## layout

```json
{
  "columns": 2,
  "slots": [
    {
      "lens": "lens-discovery-pipeline",
      "title": "Funnel",
      "span": 2
    },
    {
      "lens": "lens-release-radar",
      "title": "Shipped / near"
    }
  ]
}
```
