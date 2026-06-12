---
id: schema-edge-performs
type: schema
kind: edge-schema
schema_version: 2026.06.11.1
title: Seed schema for performs edges
summary: Edge schema for the performs type — a workflow-run performs (is an execution of) a workflow node, pinned to the workflow's version at start. Seed-pack mirror of the run lineage (API.md §3.1); a graph-resident schema node for this edge type overrides it.
date: 2026-06-11
---

Seed schema for the `performs` edge type (workflow-run → workflow), shipped
with the plugin as a registry default (QUEUE.md §2). Written by the run
engine when a run starts: `run-… performs → wf-…`, pinned to the workflow
node's version at start so a workflow edit mid-run does not change a live
run (API.md §3.1). Strong lineage weight — a run is best understood next
to the workflow that defines it.

```json
{
  "edge_type": "performs",
  "description": "this run is an execution of the target workflow",
  "weight": 0.8
}
```
