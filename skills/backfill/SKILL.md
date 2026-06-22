---
name: backfill
description: Bootstrap or extend a project's Spor graph and organize its repos into projects. Use to backfill a repo's history into the graph, to onboard a newly cloned repo, or to group repos ("organize my repos", "set up / pick a project for this repo", "what project does this repo belong to", "group these repos under a project"). Proposes project groupings from the repos already in the graph and writes nothing without confirmation.
---

# Backfill & organize

Two onboarding jobs behind one door: get a repo's history INTO the graph, and
organize the repos that are in it into `type: project` groupings. Both are
re-runnable — run this again whenever you add a repo.

## 1. Populate the graph (backfill), if the repo is thin

If the current repo has little or no graph content yet, offer to backfill it:
spawn the **spor-backfill subagent** (Task tool, `subagent_type:
spor:spor-backfill`) pointed at this repo — it mines git history, design docs,
and issue trackers into typed nodes, edges first (and, against a gated remote
graph, resolvers before the terminal nodes they resolve, so a born-`done`/
`resolved` node isn't rejected by the completion-resolver gate). Skip this when
the repo is already well represented (the enumeration in step 2 tells you what
is present).
The heavy mining always runs in the subagent, never inline in this session.

## 2. Suggest project groupings

A repo's home is a `type: project` grouping it sits under via a `grouped-under`
edge (dec-cc-repo-project-membership-edge); project-scoped reads union every
repo grouped-under one project. A freshly onboarded repo starts **ungrouped**,
which is valid — repo-scoped reads work on its slug. This step proposes the
single home for confirmation; it is the whole point of running this again as
repos accumulate.

### a. Enumerate what exists

Gather every `type: repo` and `type: project` node, plus each repo's `slugs`,
`fingerprints`, and current `grouped-under` edge (if any):

- **With the `spor` CLI** (shell): enumerate the local graph with `spor query`
  (the CLI resolves the graph home for you) —
  ```bash
  spor query --type repo --full        # repo nodes: slugs, fingerprints, grouped-under edge
  spor query --type project --summary  # the existing groupings
  spor query --edges --edge-type grouped-under   # who is already homed
  ```
  Repo nodes carry `slugs:` and `fingerprints:` and (if homed) a `grouped-under`
  edge; project nodes are the groupings themselves. (`spor query` is dual-mode —
  it enumerates the local graph, or the team graph against a server; in Cowork /
  with the connector there is no shell, so use the MCP tools below or `spor lens`.)
- **With the Spor MCP tools** (Cowork, or Claude Code with the connector):
  call `render_lens` with no `lens_id` to list the saved lenses, render the
  project-breakdown one to see existing projects and their members, and
  `query_graph` for repo nodes; `get_node` each repo to read its `fingerprints`.

The repos with no `grouped-under` edge are the ones to home.

**Bridge older backfills.** A repo backfilled before identity-node
auto-registration (client ≤ 0.2.2) has `repo:`/`project:` stamps on its work
nodes but no `type: repo` node — and a home edge has nothing to attach to
without one. So before grouping, find the distinct stamp slugs that have no
matching `type: repo` node (no `repo-<slug>` id and not in any `slugs:`
register) and register an ungrouped identity node for each:

- **Shell (local graph):** write `repo-<slug>.md` in the graph's `nodes/` dir
  (`spor status` prints the resolved graph home) — `type: repo`, `title: <slug>`,
  `slugs: [<slug>]`, today's `date`, no edges — then `spor validate`.
- **Spor MCP tools:** `put_node` the same `type: repo` node.

Register them with **slugs only** — fingerprints accrue automatically when a
session next runs in each repo (session-start records them). The repo you are
currently in usually already has its node, since session-start registers it on
first sight; this step exists so a single `/spor:backfill` run can surface and
home *all* of a user's already-backfilled repos, not just the current one.
Announce which identity nodes you registered. (This is mechanical — the slugs
demonstrably exist in the graph — so it does not need the per-grouping
confirmation that step c does.)

### b. Group the ungrouped repos by signal

For each ungrouped repo, find its best home. Signals, strongest first:

1. **Git remote org** — `fingerprints: [remote:github.com/<org>/<repo>]`. Repos
   sharing an org almost always belong to one product (`sporhq/spor` +
   `sporhq/spor-server` → one project). This is the primary signal.
2. **Shared name stem** — `acme-web`, `acme-api`, `acme-mobile` → `acme`.
3. **Cross-repo edges** — a repo whose nodes carry `derived-from`/`blocks`/
   `relates-to` edges into another repo's nodes belongs with that repo.
4. Shared people (contributors/stewards), then — weakest, last resort — topic
   similarity across the repos' node text.

### c. Propose — never auto-write

Present each suggestion with its evidence and let the user confirm before any
write:

> - Group **repo-acme-api** under **proj-acme** (existing, ⊇ {repo-acme-web}) —
>   shared org `github.com/acme`, shared stem `acme`.  [extend]
> - Create **proj-acme-platform** ⊇ {repo-acme-api, repo-acme-jobs} — shared
>   org + 3 cross-repo edges.  [new]

Rules, from the two-layer identity model (dec-cc-repo-project-two-layer-identity):

- **One home per repo.** Never propose a repo into two projects — suggestions
  are mutually exclusive per repo.
- **Co-ownership is banned.** A repo genuinely shared by two products gets its
  OWN grouping, not membership in both; cross-cutting work stays at the work
  layer as edges, not as duplicated groupings.
- **Ungrouped is a fine outcome.** If there is no real signal, leave the repo
  ungrouped and say so — don't invent a singleton project to fill the slot
  unless the user asks for one.
- Prefer **extending** an existing project over creating a near-duplicate.

### d. Write the confirmed homes

A grouping node's id is `proj-<stem>` (the `proj-` grouping prefix); it owns no
slugs or fingerprints — those live on the repo nodes. The home is a
`grouped-under` edge written ON the repo node, pointing TO the project.

- **Shell (local graph):** create `proj-<stem>.md` in the graph's `nodes/` dir
  (`type: project`, `title`, `summary`, today's `date`), and add a
  `- {type: grouped-under, to: proj-<stem>}` line under each member repo node's
  `edges:`. Then `spor validate`, fix anything it flags, and commit the graph
  repo if it is one.
- **Spor MCP tools:** `put_node` the new `type: project` node (skip if it
  exists), then for each member repo `add_edge {id: "repo-<slug>", type:
  "grouped-under", to: "proj-<stem>"}`. To RE-HOME a repo later, remove the old
  `grouped-under` edge and add the new one — still exactly one home.

Report what you grouped, and — just as important — what you left ungrouped and
why.
