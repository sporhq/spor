---
id: task-keyset-pagination
type: task
project: meridian
title: Keyset pagination for the export reader
summary: Replace OFFSET pagination so exports stream at 1M rows; gates the latency KR.
status: in-progress
owner: person-marco
date: 2026-06-10
edges:
  - {type: assigned, to: person-marco}
  - {type: blocks, to: task-export-streaming}
---

Replace OFFSET pagination so exports stream at 1M rows; gates the latency KR.
