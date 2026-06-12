---
id: task-pricing-rollout
type: task
project: meridian
title: Roll out vendor neutral pricing to the price book
summary: Apply the vendor-neutral pricing decision across the published
  price book plans, including composed bundles and the plan tier table,
  so quotes stop drifting from the billing cost spec.
status: open
date: 2026-06-10
edges:
  - {type: derived-from, to: dec-new}
  - {type: constrained-by, to: spec-rc}
---
Reprice every published plan with the vendor neutral envelopes. The
plan tier table ships last because the composed bundles feed it.
