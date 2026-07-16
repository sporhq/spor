---
id: schema-artifact
type: schema
kind: node-schema
schema_version: 2026.07.16.2
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

`status.terminal` (2026.07.16.1, issue-spor-coupling-resolution-terminal-
status-divergence): the artifact type's own-lifecycle terminal vocabulary —
`merged`/`released`/`done` — declared on the registry so work-analytics counts
a delivered or otherwise-finished artifact as completed off
`graph.registry.terminalStatuses()`, the lifecycle twin of `non_resolving`
above. `done` joins `merged`/`released` here because artifacts also use it as
a general non-delivery completion status (a finished doc/spec/build product,
not a change going through review) — the live graph carries many artifacts at
each of `done`, `merged`, and `released`. `in-review`/`approved` and any
unlisted/empty status (the live default: a plain reference doc with no
status, or one mid-review) are NOT terminal — they, and any other status,
stay OUT of this partition, so the artifact keeps reading as work in progress.
Separately, `merged`/`done` are also part of the type-blind `terminal-status`
register (GRAPH.md) that `lib/kernel/resolution.js` and
`lib/kernel/coupling.js` read for queue liveness and briefing surfacing.
`released` is NOT: it is artifact-scoped, reaching queue liveness only
through this partition — the per-type `status.inert` overlay inherits this
`terminal` set (no `inert` declared here, the inheritance default of
dec-spor-status-inert-third-partition), so a released ARTIFACT retires from
queues and briefings while a non-artifact marked `released` stays live
(task-spor-terminal-status-type-aware-migration; it sat in the type-blind
register for one version, 2026.07.16.1, before the inert partition existed).
Registry behavior only, no node-shape change, backward-readable, no upgrade
chain.

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
    ],
    "terminal": [
      "merged",
      "released",
      "done"
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
