# Spor graph format

> **Status: seed schema pack, not the contract.** As of QUEUE.md §2 rollout
> step 1, the ontology below (node types, prefixes, edge types, weights, the
> norm ride-along, briefing/correction traversal exclusion) is data, not code:
> it ships as schema nodes in `lib/seed/` and is loaded as the registry
> default for any graph that carries no schema nodes of its own. A
> graph-resident `type: schema` node overrides or extends any entry here.
> This file remains accurate documentation of the seed pack and of the node
> file format, but when this prose and the registry disagree, the registry
> wins — see QUEUE.md §2.

The Spor graph lives OUTSIDE code repos, at `$SPOR_HOME` (the legacy
`SUBSTRATE_HOME` spelling is still read; default `~/.spor/`, or the legacy
`~/.substrate/` when `~/.spor` is absent and it exists) — one markdown file
per node in `nodes/`, briefing history in `history/`, ephemeral session
journals (gitignored) in `journal/`. The graph
home is its own git repo: its history is the knowledge history, decoupled from
any code repo's branches — knowledge distilled on branches that never merge,
and ideas that were dismissed, persist. One graph spans all projects; nodes
carry a `project:` field and edges freely cross project boundaries.

## Node file format

```markdown
---
id: dec-export-csv-format
type: decision
project: meridian
title: Bulk export ships as CSV with a stable column order
summary: One or two sentences. This is what the compiler shows at summary
  resolution (pyramid level 1), so it must stand alone.
status: active
date: 2026-06-09
edges:
  - {type: derived-from, to: spec-export-schema}
  - {type: supersedes, to: dec-export-json-only}
---

Full body. A few paragraphs at most — the body is shown at full resolution
when the node scores high in a compile. Write for a reader with zero session
context.
```

Rules:

- `id` must equal the filename minus `.md`, be kebab-case, and start with the
  type prefix (below). It never changes once created.
- `summary` is mandatory and must stand alone — most consumers only ever see
  the summary.
- `date` is YYYY-MM-DD (date of the underlying event, not of node creation).
- `author` and `authored_via` are optional. The remote server (see API.md
  §1) stamps `author: Name <email>` and `authored_via:
  mcp|rest|capture|gardener` from the authenticated identity on every node
  it writes (`capture` marks nodes drafted by the ingestion path, QUEUE.md
  §2.3; `gardener` marks sweep findings, §6); any payload-supplied value is
  discarded. Both are simple `key: value` scalars. Locally written nodes may
  omit them.
- Edges may point at ids that don't exist yet; the compiler skips them. Don't
  delete an edge just because the target is missing — it marks a node worth
  creating.
- `commits` is an optional inline list of repo-qualified git shas
  (`commits: [wf@1a2b3c4d, ...]`, kebab-case repo slug + 7–40 hex) linking
  the node to the code commits that implement it (task-cc-commit-linking).
  Commits are not nodes — a node-per-commit would mirror `git log` and drown
  the curated graph; the field plus the `Spor: <node-id>`
  commit-message trailer give both directions (node→commit here, commit→node
  in git). The legacy `Substrate: <node-id>` trailer is still read for commits
  made before the rename. The trailer must sit in the commit's FINAL trailer block — the
  last paragraph, directly adjacent to any other trailers like
  Co-Authored-By, no blank line between — or git (and therefore the hooks)
  will not parse it as a trailer. Stamped automatically by the hooks when a commit carries the
  trailer; `GET /v1/commits/{sha}` answers the reverse lookup. Only
  milestone commits deserve hand-written entries.
- `wake` is an optional `YYYY-MM-DD` scalar on queueable nodes (QUEUE.md
  §4): scheduled dormancy. The decision queue counts the node as `dormant`
  instead of ranking it until the date arrives, then surfaces it to every
  viewer — the renew-the-cert / schedule-the-audit shape, kept with the
  work instead of in one person's calendar. Everything else (compiles,
  briefings, edges) sees a dormant node normally.
- One fact per node. If you're writing "also" a lot, split it.

## Node types and id prefixes

| type       | prefix    | what it is                                                |
|------------|-----------|-----------------------------------------------------------|
| decision   | `dec-`    | a choice that was made, with the why (status `active`/`superseded`/`rejected`, gated) |
| task       | `task-`   | active or planned work (status `open`/`active`/`done`/`abandoned`, gated) |
| issue      | `issue-`  | a defect/finding and its resolution lineage (queueable: open issues join the decision queue; status `open`/`active`/`resolved`, gated) |
| incident   | `inc-`    | something that went wrong in operation (queueable: live incidents join the decision queue) |
| artifact   | `spec-`, `art-` | a document, spec, module, or build product worth referencing |
| norm       | `norm-`   | a standing convention or constraint (rides along in every compile) |
| briefing   | `brief-`  | a compiled briefing (output of this system; never traversed) |
| correction | `corr-`   | standing fix to a briefing: pin/exclude/guidance (never traversed) |
| question   | `question-` | a routed ask the graph could not answer (queueable; status `open`/`answered`, gated) |
| capture-pending | `cap-` | raw captured text that fit no schema; filed by the server for later triage (QUEUE.md §2.3); born status-less, closed only as `merged` (content now in proper node(s)) or `rejected` (no durable fact) — a `transitions()` gate rejects other statuses at write time |
| finding    | `find-`   | a gardener observation about another node, filed as a queue item (QUEUE.md §6) |
| project    | `proj-`   | durable project identity: slug aliases + repo fingerprints; heals renames at read time (below) |

