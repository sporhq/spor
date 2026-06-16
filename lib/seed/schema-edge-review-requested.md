---
id: schema-edge-review-requested
type: schema
kind: edge-schema
schema_version: 2026.06.16.1
title: Seed schema for review-requested edges
summary: Edge schema for the review-requested type — a review of this node is requested OF a person; the open state of the review-as-graph-object lifecycle, surfaced into the reviewer's queue. Low traversal weight (routing wiring, not knowledge lineage). Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-16
---

Seed schema for the `review-requested` edge type (work node → person),
shipped with the plugin as a registry default (QUEUE.md §2). It is the
*open* state of the native review lifecycle (review-as-graph-object,
dec-spor-definition-of-done-org-policy): a resolving artifact (a change/PR)
or any work node points a `review-requested` edge at each `person` a review
is wanted from. The server surfaces those nodes into each named reviewer's
personal queue (`my_queue` `reviews`), the same per-person filter questions
and findings route through.

An outcome **flips the edge in place**: an approval rewrites it to
`reviewed-by`, a request for changes to `changes-requested-by`; a re-review
flips it back to `review-requested`. The edge type *is* the state, so a node
carries a `review-requested` edge only while that reviewer's verdict is
still pending. Reviewer *selection* (who is asked) is a distinct point from
gate-time *enforcement* (is the bar met, counted from `reviewed-by`): for the
GitHub-reflected path selection comes from CODEOWNERS via the adapter, not a
Spor router.

Weight is low (0.3, like `routed-to`): a pending review request is routing
wiring, not knowledge lineage, so it should not pull the requested node into
unrelated briefings.

```json
{
  "edge_type": "review-requested",
  "description": "a review of this node is requested of this person (pending)",
  "weight": 0.3
}
```
