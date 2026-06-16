---
id: schema-repo
type: schema
kind: node-schema
schema_version: 2026.06.13.1
title: Seed schema for repo nodes
summary: Node schema for the repo type — durable git-repo identity owning a slug-alias list and repo fingerprints, so renames are healed by read-time alias resolution instead of orphaning historical project tags. Renamed from the former `project` node type (dec-cc-repo-project-two-layer-identity); the new grouping above repos is `type: project`. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-13
---

Seed schema for the `repo` node type, shipped with the plugin as a registry
default (QUEUE.md §2). A `type: schema` node in the graph with `kind:
node-schema` and the same `node_type` overrides this entry.

A repo node makes git-repo identity data instead of a derived convention
(task-cc-project-identity-nodes). It is the renamed former `type: project`
node: under the two-layer model (dec-cc-repo-project-two-layer-identity) a
repo is one git identity, and the stable grouping ABOVE repos is the net-new
`type: project` (schema-project). A repo carries its home grouping with a
`grouped-under` edge to a `type: project` node; project-scoped reads union the
nodes of all repos `grouped-under` that project. Instances carry two
inline-list fields:

- `slugs: [cc-context-substrate, spor]` — every slug that has ever referred
  to this repo, oldest first; the last entry is the current name. The
  `project:` stamp on existing nodes NEVER rewrites — it is a historical
  fact about where work was discovered, and it now reads as a REPO slug.
  Consumers resolve any listed alias to this node at read time (queue filters,
  `brief-<slug>` lookup, digest scoping), so a rename heals all historical
  associations with one edit to one node.
- `fingerprints: [remote:github.com/sporhq/spor, root:<sha>]` — accumulated
  repo evidence (`remote:` host/path with scheme, userinfo, and `.git`
  stripped; `root:` a root-commit sha). An unknown slug arriving with a
  matching fingerprint is high-confidence rename evidence; the server files
  the alias as a queue item for human confirmation. An accumulating set,
  not a derivation rule — no single fingerprint survives every rewrite.

A repo may also carry an optional free-form `tags` register
(task-cc-norm-ride-along-repo-tag-scope):

- `tags: [python, backend]` — labels describing this repo, the matching key
  for a norm's `applies_to_tags` ride-along selector (schema-norm). A norm
  scoped `applies_to_tags: [python]` rides along into a session's briefing
  only when this repo (the session's OWN repo) is tagged `python` — so a
  `uv` norm stays out of a terraform or Go sibling under the same project
  grouping. An untagged repo matches no tag-scoped norm (strict — repo
  tagging is the opt-in that turns scoped norms on). Tags are flat strings,
  consulted only on repo nodes; a graph with no `tags` behaves exactly as
  before.

An optional `status: archived` retires the whole repo at end-of-life
(issue-cc-project-lifecycle-queue-pollution). One identity-level edit hides
the repo's open tasks/questions from the decision queue for EVERY viewer —
unlike the per-person `queue_mute`, which a repo retirement would otherwise
need N people to each set. Slug aliases still resolve, so the repo's closed
history stays reachable in a repo-scoped read, and session-start announces the
archival instead of injecting a stale brief. Any other status (or none) is
live and behaves exactly as before; archival is not gated by a `transitions()`
status enum, so it stays backward-readable (old clients ignore it).

`capturable: false`: repo identity is created deliberately (by a human or
the rename-detection loop), never drafted from a capture. Graphs without
repo nodes behave exactly as before — slug inference stays the default,
and a committed `.spor` marker file (`repo: <slug>`, legacy `project: <slug>`)
beats all inference.

**Rename note (dec-cc-repo-project-two-layer-identity,
dec-cc-repo-project-id-prefix-scheme).** This type was renamed from `project`
to `repo` and re-prefixed `proj-` → `repo-`. A node-type rename is NOT
backward-readable and the lazy upgrade-chain executor cannot re-key a node's
`type`, so the migration is an explicit one-off supersede of the (small)
existing identity-node set (`proj-<slug>` → `repo-<slug>`, edges rewritten,
`supersedes` links preserved), NOT a lazy upgrade chain. The freed `proj-`
prefix is taken by the new `type: project` grouping.

```json
{
  "node_type": "repo",
  "description": "a git-repo identity — durable, owning slug aliases and repo fingerprints",
  "prefix": [
    "repo-"
  ],
  "capturable": false
}
```
