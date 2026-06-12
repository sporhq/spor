---
id: lens-discovery-pipeline
type: lens
project: meridian
title: Discovery pipeline — features by stage
summary: PM lens - features grouped discovery to shipped, with promote
  actions bound to stage transitions.
status: active
date: 2026-06-10
---

The PM's funnel. Promoting a feature is a typed transition, not an edit.

## query

```json
{ "select": { "type": "feature" }, "group": { "by": "stage", "order": ["discovery", "shaping", "build", "shipped"] }, "sort": { "by": "id" } }
```

## render

```json
{ "as": "board" }
```

## actions

```json
[
  { "id": "shape", "label": "Promote to shaping", "on": { "stage": "discovery" }, "set": { "stage": "shaping" } },
  { "id": "greenlight", "label": "Greenlight build", "on": { "stage": "shaping" }, "set": { "stage": "build" } },
  { "id": "ship", "label": "Mark shipped", "confirm": true, "on": { "stage": "build" }, "set": { "stage": "shipped", "status": "released" } }
]
```
