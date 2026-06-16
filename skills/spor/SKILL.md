---
name: spor
description: Load this skill whenever you work with Spor — a project-specific knowledge-graph tool your training does not cover — so you use the right CLI syntax, node and edge format, MCP tools, and REST API instead of rediscovering them each time. Read it before any Spor graph operation — querying or searching the graph, reading or writing nodes, adding edges, capturing or deferring work, running spor CLI commands or Spor MCP tools, working in local vs remote mode, or defining a new node/edge type or schema. Also use it for any conceptual question about Spor (what it is, how it works, the mental model of nodes and edges, what the auto-injected briefing is) and to choose among the /spor commands — defer, brief, next, correct, backfill. When unsure about anything Spor, consult this first rather than guessing.
---

# Orient yourself in Spor

Spor is a typed, versioned **knowledge graph** that holds the durable
outcomes of work — decisions (including the ones that were dismissed, and
why), tasks, issues, norms, specs, questions — one fact per node, joined by
typed edges. It exists because that knowledge otherwise dies in branches, PR
threads, and chat scrollback: the next session starts cold and the team
relitigates settled questions. Spor persists it across sessions and
teammates, indexes it for relevance, **resurfaces deferred work** the moment
a session touches its neighborhood, and keeps dismissed approaches — the "why
we didn't" — retrievable.

Much of the time you don't touch it by hand: in Claude Code, hooks compile a
briefing at session start and a per-prompt digest automatically, and at session
end a distiller writes new nodes back. But when you need to operate on the graph
yourself — query or search it, read or write nodes and edges, run a `spor`
command or a Spor MCP tool, or extend the schema — this skill is your standing
reference, so you use the right syntax, formats, and tools instead of
rediscovering them each time. It also explains the model when you (or the user)
just need to understand Spor, and routes you to the action skills for specific
operations.

## The model in one minute

- **Nodes** are markdown files, one fact each, with a `type` and a kebab-case
  `id` that starts with the type's prefix (`dec-`, `task-`, `issue-`, `norm-`,
  `spec-`/`art-`, `question-`, …). The `summary` line must stand on its own —
  most consumers only ever see it.
- **Edges** are typed and directional, written from the source node's
  perspective: `supersedes`, `blocks`, `resolves`, `derived-from`,
  `constrained-by`, `governed-by`, `decided-in`, `relates-to`, `mentions`, …
  They carry the lineage a flat list can't — *why* a node exists and what it
  depends on. An edge may point at an id that doesn't exist yet; the compiler
  just skips it (a marker that the node is worth creating).
- **The ontology is data you can extend.** Those type and edge tables aren't
  fixed — each type is itself a `type: schema` node (QUEUE.md §2). The seed
  pack shipped in `lib/seed/` is the default set; a schema node you add to a
  graph overrides or extends it, so an org can shape its own ontology.

For the full node-type and edge-type registries, the node file format, and the
project-slug rule, read **`references/concepts.md`**.

## Are you local or remote? (resolve it silently)

Spor runs against your **personal** graph (local mode) or a **team server**
(remote mode). Tell which from the status line injected at session start:
`team graph: …` = remote, `A Spor knowledge graph is active: …` = local. If it
isn't in context, run `spor status` (or test `[ -n "$SPOR_SERVER" ]`). Don't echo
`SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode unless the user
asks — it's plumbing.

What actually differs:

| | local (`SPOR_SERVER` unset) | remote (`SPOR_SERVER` set) |
|---|---|---|
| **the graph** | files under `$SPOR_HOME/nodes/` (default `~/.spor/`) | lives on the server; client caches |
| **writing** | you write the node markdown yourself; the distiller commits it | the server's ingestion model types raw text into nodes; writes are attributed to you |
| **reading** | the `spor` CLI, against your local files | the `spor` CLI, the MCP tools, or their REST twins (API.md §3) |

`spor status` prints the resolved mode, graph home, project, and identity if
you need to confirm. Settings resolve through a cascade (CLI flag > env >
repo `.spor.json` > user/global config > defaults), so when in doubt let
`spor status` report the effective values rather than guessing.

## Reading and writing the graph

Work the graph in a loop: **ORIENT → TRAVERSE → COMMIT**. Find where to start,
walk outward through edges until you have enough context, then write the
outcome back so the next session inherits it.

**The `spor` CLI** is the simplest surface. A few verbs work in either mode;
the rest are mode-specific (`spor status` confirms which mode you're in):

```bash
# either mode
spor status                    # resolved mode, graph, project, identity, health
spor next [--project <slug>]   # the ranked decision queue — "what's next"
spor get <id>                  # one node by id
spor add "<2-3 sentences>"     # capture a node (typed file locally; /v1/capture remotely)

# remote (team server) only
spor lens [<id>]               # list saved views, or render one

# dual-mode (local passthrough / remote dispatch to the server)
spor compile --query "<text>"  # search → compiled neighborhood (--digest for compact)
spor brief <id>                # a briefing for one node (compile --root <id>)

