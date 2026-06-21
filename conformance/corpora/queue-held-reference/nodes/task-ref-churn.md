---
id: task-ref-churn
type: task
project: infra
title: Add a scheduled SHA-drift monitor
summary: Fix (a) isolation — open, no blocker, with HIGH front. Its only inbound outcome is a bare derived-from reference from a non-resolving artifact, so even with churn-level front it must not held-flag.
status: open
date: 2026-06-19
---
High front alone is not churn unless a real outcome was recorded. A bare
derived-from reference is not an outcome, so this stays `do` and keeps its
front boost — it remains dispatchable via --from-queue.
