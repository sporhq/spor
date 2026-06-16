---
id: schema-norm
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Seed schema for norm nodes
summary: Node schema for the norm type — a standing convention or constraint; rides along in every project-relevant compile (always_on; the ride-along is project-scoped and capped by the compiler, never an unconditional injection). Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `norm` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

A norm's `always_on` ride-along is project-scoped by default
(issue-cc-norm-ride-along-unscoped-bloat), but "project" resolves to the whole
home-project GROUPING union — so a grouping that spans heterogeneous repos
(a terraform IaC repo, a Go service, a Python service) would still cross-
pollinate norms. A norm may NARROW its ride-along with optional flat
`applies_to_*` selectors, matched against the session's OWN repo
(task-cc-norm-ride-along-repo-tag-scope):

- `applies_to_tags: [python]` — rides along only into repos tagged `python`
  (matched against the session repo node's `tags`, schema-repo). A `uv` norm
  scoped this way stays out of a terraform or Go sibling.
- `applies_to_repos: [repo-my-svc]` — rides along only in the named repo(s)
  (slug or `repo-` id; resolved through the alias map).
- `applies_to_projects: [proj-platform]` — rides along only when the session
  repo belongs to the named project grouping.

Matching is **OR across axes** (inclusion union — "apply in these repos OR
anything python-tagged"), ANY within an axis — deliberately unlike the policy
layer's `governs`, which is AND-across-axes. A norm that declares any
`applies_to_*` and matches none is EXCLUDED (strict, including in a repo with
no tags). A norm with no `applies_to_*` keeps today's project-scoped ride-along
unchanged, so a graph that uses none is byte-identical. The selectors are flat
inline-list strings (the frontmatter parser takes no nested maps).

```json
{
  "node_type": "norm",
  "description": "a standing convention or constraint; rides along in every project-relevant compile (always_on; project-scoped and capped by the compiler)",
  "prefix": [
    "norm-"
  ],
  "always_on": true
}
```
