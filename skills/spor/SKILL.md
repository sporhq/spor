---
name: spor
description: The operating manual for Spor — a knowledge-graph tool your training does not cover. Load it before any Spor graph operation so you use the right CLI syntax, node and edge format, MCP tools, and REST API instead of rediscovering them: querying or searching the graph, reading or writing nodes, adding edges, capturing or deferring work, running spor CLI commands or Spor MCP tools, working in local vs remote mode, or defining a new node/edge type or schema. It also routes you to the right /spor action skill (defer, brief, next, correct, ask, backfill) for a specific operation, and explains the node/edge mental model when you need it. For FIRST-TIME setup — installing, creating an identity, joining a team graph, or "spor isn't doing anything" — use /spor:onboard instead. When unsure how to operate Spor, consult this before guessing.
---

# Operate Spor

Spor is a typed, versioned **knowledge graph** of the durable outcomes of
work — decisions (including the dismissed ones, and why), tasks, issues, norms,
specs, questions — one fact per node, joined by typed edges. Your training
doesn't cover it, so this skill is your standing **operating reference**: the
CLI verbs, node and edge format, MCP tools, and REST surface, so you use the
right ones instead of rediscovering them each time.

Most of the time you don't touch the graph by hand — in Claude Code, hooks
compile a briefing at session start and a per-prompt digest automatically, and a
distiller writes new nodes back at session end. This skill is for when you
operate it yourself: query or search, read or write nodes and edges, run a
`spor` verb or a Spor MCP tool, or extend the schema. For **first-time setup** —
installing, creating an identity, joining a team graph, or "spor isn't doing
anything" — stop here and use **/spor:onboard**, the front door.

Work the graph in a loop: **ORIENT → TRAVERSE → COMMIT**. Find where to start,
walk outward through edges until you have enough context, then write the outcome
back so the next session inherits it.

## The model, in brief

- **Nodes** are markdown files, one fact each, with a `type` and a kebab-case
  `id` that starts with the type's prefix (`dec-`, `task-`, `issue-`, `norm-`,
  `art-`/`spec-`, `question-`, …). The `summary` line must stand on its own —
  most consumers only ever see it.
- **Edges** are typed and directional, written from the source node's
  perspective: `supersedes`, `blocks`, `resolves`, `derived-from`,
  `constrained-by`, `governed-by`, `relates-to`, `mentions`, … They carry the
  lineage a flat list can't — *why* a node exists and what it depends on. An
  edge may point at an id that doesn't exist yet; the compiler skips it (a marker
  the node is worth creating).
- **The ontology is data you can extend.** Each type is itself a `type: schema`
  node (QUEUE.md §2): the seed pack in `lib/seed/` is the default, and a schema
  node resident in a graph overrides or extends it. Introspect the live set with
  `spor schema` — don't reverse-engineer it from `lib/seed/` (that misses
  resident overrides).

Full node-type and edge-type registries, the node file format, and the
project-slug rule live in **`references/concepts.md`**.

## Mode: the CLI resolves it — don't branch in prose

Spor runs against your **personal** graph (local mode) or a **team server**
(remote mode), but you don't detect that and fork: **run one `spor <verb>` and
the CLI self-resolves** enabled → local/remote → tenant per call (the config
cascade, dec-spor-client-cli-mode-tenant-resolution). So the action skills carry
no mode branch — no `[ -n "$SPOR_SERVER" ]` test, no raw `curl /v1/*` vs
`lib/*.js` fork. Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce
the mode unless the user asks; if you need to *see* the resolved mode/tenant, run
`spor status`. (The one branch that remains is **surface, not mode**: in Cowork /
with the connector there is no shell, so use the MCP tools — see below.)

As background, the two modes differ in what happens underneath:

