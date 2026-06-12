---
id: workspace-engineer
type: workspace
project: meridian
title: Engineer — my work radius
summary: Your assigned work and everything it touches, beside the team's load.
status: active
date: 2026-06-10
edges:
  - {type: composes, to: lens-my-work}
  - {type: composes, to: lens-team-capacity}
---

Your assigned work and everything it touches, beside the team's load.

## layout

```json
{
  "columns": 2,
  "slots": [
    {
      "lens": "lens-my-work",
      "title": "My radius",
      "span": 2,
      "params": {
        "focus": "$focus"
      }
    },
    {
      "lens": "lens-team-capacity",
      "title": "Team load"
    }
  ]
}
```
