---
id: bad-edge-missingto
type: task
title: Block-form edge entry missing a to/target
summary: Exercises the unparseable-edge-entry error (severity promoted from warning to error).
date: 2026-06-01
edges:
  - type: relates-to
---
This edge entry never resolves a to/target, so the loader skips the whole file.
