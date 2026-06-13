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
| norm       | `norm-`   | a standing convention or constraint (rides along in every project-relevant compile) |
| briefing   | `brief-`  | a compiled briefing (output of this system; never traversed) |
| correction | `corr-`   | standing fix to a briefing: pin/exclude/guidance (never traversed) |
| question   | `question-` | a routed ask the graph could not answer (queueable; status `open`/`answered`, gated) |
| person     | `person-` | a member of the org — the identity anchor for `$viewer` binding and Tier-2 question routing (team mode; see "People, routing, and onboarding") |
| capture-pending | `cap-` | raw captured text that fit no schema; filed by the server for later triage (QUEUE.md §2.3); born status-less, closed only as `merged` (content now in proper node(s)) or `rejected` (no durable fact) — a `transitions()` gate rejects other statuses at write time |
| finding    | `find-`   | a gardener observation about another node, filed as a queue item (QUEUE.md §6) |
| repo       | `repo-`   | durable git-repo identity: slug aliases + repo fingerprints; heals renames at read time (below) |
| project    | `proj-`   | a grouping above repos; owns its member repos via inbound `grouped-under` edges (below) |

## Norm ride-along

A `norm` node (any `always_on` type) rides along on every compile — but the
ride-along is **project-scoped and capped**, not an unconditional dump
(issue-cc-norm-ride-along-unscoped-bloat). A norm rides along only when it is
unstamped/global OR its `project:` matches the session's; a foreign-project
norm still competes through the normal relevance arms, so a genuinely relevant
cross-team norm isn't lost — it just stops being injected by default. The
`ORG NORMS` section then caps at the most topically-relevant norms (rendered in
their original order), so the briefing degrades by relevance rather than by the
downstream 7KB session-start body truncation. A project-blind compile keeps
every norm, exactly as before.

Because a norm rides along with no relevance gate and the team trust model lets
every writer author one, the briefing renderer treats norm bodies as an
**injection surface** (issue-cc-norm-always-on-injection): each is quoted as
untrusted, teammate-authored reference *data* with explicit author attribution
(unattributed norms are flagged as such), under a one-time banner stating the
data-vs-instructions boundary. Imperative wording inside a norm describes team
policy to weigh — it is never a command addressed to the assistant, so a
planted "ignore prior instructions" can't hijack a session.

## Repo and project identity (two-layer)

Identity is two layers (dec-cc-repo-project-two-layer-identity): a **repo** is
one git identity; a **project** is a stable grouping above repos (`spor` the
project owns the `spor` and `spor-server` repos). The word "project" used to do
both jobs and pulls apart the moment an org has more than one repo per unit of
work, so the former `type: project` identity node was renamed to `type: repo`
(prefix `proj-` → `repo-`, dec-cc-repo-project-id-prefix-scheme) and the freed
`proj-` prefix now names the net-new grouping.

A session's repo slug is derived (repo basename, kebab-cased — see the plugin's
CLAUDE.md), so a rename would orphan every historical provenance stamp. New
nodes stamp the slug as `repo:`; pre-rename nodes stamped it `project:`, and
both are read as the repo slug (`repo:` wins if a node carries both,
task-cc-repo-stamp-field-rename). A `type: repo` node makes the identity data
instead (task-cc-project-identity-nodes):

```markdown
---
id: repo-spor
type: repo
title: spor
summary: The Spor knowledge-graph plugin (client half).
slugs: [cc-context-substrate, spor]
fingerprints: [remote:github.com/sporhq/spor, root:47520dcafe1b]
date: 2026-06-13
---
edges:
  - {type: grouped-under, to: proj-spor}
```

- `slugs` lists every slug that has ever referred to the repo, oldest first;
  the last entry is the current name. The `project:` stamp on existing nodes
  **never rewrites** — it is a historical fact about where work was discovered
  and now resolves as a repo slug. Consumers resolve aliases at read time
  instead: queue filters, mutes, and the session-start `brief-<slug>` lookup
  all match any listed alias, so one edit to one node heals all history.
- `fingerprints` accumulates repo evidence: `root:<sha>` (root commits) and
  `remote:<host/path>` (remote URLs with scheme, userinfo, and `.git`
  stripped; ssh and https spellings converge). An unknown slug arriving
  with a known fingerprint is rename evidence — the server files the alias
  as a queue item for a human to confirm. It is an accumulating set, not a
  derivation rule: no single fingerprint survives every history rewrite.
