---
id: schema-edge-reviewed-by
type: schema
kind: edge-schema
schema_version: 2026.06.16.1
title: Seed schema for reviewed-by edges
summary: Edge schema for the reviewed-by type — this person reviewed and approved the node; the approving outcome of the review-as-graph-object lifecycle that the org-defined policy layer's quorum gate counts. Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-16
---

Seed schema for the `reviewed-by` edge type (work node → person), shipped
with the plugin as a registry default (QUEUE.md §2). It is the **approving**
outcome of the native review lifecycle (review-as-graph-object,
dec-spor-definition-of-done-org-policy): a `review-requested` edge to a
reviewer flips in place to `reviewed-by` when that reviewer approves.

This is the edge the org-defined policy layer's **definition-of-done quorum
gate** counts (GRAPH.md "The org-defined policy layer"). On the write path
the server joins each `reviewed-by` (and the synonym `approved-by`) edge to
the reviewer's `roles` register and hands them to the gate as
`view.approvals`, with the node's own author excluded — so a policy may
require a quorum of approvals from a named role before a work node reaches a
resolving/`done` state, and self-approval can never launder past the native
floor.

Weight is mid (0.5, the `relates-to`/`assigned` tier): an approval is a real
outcome worth pulling through a briefing, but not a structural dependency.

```json
{
  "edge_type": "reviewed-by",
  "description": "this person reviewed and approved the node (counts toward a policy quorum)",
  "weight": 0.5
}
```
