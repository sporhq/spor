---
id: dec-newer-a
type: decision
project: infra
title: Standardize on the new auth provider
summary: A decision recorded around the cold task and updated later (newer git updated_at) — one of the two newer neighbors that make task-cold cold.
status: active
date: 2026-01-01
---
A newer neighbor of task-cold, reached over its outbound relates-to edge. Its
injected updated_at is later than task-cold's, so it counts toward
cold_neighbors. A decision is non-queueable, so it never appears in the ranked
queue itself — it only shapes task-cold's neighborhood.
