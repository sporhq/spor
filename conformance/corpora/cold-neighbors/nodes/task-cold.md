---
id: task-cold
type: task
project: infra
title: Migrate the legacy auth shim
summary: Untouched since January while the decisions around it kept moving — the cold-node-in-a-hot-neighborhood shape the cold_neighbors signal surfaces.
status: open
date: 2026-01-01
edges:
  - {type: relates-to, to: dec-newer-a}
---
This task has not been written to since it was filed, but the neighborhood it
sits in has kept moving: dec-newer-a (an outbound relate) and dec-newer-b (a
newer decision that relates BACK to this task — an inbound mirror) both carry a
later git updated_at than this node. With the timestamp index injected,
cold_neighbors counts both (2); without the index the signal is absent and the
score is unchanged either way.
