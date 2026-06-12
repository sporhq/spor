---
id: lens-team-capacity
type: lens
project: meridian
title: Capacity — open work by person
summary: VP lens - open and in-progress tasks grouped by owner.
status: active
date: 2026-06-10
---

Who is carrying what right now. The assigned edges make this a graph
query; the owner field makes it groupable.

## query

```json
{ "select": { "type": "task", "status": ["open", "in-progress"] }, "group": { "by": "owner" }, "sort": { "by": "id" } }
```

## render

```json
{ "as": "list" }
```
