---
id: dec-newer-b
type: decision
project: infra
title: Retire the shim's feature flag
summary: A later decision that relates BACK to task-cold (inbound mirror) with a newer git updated_at — the second newer neighbor, proving inbound adjacency counts.
status: active
date: 2026-01-01
edges:
  - {type: relates-to, to: task-cold}
---
This decision points its relates-to edge AT task-cold, so it reaches task-cold
as an inbound adjacency mirror. Its injected updated_at is later than
task-cold's, so cold_neighbors counts it too — locking that the signal walks
both outbound edges and inbound mirrors over graph.adj.
