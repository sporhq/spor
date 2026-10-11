---
id: bad-inline-edges-multiline
type: task
title: A refused multi-line inline edges value never leaks its inner lines as edges
edges: [
  - {type: blocks, to: bad-inline-edges},
  {type: relates-to}
]
status: open
---

Strict throws; lenient records one fault, skips the whole gathered range (the
inner flow line is not an edge) and keeps status.
