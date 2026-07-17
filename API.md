# Spor server — public API

The contract that adapters, hook engines, and third-party clients program
against. From a client's perspective the Spor server is one org graph behind
two doors: a **REST surface** (`/v1/*`, plain HTTPS + JSON) for deterministic
hook scripts and mechanical writers, and an **MCP surface** (Streamable HTTP
at `/mcp`) for model-driven clients — Cowork, claude.ai connectors,
in-session tool calls. Both doors require bearer auth (§4), are thin adapters
over the same core, and a tool call and its REST twin return byte-identical
payloads. Companion specs: [GRAPH.md](GRAPH.md) (node/edge format),
[QUEUE.md](QUEUE.md) (capture, decision queue, schema registry).

## 1. Write semantics (both surfaces)

Every mutation is validated, attributed, serialized, and committed to the
graph's git repo. What a client sees:

- **Attribution**: the server stamps `author: <identity>` and
  `authored_via: mcp|rest|capture|dispatch` from the authenticated token — any
  `author:` supplied in the payload is discarded. A write under an
  **agent-scoped token** (§4) additionally stamps `authored_by_agent: <agent-id>`
  and `session: <id>` and uses `authored_via: dispatch`, while `author:` stays
  the agent's **owning person** — so the node reads "agent on behalf of person".
  These ride-along fields are token-derived too; any supplied in the payload are
  discarded. The `session` is the agent's REAL run session: `spor dispatch` mints
  the token **session-deferred** (it can't know the session before `claude --bg`
  self-allocates it) and binds the real one post-launch via `POST /v1/agents/session`
  (§3, dec-spor-dispatch-bg-session-late-bind) — so writes BEFORE the bind carry no
  `session` (honest, never a phantom), and writes after trace to the actual run.
- **Create**: `if_exists: "skip"` → id collision is reported as `skipped`
  (the distiller default); `if_exists: "error"` → id collision is a
  `conflict` error.
- **Update**: the caller must send `revision` — the git blob SHA of the
  version it read (returned by `get_node`). Mismatch → `conflict` error with
  the current revision; re-read and retry. No silent last-write-wins.
- **Validation**: id/filename agreement, kebab-case, type prefix, mandatory
  standalone summary, known node type, `date:` format, edge syntax. Failures
  return the validator's error list verbatim so a calling model can
  self-correct. Size limits: body ≤ 8KB, summary ≤ 500 chars, ≤ 40 edges.
- **Edge normalization**: edge types accept canonical names, registry-declared
  **aliases** (renamed in place), and **inverse labels** (the edge read from
  the target's side — `{blocked-by, to: X}` on N is flipped and written to X
  as `{blocks, to: N}`, reported in `warnings`; the target must exist).
  Unknown edge types beyond that vocabulary are rejected, not defaulted.
  Edges to nonexistent ids are allowed on full puts (they mark nodes worth
  creating).
- **Schema gating**: the active schema's `transitions()` gate arbitrates
  updates — a denial is `409 transition_denied` with the schema's reason.
  Schema nodes created through the server are forced to `status: proposed`;
  flipping one `proposed → active` requires an identity different from the
  proposal's last author (the self-approval ban).
- Successful writes return `{status, id, revision, warnings}`
  (`status: created|updated|skipped`).

## 2. MCP surface (`/mcp`)

Streamable HTTP, implemented with the official SDK. All tool results are
returned as both human-readable text content and structured JSON.

The server advertises **`instructions`** (the SDK initialize result, surfaced
by clients as an "MCP Server Instructions" block). It frames the tools
as an **ORIENT → TRAVERSE → COMMIT** loop rather than a flat list of independent
verbs, so an assistant can infer a recursive research chain — e.g. `show_queue`
(or `recent_changes` for "what happened lately") → `query_graph` with `root_id`
(deepen) → `render_lens` on a lineage lens →
`put_node`/`capture` the outcome — instead of reconstructing it from per-tool
descriptions. `query_graph`'s `root_id` is the recursive-deepen move (walk
neighbor → neighbor); `render_lens` lineage lenses trace why a node exists,
and `render_lens` with no `lens_id` returns the lens catalog (the discovery
step before rendering).

**Per-viewer language register** (task-spor-viewer-register-adaptation): when
the authenticated viewer's person node carries a free-text `register:` field
(GRAPH.md "person" — role + preferred language style), the server renders it
on two channels so the host's model adapts how it explains graph content to
that user. (1) The initialize `instructions` gain a trailing **`AUDIENCE`**
section quoting the field; (2) the conversational read tools — `query_graph`,
`get_node`, `explore_graph`, `show_queue` — prepend one line to their TEXT
content: `Audience note — how to communicate with this user: <register>`.
Both channels because host support for instructions is uneven. The preamble
is presentation-only: `structuredContent` is never touched, `isError` results
are exempt, and content is never filtered or reordered by it. The field is
capped at 500 chars on render; agent-scoped identities (dispatch tokens) get
neither channel — the register describes the human reader. Absent the field,
both channels are byte-identical to before.

### `query_graph`

The compiler over the wire. Input:

```json
{
  "query":   "free text — the task, question, or prompt",
  "root_id": "optional node id; overrides query (root-mode compile)",
  "mode":    "digest | full",        // default digest
  "min_sim": 0.08                     // optional; relevance gate
}
```

Output: `{ "found": bool, "text": "<digest or full neighborhood>",
"node_ids": [...], "top_sim": 0.31 }`. `found: false` (gate not met) is a
**successful empty result**, not an error.

### `get_node`

Input `{ "id": "dec-..." }` → full raw markdown, parsed frontmatter, and
`revision` (git blob SHA) for use in updates. Unknown id → not-found error.
**Read-time enrichment** rides along on the same response: the node's active
schema may carry a `get(node, ctx)` hook (GRAPH.md) that attaches derived
context as extra top-level keys — e.g. `resolution` (what answered/resolved
this node). These are additive; a client ignores keys it does not know.

### `explore_graph`

Browse/map the team graph's **structure** — a bounded neighborhood as plain
nodes + typed edges, each node carrying truth flags
(`superseded`/`resolved`/`blocked`) and a count of further unexpanded
neighbors (`more`). Input `{ "root_id"?, "query"?, "depth"?, "limit"? }` → the
view-tree slice (`view`, `node_ids`) plus a text rendering. Call with **no
arguments** for the birds-eye programs overview — every umbrella root (any
node other work `blocks`) with resolution-derived completion %, most complete
first. Pass `root_id` to walk outward from one node (depth 1-2, deterministic,
no LLM; default depth 1, limit 40 capped at 80); pass `query` instead to seed
the roots by relevance. The two are mutually exclusive; `root_id` wins when
both are given, and an unknown `root_id` is an error (`unknown_root`) rather
than an empty result — the same precedence `/v1/digest`'s `root`/`query` pair
uses (§3). Re-call with a neighbor's id as `root_id` to expand the frontier —
the browse/map twin of `query_graph`'s recursive deepen, for structure rather
than compiled digests. In MCP-Apps hosts this renders the
interactive graph navigator (lineage bands, expand/re-root, node inspector);
elsewhere it returns the same slice as text. **MCP-only — no REST twin.**

### `put_node`

Input:

```json
{
  "node":      "<full markdown file content, frontmatter + body>",
  "if_exists": "skip | error | update",   // default error
  "revision":  "<blob sha>"                // required when update
}
```

The server parses, validates, normalizes, stamps attribution (§1), writes,
commits. Output `{ "status": "created|skipped|updated", "id": ...,
"revision": ..., "warnings": [...] }`. Validation failure returns the
validator's error list verbatim.

The tool description **embeds the registry's edge vocabulary** — every
canonical edge type with its schema's one-line description (direction is
written from the source node's perspective) plus the accepted inverse forms.
Generated from the live registry, so an org schema that adds an edge type
changes the description without a deploy.

### `add_edge`

Micro-mutation. Input `{ "id": "<node>", "type": "<edge type>",
"to": "<target>", "attrs"?: { "<k>": "<v>" } }` — accepts canonical, alias, and
inverse forms; inverse forms are flipped onto the target before writing. No
revision echo is needed. Output `{ "status": "updated|skipped",
"id": <node actually modified>, "revision", "warnings" }` (`skipped` = edge
already present — the call is idempotent). Both nodes must exist. The tool
description carries the same registry-generated vocabulary as `put_node`.

The optional `attrs` carries trailing flat edge attributes — the per-assignment
`profile:` override on an `assigned → agent` edge is the motivating case. Values
round-trip only simple `[A-Za-z0-9_-]` tokens (the frontmatter edge grammar);
richer values need `put_node`, and `type`/`to` are reserved. With `attrs`, a
duplicate `(type, to)` becomes an **upsert**: same attributes → still `skipped`;
different attributes → the edge's attribute set is replaced (not merged) in
place. Omitting `attrs` never touches an existing edge's attributes, so a bare
`add_edge` is unchanged.

**Submitting a review is one call.** The review-outcome edges
(`review-requested` / `reviewed-by` / `changes-requested-by`, plus the
`approved-by` approval synonym) are mutually exclusive per `(node, person)` —
the edge type *is* that reviewer's current verdict — so adding one review edge
to a person **flips** any sibling review edge to that same person in place
instead of leaving two contradictory edges. A reviewer thus turns a pending
`review-requested` into `reviewed-by` (or `changes-requested-by`, or back) with
one `add_edge`, no remove-and-re-add or whole-node `put_node`; the flip is
reported in `warnings` (`flipped review-requested -> reviewed-by for <person>`).
This is scoped strictly to the review family — every other edge type keeps the
plain append-or-idempotent behavior above.

### `remove_edge`

