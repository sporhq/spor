---
id: schema-edge-focuses-on
type: schema
kind: edge-schema
schema_version: 2026.06.10.1
title: Seed schema for focuses-on edges
summary: Edge schema for the focuses-on type — a lens (or other view-like node) → the node it is parameterized on, so re-pointing a view is an edge edit and "which lenses watch this node" is graph traversal. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-10
---

Seed schema for the `focuses-on` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

A lens that renders one node's neighborhood carries `{type: focuses-on, to:
<node>}` (schema-lens), and the runner resolves `"$focus"` in the lens query
from that edge when no runtime parameter is given. Low weight — a lens watching
a node says little about the node's own lineage. `capturable: false` like the
lens type it wires: view parameterization is authored, never drafted from a
capture.

```json
{
  "edge_type": "focuses-on",
  "description": "view-like node → the node it is parameterized on",
  "weight": 0.2,
  "capturable": false
}
```
