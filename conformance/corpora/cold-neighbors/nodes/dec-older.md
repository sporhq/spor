---
id: dec-older
type: decision
project: infra
title: Keep the existing rate-limit backend
summary: An older neighbor of task-warm (earlier git updated_at) — proves a neighbor that has NOT moved more recently does not make a node cold.
status: active
date: 2026-01-01
---
A neighbor of task-warm whose injected updated_at predates task-warm's, so it is
not strictly newer and contributes nothing to cold_neighbors.