| | local (`SPOR_SERVER` unset) | remote (`SPOR_SERVER` set) |
|---|---|---|
| **the graph** | files under `$SPOR_HOME/nodes/` (default `~/.spor/`) | lives on the server; client caches |
| **writing** | you write the node markdown yourself; the distiller commits it | the server's ingestion model types raw text into nodes; writes are attributed to you |
| **reading** | the `spor` CLI, against your local files | the `spor` CLI, the MCP tools, or their REST twins (API.md §3) |

`spor status` prints the resolved mode, graph home, project, and identity.
Settings resolve through a cascade (CLI flag > env > repo `.spor.json` >
user/global config > defaults), so when in doubt let `spor status` report the
effective values rather than guessing.

## CLI reference

The `spor` CLI is the simplest surface. A few verbs work in either mode; the
rest are mode-specific (`spor status` confirms which mode you're in):

```bash
# either mode (the CLI self-resolves local vs remote per verb)
spor status                    # resolved mode, graph, project, identity, health
spor next [--project <slug>]   # the ranked decision queue — "what's next"
spor get <id>                  # one node by id
spor put-node [<file>|-] --if-exists <error|skip|update> [--revision <sha>]
                               # write a full node markdown file through validated put_node semantics;
                               # use `spor get <id> --json` first and pass its revision for updates
spor blame <sha> [--repo <s>]  # which nodes reference a git commit (alias: spor commits <sha>)
spor history <id> [<sha>]      # a node's commit lineage (actor/when/what); <sha> = that revision's diff (local git log / GET /v1/nodes/<id>/history)
spor schema [<type>]           # introspect the live registry (types/prefixes/weights/flags/gates,
                               #   seed + resident overrides, provenance-tagged) — query this, don't
                               #   read lib/seed/. Remote reflects the server's registry (GET /v1/schema)
spor add "<2-3 sentences>"     # capture a node (typed file locally; /v1/capture remotely)
spor ask "<question>"          # file a question the graph can't answer (open question node locally; routed via /v1/questions remotely)
spor correct <target> "<text>" # standing briefing correction (corr file locally; /v1/corrections remotely)
spor priority <id> <p1|p2|p3|clear>  # set/clear queue human-triage priority (local: rewrite frontmatter; remote: /v1/nodes/{id}/priority)
spor set-status <id> <status>  # flip a node's status — an active status (active/open) also CLAIMS it (local: rewrite frontmatter; remote: /v1/nodes/{id}/status)
spor edge <id> <type> <to>     # add a typed edge, e.g. close a loop with resolves (local: append edge line; remote: /v1/nodes/{id}/edges)

# remote (team server) only
spor lens [<id>]               # list saved views, or render one
spor agent create <label>      # create one of your agents — a person-owned principal (`spor agent list`)
spor agent use <agent-id>      # make it THIS machine's default dispatch identity (writes dispatch.agent)
spor dispatch <id>|"<task>"    # run work as a background agent; in team mode its graph writes are
                               #   attributed "agent on behalf of you" (the machine's default agent =
                               #   dispatch.agent, set by `spor agent use`; --as <agent-id> overrides it
                               #   per dispatch; --agent is the unrelated `claude --agent` passthrough).
                               #   --profile <id> pins the profile to run under; if THIS machine can't
                               #   satisfy it, dispatch refuses loudly and leaves the assignment intact
                               #   (never substitutes). See API.md §3-§4.
spor capabilities              # this machine's dispatch capability map (harnesses/MCP/skills/plugins/
                               #   deny) matched against a profile at dispatch; self-probes each session.
                               #   probe | set <axis> <v…> | allow-mcp <m…> | deny <profile-id…> | clear
spor claim <node-id>           # manually take the heartbeat-renewed lease on a task (POST .../claim) —
                               #   yours-in-progress, out of teammates' queues (dec-cc-task-claim-lease)
spor renew <node-id>           # heartbeat your live claim, bumping its expiry (POST .../renew)
spor extend <node-id> <2h|45m> # stretch your live claim for a long idle gap, up to the org max (.../extend)
spor release <node-id>         # hand a task back to the pool, retiring the assigned edge (POST .../release)
spor admin gardener [--json]   # run a gardener sweep now (POST /v1/gardener) — files findings as queue
                               #   items, resolves its own cleared ones; ops-facing (the `spor admin` surface)

# dual-mode (local passthrough / remote dispatch to the server)
spor compile --query "<text>"  # search → compiled neighborhood (--digest for compact)
spor brief <id>                # a briefing for one node (compile --root <id>)
spor analytics --type task,issue      # created-vs-completed metrics (local git history / GET /v1/analytics)
spor changes [--since <sha|date>]     # recent-activity feed: what changed lately (local git log / GET /v1/changes)
spor query --type task --where status=open --ids   # structured node/edge enumeration (local nodes dir / GET /v1/export then query locally)
spor export [--gzip] [--history|--auth] [--out <file>]   # nodes/ ustar tarball (--history: git-bundle data-exit; --auth: admin-gated restore w/ auth files — both remote-only); local build / GET /v1/export

# local (personal graph) only — fail fast with a redirect in remote mode
spor validate                  # lint the local graph (server validates per-write remotely)
spor compile --root <id> --skeleton   # writes a local briefing-node skeleton
```

A few of these have enough surface to be worth a sentence:

- **`spor next --project <token>`** accepts a **repo slug** (resolves *up* to its
  home-project grouping and unions the members — the intuitive token), a
  **`repo-<slug>` node id** (pins that single repo), or a **grouping id
  `proj-<stem>`** (the grouping union). An unknown token warns on stderr and
  yields an empty queue (still exit 0). Pin a default for both modes with the
  `queue.project` config key (`SPOR_QUEUE_PROJECT`, or `.spor.json` `{"queue":
  {"project": "<token>"}}`); an explicit `--project` always wins.
- **`spor query`** is the structured enumeration `get` (one node), `next` (the
  ranked queue) and `compile --query` (semantic search) are not. It AND-combines
  node predicates — `--type <T>` (repeatable), `--where key=value` (repeatable; a
  list field like `tags` matches on membership), `--id-prefix <p>` — and with
  `--edges` emits `{from,type,to}` edges instead, filterable by `--edge-type`,
  `--from <id>` (out-edges) and `--to <id>` (in-edges), e.g. `spor query --edges
  --edge-type grouped-under --to proj-rdi`. Projections: default table, `--ids`,
  `--summary`, `--full`, `--json`. Remote mode runs the same enumeration over the
  TEAM graph (fetched via `GET /v1/export`); use `spor lens` for a saved
  board/table.
- **`spor schema`** is the contract introspection surface
  (norm-cc-registry-is-contract): it renders the LIVE registry — every node and
  edge type with prefixes, weights, ride-along flags
  (`always_on`/`traversable`/`capturable`/`queueable`), the status partition, and
  the attached `validate()`/`transitions()`/`get()` gates — **merging the seed
  pack with graph-resident `type: schema` overrides** and tagging provenance
  (`seed`/`graph`/`native`). `spor schema <type>` details one type; `--source
  seed|graph|native` filters, `--json` is the machine snapshot. Reach for this
  instead of reading `lib/seed/`.
- **`spor analytics`** folds the graph repo's git history into work-flow metrics
  (created vs completed per ISO week, throughput, cycle time, WIP by type,
  oldest-open bottlenecks). Completion time is a node's status-*transition* time
  read from git content history, never `updated_at`
  (dec-spor-git-derived-timestamps). `--project`/`--type`/`--weeks`/`--json`
  scope and shape it.
- **`spor put-node`** is the shell twin of MCP `put_node` / REST `POST
  /v1/nodes`: pass a complete node markdown file, or `-`/stdin. Default
  `--if-exists error` rejects collisions; `--if-exists skip` no-ops on an
  existing id; `--if-exists update` requires the `revision` from `spor get <id>
  --json` so updates are optimistic-concurrency checked instead of last-writer
  wins. Prefer `spor edge`/`spor set-status` for narrow mutations; use
  `put-node` for full-node artifacts such as briefing versions or body edits.
- **`spor compile`/`spor brief`** are mode-aware: local runs the in-repo
  compiler, remote dispatches to the server (this is what `/spor:brief` pulls).
  In local mode add `--project <repo-slug>` to scope to a repo — without it
  `compile --root`/`--query` run *project-blind* and every `always_on` norm rides
  along regardless of `applies_to_*`. `--nodes <dir>` always targets that local
  checkout, even under a server.

The deeper mode-specific flows — the exact REST calls, and the rule that
*completing* a task or issue needs a resolving node on the graph first — live in
the action skills below; reach for those rather than reinventing them.

## MCP tools (Cowork / connector — no shell)

In Cowork (Anthropic's chat workspace) and Claude Code with the connector there
is no shell and no ambient injection — reach the graph through the **Spor MCP
tools** instead: `query_graph` (ORIENT/TRAVERSE: free-text search, or `root_id`
to compile one node's neighborhood), `get_node` (raw node + revision),
`my_queue` (the ranked queue), `render_lens` (a saved board/table/lineage view;
no id lists them), and to COMMIT: `capture` (raw prose → server types it — reach
for this when unsure of the shape), or the precise writes `put_node` /
`add_edge` / `set_status`. Close loops with edges: answer a question with a node
carrying an `answers` edge; close work with a `resolves` edge from a
`decision`/`artifact`.

## Adding a node or edge type

Because schemas are themselves nodes, you extend the ontology by **writing a
node**, not editing code: a `type: schema` node with `kind: node-schema` (or
`edge-schema`), a CalVer `schema_version`, a fenced-JSON payload, and optional
sandboxed `validate`/`transitions`/`queueSignals` functions. A resident schema
overrides its seed equivalent and lives *in your graph* (you don't edit the
plugin's source); the server forces new schemas to `proposed` and a *different*
identity must activate them (no self-approval). It's still a contract change, so
version it with CalVer and keep it backward-readable. Before doing it, read
**`references/authoring-schemas.md`**.

## Which skill do I use

This skill orients and carries the operating reference; these do the work. Route
to them rather than improvising:

| You want to… | Use | Trigger |
|---|---|---|
| First-time setup: identity, mode, join a team graph, "nothing happens" | **/spor:onboard** | installing Spor, creating an identity, "spor isn't doing anything" |
| File deferred / discovered work, a follow-up, a dismissed approach | **/spor:defer** | "remember / file / defer this", work postponed mid-session |
| File a question the graph can't answer, so it routes to whoever knows | **/spor:ask** | the briefing/digest came back empty on something a teammate would know |
| Get a briefing for a task or node before starting | **/spor:brief** | starting non-trivial work; `/spor:brief <query\|id>` |
| See what to work on next | **/spor:next** | "what's next / my queue / the backlog", triage |
| Fix a briefing that was wrong, missing, or stale | **/spor:correct** | "the briefing was wrong / missed / included junk" |
| Bootstrap a repo's graph, or group repos into projects | **/spor:backfill** | onboarding a repo, "organize my repos" |
| Read/write the team graph in Cowork (no hooks there) | **/spor:team-graph** | any graph work in Cowork |

If a request is just "which Spor thing do I use for X", answer from this table.
If it's "how do I get started / set up Spor", that's **/spor:onboard**.

## Read more

- **`references/concepts.md`** — full node/edge registries, node file format,
  project-slug convention.
- **`references/authoring-schemas.md`** — how to add or change a schema.
- **README.md** (architecture, roadmap), **GRAPH.md** (node format + seed
  ontology), **QUEUE.md** (capture, queue, schema registry), **API.md** (the
  MCP + REST contract). All at the plugin root.