- A committed `.spor` marker file beats all inference — escape hatch for forks,
  moves, and rewrites. The identity key is `repo: <slug>` (legacy `project:
  <slug>` is still read as the repo slug; `repo:` wins when both are present).
  It is read by **nearest ancestor**: the search walks up from the session's
  cwd to the repo root, so a monorepo subtree can carry its own marker
  (`services/api/.spor` → `my-api`) that beats the root's, splitting one repo
  into distinct identities. With no subtree marker the search reaches the root
  and inference is unchanged. Zero-config slug inference stays the default, and
  a graph with no repo nodes behaves exactly as before.
- **Git worktrees** resolve to their main repo, not the worktree directory's
  basename. A linked worktree shares the main repo's root-commit sha and
  remotes, so inferring identity from its (markerless, often throwaway-named)
  directory would mint a wrong slug *and* file false rename evidence (matching
  fingerprints, different checkout dir). Inference uses the main worktree's
  basename — `dirname(git rev-parse --git-common-dir)` — so every worktree of
  one repo shares one identity.
- `status: archived` retires a finished or abandoned repo. One edit to the repo
  node hides its open tasks and questions from the decision queue for **every**
  viewer (the queue reports the hidden count as `archived`, never silent), and
  session-start announces the archival instead of injecting a stale brief —
  replacing the only prior relief, a per-person `queue_mute` that each teammate
  had to set. Slug aliases still resolve, so closed history stays reachable in a
  repo-scoped read. Archival is backward-readable: any other status (or none)
  is live, exactly as before.

### The project grouping

A `type: project` node (prefix `proj-`) is the stable grouping above repos. It
is **not** a git identity: it owns no `slugs`/`fingerprints` and is not inferred
from cwd. A repo joins its ONE home project with a `grouped-under` edge (repo →
project); a shared/cross-cutting repo (`auth`, `iac`) is grouped under its own
grouping (e.g. `platform`) rather than co-owned by every product. Cross-cutting
*work* stays edges between work nodes across repos, never repo co-ownership.

```markdown
---
id: proj-spor
type: project
title: Spor
summary: The Spor product — the spor plugin and spor-server.
date: 2026-06-13
---
```

- **Reads.** repo-scoped = nodes stamped that repo's slug; project-scoped = the
  union over the nodes of every repo `grouped-under` the project. Session-start
  injects the repo brief AND the project brief.
- **Active project** (dec-cc-active-project-declared-default). When a repo
  serves more than one project, cwd no longer names the active one. A session's
  active project is the repo's home project (its `grouped-under` edge) by
  default — the common single-project repo declares nothing. A repo serving
  many projects overrides it with a `.spor` marker `project: <slug>` key (read
  by the same nearest-ancestor walk), or a session command. Branch-name
  inference and distill-time content linking were rejected as non-deterministic.
- A graph with no `type: project` nodes has no grouping layer — every repo is
  simply its own scope, exactly as before.

## People, routing, and onboarding

Team mode (API.md) adds people to the graph. A `person` node is the org
member's identity anchor — every authenticated token's canonical subject is a
`person-` node, and `{name, email}` attribution resolves *from that node at
read time* (API.md §4). Tier-2 question routing and `$viewer`-scoped views
(your queue, your mutes, "what am I blocking") all key off the person node the
caller's token is bound to.

```markdown
---
id: person-anthony
type: person
title: Anthony Allen
summary: Maintainer; stewards the schema registry and the hook engines.
email: losthammer@gmail.com
queue_mute: [some-noisy-project, task-noisy-job@2026-07-01]
date: 2026-06-10
edges:
  - {type: stewards, to: norm-cc-registry-is-contract}
  - {type: stewards, to: art-cc-hooks}
---
```

- **`email` is the identity attribute, not the key.** The token binds to the
  *person node id*; `email` is a re-pointable field on the node, so changing it
  re-points attribution and routing instead of severing them
  (issue-cc-identity-email-mutable-primary-key). The token's `{name, email}`
  attribution is read from the bound node, never from a caller parameter
  (dec-viewer-token-binding, dec-cc-attribution-from-token).
