---
id: schema-edge-triggered-by
type: schema
kind: edge-schema
schema_version: 2026.06.11.1
title: Seed schema for triggered-by edges
summary: Edge schema for the triggered-by type — a workflow-run was triggered by the target node or event (the cause that started it). Seed-pack mirror of the run lineage (API.md §3.1); a graph-resident schema node for this edge type overrides it.
date: 2026-06-11
---

Seed schema for the `triggered-by` edge type (workflow-run → cause), shipped
with the plugin as a registry default (QUEUE.md §2). Written by the run
engine when a run starts and a graph-resident cause exists: `run-…
triggered-by → <node>` — the merged-PR event, the task that matched a
trigger filter, or another node that started it (API.md §3.1). A
manual run with no node-shaped cause records its initiator in the run's
`initiator:` frontmatter field instead (edges need real targets). Modest
causal-lineage weight — the cause neighbors the run without dominating it.

```json
{
  "edge_type": "triggered-by",
  "description": "this run was triggered by the target node or event",
  "weight": 0.7
}
```
