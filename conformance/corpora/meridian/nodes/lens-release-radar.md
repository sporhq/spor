---
id: lens-release-radar
type: lens
project: meridian
title: Release radar — what just shipped, what is close
summary: Sales lens - features near release or released, newest first.
status: active
date: 2026-06-10
---

What sales can talk about today and what is coming.

## query

```json
{ "select": { "type": "feature", "status": ["near-release", "released"] }, "sort": { "by": "date", "dir": "desc" } }
```

## render

```json
{ "as": "table", "columns": ["title", "status", "date", "id"] }
```