Micro-mutation, the withdrawal twin of `add_edge`. Input `{ "id": "<node>",
"type": "<edge type>", "to": "<target>" }` — accepts canonical, alias, and
inverse forms, normalized exactly as `add_edge` (an inverse form removes the
canonical edge on the *other* node and echoes that node's id). Output
`{ "status": "updated|skipped", "id": <node actually modified>, "revision",
"warnings" }`; a missing edge is an idempotent `skipped`, never an error. Use it
when a relationship should simply cease to exist — a *withdrawn* review request
or a *dismissed* review — which the `add_edge` review flip cannot express (the
flip only swaps one verdict for another *within* the family; it never drops an
edge). To change a verdict in place, prefer `add_edge`; reach for `remove_edge`
to withdraw one. The REST twin is `DELETE /v1/nodes/{id}/edges` (§3).

### `set_status`

Micro-mutation. Input `{ "id": "<node>", "status": "<value>" }`. Output
`{ "status": "updated", "id", "revision", "warnings" }`. Denials from the
schema's `transitions()` gate return `transition_denied` with the gate's
reason, exactly as on a full put. set_status on a `type: schema` node is how
a human flips `proposed → active` (it carries the same authority as the
equivalent put).

### `set_priority`

Micro-mutation, the human-override half of the decision queue
(dec-cc-opinionated-queue-blend). Input `{ "id": "<node>", "priority":
"<value>" }`, where `<value>` is `p1` (highest), `p2`, `p3`, or a clearing
form (`none`/`clear`/`""`/`p0`) to remove it. Output `{ "status": "updated",
"id", "revision", "warnings" }`; an unknown value is `invalid_node` with the
allowed list in `details`. Like `set_status` it is a server-side
read-modify-write — no client revision round-trip — and it stamps
`priority_by` (acting identity), `priority_at`, and `priority_via` (the door)
so an agent-set priority is distinguishable from human triage
(issue-cc-priority-attribution-gap). The CLI wrapper is `spor priority <id>
<p1|p2|p3|clear>`.

### `set_readiness`

Micro-mutation, the agent-readiness manual override
(dec-spor-agent-readiness-derived-classification), a verbatim sibling of
`set_priority` above. Input `{ "id": "<node>", "readiness": "<value>" }`,
where `<value>` is `agent` (the ONE hand-settable value of the otherwise
structurally-derived `agent|human|untriaged` classification `rankQueue`
computes) or a clearing form (`none`/`clear`/`""`) to demote the item back off
agent-ready. There is no hand-settable `readiness: human` — human is always
derived structurally (`requires: human`, `assigned → person`, held-task state,
an open neighborhood question) and always wins over the stamp, so a later
human-signal edit still flips a stamped item back. Output `{ "status":
"updated", "id", "revision", "warnings" }`; an unknown value is `invalid_node`
with the allowed value in `details`. Like `set_priority` it is a server-side
read-modify-write — no client revision round-trip — and it stamps
`readiness_by` (acting identity), `readiness_at`, and `readiness_via` (the
door). The CLI wrapper is `spor ready <id> [--needs-input]`.

### `reserve`

The fifth task-lease action (dec-cc-task-resumption-reservation), alongside
`claim`/`renew`/`extend`/`release` — all five share one ephemeral per-node
lease table and one REST route family (`POST /v1/nodes/{id}/<action>`, §3).
Converts your LIVE claim into an owner-exclusive **resumption reservation**
when a session ends cleanly with the task advanced but unfinished: the
heartbeat is dropped, `expires` is re-pointed at a grace-window expiry
(~2 days, tenant policy — a timestamp, not a graph edge), and the durable
`assigned` edge is kept (so a steward/capacity view still reads "reserved by
you"). Input `{ "id": "<task node id you hold a claim on>", "session"? }` →
`{ "ok": true, "status": "reserved", "lease", "grace_window_ms" }`.
`rankQueue` floats a reservation to the top of the owner's queue while
dropping it from teammates' actionable lists. Within the grace window the
reservation still counts as a live lease, so the owner claiming, renewing, or
extending it drops the `reserved` flag and re-establishes a normal Tier-1
heartbeat lease; once the grace window lapses the entry is gone (full pool,
everyone) and `renew`/`extend` return `409 lease_lost` same as any lapsed
lease — only a fresh `claim` picks the task back up. Reserving itself fails
`409 lease_lost` (naming the current holder) if you do not hold a live claim
on the node. The client SessionEnd hook
(task-cc-client-sessionend-reserve-hook) is the intended caller: it holds the
transcript, so it is the one thing that can tell "advanced but unfinished"
(→ reserve) from "finished" (→ release) apart.

### `propose_correction`

Sugar over `put_node` for the correction loop. Input:

```json
{
  "target":   "node id | \"project:<slug>\" | \"global\"",
  "pin":      ["spec-actor-model"],
  "exclude":  ["art-stale-notes"],
  "guidance": "free text injected into compiles for the target",
  "title":    "one line"
}
```

The server generates the `corr-<target>-<n>` id (next free ordinal), builds
the node per GRAPH.md, and routes it through the same write path. `target`
is one of: an existing **node id** (fires when that node is the compile root
or a query-matched seed — query/digest mode included, per
issue-cc-corrections-silent-noop-query-mode); **`project:<slug>`** (fires on
every compile for that project, slug resolved through project aliases); or
**`global`** (every compile, graph-wide). A node-id target must exist; the
`project:`/`global` forms are accepted verbatim. The kernel `compile()`
honors all three when handed `opts.project` (the session slug).

### `capture`

The default write door for sessions and Cowork: raw text in, typed nodes
out. Input:

```json
{
  "text":    "2-3 standalone sentences — the fact, what + why",
  "project": "optional project slug",
  "during":  "optional node id the work was discovered during (provenance)"
}
```

The server-side ingestion model drafts node(s) against the live registry and
the similarity-ranked node index; the deterministic half validates (one
self-correction bounce), normalizes, stamps `authored_via: capture`, and
commits. Output `{ "status": "captured|pending", "node_ids": [...],
"nodes": [...], "summary": "...", "warnings": [...] }`. `pending` means the
text fit no schema (or failed validation twice) and was preserved as a
`cap-…` capture-pending node — ingestion-quality failures never lose text.
Only an unreachable ingestion model is an error (`ingestion_unavailable`).

### `show_queue`

The decision queue (QUEUE.md §4/§5) — the data answer to "show my queue" /
"what's next" / "the backlog". Input `{ "project"?: "slug",
"types"?: ["task"], "exclude_types"?: ["capture-pending"], "assignee"?:
"<person-id>|me", "limit"?: 20,
"offset"?: 0 }` → `{ "items": [{id, title, type, status,
priority, score, signals: {blocking, heat, staleness, age_days}, suggest:
"do|dispatch|blocked|triage|close|approve", why}], "count": N, "offset": 0, "returned_count": N,
"total_count": N, "truncated": false, "next_offset": null, "questions": []
}` — queueable live nodes ranked by the default blend, each with a one-line
*why*. Items already retired by a live inbound resolves/answers edge are
excluded whatever their status field reads; open gardener findings ride
along per item as `findings`, capture-pending triage as `pending`, questions
you asked as `asked`, and nodes whose review is requested of you as `reviews`
(an open `review-requested` edge to your person node — the reviewer-facing
twin of `questions`, surfaced through the same per-person routing filter;
respond by flipping the edge to `reviewed-by` or `changes-requested-by`).
Structured output additionally carries `view` — the queue projected into the
view-tree catalog for the MCP-app widget (below).

**Limit and pagination.** `limit` is the page size (default 20, **max
100** — values above the max are clamped, not rejected); `offset` skips that
many items in the ranked order before the page (default 0). The aggregate
counts (`counts_by_type` / `_project` / `_suggest`, `total_count`) always
cover the **full** ranked set regardless of the page, so a single call
answers "how many issues vs tasks" without paging or project-splitting.
`returned_count` is the size of this page, `truncated` is true when more
items follow it, and `next_offset` is the offset to pass next to continue
(null on the last page). Pagination is **offset over a point-in-time ranked
slice, not a cursor**: the queue re-ranks on every call (heat, age, leases,
and status all shift), so an offset resumes the same slice only if the
ranking has not changed between calls — the benign failure mode is an item
seen twice or skipped once across a re-rank, never a hard error. Walk the
whole queue by re-calling with `offset = next_offset` until `next_offset` is
null.

**Node-type filter** (task-cc-queue-filtering-enhancements). `types` keeps only
those node types in the ranking (a whitelist); `exclude_types` drops them (a
blacklist). Given both, the include set is narrowed and then the excludes are
removed from it (exclude wins on overlap). Like `project`/`assignee` this is a
hard scope filter applied **before** scoring, so a filtered-out node is simply
out of scope — the `counts_*`/`total_count` aggregates describe the filtered
queue, not what the firehose hid. The type compared is the type the item
surfaces as, so `exclude_types: ["schema"]` also hides schema-approval items.
Omitting both (or passing empty arrays) filters nothing.

**Per-person scope** (task-cc-queue-assignee-filtering). `assignee` scopes the
ranked queue to the work one person carries — the union of nodes with an
`assigned` edge to them and the nodes they `steward`; `assignee: "me"` binds
to the caller (QUEUE.md §4). This is a **narrower carrying view**, not the
queue: for the ordinary "my queue" / "what's next" answer, omit `assignee`
entirely — pass it only when the caller explicitly asks for directly
assigned or stewarded work.

### `render_queue`

The widget twin of `show_queue`: same input, same queue, but this tool
declares the view-tree UI resource (below) so an MCP-Apps host reliably
attaches the interactive queue widget. Semantics, ranking, filters, and
pagination match `show_queue` exactly — it exists only to make widget
attachment an explicit choice; `show_queue` remains the data-oriented
queue tool for hosts (and turns) that just need the answer.

### `ask_question`

File a question the graph could not answer. Input `{ "text": "<the
question>", "title"?: "<short title>", "mentions"?: ["<node id>", ...],
"project"?: "<slug>" }` (routing considers `mentions` first). The question
becomes a durable node, deterministically routed to the steward of the closest
relevant node (unrouted if none matches), and joins the decision queue until
answered. Answer by writing a node with an `answers` edge to the question.

By default the question's project is derived from its relevance neighborhood
(its `mentions`, then the compiler's picks), falling back to the asker's home
project. An explicit `project` overrides that derivation — pass it for a
mention-less question whose neighborhood would otherwise yield nothing (a
dispatched background agent injects its session project here, since the
launcher environment never reaches it).

### `run_workflow`

Start a run of an ACTIVE workflow by hand. Input
`{ "workflow_id": "wf-...", "inputs"?: {...} }`. Creates a workflow-run node
with lineage and returns the run id and its initial step states. The
workflow must already be active (a proposed workflow must be activated by a
different identity first — the self-approval ban). This tool only starts the
run; workers then claim ready steps over the REST claim API (§3.1). It never
executes effects.

### `render_lens`

Run a saved lens — a `type: lens` node (schema-lens) — against the live
graph. Input `{ "lens_id": "lens-...", "params"?: {"project": "wf", "focus":
"<node-id>", ...} }` → `{ "found": true, "lens_id", "count", "view",
"node_ids" }`, where `view` is the plain-JSON view tree
(view/list/group/item/tree/table/text catalog) and the text content is its
terminal rendering for the model.

`lens_id` is **optional**: call with no `lens_id` to get the lens catalog —
a successful `{ "found": true, "catalog": [{"id", "title"}], "lenses": [...],
"count" }` listing every available lens (the discovery step before you
render). Unknown `lens_id` still errors, carrying the same `catalog`/`lenses`
list; engine failures (missing param, broken blocks) error with the message
verbatim.

### `render_program`

The program/progress view over `blocks` topology — the birds-eye "where do we
stand" for a large workstream, auto-derived on demand with no lens authoring.
Input `{ "id": "<root-node-id>", "max_depth"?, "max_nodes"? }` → `{ "found":
true, "root_id", "progress": {"total", "done", "active", "blocked", "open",
"pct", "statuses"}, "count", "truncated"?, "view", "node_ids" }`. Given a root
node (an umbrella task, a milestone — anything other work `blocks`), the
server walks its gating tree — every node that blocks it, transitively over
inbound `blocks` edges — and derives each node's bucket from the same truth
the queue uses: terminal statuses, supersession, and live `resolves`/`answers`
edges count as **done** (even while the status field lags — the effective
status then reads `resolved` with a `resolved_by` ride-along); a node gated by
its own live unresolved blockers is **blocked**; live unblocked work splits
**active** vs **open**. `view` is the standard view tree (`as: "tree"` with an
additive `progress` block); the text content is a progress-bar header plus the
glyphed gating tree. Shared blockers render once and repeat as `repeat: true`
leaves (counted once); `max_depth`/`max_nodes` caps count skipped branches
into `truncated`, never silently. A root nothing blocks is a successful empty
result whose prose says how to model the program (add `blocks` edges from the
gating tasks). Unknown `id` errors with `{ "found": false, "error":
"unknown_root" }`. The REST twin is `GET /v1/program/{id}` (§3).

### `apply_lens_action`

App-only execution door for one declarative action on a saved lens's rendered
item — visible only to MCP-Apps hosts (`_meta.ui.visibility: ["app"]`), not a
tool a model calls directly. Input `{ "lens_id", "action_id", "target_id",
"params"? }`. The server re-runs the lens, verifies the target and action are
still eligible, resolves authenticated-viewer parameter bindings, and passes
the scalar update through the target node's schema `validate()`/`transitions()`
gate — the same write discipline as `set_status`, reached through a lens's
declarative action instead of a direct mutation call. **MCP-only — no REST
twin.**

### `recent_changes`

The team's recent-activity feed — the temporal entry point the other read
tools lack (`query_graph` is semantic search, `show_queue` is forward-looking
open work, `render_lens` renders current state). It answers "what changed /
what was done in the last N hours", "what did the agents write overnight", and
"what landed since `<commit>`". Input `{ "since"?, "project"?, "limit"? }` →
`{ "changes": [{id, change, commit, date, committed_by, type, title,
authored_via, author}], "count", "head", "since", "project", "generated_at",
"node_ids" }`. `since` is a 7–40 hex commit sha (changes in `sha..HEAD`) or a
date/relative phrase git understands (`"12 hours ago"`, `"2026-06-15"`);
omitted, it returns the most recent changes. `project` scopes to one project's
nodes (deletions, whose project is gone, are necessarily omitted when scoped).
Each entry is decorated with the node's CURRENT `authored_via`
(`capture`/`distill`/`gardener` = machine, else human) — the trust signal the
rendered digest/briefing hides. The tool returns the changed nodes as data;
the model writes the prose summary (no LLM on this path). It is the MCP twin of
`GET /v1/changes` (§3), sharing one core so the two surfaces never drift.

### `analytics`

Work-flow analytics over the team graph — the created-vs-completed view a
remote/Cowork teammate cannot get from the local-only `spor analytics` (which
folds a LOCAL graph repo's git history). Input `{ "project"?, "types"?,
"weeks"?, "top"?, "aging"? }` → the rendered report text plus the structured
report `{window, weekly, totals, throughput, cycleTimeDays, wip, bottlenecks,
coverage}`: weekly cohorts (created / completed / net / open backlog),
throughput, cycle-time median and p90, current WIP by node type, and the
oldest-open bottlenecks. **Completion is a node's status-TRANSITION time** (when
it entered its final terminal run), never `updated_at`, so a later edge append
can't corrupt the "completed last week" signal (dec-spor-git-derived-timestamps).
`project` (a repo slug or grouping id) scopes it through the same up-resolution
as `show_queue`; `types` restricts node types; `weeks`/`top`/`aging` shape the
window. The MCP twin of `GET /v1/analytics` (§3) over the same `store.analytics`
core — for the shell-less Cowork audience that can't run the CLI.

### `schema`

Introspect the live schema registry — the contract as data
(task-spor-schema-introspection-surface; server half
task-spor-server-schema-endpoint). Input `{ "type"?, "code"? }`. With no `type`
it returns the full snapshot (the same shape as `GET /v1/schema`: `node_types`,
`edge_types`, `queue_policy`, `policies`, `registers`, `default_edge_weight`,
`stale_overrides`, `alias_collisions`), the seed pack merged with graph-resident
`type: schema` overrides and each entry tagged by `source`
(`seed`/`graph`/`native`). With `type` it returns just that node/edge type's
entry. `code: true` embeds each `validate()`/`transitions()`/`get()` hook's
source. The MCP twin of the `spor schema` CLI and `GET /v1/schema`, sharing one
`graph.registry.snapshot()` core. Read this instead of reverse-engineering the
contract from `lib/seed/` files — those miss resident overrides
(norm-cc-registry-is-contract).

### The MCP-app widget (`ui://spor/view-tree.html`)

`render_queue`, `render_lens`, and `render_program` declare a UI resource via
`_meta.ui.resourceUri`: a single trusted interpreter of the view-tree
component catalog that MCP-apps hosts (Claude, Goose, VS Code) render as an
interactive iframe — status chips, progress bars, lineage trees, node detail
on click (`callServerTool(get_node)`, no model round-trip), and
conversational affordances (`sendMessage`) for queue items. Strictly
additive: hosts without the apps surface ignore `_meta.ui` and show the text
content. Write-path actions are not emitted; writes stay with the tools
above.

`hello_mcp_app` is the minimal debug twin: a no-input, no-op tool that
renders a tiny hello-world widget, used only to check whether a host can
mount an MCP app resource for the Spor connector at all — it intentionally
bypasses the queue view-tree renderer and carries no graph semantics of its
own. **MCP-only — no REST twin.**

## 3. REST surface (`/v1/*`)

Plain HTTPS + JSON, bearer auth on every route, versioned under `/v1/`. Each
endpoint is the REST twin of a core call:

| Endpoint | Typical caller | Semantics |
|---|---|---|
| `GET /v1/status` | session-start, monitoring | `{node_count, projects: {...}, head, uptime, metrics}`; doubles as the health check. `?titles=1` adds `titles: [{id, type, project, title}]` — the one-round-trip graph index the distiller dedups against |
| `GET /v1/schema` | `spor schema`, agents introspecting the contract | the live schema registry as data (task-spor-schema-introspection-surface; server half task-spor-server-schema-endpoint): `{default_edge_weight, node_types: [{type, description, prefix, always_on, traversable, capturable, queueable, non_resolving, hooks, schema_id, schema_version, source}], edge_types: [{type, description, weight, weight_default, inverse_label, aliases, capturable, hooks, ...}], queue_policy, policies, registers, stale_overrides, alias_collisions}` — the seed pack MERGED with graph-resident `type: schema` overrides, each entry tagged by `source` (`seed`/`graph`/`native`) and the active schema node's id+version. `?code=1` embeds each hook's source under `code: {name: src}` (omitted by default to keep the response lean). The registry IS the contract (norm-cc-registry-is-contract); this read surface closes the failure mode of agents reverse-engineering it from `lib/seed/` files (which miss resident overrides). The REST/MCP twin of the `spor schema` CLI: all three render one `graph.registry.snapshot()` so they never drift |
| `GET /v1/me` | `spor whoami`/`status`, onboarding | identity echo for the bearer token → `{person, name, email, bound, is_admin, org}`. `bound:false` means the token authenticates but maps to **no person node** (legacy/OAuth, or minted before the node existed), so routed questions and the personal queue will be empty — the client warns on it (the silent identity-degradation signal). `is_admin` reflects the `stewards→root` edge that gates the token-admin surface. `org` is the slug this tenant routes to (`SPOR_ORG`/legacy `SUBSTRATE_ORG`, else `"local"`); it lets a client key its `(issuer, org)` credential store for an **opaque** `spor_oat_`/`spor_pat_` token that carries no readable `org` claim — the client falls back to it after `--org` and the JWT `org` claim (task-spor-frontdoor-me-org-echo). A connector JWT's `org` claim is enforced equal to this echo |
| `GET /v1/me/org-choices` | `spor auth list` (live membership refresh) | re-queries the IdP's *current* org membership for the held credential's subject and returns `{org_choices: [{slug, label, default?}], source: "idp"\|"bound"}` — `source:"idp"` is a true live enumeration (orgs added/removed since the last login surface without re-authenticating); `source:"bound"` means a single org-scoped token the server couldn't expand (no enumeration). The client treats only `source:"idp"` as live and **fails open** to its cached tenant listing on anything else — `source:"bound"`, a `502 {error.code:"membership_requery_failed"}` (IdP unreachable), a `404` (older server without the endpoint), or any transport/parse error (task-spor-cli-auth-list-live-membership-requery; server half task-spor-frontdoor-held-credential-membership-requery) |
| `GET /v1/me/tokens` | `spor token list` | list the caller's OWN personal access tokens → `{tokens: [{hash_prefix, person, label, name, email, created, expires, expired, last_used}], count}` — caller-scoped (only their person-bound PATs; agent session tokens excluded), never plaintext, never full hashes. `403 forbidden` if the bearer maps to **no person node** (you need a bound identity to own a PAT). The self-serve, no-admin twin of `GET /v1/admin/tokens` below (task-spor-app-me-tokens-self-serve) |
| `POST /v1/me/tokens` `{expires?, label?}` | `spor token create` | mint a human-identity `spor_pat_` PAT bound to the CALLER's own person → 201 `{token, hash_prefix, person, name, email, label, expires}`; the plaintext `token` is returned **once**. `expires` is `<N>d` or an ISO date, user-set, defaulting to and **capped at 1 year** (a past date or beyond-cap is `422`, rejected not silently clamped); `label` is an optional ≤200-char note surfaced in the listing. `403` if unbound. The self-serve mint twin of admin `POST /v1/admin/tokens` (which binds someone *else*) |
| `DELETE /v1/me/tokens/{hash-prefix}` | `spor token revoke` | revoke one of the caller's OWN PATs by hash prefix → `{revoked, hash_prefix, oauth_grants_revoked}`; a prefix that isn't one of the caller's is `404` (never another person's token). `403` if unbound. Shares the admin revoke's OAuth-grant cascade-completeness invariant (issue-cc-pat-revoke-cascades-all-oauth-grants) |
| `GET /v1/briefing/{project}` | session-start | read the `brief-<project>` node → `{found, version, body, project_brief?, graph_status}`. The slug resolves through project-node aliases (GRAPH.md "Project identity nodes") before lookup. A BARE repo slug also rides up to its home-project grouping: the grouping's `brief-<grouping>` node returns alongside as `project_brief` (the product context spanning sibling repos), matching the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping); passing the repo NODE id (`repo-<slug>`) is the escape hatch that returns only the repo brief, no `project_brief`. Optional `?fp=root:<sha>,remote:<host/path>,...` carries the repo's fingerprints: the server learns them onto the owning project node, and an unknown slug with a known fingerprint files an alias proposal in the queue |
| `POST /v1/digest` `{query, root?, project?, min_sim?}` | prompt-context, /spor:brief | digest-mode compile → `{found, text}`; `found: false` is a successful empty result. `root` is the structural-walk twin of `query` (the two are mutually exclusive; `root` wins, an unknown id is `422`). Optional `project` is the session slug: the server scopes the compile to it — the same-project relevance boost, the grouping union, and the `always_on` norm `applies_to_*` ride-along — resolving the slug through project-node aliases/groupings inside compile (dec-spor-queue-slug-resolves-to-grouping), exactly as `/v1/queue` does. A bad slug is `422`; **omitting `project` runs the digest project-blind (byte-identical to before)**, so older clients that send only `{query}` are unaffected |
| `GET /v1/nodes/{id}` | /spor:brief | `get_node` semantics; the node's active schema may attach read-time enrichment via a `get(node, ctx)` hook (GRAPH.md) — the seed `question`/`issue`/`task`/`incident` schemas attach `resolution`: a live inbound resolves/answers edge carrying the resolver's `summary`/`title` and a `lagging` flag (set when it contradicts a still-open status, clear when the node is already terminal, e.g. an answered question pointing at its answer). Open gardener findings about the node ride along as `open_findings`, and a node marked stale by an inbound supersedes edge as `superseded_by`. All enrichment is additive top-level keys; ignore unknown ones |
| `GET /v1/nodes/{id}/history?limit=N` | `spor history <id>`, the `node_history` MCP tool | per-node commit lineage — a `git log` projection over `nodes/{id}.md` → `{id, head, count, history: [{sha, short, actor, actor_name, actor_email, date, message, internal, person}]}`, newest first. Each revision is labeled `internal:true` for a server-internal write (boot reconcile / migration, `server@spor.invalid`) vs. a real actor, and mapped to its `person` node by author email. Deliberately NOT `git log --follow` (node files share heavy frontmatter boilerplate, so similarity-based rename detection crosses node boundaries — dec-spor-node-history-git-log-projection). `limit` defaults to 50, max 200. The frontmatter `author` re-stamps to the LAST editor on every write, so this is the only durable record of the full chain of editors. A node with no commit history (unknown id) is `404`; a bad id is `422`. The `spor history <id>` CLI verb is the shell front-door (remote reads this; local mode runs the same projection over the graph home) |
| `GET /v1/nodes/{id}/history/{sha}` | `spor history <id> <sha>`, `node_history` (sha mode) | one revision's detail, the expensive half gated behind an explicit per-sha fetch → the history record for that commit plus `{change, patch, content}`: the change type (`A`/`M`/`D`/`R`), the patch this commit introduced to the node file, and the full node content at that revision (`null` when the commit deleted it). The `sha` must be one from the node's own history — a sha that didn't touch the node, or an unresolvable sha, is `404`; a malformed sha is `422` |
| `POST /v1/nodes` | `spor put-node`, drain-outbox, mechanical writers | `put_node` semantics, batch: `{nodes: [...], if_exists: "skip"}` (entries may be raw strings or `{node, if_exists, revision}`) → `{results: [...]}`, 207 when any entry failed. Entries are applied **sequentially** and each is fully validated before the next — including the completion-resolver gate that runs on create (GRAPH.md "the resolver gate") — so a born-terminal node (`done` task / `resolved` issue) must have its resolving `decision`/`artifact` EARLIER in the same batch (**resolver-first ordering**; the batch does not defer the gate to end-of-batch, dec-spor-batch-create-gate-resolver-first-ordering). The 207 is partial-success: entries already applied before a later entry's failure are not rolled back |
| `POST /v1/nodes/{id}/edges` `{type, to, attrs?}` | scripts, mechanical writers | `add_edge` semantics (§1): normalize/flip, dedupe, append — no revision echo. Optional `attrs` adds trailing flat edge attributes (e.g. a per-assignment `profile:` override); re-adding the same edge with different attrs upserts the set. Adding a review-outcome edge (`reviewed-by`/`changes-requested-by`/`review-requested`) flips a sibling review edge to the same person in place — the one-call submit-review primitive |
| `DELETE /v1/nodes/{id}/edges` `{type, to}` | scripts, mechanical writers | `remove_edge` semantics (§1): the withdrawal twin of the POST above — drop one typed edge by `{type, to}`, normalize/flip exactly as `add_edge` (an inverse form removes the canonical edge on the *other* node and echoes its id), no revision echo. A missing edge is an idempotent `skipped`. For *withdrawing* a relationship the review flip can't express — a pulled review request, a dismissed review |
| `POST /v1/nodes/{id}/status` `{status}` | scripts, mechanical writers | `set_status` semantics (§1): one-scalar update through the `transitions()` gate. Setting a work node to an in-progress status also CLAIMS it (same lease as `/claim` below) |
| `POST /v1/nodes/{id}/priority` `{priority}` | `spor priority`, queue triage | `set_priority` semantics (§1): one-scalar human-override update — `p1`/`p2`/`p3` or a clearing form (`none`/`clear`/`""`/`p0`). Server-side read-modify-write (no revision), stamping `priority_by`/`priority_at`/`priority_via` for the audit trail (issue-cc-priority-attribution-gap). Unknown value → `invalid_node` with the allowed list |
| `POST /v1/nodes/{id}/readiness` `{readiness}` | `spor ready`, triage make-ready pass | `set_readiness` semantics (§1): one-scalar agent-readiness override — `agent` or a clearing form (`none`/`clear`/`""`) to demote back to derived. No hand-settable `human` value (always structurally derived, always wins). Server-side read-modify-write (no revision), stamping `readiness_by`/`readiness_at`/`readiness_via`. Unknown value → `invalid_node` with the allowed value |
| `POST /v1/nodes/{id}/claim` `{session?}` | `claim`/`set_status` MCP tools, `spor claim` CLI, `spor dispatch` | take the heartbeat-renewed lease (dec-cc-task-claim-lease): writes the durable `assigned` edge once, attributes to `$viewer` from the token (never an argument), and creates the ephemeral lease → `{ok, status, lease: {node_id, by, expires, expires_at, session, claimed_at}, edge}`. A live lease held by ANOTHER person is `409 conflict` naming the holder + expiry (re-claiming your OWN live claim just renews it). `session` scopes the heartbeat (omit to leave it person-scoped, so any of the claimer's sessions may renew — what `spor claim` and `spor dispatch` do, since `claude --bg` self-allocates the run session only at launch; dispatch then renews with the real session once it has read it from `claude agents --json`, dec-spor-dispatch-bg-session-late-bind) |
| `POST /v1/nodes/{id}/renew` `{session?}` | post-tool heartbeat, `renew` MCP tool, `spor renew` CLI, `spor dispatch` | bump the live lease's expiry only — no commit; the heartbeat that keeps a claim from lapsing. A lapsed/stolen lease is `409` (names the current holder). Person-scoped: any of the claimer's sessions may renew; a `session` binds the lease to that run (`spor dispatch` uses this to bind the captured `claude --bg` session post-launch) |
| `POST /v1/nodes/{id}/extend` `{ms, session?}` | `extend` MCP tool, `spor extend` CLI | manually stretch your live lease by `ms` milliseconds for a known long idle gap → `{ok, status, lease, capped_to_max?, claim_ttl_max_ms?}`. Bounded by the tenant's `claim_ttl_max` policy (a request past the ceiling caps to it, flagged `capped_to_max`); never shortens a lease. `ms` must be a positive number (`spor extend <id> <2h|45m|…>` parses the human duration client-side). A lapsed/stolen lease is `409 lease_lost` naming the holder |
| `POST /v1/nodes/{id}/release` | `release` MCP tool, `spor release` CLI | drop the lease AND retire the durable `assigned` edge, returning the node to the pool. Idempotent (releasing a node you hold no lease on still succeeds, cleaning up any lingering `assigned` edge of yours); releasing a claim someone else holds is `409` naming the holder |
| `POST /v1/nodes/{id}/reserve` `{session?}` | `reserve` MCP tool, client SessionEnd hook (task-cc-client-sessionend-reserve-hook) | convert your live claim into an owner-exclusive resumption reservation (dec-cc-task-resumption-reservation) when a session ends cleanly with the task advanced but unfinished → `{ok, status: "reserved", lease, grace_window_ms}`. Drops the heartbeat, re-points `expires` at a grace-window expiry (~2 days, tenant policy — a timestamp, not a graph edge), and keeps the durable `assigned` edge so a steward view still reads "reserved by you"; `rankQueue` floats it to the top of the owner's queue while dropping it from teammates' actionable lists until the grace window lapses (full pool, everyone) or the owner claims/renews/extends it within that window (drops the `reserved` flag, back to a normal heartbeat lease). `409 lease_lost` (naming the holder) if you do not hold a live claim |
| `POST /v1/nodes/{id}/commits` `{repo, sha}` | post-tool / link-commits | `link_commit`: append `repo@sha` to the node's `commits:` list (kebab-case repo slug, 7–40 lowercase hex, ≤40 commits per node); idempotent, prefix-aware dedup |
| `GET /v1/commits/{sha}?repo=` | `spor blame`/`commits` CLI verb; sessions doing git archaeology | sha → nodes lookup over the `commits:` fields (≥7 hex, abbreviated or full); each match carries `{repo, sha, id, type, title, summary, status, project}` — blame a line, get the why. The `spor blame <sha> [--repo <slug>]` CLI verb (alias `spor commits <sha>`) wraps this remotely and runs the same lookup over the local graph in local mode (`lib/query.js` `lookupCommit`) |
| `GET /v1/changes?since=&project=&limit=` | `recent_changes`'s REST twin; audit review | the remote audit trail: a git-log projection over `nodes/` → `{changes: [{id, change, commit, date, committed_by, type, title, authored_via, author}], count, head, since, generated_at}`, newest change per node first. `since` is a 7–40 hex sha (`sha..HEAD`) or a date/relative phrase git understands (`--since`); an unresolvable sha is `422`. `project` scopes to one project's nodes (deletions are omitted when scoped, their project being gone). `limit` bounds nodes returned (default 100, **max 500**). Each entry's `authored_via` is the current machine-vs-human signal (`capture`/`distill`/`gardener` = machine). Lets a remote client review what agents wrote without the whole `/v1/export` tarball |
| `POST /v1/capture` | distill, /spor:defer | `capture` semantics: `{text, context: {project, project_explicit?, during, blocks?, needed_by?}, source?, idempotency_key?}` → ingestion model + validate + commit → `{status, ids, nodes, summary, warnings}`. `source: "distill"` marks backstop captures in the journal. `idempotency_key` (client-generated; equivalently the `Idempotency-Key` header) guards the whole capture against the timeout-then-server-completes race (issue-cc-capture-transport-idempotency): a key the server has already seen returns the original result instead of re-ingesting, so a client that aborted at its read timeout but landed server-side does NOT double-write when the spooled body is replayed by `spor drain`. The client puts the key in the BODY so the verbatim outbox replay carries it for free (issue-spor-add-cli-duplicate-on-timeout-drain). `context.blocks` (a node id, must exist) and `context.needed_by` (`YYYY-MM-DD`) declare a cross-project dependency (task-cc-xproject-dependency-loop): set `context.project` to the SERVING project and the server attaches a `blocks` edge to the requester + the deadline deterministically (not via the model) onto the primary node. A missing `blocks` target is `404`; a non-date `needed_by` is `422` — both rejected before any model call. `context.project_explicit` (additive boolean, task-spor-thread-explicit-project-flag) distinguishes a user-declared `context.project` from an ambient cwd default: only a literal `false` silences the fold-mismatch warning on a cross-project capture; **absent means explicit** (old-client back-compat, so a pre-flag client keeps today's warn-on-mismatch behavior) |
| `POST /v1/distill/report` | distill | sweep telemetry, journal-only (no store mutation): `{facts, captured?, spooled?, rejected?, project?, session?}` → `{status: "reported"}`; zero-fact sweeps report too |
| `POST /v1/corrections` | /spor:correct | `propose_correction` semantics → 201 `{status, id, revision, warnings}` |
| `GET /v1/queue?project=&assignee=&type=&exclude_type=&limit=&offset=` | /spor:next, session-start | the ranked decision queue: `{items, count, offset, returned_count, total_count, truncated, next_offset, counts_by_type, counts_by_project, counts_by_suggest, muted?, dormant?, questions, asked, findings, pending, reviews, policy?, generated_at}` — items retired by a live resolves/answers edge are excluded; items hidden by the viewer's `queue_mute` or parked by a future `wake:` date (QUEUE.md §4) are counted, never silently dropped; `questions`/`findings`/`pending` are the routed-to-me-plus-unrouted views for the authenticated identity, `asked` is the questions you filed, and `reviews` is the nodes whose review is requested of you (an open `review-requested` edge to your person node — explicitly targeted, no unrouted fallback). `limit` is the page size (default 20, **max 100**, clamped not rejected) and `offset` skips that many items in the ranked order (default 0); the `counts_*`/`total_count` aggregates always cover the FULL ranked set regardless of the page, so one call answers "how many issues vs tasks" without paging, while `truncated`/`next_offset` let a client walk the rest by re-requesting with `offset=next_offset` until `next_offset` is null. Pagination is offset over a point-in-time ranked slice (the queue re-ranks every call), not a cursor — it resumes the same slice only across an unchanged ranking. `project` resolves through the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping): a bare repo slug unions its home-project grouping's member queues, the repo NODE id (`repo-<slug>`) pins one repo, a grouping id (`proj-<slug>`) is used directly; **omitting `project` is the cross-project firehose** (every repo's queue at once). `assignee=<person-id>` scopes to the work that person carries (their `assigned`/`stewards` edges) — a manager's "who is carrying what"; `assignee=me` binds to the caller (empty if the token maps to no person node). `type=`/`exclude_type=` (comma-separated, repeatable) whitelist/blacklist node types from the ranking (exclude wins on overlap) — a hard scope filter applied before scoring, so the aggregates describe the filtered queue (task-cc-queue-filtering-enhancements) |
| `GET /v1/analytics?project=&type=&weeks=&top=&aging=&format=` | remote `spor analytics`, the `analytics` MCP tool | work-flow analytics — the SERVER twin of the local-only `spor analytics` consumer, for a remote/Cowork teammate with no local graph repo to fold (task-spor-server-analytics-surface): created-vs-completed weekly cohorts, throughput, cycle-time median/p90, current WIP by node type, and the oldest-open bottlenecks, computed by the pure analytics kernel over the resident graph + a HEAD-keyed status-transition fold. **Completion is a node's status-TRANSITION time** (when it entered its final terminal run, from git content history), never `updated_at`, so a later edge append can't corrupt the "completed last week" signal (dec-spor-git-derived-timestamps). Default returns the machine (JSON) report `{window, weekly, totals, throughput, cycleTimeDays, wip, bottlenecks, coverage}`; `?format=text` renders the human report. `project` resolves through the shared up-resolution like `/v1/queue` (bare repo slug → grouping union; `repo-<slug>`/`proj-<slug>` id pins) — a zero-match scope rides back as the additive `project_warning` field (text mode prefixes a `# ` line). `type=` (comma-separated, repeatable) restricts node types; `weeks`/`top`/`aging` shape the window (clamped 1–52 / 1–100 / 1–365). A bad slug/type is `422`. The remote arm of `spor analytics` fetches the JSON and renders it with the SAME `renderReport` the local consumer uses, so remote and local output match (norm-spor-cli-mode-parity, task-spor-analytics-remote-cli-dispatch) |
| `GET /v1/metrics/capture?since=` | the cross-author capture-discipline eval harvest (task-spor-tenant-capture-metrics-export) | capture-discipline aggregates for an **opted-in** deployment — the same kernel the dogfood CLI runs (`lib-engine/kernel/capture-metrics.js`), computed server-side over the resident graph plus the FULL request journal (every rotated `server.log` segment). Three gates stack (dec-spor-tenant-metrics-aggregates-only): the per-machine opt-in env `SPOR_METRICS_EXPORT` (unset → the route 404s, so a never-opted tenant shows no surface), admin auth (stewards→root, 403), and **unconditional redaction** — the body carries counts/rates only: by-identity keys are stable per-tenant pseudonyms (`author-<hash12>`, salted at `cache/metrics-salt` so per-author trends survive across windows), closure entries keep `{edge, latency_days}` but drop node ids, and id lists reduce to `open_count`/`slug_smell_count`. No journal lines, node bodies, or capture prose ever exit. `?since=YYYY-MM-DD` bounds the window (malformed → `422`) |
| `POST /v1/questions` `{text, title?, mentions?, project?}` | ask_question's REST twin | file a question node; deterministically routed to the steward of the closest relevance-neighborhood node, unrouted if none → 201 `{status, id, project, routed_to, via, asker, revision, warnings}`. `project` is derived from the relevance neighborhood (then the asker's home project) unless an explicit `project` slug overrides it — pass that for a mention-less question (a dispatched agent injects its session project); a malformed slug → 400 |
| `POST /v1/gardener` | ops cron / on demand; `spor admin gardener` | run a gardener sweep now; findings filed as queue items → `{checked, filed, resolved, skipped, generated_at}` (`filed`/`resolved`/`skipped` are id lists, `checked` a count). The `spor admin gardener [--json]` CLI verb is the shell front-door (remote-only — the server owns the gardener); authenticated but **not** admin-gated server-side today (unlike `/v1/backup`), so any valid team token can trigger it — the verb still surfaces a 403 as an admin-privilege (stewards→root) hint for a deployment that adds the gate |
| `GET /v1/program/{id}?format=json\|text&depth=&max_nodes=` | program oversight, /spor:brief follow-ups | the program/progress view (`render_program`'s REST twin, one kernel behind both doors): the gating tree of everything that `blocks` `{id}` transitively, with resolution-derived progress (`{progress: {total, done, active, blocked, open, pct, statuses}}` on the view root; done = terminal status / supersession / live resolves-answers edge, exactly the queue's truth). JSON view tree by default, `?format=text` for the terminal rendering; `depth`/`max_nodes` bound expansion and count skipped branches into `truncated`, never silently. 404 for an unknown id |
| `GET /v1/lens/{id}/render?format=html\|text\|json` | browsers, teammates without a checkout | run a lens OR workspace node and render its view tree (html default, plain text, or the raw tree as json). Read-only — no action forms; writes stay with `/v1/nodes` and the MCP tools. Auth is the caller's bearer header OR a signed read-only **render ticket** for shared links (browser links can't carry an Authorization header): `?ticket=<blob>` is accepted once and exchanged via a 302 for an HttpOnly `spor_render_ticket` cookie (kept out of URLs, logs, and view-to-view hrefs). The ticket binds `$viewer` to the recorded sharer and the render shows a "Viewing as &lt;sharer&gt;" banner. The former `?token=<PAT>` sharing path is **removed** — a shared link can never carry a write-capable credential |
| `POST /v1/lens/{id}/ticket` `{expires?}` | sharing a view; `spor share` | mint a signed, expiring, read-only render ticket for the lens/workspace, recording the authenticated caller as the sharer → `{ticket, url, lens_id, sharer_person_id, exp}`. `expires` is `<N>d` or an ISO date (default `7d`, max `30d`); the caller must be bound to a person node (else `422 no_person`). The ticket carries no write scope and is honored only on the render route (directly, or via the app host's ticket exchange below). The minted `url` depends on host role: an MCP-only host (`SPOR_HOST_ROLE=mcp`) with `SPOR_APP_URL` set mints an **absolute** `${SPOR_APP_URL}/views/{id}?ticket=...` — the app host's own render page, since the MCP host itself 404s on HTML renders; unset, it falls back to today's relative shape; every other role keeps its existing `oauth.baseUrl(request.raw)`-based absolute `/v1/lens/{id}/render?ticket=...`. On the app host, `GET /views/{id}` accepts that `?ticket=` exactly once: it is exchanged via a 302 into an HttpOnly `spor_render_ticket` cookie (stripped from the URL, kept out of logs and view-to-view hrefs) and replayed to api as the credential on the render fetch — but a **live app-host session outranks the ticket**: if the visitor is already signed in, their own session is used and the ticket cookie is ignored, so a shared link can never pin a signed-in user's view to the sharer's `$viewer`. The `spor share <lens-id> [--expires <Nd>]` CLI verb is the shell front-door (remote-only — tickets are minted and signed server-side); it prints the shareable link ready to paste, `--json` for the raw envelope |
| `POST /v1/merge` `{nodes: [...], mode?: "plan"\|"apply", id_map?: {...}, trust_attached_code?: bool, force?: bool}` | admin promoting one graph into another — pilot-to-org, or a local dogfood graph into a hosted tenant | bring another graph's exported node files (`nodes`: an array of raw node markdown strings) into this one without the failure mode of the naive `GET /v1/export \| POST /v1/nodes --if-exists skip` — silently DROPPING every colliding node while imported edges that pointed at it re-bind to this graph's unrelated same-named node (ordinal id schemes like `cap-<date>-<n>` collide across any two independently started graphs). **Admin-gated** (stewards→root, else `403 forbidden`): `mode:"apply"` writes through the same trusted bulk-import door the server uses internally, which preserves each incoming node's original attribution (a merge moves history, it does not re-author it) and skips the `transitions()`/policy gates (content validation still runs per node; create-only, one deferred commit). Every incoming node classifies as **imported** (id unknown here), **deduped** (id collides, content identical — attribution-blind, this graph's copy wins), **remapped** (id collides, content differs, and the id's final dash-segment is all-digits/*ordinal* — rewritten to `<id>-<sha256(content)[:7]>`, with every reference to the old id across the incoming batch rewritten to match), or **conflict** (id collides with different content and a *semantic* id; a `person` node's email already bound to a different id; or a `schema`/`workflow`/`workflow-run` node or a `stewards`-to-this-graph's-root edge — none of these ever merge silently). Conflicts are reported for manual triage and never written; the schema/workflow class is the one skippable via `trust_attached_code: true` (only for a whole graph you own). `mode:"plan"` (the default) runs the same classification and validation and returns the report without writing anything; `mode:"apply"` **refuses with `409 conflict`** (nothing written) whenever the plan still carries conflicts or validation errors, unless `force: true` — which imports the clean subset and knowingly leaves any reference to a skipped id unresolved. `id_map` (`{"old-id": "new-id"}`) seeds cross-id rewrites; feed a plan's own `id_map` back into the next request when a graph is too large for one batch (plan every batch first to build the complete map, then apply each). Response: `{mode, counts: {incoming, imported, deduped, remapped, conflicts, errors}, imported, deduped, remapped, conflicts, errors, id_map, results?, generated_at}` — `imported`/`deduped`/`remapped`/`conflicts` are arrays of `{id, new_id?, title?, reason?}`; `errors` is `{id, index?, errors: [...]}` (unparseable/invalid entries); `results` (apply mode only) carries the import door's per-entry write verdicts. Deterministic and idempotent — re-running an identical merge dedups everything the first run imported, safe after a partial failure. Called directly today (bearer admin token + `curl`); a CLI wrapper defaulting to plan mode is tracked separately (task-spor-cli-merge-verb) |
| `GET /v1/export` | bootstrap/offline; `spor export` | ustar tarball of `nodes/` for seeding a local read replica (`?gzip=1` compresses); see §5 for the response headers. `curl … \| tar x` reproduces `nodes/` byte-for-byte. `?history=1` instead streams a `git bundle --all` of the repo (`application/x-git-bundle`, full commit provenance, the customer data-exit path — `git clone <bundle> graph`); `?auth=1` ALSO bundles `auth/*.json` so a disaster restore reproduces the credential set (admin-gated: stewards-root → `403` otherwise). The `spor export [--gzip] [--history\|--auth] [--out <file>]` CLI verb is the shell front-door (remote downloads this; `--gzip`/`--out` also build the same `nodes/` tarball locally, while `--history`/`--auth` are remote-only) |
| `GET /v1/admin/people` | tenant-admin console; offboarding / audit | list every person **subject** → `{people: [{id, name, email, roles, is_admin, status, tokens, active_tokens, last_used}], count}`. `is_admin` reflects the `stewards→root` edge (§4, the same per-person check the admin gate itself runs); `tokens`/`active_tokens`/`last_used` summarize the subject's PATs from the same store `GET /v1/admin/tokens` below lists. `status` is the node's own frontmatter status, stamped `active` at creation — offboarding (below) revokes access without touching it, so it is not an offboarded/active signal today. Admin-only (§4) |
| `POST /v1/admin/people` `{name, email, id?, roles?, invite?, connection_id?, org?}` | onboarding; the on-box `mint-person.js` CLI, the tenant-admin console | create the canonical person **subject** a PAT or provider callback binds to (task-spor-pilot-person-node-onboarding) — `POST /v1/admin/tokens` below and a provider (IdP) callback both refuse to conjure one, so this is the deliberate step onboarding a new teammate needs FIRST → 201 `{id, name, email, roles, revision, org_invitation?}`. `name`/`email` are required, single-line, ≤200 chars; `id` defaults to an opaque, deterministic email-hash when omitted (never the mutable display name) and must be a `person-<slug>` kebab id; `roles` is an optional array of ≤20 kebab-case role slugs. No `stewards` edge is written — a regular teammate is not an admin (grant that separately, §4). `invite:true` additionally issues a WorkOS Organization invitation for the same email (`connection_id` disambiguates when more than one WorkOS connection is configured; `org` pins the invitation's org, and is honored only on an unbound/self-host server — on a server already bound to one org (the hosted default), a supplied `org` that disagrees with it is `403 forbidden` rather than silently corrected, and omitting it just pins to the bound org) — the invite shape is validated up front so a bad arg never leaves a half-done onboarding, but an invitation failure never rolls back the created person: `org_invitation: {status: "issued"|"failed", ...}` reports either outcome. Admin-only, same `stewards→root` gate as `/v1/admin/tokens`. `409` on a colliding id; `422` invalid |
| `DELETE /v1/admin/people/{id}` | offboarding | **offboard** a member: revoke every PAT and OAuth grant bound to the subject (the same cascade a directory deprovision runs) → `{offboarded, tokens_revoked, oauth_grants_revoked}`. Does **not** delete the person node — it stays the canonical subject every attribution reference points at, so removal here means "revoke access", not "erase the record". Self-offboarding is refused (`422`) so an admin can't lock themselves out; a malformed or non-`person-` id is also `422` (checked before lookup). Admin-only (§4); `404` unknown id |
| `GET /v1/admin/tokens` | offboarding / audit; `spor admin token list` (= `spor token list --all`) | list PATs → `{tokens: [{hash_prefix, person, name, email, created, expires, expired, last_used}], count}` — never plaintext, never full hashes. Admin-only (§4). The team-wide view; the caller's own PATs are the self-serve `GET /v1/me/tokens` above |
| `POST /v1/admin/tokens` `{person, expires?}` | onboarding; `spor invite` | mint a PAT bound to an existing person node (`expires` is `<N>d` or an ISO date) → 201 `{token, hash_prefix, person, name, email, expires}`; the plaintext `token` is returned **once**. Admin-only. Binds someone *else* (onboarding); the self-serve mint is `POST /v1/me/tokens` above |
| `DELETE /v1/admin/tokens/{hash-prefix}` | offboarding / rotation; `spor admin token revoke` (= `spor token revoke --all`) | revoke the single PAT matching the hash prefix (≥8 hex chars; an ambiguous prefix is a 409) → `{revoked, hash_prefix}`. Admin-only. Revokes ANY token; the self-serve revoke (the caller's own) is `DELETE /v1/me/tokens/{hash-prefix}` above |
| `GET /v1/agents` | `spor agent list` | list the agents the caller **owns** → `{agents: [{id, label, owner, spiffe, pubkey, status}], count}`; `?all=1` lists every agent (admin-only) |
| `POST /v1/agents` `{label, id?, pubkey?}` | `spor agent create` | **self-serve** (NOT admin): create an `agent` node owned by the CALLER's bound person + its `owned-by` edge (owner is never payload-asserted; `id` derives from `label`) → 201 `{id, owner, spiffe, pubkey, status, revision}` (the shared `createAgentNode` body the admin door also runs). 409 dup id / 422 invalid / `403` if the caller maps to **no person node** (you need a subject to own one). The default door for `spor agent create`; the admin `POST /v1/admin/agents` is reached only by `--owner <other>` (task-spor-app-agents-self-serve-create) |
| `POST /v1/admin/agents` `{label, owner?, id?, pubkey?}` | `spor agent create --owner <other>`, onboarding | create an `agent` node + `owned-by` edge on behalf of ANOTHER person (`owner` defaults to the caller's person; `id` derives from `label`) → 201 `{id, owner, spiffe, pubkey, status, revision}`. 409 dup id / 422 invalid / 403 non-admin. Admin-only, same `stewards→root` gate as `/v1/admin/tokens`. The self-serve `POST /v1/agents` above is the owner=caller path |
| `POST /v1/agents/{id}/token` `{session?, audience?, expires?, standing?, label?}` | `spor dispatch` (per-session), `spor agent token <id>` (standing) | **self-serve** (NOT admin), ownership-gated (the caller's person **owns** the agent — else `403`; `404` unknown agent). Two modes. **Per-session** (default): mint a short-TTL token scoped to agent `{id}` → 201 `{token, expires_at, agent, session}` (`session: null` when deferred); `session` is OPTIONAL (deferred binding, dec-spor-dispatch-bg-session-late-bind) — `spor dispatch` mints it deferred because `claude --bg` self-allocates the run session only at launch, then binds the real one via `POST /v1/agents/session` below; a caller `expires` may only SHORTEN the default TTL, never extend past the 7d cap; `422` on a malformed SUPPLIED `session`. **Standing** (`{standing:true}`, task-spor-app-standing-agent-pat): mint a long-lived agent-scoped `spor_pat_` — the durable `SPOR_TOKEN` a headless agent (Claude Code on the Web) runs under → 201 `{token, hash_prefix, agent, owner, label, expires, standing:true}`; user-set `expires` defaults to and is **capped at 1 year** (a past/beyond-cap date is `422`, rejected not clamped), `label` is an optional ≤200-char note, a supplied `session` is `422` (a standing credential carries none); listable/revocable via `/v1/agents/{id}/tokens` below. Both modes: a write under the token is stamped agent-on-behalf-of-person (§1) |
| `GET /v1/agents/{id}/tokens` | `spor agent token <id> list` | list the agent's STANDING PATs → `{tokens: [{hash_prefix, label, standing, created, expires, expired, last_used, …}], count}` (short per-session dispatch tokens are excluded — they age out on their own). Same OWNERSHIP gate as the mint (the agent's owner — else `403`; `404` unknown agent) |
| `DELETE /v1/agents/{id}/tokens/{hash-prefix}` | `spor agent token <id> revoke` | revoke one of the agent's standing PATs by hash prefix → `{revoked, hash_prefix, oauth_grants_revoked}`; a prefix that isn't one of THIS agent's standing PATs is `404` (never a session token or another agent's PAT). Same OWNERSHIP gate as the mint — revocable per-environment without touching the owner's other access |
| `POST /v1/agents/session` `{session}` | `spor dispatch` (post-launch) | **late session binding** for a session-deferred agent token (dec-spor-dispatch-bg-session-late-bind). Authenticated by the **agent token itself** (the bearer hash identifies its own record — no agent id in the path, no ownership re-check), so only an agent-scoped token may call it (`403` otherwise). Sets that token's `session` → `200 {ok, agent, session}`. **Write-once**: idempotent on the same value (`{unchanged: true}`), `409 conflict` on a different one (a token's session is provenance, not a mutable field); `422` missing/malformed `session`. Every subsequent write under the token then stamps the bound session |
| `POST /v1/agents/{id}/capabilities` `{harnesses?, reachable_mcp?, skills?, plugins?, deny?}` | `spor capabilities publish`, session-start auto-publish | **publish** this box's machine capabilities to the fleet scheduler (task-spor-remote-fleet-scheduler, dec-spor-machine-profile-satisfiability). The remote twin of the machine-local `dispatch.capabilities` map: the server collapses the body with the SAME `effectiveCapabilities()` the client runs (so a raw `{probed,declared,deny}` map or the already-flat axes both work; also accepts a `{capabilities: {...}}` envelope) and stores it BESIDE the agent node (operational store, not the durable git-tracked node — capabilities are machine-local, probe-refreshed, never committed) → `200 {agent, capabilities, published_at, last_seen, published_by, session?, changed}`. Authorized iff the caller **owns** the agent (its `owned-by` edge) OR is the agent itself (a self-publish under an agent token) — else `403`; `404` unknown agent; `422` a malformed map. A publish stamps both `published_at` (when the CAPS last changed) and `last_seen` (last contact); `last_seen` ALSO advances on the cheap `POST .../heartbeat` below, and the host-match keys staleness off `last_seen` not `published_at`. Beyond the manual verb, `session-start` AUTO-publishes here in remote mode whenever a `dispatch.agent` is configured (task-spor-fleet-capabilities-autopublish-session-start) — bounded + fail-open, so every session refreshes this box's caps and last-contact without a manual call; disable with `SPOR_CAPABILITIES_PUBLISH=0` |
| `GET /v1/agents/{id}/capabilities` | `spor capabilities show <agent>`, steward fleet view, debugging | read back an agent's published capabilities → `200 {agent, capabilities, published_at, last_seen, published_by, session?}`; `404` if none published. Readable by the **owner**, the **agent itself**, or an **admin** (a stewards→root fleet-capacity view) — else `403`. The CLIENT reader (task-spor-capabilities-read-agent-cli-verb): `spor capabilities show <agent-id>` (`me` = this box's `dispatch.agent`) renders the stored caps + timestamps without raw REST — the read twin of `spor capabilities publish` and the per-agent companion to `spor capabilities hosts`; remote-only, fail-soft |
| `POST /v1/agents/{id}/heartbeat` | post-tool mid-session liveness tick | **liveness ping** (task-spor-fleet-scheduler-hardening): refresh this box's `last_seen` WITHOUT re-uploading capabilities — the cheap "still here" signal, decoupled from a caps re-publish, so a box that published once and runs for hours stays a live fleet host. The host-match keys staleness off `last_seen`, so a box that keeps heartbeating is never demoted while a genuinely dead one ages out under `max_age` → `200 {agent, capabilities, published_at, last_seen, …}` (the refreshed record). Same owner/self gate as publish — else `403`; `404` unknown agent OR nothing published yet (publish before heartbeat — liveness without caps is meaningless to the scheduler); `422` a malformed agent id. The CLIENT caller (task-spor-fleet-scheduler-client-heartbeat-tick): the `post-tool` hook ticks this in REMOTE mode whenever a `dispatch.agent` is configured (the SAME opt-in as the session-start auto-publish), piggybacking on write-activity but THROTTLED to one ping per `dispatch.heartbeatIntervalMs` (default 5min) — so a long session keeps `last_seen` fresh between session-starts (which today refresh it the expensive way, via a full re-publish) without re-probing. Bounded + fail-open; disable with `SPOR_HEARTBEAT=0` |
| `GET /v1/profiles/{id}/hosts` `?owner=me\|person-X&max_age=<dur>` | `spor capabilities hosts <profile>`; `spor dispatch` (auto on a FORK B refusal) | **host-match** a `type: profile` against every agent's published capabilities using the SAME pure `satisfies()` matcher the client runs locally → `200 {profile, satisfiable: [{agent, owner, published_at, last_seen, age_seconds}], unsatisfiable: [{agent, owner, published_at, last_seen, age_seconds, reasons}], counts}`. Satisfiable hosts are freshest-first (by `last_seen`); the unsatisfiable carry the matcher's own reasons (the failing atoms), enabling **substitution-free re-routing** — pick a box that satisfies the profile, NEVER substitute a different one (dec-spor-machine-profile-satisfiability FORK B). The CLIENT consumer (task-spor-fleet-scheduler-autoroute-dispatch): `spor capabilities hosts` lists the re-route targets directly, and when `spor dispatch` refuses because THIS box can't satisfy the resolved profile it calls this endpoint and names the satisfiable hosts to re-route to — or, when none satisfy it, escalates to the owner (fail-soft: an unreachable scheduler degrades to a generic hint). **Visibility is steward-scoped** (task-spor-fleet-scheduler-hardening): the whole-fleet view (every member's boxes + caps) is a multi-tenant cross-member disclosure, so an **admin** (stewards→root) sees the whole fleet and may scope to any `owner=person-X`, while an ordinary **member** is scoped to THEIR OWN boxes (default `owner` = the caller's person; an agent token resolves to its owner; `owner=me` is the explicit form) and a member asking for a colleague's `owner=person-X` is `403`. `max_age` (`30m`/`12h`/`7d`/ms) demotes hosts whose `last_seen` is older than it to unsatisfiable (the liveness filter). `404` unknown/non-profile id; `422` bad `max_age`/`owner` |

Path parameters (node ids, project slugs) must match
`^[a-z0-9][a-z0-9-]*$`. Request bodies are capped at 1MB
(`413 too_large`).

### 3.1 Workflow runs

The run engine's claim/complete API. Full contract and the reference worker
live with [workers/shim/README.md](workers/shim/README.md); a worker is
anything with a token.

| Endpoint | Typical caller | Semantics |
|---|---|---|
| `POST /v1/workflows/{id}/run` `{inputs?}` | `spor run`, `run_workflow` MCP tool | start a run on an ACTIVE workflow → `{run_id, revision, workflow, workflow_version, state}` |
| `GET /v1/work?capability=a,b` | run worker (workers/shim) | claimable steps across live runs, filtered by capability → `{work, count, generated_at}`; approval steps are excluded (they surface in the queue, not as worker-claimable work) |
| `POST /v1/runs/{id}/steps/{sid}/claim` `{iteration?}` | run worker (workers/shim) | claim a ready step → `{run_id, step, lease, state}`; a step that isn't claimable is a 409 |
| `POST /v1/runs/{id}/steps/{sid}/complete` `{lease, status, result?, log?, iteration?}` | run worker (workers/shim) | report a verdict (`status: succeeded \| failed` only — anything else is 422). An expired/superseded lease is `409 lease_expired`; a same-generation retry that disagrees with the recorded outcome is `409 outcome_conflict` — redo the work under a fresh lease |
| `GET /v1/runs/{id}` | `spor run status` | full run record: `{run_id, status, project, title, initiator, workflow, workflow_version, lineage, state, revision, timestamps?}` |

## 4. Identity and auth

- **Bearer tokens (REST + MCP).** Per-user tokens `spor_pat_…` (legacy
  `sub_pat_…` tokens stay valid, no re-mint required). Minted by a server
  admin with `spor-mint-token --person <person-node-id>` on the server box;
  the token's canonical subject is that **person node**, and its
  `{name, email}` attribution resolves from the node at read time, so an
  email change re-points the token instead of severing it. Send
  `Authorization: Bearer <token>` on every request. Tokens grant full
  read/write — the trust model is "everyone on the team can read and write
  the team graph", same as a shared repo. Transport is HTTPS only. A token
  may carry an expiry (`spor-mint-token --expires <N>d|<date>`, or the REST
  `expires` field); once past it the token is rejected like a revoked one.
- **Token lifecycle admin.** Mint, list, and revoke run over REST
  (`/v1/admin/tokens`, §3) so onboarding/offboarding needs no server-box
  shell — but every one of those operations is **admin-only**. A caller is an
  admin iff their person node carries a `stewards` edge to the graph root
  (`$SPOR_ROOT_ID`, default `org-root`); without it the admin routes return
  `403 forbidden`. This is the one privileged distinction in the otherwise
  flat trust model, and the seam the future fine-grained model generalizes.
  The first admin is bootstrapped on the server box with `spor-mint-token
  --admin --person <id>` (it writes that `stewards` edge, creating the person
  node from `--name`/`--email` if needed). Hand-editing the token file stays
  as the break-glass path.
- **Person subject lifecycle admin** (task-spor-pilot-person-node-onboarding).
  A person node is the canonical subject a PAT or provider callback binds to,
  and `POST /v1/admin/tokens` above refuses to conjure one — so onboarding a
  new teammate is two admin calls, no server-box shell required:
  `POST /v1/admin/people` (§3) creates the subject, then
  `POST /v1/admin/tokens` binds its PAT. `GET /v1/admin/people` lists every
  subject with its admin-vs-teammate flag and a PAT summary;
  `DELETE /v1/admin/people/{id}` offboards one — revoking every PAT and OAuth
  grant bound to it, but never deleting the node itself, since it remains the
  subject every attribution reference points at — and refuses to offboard
  the caller's own account. Same `stewards→root` gate as token lifecycle
  above.
- **Agent-scoped session tokens.** A person mints a short-lived, per-session
  token for an `agent` they **own** through the self-serve
  `POST /v1/agents/{id}/token` (§3) — authorized by ownership (the agent's
  `owned-by → person` edge), never admin, so a dispatcher needs no special
  privilege to run their own agents. The token's record carries `{agent,
  session}` and no person; the owning person (and its `{name, email}`) resolves
  from the `owned-by` edge at verify time, so a deleted agent or owner makes the
  token fail closed rather than impersonate. Writes under it are attributed
  agent-on-behalf-of-person (§1) — the `person → agent` chain is the audit
  trail. `spor dispatch` mints one per run and injects it into the launched
  background agent (so the agent's own graph writes carry its identity), picking
  the machine's default agent from the `dispatch.agent` client config (set with
  `spor agent use <agent-id>`, or `SPOR_DISPATCH_AGENT`), which `spor dispatch
  --as <agent-id>` overrides for a single run. The `<agent-id>` is the agent's
  `agent-`-prefixed NODE id (what `spor agent list` prints), **not** its bare
  label — the token endpoint requires the prefix, so `dispatch --as` rejects a
  prefix-less id with a `did you mean agent-…?` hint rather than persist one
  every dispatch would 422 on. `spor agent use` goes one step further: a
  prefix-less argument is first resolved against the caller's own agents (their
  label or a plain `agent-<label>` guess) and normalized to the canonical id
  before it's written — a re-typed label just works, and only an id that
  matches none of the caller's agents falls back to the same prefix-hint error.
  (Not to be confused with `spor dispatch --agent`, the unrelated `claude
  --agent` harness passthrough.) The
  token is minted **session-deferred** and bound to the real run session AFTER
  launch (dec-spor-dispatch-bg-session-late-bind): `claude --bg` ignores
  `--session-id` and self-allocates its session, so dispatch reads the real one
  from `claude agents --json` and binds it via `POST /v1/agents/session` (§3) — the
  one place an agent token's session is set, write-once. The session can't be
  forged a-priori (it isn't known until the run exists) and can't ride the write
  payload (token-derived, §1), so the binding is always the actual run.
- **OAuth 2.1 for MCP connectors** (Cowork/claude.ai, which cannot carry a
  static bearer token): protected-resource metadata discovery (RFC 9728,
  advertised on the `/mcp` 401 via `WWW-Authenticate`), authorization-server
  metadata (RFC 8414), dynamic client registration (RFC 7591), and
  authorization-code + PKCE (S256 only, public clients). The consent step is
  a **PAT exchange**: the authorize page asks the user to paste their
  existing `spor_pat_…` token into the server's own page — it never reaches
  the connector host — so the OAuth identity is exactly the PAT's
  `{name, email}` attribution record. Access tokens are `spor_oat_…` (30d;
  legacy `sub_oat_…` accepted); refresh tokens are `spor_ort_…` (90d,
  rotating, single-use). Authorization codes are single-use, 10-minute.
- **Connector grant teardown — token-scoped revocation (RFC 7009).**
  `POST /oauth/revoke` `{token, token_type_hint?}` ends exactly the grant
  that `token` (access or refresh) belongs to and nothing else — the
  caller's PATs and any other connector grants for the same identity are
  untouched. This is the narrow, safe way to disconnect one MCP connector
  (e.g. removing it from a host's settings), distinct from the identity-wide
  cascades: `DELETE /v1/me/tokens/{hash-prefix}` (§3) revokes a PAT plus
  every grant *it* minted, and the admin offboarding cascade revokes
  *every* grant for a person — using either of those to "clean up one
  connector" collaterally logs out the identity's other live sessions
  (issue-spor-teardown-revoke-by-identity-logs-out-operator;
  dec-spor-pat-revoke-cascade-token-scoped). Like the rest of the
  `/oauth/*` surface it is unversioned and takes no bearer — public client,
  the token being revoked is itself the credential. Per RFC 7009 §2.2 the
  response is always `200` whether or not `token` was known (anything else
  is an unauthenticated validity oracle), so success never confirms the
  token existed.
- **CLI interactive sign-in — the device authorization grant.** `spor auth
  login` (flat alias `spor login`) defaults to the OAuth 2.0 device
  authorization grant (RFC 8628), brokered at the Spor front door so it works
  headless / over SSH (dec-spor-cli-auth-device-grant-front-door). Flow:
  `POST /oauth/device_authorization {client_id?, scope?}` →
  `{device_code, user_code, verification_uri, verification_uri_complete,
  expires_in, interval}`; the CLI prints the URL + code (auto-opening a local
  browser when one is present), the human approves in any browser (the
  verification leg runs the same AuthKit login + org resolution as the
  connector flow), and the CLI polls `POST /oauth/token
  {grant_type: urn:ietf:params:oauth:grant-type:device_code, device_code}` —
  answering `authorization_pending`/`slow_down` until approval, then minting the
  same person-bound, **org-scoped**, refreshable `spor_oat_…`/`spor_ort_…` pair
  `addGrant` mints. `--web` is the localhost-loopback optimization for when a
  browser is on the same machine (OAuth 2.1 authorization-code + PKCE, RFC 8252):
  the CLI binds a one-shot `http://127.0.0.1:<port>/callback` listener,
  anonymously registers a public client for it (`POST /oauth/register`, RFC 7591),
  opens the browser to `GET /oauth/authorize {response_type=code, client_id,
  redirect_uri, code_challenge, code_challenge_method=S256, state, scope?}`,
  captures the redirected `?code` (CSRF-checked against `state`), and exchanges it
  at `POST /oauth/token {grant_type: authorization_code, code, code_verifier,
  client_id, redirect_uri}` for the same token pair; it then best-effort
  unregisters the throwaway client (RFC 7592 `DELETE`). It falls back to the
  device grant when the front door exposes no loopback/DCR endpoints. `spor auth
  login <url> <token>` / `spor join <url>
  <token>` is the non-interactive paste path; CI stays `SPOR_TOKEN`. The minted
  credential is stored per-tenant (§6.2).
- **Render tickets (shared lens links).** `POST /v1/lens/{id}/ticket` (§3)
  mints a signed, expiring, **read-only** ticket carrying `{lens_id,
  sharer_person_id, exp}` — the credential a *shared* view link carries instead
  of the sharer's PAT. It binds `$viewer` to the recorded sharer (rendered with
  a "Viewing as" banner), is honored only on `GET /v1/lens/{id}/render`
  (directly, or via the app host's `GET /views/{id}` ticket-to-cookie
  exchange), and can never authorize a write. Stateless (HMAC over a
  server-held key — no
  revocation list, expiry is the bound); per-recipient/revocable grants are a
  later fine-grained-authz refinement.

Unauthenticated MCP calls are hard-rejected — there is no anonymous author.

## 5. Errors and wire constants

Non-2xx responses carry the envelope:

```json
{ "error": { "code": "...", "message": "...", "details": [...] } }
```

Codes and their HTTP statuses: `unauthorized` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `transition_denied` 409, `lease_expired` 409,
`outcome_conflict` 409, `not_ready` 409, `invalid_node` 422, `rate_limited`
429, `too_large` 413, `ingestion_unavailable` 503, `unimplemented` 501,
`internal` 500. Hooks never parse error bodies — any non-200 means "behave
as if the graph is empty" (§6).

A `429 rate_limited` response SHOULD carry a `Retry-After` header (delay
seconds or an HTTP-date); clients honor it, otherwise backing off
exponentially, capped, before retrying. Mechanical writers
(drain-outbox, distill) classify `401`, `400`, `413`, and `422` as
**permanent** — a revoked token will not un-revoke, so these are
dead-lettered to `outbox/dead/` with a loud `journal/remote.log` line
rather than re-POSTed forever; `429` and `5xx` stay transient and are
retried with backoff.

`GET /v1/export` response headers: `x-substrate-head` carries the graph
commit, `x-substrate-node-count` the entry count (plus
`x-substrate-skipped` when any entry was omitted, and `x-substrate-auth-files`
on an `?auth=1` export — the count of `auth/*.json` files bundled). A
`?history=1` bundle carries only `x-substrate-head` (a git bundle has no node
count). These header names are a wire contract and were deliberately **not**
renamed in the Spor rename — clients should keep reading the `x-substrate-*`
spellings.

## 6. Client configuration

Two env vars switch a client into remote mode (the legacy `SUBSTRATE_*`
spellings are still read — dual-read back-compat window); unset means local
mode, reading `$SPOR_HOME` directly:

```
SPOR_SERVER=https://api.sporhq.io      # hosted Spor REST base (the onboarding default)
SPOR_TOKEN=spor_pat_...                # per-user token (§4)
SPOR_ORG=acme                         # select a stored tenant by org (§6.2)
```

`spor join <token>` writes both for you, defaulting `SPOR_SERVER` to the hosted
base `https://api.sporhq.io`; pass a URL (`spor join <url> <token>`) to point at
a self-hosted server instead.

**Opt-in activation.** Spor is opt-in per repo: with the plugin installed, the
hooks are a full no-op (no context injected, nothing distilled) in any repo that
has not opted in. A repo is active when its mode is not `off` AND either an
`enabled` flag is set anywhere in the cascade (`enabled:true`/`false` in a config
layer, `SPOR_ENABLED=1`/`0`, or a CLI `--enabled`) OR a repo-level `.spor` /
`.spor.json` marker is present in the cwd ancestry — what `spor enable`, `spor
link`, and `spor dispatch --backfill` write. An explicit flag wins over marker
presence (so `enabled:false` forces a no-op even where a marker exists). The
default — no flag, no marker — is OFF, including in remote mode: a globally
configured `SPOR_SERVER` resolves the *mode* to remote but does not by itself
*enable* an unrelated repo, so side projects never distill into the team graph.
`spor status` / `spor-hook doctor` report whether the current repo is active.

Failure policy: **fail open, never block** — a hook must never break a
session; connection refused, timeout, 5xx, and auth failure all collapse to
"the graph has nothing for you".

Because fail-open hides degradation by design — a crashing engine and a
quiet success look identical, and stranded captures pile up unseen in
`outbox/dead/` — the client carries three operability surfaces
(task-cc-client-hook-operability-diagnostics):

- **Crash telemetry.** The dispatcher's top-level catch appends one line to
  `journal/remote.log` (`dispatcher <event>: crashed (fail-open, exit 0):
  …`) before honoring the exit-0 contract, so a crash is distinguishable
  from healthy silence after the fact.
- **Session-start nudge.** When `outbox/dead/` is non-empty or the outbox
  spool exceeds a depth threshold, session-start splices a one-line warning
  into the same channel as the `OFFLINE`/`AUTH FAILED` banner, pointing at
  `spor-hook doctor`.
- **`spor-hook doctor`.** An operator-run, read-only diagnostic (no stdin,
  exits 0) that reports resolved mode, server reachability, token validity,
  outbox + dead-letter counts with the oldest file's age, cached-briefing
  freshness, and the trailing error lines from `journal/remote.log` and
  `journal/distill.log`.

### 6.1 Per-repo graph home (local-mode git sharing)

In **local mode** a code repo can bind itself to a specific graph home with a
`graph: <path>` key in its committed `.spor` marker (the same flat `key: value`
marker that carries `repo:`/`project:`). This is how a team shares one graph
for free over plain git, with no server (dec-spor-local-mode-sharing-boundary):

```
# .spor at the repo root
repo: my-service
graph: ../my-team-graph     # path, resolved relative to this marker
```

Contract:

- **Precedence.** The `graph:` binding **overrides `SPOR_HOME`** — it is the
  one input above the environment — but loses to an explicit CLI `--home`. A
  `home` set in `.spor.json` config stays *below* the environment, unchanged; only the
  `.spor` marker `graph:` key beats env. (A contributor with a personal global
  `SPOR_HOME` therefore still inherits the shared graph inside a shared-graph
  repo.)
- **Resolution.** Relative to the marker's own directory (so a committed
  relative path is stable regardless of cwd); nearest-ancestor marker carrying
  a `graph:` key wins.
- **Mode.** Local mode only. With `SPOR_SERVER` set the server is the graph and
  the marker is ignored.
- **Hygiene.** When a marker home is in force the client maintains a
  `.gitignore` in it covering the machine-local, per-person state
  (`journal/`, `cache/`, `outbox/`, `auth/`, `config.json`); only the durable
  `nodes/` and brief `history/` are committed. The SessionEnd distiller leaves
  distilled nodes **uncommitted** (for the human PR flow) instead of
  auto-committing when the graph home is the same git repo as the code repo.

### 6.2 Multi-tenant credentials (the credential store + tenant selector)

Server tokens are **org-scoped** (the `org` claim is the routing + isolation
key), so a person in N orgs holds N credentials. The client is multi-tenant
(dec-spor-client-cli-mode-tenant-resolution): tokens live in a credential store
**keyed by `(issuer, org)`** at `$SPOR_HOME/auth/credentials.json` (mode `0600`,
machine-local — never committed, always in the shared-graph `.gitignore`):

```
{ "version": 1,
  "tenants": {
    "<server>/<org>": { "server": "...", "org": "...", "person": "...",
                        "email": "...", "access_token": "...",
                        "refresh_token": "...", "exp": 1234567890 } },
  "default": "<server>/<org>" }
```

- **Acquire.** `spor auth login` (device grant, §4) and `spor join <url>
  <token>` (paste) both **ADD** a tenant — they never overwrite a sibling. The
  org is read from the token (JWT `org` claim) or `--org`. The first tenant
  becomes the active default.
- **Manage.** `spor auth list` (tenants + active + token health, with a **live
  org-membership refresh** — one `GET /v1/me/org-choices` against the active
  tenant's issuer surfaces orgs added/removed since the last login, fail-open to
  the cached listing when the server can't enumerate; task-spor-cli-auth-list-
  live-membership-requery), `spor auth switch <org>`, `spor auth whoami
  [--all]`, `spor auth logout [<org>|--all]`.
- **Tenant selector** (which credential is active), highest wins:
  `--org`/`--server` flag > `SPOR_SERVER`(+`SPOR_TOKEN`)/`SPOR_ORG` env > repo
  `.spor` `org:` marker (committable, nearest-ancestor — the remote-mode sibling
  of the `graph:` binding in §6.1) > store `default` > legacy flat config.json
  `server`+`token` (migrated on read) > local.
- **Refresh.** A 401/403 on a tenant carrying a `refresh_token` transparently
  refreshes against its issuer (`grant_type=refresh_token`) and retries once.
- **Byte-identical.** With no credential store and only a flat
  `server`+`token` or `SPOR_*` env set, every resolved value equals the prior
  single-tenant behavior (norm-cc-byte-identical-refactor).
