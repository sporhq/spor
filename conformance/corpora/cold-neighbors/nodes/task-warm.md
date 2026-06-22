---
id: task-warm
type: task
project: infra
title: Tune the rate limiter thresholds
summary: Same age and shape as task-cold but its one neighbor is OLDER — no newer neighbor, so cold_neighbors never fires even with the index injected.
status: open
date: 2026-01-01
edges:
  - {type: relates-to, to: dec-older}
---
The contrast case: identical frontmatter date to task-cold (so an identical age
score) and one relate, but dec-older's injected updated_at is EARLIER than this
node's, so no neighbor is strictly newer and cold_neighbors stays absent. Its
score must equal task-cold's, proving the signal is suggestion-only (0 weight).
