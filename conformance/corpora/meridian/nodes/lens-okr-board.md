---
id: lens-okr-board
type: lens
project: meridian
title: OKRs — key results by objective
summary: Leadership lens - every key result grouped under its objective.
status: active
date: 2026-06-10
---

Key results grouped by objective; the measures edges carry lineage to the
work that moves each number.

## query

```json
{ "select": { "type": "key-result" }, "group": { "by": "objective" }, "sort": { "by": "id" } }
```

## render

```json
{ "as": "board" }
```
