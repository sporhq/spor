---
id: schema-edge-changes-requested-by
type: schema
kind: edge-schema
schema_version: 2026.06.16.1
title: Seed schema for changes-requested-by edges
summary: Edge schema for the changes-requested-by type — this person reviewed the node and requested changes; the blocking outcome of the review-as-graph-object lifecycle. Does NOT count as an approval; the policy layer can surface it as an outstanding change request. Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-16
---

Seed schema for the `changes-requested-by` edge type (work node → person),
shipped with the plugin as a registry default (QUEUE.md §2). It is the
**changes-requested** outcome of the native review lifecycle
(review-as-graph-object, dec-spor-definition-of-done-org-policy): a
`review-requested` edge to a reviewer flips in place to `changes-requested-by`
when that reviewer asks for changes; addressing them and asking again flips it
back to `review-requested`.

It is explicitly **not** an approval: it never enters `view.approvals` and so
never counts toward the definition-of-done quorum. The write path additionally
hands these edges to the policy gate as `view.changes_requested` (reviewer +
`roles`, author excluded), so a policy may require that no change request from
a qualified role is outstanding before a work node may go `done` — the
blocking complement to the quorum of `reviewed-by` approvals.

Weight is mid (0.5, the `relates-to`/`assigned` tier): a recorded
changes-requested verdict is a real outcome, not a structural dependency.

```json
{
  "edge_type": "changes-requested-by",
  "description": "this person reviewed the node and requested changes (does not count as an approval)",
  "weight": 0.5
}
```