## Project identity nodes

A session's project slug is derived (repo basename, kebab-cased — see the
plugin's CLAUDE.md), so a rename would orphan every historical `project:`
stamp. A `type: project` node makes the identity data instead
(task-cc-project-identity-nodes):

```markdown
---
id: proj-spor
type: project
title: Spor
summary: The Spor knowledge-graph plugin and server.
slugs: [cc-context-substrate, spor]
fingerprints: [remote:github.com/sporhq/spor, root:47520dcafe1b]
date: 2026-06-12
---
```

- `slugs` lists every slug that has ever referred to the project, oldest
  first; the last entry is the current name. The `project:` stamp on
  existing nodes **never rewrites** — it is a historical fact about where
  work was discovered. Consumers resolve aliases at read time instead:
  queue project filters, mutes, and the session-start `brief-<slug>` lookup
  all match any listed alias, so one edit to one node heals all history.
- `fingerprints` accumulates repo evidence: `root:<sha>` (root commits) and
  `remote:<host/path>` (remote URLs with scheme, userinfo, and `.git`
  stripped; ssh and https spellings converge). An unknown slug arriving
  with a known fingerprint is rename evidence — the server files the alias
  as a queue item for a human to confirm. It is an accumulating set, not a
  derivation rule: no single fingerprint survives every history rewrite.
- A committed `.spor` marker file (`project: <id>`) beats all inference —
  escape hatch for forks, moves, and rewrites. It is read by **nearest
  ancestor**: the search walks up from the session's cwd to the repo root, so
  a monorepo subtree can carry its own marker (`services/api/.spor` →
  `my-api`) that beats the root's, splitting one repo into distinct project
  identities. With no subtree marker the search reaches the root and inference
  is unchanged. Zero-config slug inference stays the default, and a graph with
  no project nodes behaves exactly as before.
- **Git worktrees** resolve to their main repo, not the worktree directory's
  basename. A linked worktree shares the main repo's root-commit sha and
  remotes, so inferring identity from its (markerless, often throwaway-named)
  directory would mint a wrong slug *and* file false rename evidence (matching
  fingerprints, different checkout dir). Inference uses the main worktree's
  basename — `dirname(git rev-parse --git-common-dir)` — so every worktree of
  one repo shares one identity.
- `status: archived` retires a finished or abandoned project. One edit to the
  project node hides its open tasks and questions from the decision queue for
  **every** viewer (the queue reports the hidden count as `archived`, never
  silent), and session-start announces the archival instead of injecting a
  stale brief — replacing the only prior relief, a per-person `queue_mute` that
  each teammate had to set. Slug aliases still resolve, so closed history stays
  reachable in a project-scoped read. Archival is backward-readable: any other
  status (or none) is live, exactly as before.

## Edge types and traversal weights

| edge             | weight | meaning                                          |
|------------------|--------|--------------------------------------------------|
| `supersedes`     | 1.0    | this node replaces the target; target is stale   |
| `constrained-by` | 1.0    | target limits what this node may do              |
| `governed-by`    | 0.95   | target is the norm/policy this node falls under  |
| `derived-from`   | 0.9    | this node was produced from the target           |
| `decided-in`     | 0.9    | the choice in this node was made in the target   |
| `resolves`       | 0.9    | this node fixes/closes the target                |
| `blocks`         | 0.7    | target cannot proceed until this node does       |
| `relates-to`     | 0.5    | weak association                                 |
| `mentions`       | 0.5    | weakest association                              |
| `compiled-for`   | —      | briefing → its task/query (provenance only)      |
| `shaped-by`      | —      | briefing → corrections applied (provenance only) |

High-weight edges decay slowly across hops; they are what makes structural
traversal beat similarity search. Prefer one precise high-weight edge over
three `relates-to`.

Edges are written in the canonical direction above, but the server's write
path accepts two normalized forms (API.md §1, registry data on each
edge schema): **aliases** — same-direction synonyms renamed in place
(`related-to` → `relates-to`, `derives-from` → `derived-from`,
`supercedes` → `supersedes`) — and **inverse labels** — the edge read from
the target's side, flipped onto the target node on write (`blocked-by` →
`blocks`, `answered-by` → `answers`, `superseded-by` → `supersedes`).
Hand-written nodes should still use the canonical forms.

## Correction nodes

```markdown
---
id: corr-issue-86-1
type: correction
title: Pin the actor-model spec when briefing issue-86
target: issue-86
pin: [spec-actor-model]
exclude: [art-stale-notes]
date: 2026-06-10
---

Free-text guidance, injected verbatim into the compile for the target.
```

`target` is a node id, or `global` to apply to every compile. Corrections are
how humans debug the context instead of the model: fix it once, it applies to
every future compile.

## Briefing nodes

Created by the distiller or `/spor:brief`. Carry `derived-from` edges to
every source node and `shaped-by` edges to applied corrections, plus a
`version:` integer. On recompile the old version is archived to
the graph home's `history/` and the version bumps. `brief-project` is the standing
project briefing injected at session start.
