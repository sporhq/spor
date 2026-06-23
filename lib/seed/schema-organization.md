---
id: schema-organization
type: schema
kind: node-schema
schema_version: 2026.06.23.1
title: Seed schema for organization nodes
summary: Node schema for durable organization identity anchors used by front-door membership and stewardship relations.
date: 2026-06-23
---

Seed schema for the `organization` node type. An organization is the durable
front-door identity anchor for one Spor org slug. Person nodes point at it with
`member-of-org` for membership and `stewards` for org-admin authority.

Organization nodes are deliberately authored by trusted identity-management
surfaces, not inferred by capture. `org-root` remains the virtual graph-wide
operator anchor and is not an organization node.

```json
{
  "node_type": "organization",
  "description": "a durable organization identity anchor for membership and org-admin relations",
  "prefix": [
    "org-"
  ],
  "capturable": false
}
```

```js
export function validate(node) {
  const slug = typeof node.slug === "string" ? node.slug : "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return ["organization requires a valid `slug` (DNS-label-ish kebab token, max 63 chars)"];
  }
  if (slug === "root") {
    return ["organization slug `root` is reserved for the virtual org-root operator anchor"];
  }
  if (node.id !== `org-${slug}`) {
    return [`organization id must be org-${slug} to match its slug`];
  }
  return [];
}
```
