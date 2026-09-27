---
id: corr-lists
type: correction
target: dec-flow-edges
title: Every list shape
summary: Inline lists, indented and flush-left block lists, an empty block list, a stray line, a list key with a scalar.
pin: [dec-flow-edges, task-block-edges]
exclude: []
commits:
  - grammar@1a2b3c4d
  - "grammar@5e6f7a8b"
slugs:
- grammar
- grammar-alias
fingerprints:
  - abc123
  this line is stray and must not fold into the array
  - def456
tags:
applies_to_tags: not-a-list
queue_mute: [a, , b]
date: 2026-09-27
---

Body with a list-looking line:
- not frontmatter
