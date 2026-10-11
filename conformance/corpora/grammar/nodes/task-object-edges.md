---
id: task-object-edges
type: task
title: The spor get --json edges object reads as its outbound edges
edges: {"outbound": [{"type": "blocks", "to": "task-inline-edges"}], "inbound": [{"from": "dec-flow-edges", "type": "relates-to"}]}
status: open
---

Both reads take the outbound edge, ignore inbound, and the lenient lex notes
the shape as normalisable; the serialization is block/flow form.