# local (personal graph) only — fail fast with a redirect in remote mode
spor validate                  # lint the local graph (server validates per-write remotely)
spor compile --root <id> --skeleton   # writes a local briefing-node skeleton
spor query --type task --where status=open --ids   # structured node/edge enumeration
```

`spor query` is the local structured enumeration — the deterministic,
predicate-filtered list that `get` (one node), `next` (the ranked queue) and
`compile --query` (semantic search) are not; it is the local-mode primitive
under what remote mode offers as saved `render_lens` views (use `spor lens`
there). It AND-combines node predicates — `--type <T>` (repeatable),
`--where key=value` (repeatable; a list field like `tags` matches on
membership), `--id-prefix <p>` — and with `--edges` emits `{from,type,to}`
edges instead, filterable by `--edge-type`, `--from <id>` (out-edges) and
`--to <id>` (in-edges), e.g. `spor query --edges --edge-type grouped-under
--to proj-rdi` answers "what is grouped under proj-rdi". Projections: default
table, `--ids`, `--summary`, `--full`, `--json`.

`spor next --project <token>` accepts three forms: a **repo slug** (resolves
*up* to its home-project grouping and unions the members — the intuitive token),
a **`repo-<slug>` node id** (pins that single repo — the escape hatch), or a
**grouping id `proj-<stem>`** (the grouping union). An unknown token warns on
stderr and yields an empty queue (it still exits 0). Pin a default scope for both
modes with the `queue.project` config key (`SPOR_QUEUE_PROJECT`, or `.spor.json`
`{"queue": {"project": "<token>"}}`); an explicit `--project` always wins.

`compile`/`brief` are mode-aware: local mode runs the in-repo compiler, remote
mode dispatches to the server (mirroring `/spor:brief`). Much of this is what
the session hooks already inject for you automatically; pulling one on demand
with `spor brief`, `spor compile`, or `/spor:brief` is the same briefing.
Passing `--nodes <dir>` always targets that local checkout, even under a server.
In local mode, add `--project <repo-slug>` to scope to a repo: without it
`compile --root`/`--query` run *project-blind* and the `always_on` norm
ride-along ignores `applies_to_*` scoping (every norm rides along) — pass it to
match what a real session in that repo sees. `/spor:brief` does this for you.

**In Cowork (Anthropic's chat workspace) and Claude Code with the connector**
there is no shell and no ambient injection — reach the graph through the
**Spor MCP tools** instead:
`query_graph` (ORIENT/TRAVERSE: free-text search, or `root_id` to compile one
node's neighborhood), `get_node` (raw node + revision), `my_queue` (the ranked
queue), `render_lens` (a saved board/table/lineage view; no id lists them),
and to COMMIT: `capture` (raw prose → server types it — reach for this when
unsure of the shape), or the precise writes `put_node` / `add_edge` /
`set_status`. Close loops with edges: answer a question with a node carrying an
`answers` edge; close work with a `resolves` edge from a `decision`/`artifact`.

The deeper, mode-specific flows — the exact REST calls, and the rule that
*completing* a task or issue needs a resolving node on the graph first — live
in the action skills below; reach for those rather than reinventing them.

## Adding a node or edge type

Because schemas are themselves nodes, you extend the ontology by **writing a
node**, not editing code: a `type: schema` node with `kind: node-schema` (or
`edge-schema`), a CalVer `schema_version`, a fenced-JSON payload, and optional
sandboxed `validate`/`transitions`/`queueSignals` functions. A resident schema
overrides its seed equivalent; the server forces new schemas to `proposed` and
a *different* identity must activate them (no self-approval).

For an org-specific type, that schema node lives *in your graph* and overrides
the seed default — you don't edit the plugin's source. It's still a contract
change (every node of that type depends on it), so version it with CalVer and
keep it backward-readable. Before doing it, read
**`references/authoring-schemas.md`**.

## Which skill do I use?

This skill orients; these do the work. Route to them rather than improvising:

| You want to… | Use | Trigger |
|---|---|---|
| File deferred / discovered work, a follow-up, a dismissed approach | **/spor:defer** | "remember / file / defer this", work postponed mid-session |
| Get a briefing for a task or node before starting | **/spor:brief** | starting non-trivial work; `/spor:brief <query\|id>` |
| See what to work on next | **/spor:next** | "what's next / my queue / the backlog", triage |
| Fix a briefing that was wrong, missing, or stale | **/spor:correct** | "the briefing was wrong / missed / included junk" |
| Bootstrap a repo's graph, or group repos into projects | **/spor:backfill** | onboarding a repo, "organize my repos" |
| Read/write the team graph in Cowork (no hooks there) | **/spor:team-graph** | any graph work in Cowork |

If a request is just "explain Spor" or "which Spor thing do I use for X",
answer from this skill — in plain language for a newcomer, without dumping the
whole ontology unless asked.

## Read more

- **`references/concepts.md`** — full node/edge registries, node file format,
  project-slug convention.
- **`references/authoring-schemas.md`** — how to add or change a schema.
- **README.md** (architecture, roadmap), **GRAPH.md** (node format + seed
  ontology), **QUEUE.md** (capture, queue, schema registry), **API.md** (the
  MCP + REST contract). All at the plugin root.
