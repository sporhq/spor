---
id: schema-edge-member-of-org
type: schema
kind: edge-schema
schema_version: 2026.06.23.1
title: Seed schema for member-of-org edges
summary: Edge schema for graph-native organization membership — a person is a member of a durable organization identity anchor.
date: 2026-06-23
---

Seed schema for the `member-of-org` edge type. The canonical direction is
`person -> organization`; the inverse `has-org-member` form is accepted at the
write door and folded onto the person node.

The org-specific name is deliberate: graphs may define a generic `member-of`
relation for teams or other local groupings. Membership alone grants no admin
authority. A person additionally carrying `stewards -> org-<slug>` is an
administrator of that organization.

```json
{
  "edge_type": "member-of-org",
  "description": "this person is a member of the target organization",
  "weight": 0.3,
  "inverse_label": "has-org-member",
  "capturable": false
}
```
