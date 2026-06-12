---
id: workspace-sales
type: workspace
project: meridian
title: Sales — orientation on capabilities
summary: What is released, what is near, what is coming later.
status: active
date: 2026-06-10
edges:
  - {type: composes, to: lens-release-radar}
  - {type: composes, to: lens-discovery-pipeline}
---

What is released, what is near, what is coming later.

## layout

```json
{
  "columns": 2,
  "slots": [
    {
      "lens": "lens-release-radar",
      "title": "Talk about today",
      "span": 2
    },
    {
      "lens": "lens-discovery-pipeline",
      "title": "Coming later"
    }
  ]
}
```
