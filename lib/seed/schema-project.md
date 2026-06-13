---
id: schema-project
type: schema
kind: node-schema
schema_version: 2026.06.12.1
title: Seed schema for project nodes
summary: Node schema for the project type — durable project identity owning a slug-alias list and repo fingerprints, so renames are healed by read-time alias resolution instead of orphaning historical project tags. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-12
---

Seed schema for the `project` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

A project node makes project identity data instead of a derived convention
(task-cc-project-identity-nodes). Instances carry two inline-list fields:

- `slugs: [cc-context-substrate, spor]` — every slug that has ever referred
  to this project, oldest first; the last entry is the current name. The
  `project:` stamp on existing nodes NEVER rewrites — it is a historical
  fact about where work was discovered. Consumers resolve any listed alias
  to this node at read time (queue filters, `brief-<slug>` lookup, digest
  scoping), so a rename heals all historical associations with one edit
  to one node.
- `fingerprints: [remote:github.com/sporhq/spor, root:<sha>]` — accumulated
  repo evidence (`remote:` host/path with scheme, userinfo, and `.git`
  stripped; `root:` a root-commit sha). An unknown slug arriving with a
  matching fingerprint is high-confidence rename evidence; the server files
  the alias as a queue item for human confirmation. An accumulating set,
  not a derivation rule — no single fingerprint survives every rewrite.

An optional `status: archived` retires the whole project at end-of-life
(issue-cc-project-lifecycle-queue-pollution). One identity-level edit hides
the project's open tasks/questions from the decision queue for EVERY viewer —
unlike the per-person `queue_mute`, which a project retirement would otherwise
need N people to each set. Slug aliases still resolve, so the project's closed
history stays reachable in a project-scoped read, and session-start announces
the archival instead of injecting a stale brief. Any other status (or none) is
live and behaves exactly as before; archival is not gated by a `transitions()`
status enum, so it stays backward-readable (old clients ignore it).

`capturable: false`: project identity is created deliberately (by a human or
the rename-detection loop), never drafted from a capture. Graphs without
project nodes behave exactly as before — slug inference stays the default,
and a committed `.spor` marker file (`project: <id>`) beats all inference.

```json
{
  "node_type": "project",
  "description": "a project — durable identity owning slug aliases and repo fingerprints",
  "prefix": [
    "proj-"
  ],
  "capturable": false
}
```
