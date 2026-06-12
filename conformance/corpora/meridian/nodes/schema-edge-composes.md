---
id: schema-edge-composes
type: schema
kind: edge-schema
schema_version: 2026.06.10.1
project: wf
title: composes — workspace arranges this lens
summary: Edge schema for the composes type - a workspace node composes the
  lens nodes it arranges. Low weight: composition is interface wiring, not
  knowledge lineage. Makes "which workspaces break if this lens changes?"
  a one-edge graph query (dec-workspaces-as-nodes).
date: 2026-06-10
status: active
---

The `composes` edge: from a workspace node to each lens it arranges. The
workspace's `## layout` slots and its composes edges must agree (enforced
by schema-workspace's validate gate), so layout stays analyzable from the
edge index alone without parsing bodies.

```json
{
  "edge_type": "composes",
  "description": "workspace arranges this lens",
  "weight": 0.2
}
```
