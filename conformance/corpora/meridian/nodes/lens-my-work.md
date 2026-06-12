---
id: lens-my-work
type: lens
project: meridian
title: Work radius — {focus}
summary: Engineer lens - assigned work and what it blocks, two hops out
  from a person. The focus param is the $viewer stand-in until identity
  binding lands (task-ui-persona-vocabulary).
status: active
date: 2026-06-10
---

Everything assigned to you and what it blocks, as lineage.

## query

```json
{ "traverse": { "from": "$focus", "follow": ["assigned", "blocks"], "direction": "both", "depth": 2 } }
```

## render

```json
{ "as": "tree", "title": "Work radius — {focus}" }
```
