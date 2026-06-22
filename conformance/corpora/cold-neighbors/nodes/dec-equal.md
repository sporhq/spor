---
id: dec-equal
type: decision
project: infra
title: Adopt the standard pool-sizing formula
summary: A neighbor of task-equal updated at the exact same instant — equal, not strictly newer, so it does not count toward cold_neighbors.
status: active
date: 2026-01-01
---
A neighbor of task-equal whose injected updated_at is identical to task-equal's,
exercising the strict-greater-than boundary in coldInHotNeighborhood.
