---
id: workspace-leadership
type: workspace
project: meridian
title: Leadership — objectives and what ships
summary: OKR progress beside the release radar.
status: active
date: 2026-06-10
edges:
  - {type: composes, to: lens-okr-board}
  - {type: composes, to: lens-release-radar}
  - {type: composes, to: lens-discovery-pipeline}
---

OKR progress beside the release radar.

## layout

```json
{
  "columns": 2,
  "slots": [
    {
      "lens": "lens-okr-board",
      "title": "OKRs",
      "span": 2
    },
    {
      "lens": "lens-release-radar",
      "title": "Shipping"
    },
    {
      "lens": "lens-discovery-pipeline",
      "title": "Pipeline"
    }
  ]
}
```
