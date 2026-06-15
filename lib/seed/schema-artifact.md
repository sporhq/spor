---
id: schema-artifact
type: schema
kind: node-schema
schema_version: 2026.06.15.1
title: Seed schema for artifact nodes
summary: Node schema for the artifact type — a document, spec, module, or build product worth referencing, optionally carrying a delivery-stage status when it represents a change. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `artifact` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

Delivery-stage vocab (2026.06.15.1, dec-spor-definition-of-done-org-policy):
an artifact that represents a *change* (a PR, a branch, a release) — rather than
a static doc or spec — may carry an OPTIONAL delivery-stage `status`:

| status      | resolving? | meaning                                            |
|-------------|------------|----------------------------------------------------|
| `in-review` | no         | change submitted, under review — keeps its task live |
| `approved`  | no         | reviewed and approved, not yet landed — task still live |
| `merged`    | yes        | landed on the default branch — retires its task    |
| `released`  | yes        | shipped/released                                   |

The non-resolving stages are declared in `status.non_resolving`, the artifact's
half of the resolving partition the kernel reads off `graph.registry`: a
resolver in `in-review`/`approved` does not retire its targets, so a task whose
only resolver is a change still in review stays live (this is what dissolves the
overnight-review smell — no `open` status to hand-manage). `merged`/`released`
and any unlisted/empty status resolve, so existing artifacts (no delivery stage)
are unaffected and the seed is byte-identical with the prior hardcoded set.

The stage is one half of a **source-blind** resolver contract (so a GitHub
reflection adapter and a native Spor review surface write the same shape). The
other half is flat scalar frontmatter the regex parser already supports — no
inline-list generalization:

- `delivery_ref` — the change's address (PR url, commit sha, tag).
- `delivery_source` — where it lives (e.g. `github`, `spor`).
- `size`, `labels`, `paths` — diff metadata as comma-scalars
  (`paths: lib/x.js, lib/y.js`).

The kernel never reads these keys; it reads `status` against the partition only.
The **trust seam** — *who* may assert `merged`/`released` (the self-approval
floor: an author cannot land their own change) — is policy that lands in a later
stage (the policy kind + the reflection adapter), not here. There is no status
gate on this type: the stages are optional recognized values, and an artifact
remains free to be a plain doc with no status.

```json
{
  "node_type": "artifact",
  "description": "a document, spec, module, or build product worth referencing",
  "prefix": [
    "spec-",
    "art-"
  ],
  "status": {
    "non_resolving": [
      "in-review",
      "approved"
    ]
  },
  "display": {
    "statuses": {
      "in-review": "active",
      "approved": "active",
      "merged": "positive",
      "released": "positive"
    }
  }
}
```
