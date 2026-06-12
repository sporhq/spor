---
id: schema-policy
type: schema
kind: queue-policy
schema_version: 2026.06.12.1
title: Org queue policy favoring blockers and rockets
summary: Queue policy whose rank() rescoring favors blocking work and
  rocket-typed items over the default blend.
status: active
date: 2026-06-12
---
Deterministic re-scoring for the conformance suite.

```json
{
  "description": "blockers first, rockets above everything"
}
```

```js
export function rank(items) {
  return items.map((it) => ({
    id: it.id,
    score: (it.signals.blocking || 0) * 10 + (it.type === "rocket" ? 100 : 0) + (it.priority === "p1" ? 1 : 0),
  }));
}
```
