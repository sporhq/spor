---
id: schema-project
type: schema
kind: node-schema
schema_version: 2026.06.13.1
title: Seed schema for project nodes
summary: Node schema for the project type — the stable grouping ABOVE repos (dec-cc-repo-project-two-layer-identity). A project owns one or more repos, each joined by an inbound `grouped-under` edge; project-scoped reads union the nodes of all member repos. This is the net-new layer; git-repo identity is now `type: repo` (schema-repo). Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-13
---

Seed schema for the `project` node type, shipped with the plugin as a registry
default (QUEUE.md §2). A `type: schema` node in the graph with `kind:
node-schema` and the same `node_type` overrides this entry.

Under the two-layer identity model (dec-cc-repo-project-two-layer-identity)
the word "project" is split in two. A `repo` (schema-repo, renamed from the
former `type: project`) is one git identity. A `project` — this type — is the
stable, product-style grouping above repos: `spor` the project owns the `spor`
and `spor-server` repos. It is the net-new layer and is NOT a git identity: it
owns no `slugs`/`fingerprints` and is not inferred from cwd.

**Membership is an edge, not co-ownership.** A repo joins its home project with
a `grouped-under` edge (repo → project; schema-edge-grouped-under). A repo has
ONE home project; a shared/cross-cutting repo (`auth`, `iac`) is grouped under
its own grouping (e.g. `platform`) rather than co-owned by every product.
Cross-cutting WORK stays edges between work nodes across repos (the existing
primitive), never repo co-ownership.

**Reads.** repo-scoped = nodes stamped that repo's slug; project-scoped = the
union over the nodes of every repo `grouped-under` this project. Session-start
injects the repo brief AND the project brief. The active project for a session
is the repo's home project by default, overridable by a `.spor` marker
`project:` key (dec-cc-active-project-declared-default).

`capturable: false`: a project grouping is created deliberately by a human,
never drafted from a capture. Graphs with no project nodes behave exactly as
before — every repo is simply its own scope and there is no grouping layer.

```json
{
  "node_type": "project",
  "description": "a grouping above repos — owns member repos via inbound grouped-under edges",
  "prefix": [
    "proj-"
  ],
  "capturable": false
}
```
