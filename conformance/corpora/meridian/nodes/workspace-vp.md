---
id: workspace-vp
type: workspace
project: meridian
title: VP — team capacity and the numbers it moves
summary: Open work per person beside the key results that depend on it.
status: active
date: 2026-06-10
edges:
  - {type: composes, to: lens-team-capacity}
  - {type: composes, to: lens-okr-board}
---

Open work per person beside the key results that depend on it.

## layout

```json
{
  "columns": 2,
  "slots": [
    {
      "lens": "lens-team-capacity",
      "title": "Capacity"
    },
    {
      "lens": "lens-okr-board",
      "title": "OKRs at stake"
    }
  ]
}
```