- **`stewards` edges are the routing key.** A `person → node` `stewards` edge
  declares ownership of an area, spec, or norm. When a question can't be
  answered from the graph and is filed (`ask_question` / `POST /v1/questions`),
  the deterministic router walks `stewards` edges from the question's relevance
  neighborhood to the closest steward and writes a `routed-to` edge to that
  person; an unrouted question (no steward matched) surfaces to everyone.
- **`assigned`** points work (task/issue) at a person; per-person queues filter
  on it. **`answers`** points any answer node back at the `question-` it
  resolves — the answer loop is lineage, not messaging, so the asker's next
  compile pulls the answer through the question's neighborhood.
- **`queue_mute`** (flat inline list of project slugs or node ids, each with an
  optional `@YYYY-MM-DD` expiry) is per-viewer presentation only: the queue
  hides those items for this person and reports how many it hid; they stay live
  and visible to everyone else (QUEUE.md §4).

### Onboarding a team member

Joining someone to a team graph is three deliberate steps — do all three or
routing degrades quietly:

1. **Author the `person-<name>` node** (frontmatter above), with `email` set to
   the address the member commits and authenticates under.
2. **Add `stewards` edges** from that node to the areas/specs/norms they own.
   Without at least one steward in a topic's neighborhood, questions there route
   to no one and fall back to surfacing for everybody — answerable, but not
   *directed*.
3. **Mint a token bound to the node:** an admin runs `spor-mint-token --person
   person-<name>` on the server box, or `POST /v1/admin/tokens {person}` over
   REST (admin-only; API.md §3/§4). The plaintext token is returned once.

If a member is reading and writing but **never receives routed questions, sees
an empty personal queue, or has no mutes take effect**, their token did not bind
to a person node (no node, or a token minted before the node existed). That is
the failure this section exists to prevent: today it degrades silently — the
client surfaces no warning when the authenticated identity maps to no person
node. Surfacing that unbound state in queue and briefing responses is tracked
server-side (issue-cc-onboarding-email-mismatch-silent-degradation).

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
| `answers`        | 0.7    | this node answers that question (inverse `answered-by`); pulls the answer through the asker's next compile |
| `assigned`       | 0.5    | work is assigned to this person                  |
| `relates-to`     | 0.5    | weak association                                 |
| `mentions`       | 0.5    | weakest association                              |
| `stewards`       | 0.4    | this person stewards an area/spec/norm — the Tier-2 question-routing key |
| `grouped-under`  | 0.3    | this repo's home project grouping (inverse `groups`); structural membership, not work dependency |
| `routed-to`      | 0.3    | a question routed to this person for answering   |
| `compiled-for`   | —      | briefing → its task/query (provenance only)      |
| `shaped-by`      | —      | briefing → corrections applied (provenance only) |

`answers`, `assigned`, `stewards`, and `routed-to` are the person-graph
edges of Tier-2 question routing; they ship in the seed pack and are
documented under "People, routing, and onboarding" above. `assigned` and
`routed-to` point at a `person-` node; `stewards` points from a person to
the area they own; `answers` points from any answer node back at the
`question-` it resolves.

High-weight edges decay slowly across hops; they are what makes structural
traversal beat similarity search. Prefer one precise high-weight edge over
three `relates-to`.

When the session's project is known (the compile's `project` option, plumbed
from the cwd slug), tf-idf relevance **boosts same-project nodes** so the
session's own context wins ties and edges out marginally-higher foreign hits;
a strongly-relevant cross-project node still surfaces but is labeled
`— cross-project` so it reads as another team's prior art rather than
session-local guidance (issue-cc-digest-unscoped-cross-project-ranking). This
is a single-org-graph relevance-topology fix — shared vocabulary ("auth",
"deploy", "migration") otherwise dilutes the gate across teams. A project-blind
compile (no `project`) ranks every node equally, exactly as before.

A seed (the compile root, or each query-mode content match) always contributes
its **direct 1-hop lineage** to the structural arm, even when score-decay would
push a low-weight edge under the traversal threshold
(issue-cc-digest-omits-task-lineage): a queried node's immediate
parents/children/related work is the single most relevant context and must not
be dropped for higher-heat tangential nodes. The guarantee adds only the
immediate neighbors and never outranks an organic walk hit, so deeper lineage
still decays normally.

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
