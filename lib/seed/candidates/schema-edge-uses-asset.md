---
id: schema-edge-uses-asset
type: schema
kind: edge-schema
schema_version: 2026.10.09.1
title: Schema for uses-asset edges
summary: Edge schema for asset inclusion — this document embeds the target asset descriptor (an artifact naming immutable bytes held outside graph Git), so retention, history and briefings can see what a document shows.
date: 2026-10-09
edges:
  - {type: derived-from, to: art-spor-chatgpt-workspace-plan-2026-10-08}
  - {type: derived-from, to: dec-spor-chatgpt-asset-storage-contract-2026-10-08}
---

Asset inclusion as its own edge type (task-spor-chatgpt-content-contracts). The
canonical direction is `document -> descriptor`: an artifact whose body is
`content_format: markdown` and embeds `![alt](spor-asset:<descriptor-id>)`
carries one `uses-asset` edge to each descriptor it embeds. The inverse
`asset-used-by` form is accepted at the write door and folded onto the
document.

The edge is the GRAPH half of an embed; the body URI is the text half.
`lib/kernel/content.js` `reconcileAssetEdges` reports the drift between them
(embedded without an edge, an edge with no embed, a malformed URI, a pinned
digest the descriptor no longer names). Only inline image syntax outside code
counts as an embed — a `spor-asset:` URI in a code fence or code span is an
example, never an inclusion. Enforcing the reconciliation is the strict phase
after this schema is ACTIVE, not part of the candidate.

Rollout: a candidate, so it is inert until adopted. `spor schema adopt
schema-edge-uses-asset` writes it into a graph as a resident schema at
`status: proposed`; on a team graph a DIFFERENT authorized identity activates it
(no self-approval; task-spor-chatgpt-asset-schema-activation), and only then do
readers count these edges. `--activate` is the trusted-admin form for a solo or
local graph.

The weight is deliberately low and lives here, in the registry, never in
code: a descriptor is a leaf whose summary is a caption, and a widely embedded
asset (a logo, a shared diagram) must not become a hub that pulls every
document using it into one briefing. `capturable: false` — the distiller and
the capture nudge never mint it; the publisher that writes the embed writes the
edge.

```json
{
  "edge_type": "uses-asset",
  "description": "this document embeds the target asset descriptor",
  "weight": 0.3,
  "inverse_label": "asset-used-by",
  "capturable": false
}
```
