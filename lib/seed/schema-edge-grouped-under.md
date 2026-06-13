---
id: schema-edge-grouped-under
type: schema
kind: edge-schema
schema_version: 2026.06.13.1
title: Seed schema for grouped-under edges
summary: Edge schema for the grouped-under type — this repo's home project grouping (repo → project, dec-cc-repo-project-two-layer-identity). The inbound set on a project node enumerates its member repos for project-scoped reads. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this edge type overrides it.
date: 2026-06-13
---

Seed schema for the `grouped-under` edge type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: edge-schema` and the same `edge_type` overrides this entry.

Carried by a `repo` node, naming its ONE home `project` grouping
(dec-cc-repo-project-two-layer-identity). The inverse `groups` reads from the
project node; the set of repos `grouped-under` a project is what project-scoped
reads union over. This is structural membership, not work dependency — it
carries no queue/briefing traversal weight beyond a weak association.

```json
{
  "edge_type": "grouped-under",
  "description": "this repo's home project grouping (repo → project)",
  "weight": 0.3,
  "inverse_label": "groups"
}
```
