---
id: schema-person
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Seed schema for person nodes
summary: Node schema for the person type — a member of the org, the anchor for $viewer identity binding and Tier-2 question routing. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `person` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

A person node's `email` frontmatter field is the identity key: the server
binds `$viewer` from the authenticated token's email — mapping it to this
person node — and, when Tier-2 routing lands, uses the same mapping to route
questions and stewarded queue items. Like attribution
(dec-cc-attribution-from-token), the mapping derives only from the
authenticated identity — never from a caller-supplied parameter.

A person node may also carry a `queue_mute` register (flat inline list):
`queue_mute: [my-project, task-noisy-job@2026-07-01]`. Each entry names a project
slug or node id the queue hides for this viewer; an optional `@YYYY-MM-DD`
expiry makes the mute temporary. Per-viewer presentation only — the items
stay live in the graph and visible to everyone else, and the queue reports
how many it hid (QUEUE.md §4).

```json
{
  "node_type": "person",
  "description": "a member of the org — identity anchor for $viewer binding and question routing",
  "prefix": [
    "person-"
  ]
}
```
