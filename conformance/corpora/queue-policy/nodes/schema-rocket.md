---
id: schema-rocket
type: schema
kind: node-schema
schema_version: 2026.06.12.1
title: Rocket node schema with attached queue signals
summary: Org-defined rocket type, queueable, contributing a thrust signal
  from attached queueSignals code.
status: active
date: 2026-06-12
---
Org vocabulary for the conformance suite: a queueable rocket type whose
attached code adds a deterministic thrust signal.

```json
{
  "node_type": "rocket",
  "description": "conformance fixture type",
  "prefix": ["rocket-"],
  "queueable": true
}
```

```js
export function queueSignals(node, ctx) {
  return { thrust: (ctx.neighbors || []).length + 2 };
}
```
