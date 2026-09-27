---
id: task-block-edges
type: task
project: grammar
title: Block-form edges with comments and blank lines
summary: Edges in YAML block form, opened by any key, target alias, extra attributes.
status: open
edges:
  # a comment inside the block

  - type: blocks
    to: dec-flow-edges
  - to: corr-lists
    type: "relates-to"
  - type: assigned
    target: agent-x
    profile: profile-y
- type: mentions
  to: norm-inverse-alias
date: 2026-09-27
---

Body of the block-form task.
