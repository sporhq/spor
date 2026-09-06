---
id: schema-briefing
type: schema
kind: node-schema
schema_version: 2026.09.06.1
title: Seed schema for briefing nodes
summary: Node schema for the briefing type — a compiled briefing; output of this system, never traversed. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `briefing` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`resolution` (2026.09.06.1, issue-spor-offline-check-get-hook-resolution-proxy):
the attestation path for this type's completion, DECLARED as registry data.
`verified_by: status` — a briefing's own terminal status retires it; no inbound
resolving edge attests it. Readers (remote dispatch's terminal-state verify,
`spor schema`) used to infer this from the ABSENCE of a `get()` hook on this
schema, which is the general-purpose read-time enrichment verb and says
nothing about resolution — so adopting one here for any other purpose would
have silently flipped this type to edge-verified and read genuinely
status-retired work as unattested. Declaration only — enforcement stays in the
hooks — no stored-shape change, no upgrade chain.

```json
{
  "node_type": "briefing",
  "description": "a compiled briefing; output of this system, never traversed",
  "prefix": [
    "brief-"
  ],
  "traversable": false,
  "capturable": false,
  "resolution": {
    "verified_by": "status"
  }
}
```
