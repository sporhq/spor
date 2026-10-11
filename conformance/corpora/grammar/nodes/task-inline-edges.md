---
id: task-inline-edges
type: task
title: Inline edge lists are read, never dropped
summary: A JSON array, a YAML flow sequence, and a flow list spanning lines all read as edges.
edges: [{"type":"blocks","to":"task-block-edges"},{"type":"relates-to","to":"dec-flow-edges","note":"a b"}]
status: open
edges: [
  {type: mentions, target: norm-inverse-alias},
  {type: relates-to, to: "art-crlf", profile: profile-x},
]
---

Two inline headers; the reader accumulates both.
