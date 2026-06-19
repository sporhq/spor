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
by clients as an "MCP Server Instructions" block). It frames the eleven tools
as an **ORIENT → TRAVERSE → COMMIT** loop rather than eleven independent
verbs, so an assistant can infer a recursive research chain — e.g. `my_queue`
(or `recent_changes` for "what happened lately") → `query_graph` with `root_id`
(deepen) → `render_lens` on a lineage lens →
`put_node`/`capture` the outcome — instead of reconstructing it from per-tool
descriptions. `query_graph`'s `root_id` is the recursive-deepen move (walk
neighbor → neighbor); `render_lens` lineage lenses trace why a node exists,
and `render_lens` with no `lens_id` returns the lens catalog (the discovery
step before rendering).

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

### `set_status`

Micro-mutation. Input `{ "id": "<node>", "status": "<value>" }`. Output
`{ "status": "updated", "id", "revision", "warnings" }`. Denials from the
schema's `transitions()` gate return `transition_denied` with the gate's
reason, exactly as on a full put. set_status on a `type: schema` node is how
a human flips `proposed → active` (it carries the same authority as the
equivalent put).

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

### `my_queue`

The decision queue (QUEUE.md §4/§5). Input `{ "project"?: "slug",
"types"?: ["task"], "exclude_types"?: ["capture-pending"], "limit"?: 20,
"offset"?: 0 }` → `{ "items": [{id, title, type, status,
priority, score, signals: {blocking, heat, staleness, age_days}, suggest:
"do|close", why}], "count": N, "offset": 0, "returned_count": N,
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

### `recent_changes`

The team's recent-activity feed — the temporal entry point the other read
tools lack (`query_graph` is semantic search, `my_queue` is forward-looking
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

### The MCP-app widget (`ui://spor/view-tree.html`)

`my_queue` and `render_lens` declare a UI resource via
`_meta.ui.resourceUri`: a single trusted interpreter of the view-tree
component catalog that MCP-apps hosts (Claude, Goose, VS Code) render as an
interactive iframe — status chips, progress bars, lineage trees, node detail
on click (`callServerTool(get_node)`, no model round-trip), and
conversational affordances (`sendMessage`) for queue items. Strictly
additive: hosts without the apps surface ignore `_meta.ui` and show the text
content. Write-path actions are not emitted; writes stay with the tools
above.

## 3. REST surface (`/v1/*`)

Plain HTTPS + JSON, bearer auth on every route, versioned under `/v1/`. Each
endpoint is the REST twin of a core call:

| Endpoint | Typical caller | Semantics |
|---|---|---|
| `GET /v1/status` | session-start, monitoring | `{node_count, projects: {...}, head, uptime, metrics}`; doubles as the health check. `?titles=1` adds `titles: [{id, type, project, title}]` — the one-round-trip graph index the distiller dedups against |
| `GET /v1/me` | `spor whoami`/`status`, onboarding | identity echo for the bearer token → `{person, name, email, bound, is_admin, org}`. `bound:false` means the token authenticates but maps to **no person node** (legacy/OAuth, or minted before the node existed), so routed questions and the personal queue will be empty — the client warns on it (the silent identity-degradation signal). `is_admin` reflects the `stewards→root` edge that gates the token-admin surface. `org` is the slug this tenant routes to (`SPOR_ORG`/legacy `SUBSTRATE_ORG`, else `"local"`); it lets a client key its `(issuer, org)` credential store for an **opaque** `spor_oat_`/`spor_pat_` token that carries no readable `org` claim — the client falls back to it after `--org` and the JWT `org` claim (task-spor-frontdoor-me-org-echo). A connector JWT's `org` claim is enforced equal to this echo |
| `GET /v1/briefing/{project}` | session-start | read the `brief-<project>` node → `{found, version, body, project_brief?, graph_status}`. The slug resolves through project-node aliases (GRAPH.md "Project identity nodes") before lookup. A BARE repo slug also rides up to its home-project grouping: the grouping's `brief-<grouping>` node returns alongside as `project_brief` (the product context spanning sibling repos), matching the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping); passing the repo NODE id (`repo-<slug>`) is the escape hatch that returns only the repo brief, no `project_brief`. Optional `?fp=root:<sha>,remote:<host/path>,...` carries the repo's fingerprints: the server learns them onto the owning project node, and an unknown slug with a known fingerprint files an alias proposal in the queue |
| `POST /v1/digest` `{query, root?, project?, min_sim?}` | prompt-context, /spor:brief | digest-mode compile → `{found, text}`; `found: false` is a successful empty result. `root` is the structural-walk twin of `query` (the two are mutually exclusive; `root` wins, an unknown id is `422`). Optional `project` is the session slug: the server scopes the compile to it — the same-project relevance boost, the grouping union, and the `always_on` norm `applies_to_*` ride-along — resolving the slug through project-node aliases/groupings inside compile (dec-spor-queue-slug-resolves-to-grouping), exactly as `/v1/queue` does. A bad slug is `422`; **omitting `project` runs the digest project-blind (byte-identical to before)**, so older clients that send only `{query}` are unaffected |
| `GET /v1/nodes/{id}` | /spor:brief | `get_node` semantics; a live inbound resolves/answers edge rides along as `resolution` (carrying the resolver's `summary`/`title` and a `lagging` flag — set when it contradicts a still-open status, clear when the node is already terminal, e.g. an answered question pointing at its answer), and open gardener findings about the node ride along as `open_findings` |
| `POST /v1/nodes` | drain-outbox, mechanical writers | `put_node` semantics, batch: `{nodes: [...], if_exists: "skip"}` (entries may be raw strings or `{node, if_exists, revision}`) → `{results: [...]}`, 207 when any entry failed |
| `POST /v1/nodes/{id}/edges` `{type, to, attrs?}` | scripts, mechanical writers | `add_edge` semantics (§1): normalize/flip, dedupe, append — no revision echo. Optional `attrs` adds trailing flat edge attributes (e.g. a per-assignment `profile:` override); re-adding the same edge with different attrs upserts the set |
| `POST /v1/nodes/{id}/status` `{status}` | scripts, mechanical writers | `set_status` semantics (§1): one-scalar update through the `transitions()` gate. Setting a work node to an in-progress status also CLAIMS it (same lease as `/claim` below) |
| `POST /v1/nodes/{id}/claim` `{session?}` | `claim`/`set_status` MCP tools, `spor dispatch` | take the heartbeat-renewed lease (dec-cc-task-claim-lease): writes the durable `assigned` edge once, attributes to `$viewer` from the token (never an argument), and creates the ephemeral lease → `{ok, status, lease: {node_id, by, expires, expires_at, session, claimed_at}, edge}`. A live lease held by ANOTHER person is `409 conflict` naming the holder + expiry (re-claiming your OWN live claim just renews it). `session` scopes the heartbeat (omit to leave it person-scoped, so any of the claimer's sessions may renew — what `spor dispatch` does at the PRE-launch claim, since `claude --bg` self-allocates the run session only at launch; dispatch then renews with the real session once it has read it from `claude agents --json`, dec-spor-dispatch-bg-session-late-bind) |
| `POST /v1/nodes/{id}/renew` `{session?}` | post-tool heartbeat, `renew` MCP tool, `spor dispatch` | bump the live lease's expiry only — no commit; the heartbeat that keeps a claim from lapsing. A lapsed/stolen lease is `409` (names the current holder). Person-scoped: any of the claimer's sessions may renew; a `session` binds the lease to that run (`spor dispatch` uses this to bind the captured `claude --bg` session post-launch) |
| `POST /v1/nodes/{id}/release` | `release` MCP tool | drop the lease AND retire the durable `assigned` edge, returning the node to the pool. Idempotent (releasing a node you hold no lease on still succeeds, cleaning up any lingering `assigned` edge of yours); releasing a claim someone else holds is `409` naming the holder |
| `POST /v1/nodes/{id}/commits` `{repo, sha}` | post-tool / link-commits | `link_commit`: append `repo@sha` to the node's `commits:` list (kebab-case repo slug, 7–40 lowercase hex, ≤40 commits per node); idempotent, prefix-aware dedup |
| `GET /v1/commits/{sha}?repo=` | sessions doing git archaeology | sha → nodes lookup over the `commits:` fields (≥7 hex, abbreviated or full); each match carries `{repo, sha, id, type, title, summary, status, project}` — blame a line, get the why |
| `GET /v1/changes?since=&project=&limit=` | `recent_changes`'s REST twin; audit review | the remote audit trail: a git-log projection over `nodes/` → `{changes: [{id, change, commit, date, committed_by, type, title, authored_via, author}], count, head, since, generated_at}`, newest change per node first. `since` is a 7–40 hex sha (`sha..HEAD`) or a date/relative phrase git understands (`--since`); an unresolvable sha is `422`. `project` scopes to one project's nodes (deletions are omitted when scoped, their project being gone). `limit` bounds nodes returned (default 100, **max 500**). Each entry's `authored_via` is the current machine-vs-human signal (`capture`/`distill`/`gardener` = machine). Lets a remote client review what agents wrote without the whole `/v1/export` tarball |
| `POST /v1/capture` | distill, /spor:defer | `capture` semantics: `{text, context: {project, during, blocks?, needed_by?}, source?}` → ingestion model + validate + commit → `{status, ids, nodes, summary, warnings}`. `source: "distill"` marks backstop captures in the journal. `context.blocks` (a node id, must exist) and `context.needed_by` (`YYYY-MM-DD`) declare a cross-project dependency (task-cc-xproject-dependency-loop): set `context.project` to the SERVING project and the server attaches a `blocks` edge to the requester + the deadline deterministically (not via the model) onto the primary node. A missing `blocks` target is `404`; a non-date `needed_by` is `422` — both rejected before any model call |
| `POST /v1/distill/report` | distill | sweep telemetry, journal-only (no store mutation): `{facts, captured?, spooled?, rejected?, project?, session?}` → `{status: "reported"}`; zero-fact sweeps report too |
| `POST /v1/corrections` | /spor:correct | `propose_correction` semantics → 201 `{status, id, revision, warnings}` |
| `GET /v1/queue?project=&assignee=&type=&exclude_type=&limit=&offset=` | /spor:next, session-start | the ranked decision queue: `{items, count, offset, returned_count, total_count, truncated, next_offset, counts_by_type, counts_by_project, counts_by_suggest, muted?, dormant?, questions, asked, findings, pending, reviews, policy?, generated_at}` — items retired by a live resolves/answers edge are excluded; items hidden by the viewer's `queue_mute` or parked by a future `wake:` date (QUEUE.md §4) are counted, never silently dropped; `questions`/`findings`/`pending` are the routed-to-me-plus-unrouted views for the authenticated identity, `asked` is the questions you filed, and `reviews` is the nodes whose review is requested of you (an open `review-requested` edge to your person node — explicitly targeted, no unrouted fallback). `limit` is the page size (default 20, **max 100**, clamped not rejected) and `offset` skips that many items in the ranked order (default 0); the `counts_*`/`total_count` aggregates always cover the FULL ranked set regardless of the page, so one call answers "how many issues vs tasks" without paging, while `truncated`/`next_offset` let a client walk the rest by re-requesting with `offset=next_offset` until `next_offset` is null. Pagination is offset over a point-in-time ranked slice (the queue re-ranks every call), not a cursor — it resumes the same slice only across an unchanged ranking. `project` resolves through the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping): a bare repo slug unions its home-project grouping's member queues, the repo NODE id (`repo-<slug>`) pins one repo, a grouping id (`proj-<slug>`) is used directly; **omitting `project` is the cross-project firehose** (every repo's queue at once). `assignee=<person-id>` scopes to the work that person carries (their `assigned`/`stewards` edges) — a manager's "who is carrying what"; `assignee=me` binds to the caller (empty if the token maps to no person node). `type=`/`exclude_type=` (comma-separated, repeatable) whitelist/blacklist node types from the ranking (exclude wins on overlap) — a hard scope filter applied before scoring, so the aggregates describe the filtered queue (task-cc-queue-filtering-enhancements) |
| `POST /v1/questions` `{text, title?, mentions?, project?}` | ask_question's REST twin | file a question node; deterministically routed to the steward of the closest relevance-neighborhood node, unrouted if none → 201 `{status, id, project, routed_to, via, asker, revision, warnings}`. `project` is derived from the relevance neighborhood (then the asker's home project) unless an explicit `project` slug overrides it — pass that for a mention-less question (a dispatched agent injects its session project); a malformed slug → 400 |
| `POST /v1/gardener` | ops cron / on demand | run a gardener sweep now; findings filed as queue items → `{filed, resolved, ..., generated_at}` |
| `GET /v1/lens/{id}/render?format=html\|text\|json` | browsers, teammates without a checkout | run a lens OR workspace node and render its view tree (html default, plain text, or the raw tree as json). Read-only — no action forms; writes stay with `/v1/nodes` and the MCP tools. Auth is the caller's bearer header OR a signed read-only **render ticket** for shared links (browser links can't carry an Authorization header): `?ticket=<blob>` is accepted once and exchanged via a 302 for an HttpOnly `spor_render_ticket` cookie (kept out of URLs, logs, and view-to-view hrefs). The ticket binds `$viewer` to the recorded sharer and the render shows a "Viewing as &lt;sharer&gt;" banner. The former `?token=<PAT>` sharing path is **removed** — a shared link can never carry a write-capable credential |
| `POST /v1/lens/{id}/ticket` `{expires?}` | sharing a view | mint a signed, expiring, read-only render ticket for the lens/workspace, recording the authenticated caller as the sharer → `{ticket, url, lens_id, sharer_person_id, exp}`. `expires` is `<N>d` or an ISO date (default `7d`, max `30d`); the caller must be bound to a person node (else `422 no_person`). The ticket carries no write scope and is honored only on the render route |
| `GET /v1/export` | bootstrap/offline | ustar tarball of `nodes/` for seeding a local read replica (`?gzip=1` compresses); see §5 for the response headers. `curl … \| tar x` reproduces `nodes/` byte-for-byte |
| `GET /v1/admin/tokens` | offboarding / audit | list PATs → `{tokens: [{hash_prefix, person, name, email, created, expires, expired}], count}` — never plaintext, never full hashes. Admin-only (§4) |
| `POST /v1/admin/tokens` `{person, expires?}` | onboarding | mint a PAT bound to an existing person node (`expires` is `<N>d` or an ISO date) → 201 `{token, hash_prefix, person, name, email, expires}`; the plaintext `token` is returned **once**. Admin-only |
| `DELETE /v1/admin/tokens/{hash-prefix}` | offboarding / rotation | revoke the single PAT matching the hash prefix (≥8 hex chars; an ambiguous prefix is a 409) → `{revoked, hash_prefix}`. Admin-only |
| `GET /v1/agents` | `spor agent list` | list the agents the caller **owns** → `{agents: [{id, label, owner, spiffe, pubkey, status}], count}`; `?all=1` lists every agent (admin-only) |
| `POST /v1/admin/agents` `{label, owner?, id?, pubkey?}` | `spor agent create`, onboarding | create a person-owned `agent` node + its `owned-by` edge (`owner` defaults to the caller's person; `id` derives from `label`) → 201 `{id, owner, spiffe, pubkey, status, revision}`. 409 dup id / 422 invalid / 403 non-admin. Admin-only, same `stewards→root` gate as `/v1/admin/tokens` |
| `POST /v1/agents/{id}/token` `{session?, audience?, expires?}` | `spor dispatch` | **self-serve** (NOT admin): mint a short-TTL, per-session token scoped to agent `{id}` → 201 `{token, expires_at, agent, session}` (`session: null` when deferred). Authorized iff the caller's person **owns** the agent (its `owned-by` edge) — else `403`; `404` unknown agent; `422` a SUPPLIED `session` that is malformed. `session` is now **OPTIONAL** (deferred binding, dec-spor-dispatch-bg-session-late-bind): `spor dispatch` mints it deferred because `claude --bg` self-allocates the run session only at launch, then binds the real one via `POST /v1/agents/session` below. The token carries `{agent, session?}` (the person is derived from the `owned-by` edge at verify time); a write under it is stamped agent-on-behalf-of-person (§1). A caller `expires` may only shorten the default TTL, never extend it |
| `POST /v1/agents/session` `{session}` | `spor dispatch` (post-launch) | **late session binding** for a session-deferred agent token (dec-spor-dispatch-bg-session-late-bind). Authenticated by the **agent token itself** (the bearer hash identifies its own record — no agent id in the path, no ownership re-check), so only an agent-scoped token may call it (`403` otherwise). Sets that token's `session` → `200 {ok, agent, session}`. **Write-once**: idempotent on the same value (`{unchanged: true}`), `409 conflict` on a different one (a token's session is provenance, not a mutable field); `422` missing/malformed `session`. Every subsequent write under the token then stamps the bound session |
| `POST /v1/agents/{id}/capabilities` `{harnesses?, reachable_mcp?, skills?, plugins?, deny?}` | `spor capabilities publish`, session-start auto-publish | **publish** this box's machine capabilities to the fleet scheduler (task-spor-remote-fleet-scheduler, dec-spor-machine-profile-satisfiability). The remote twin of the machine-local `dispatch.capabilities` map: the server collapses the body with the SAME `effectiveCapabilities()` the client runs (so a raw `{probed,declared,deny}` map or the already-flat axes both work; also accepts a `{capabilities: {...}}` envelope) and stores it BESIDE the agent node (operational store, not the durable git-tracked node — capabilities are machine-local, probe-refreshed, never committed) → `200 {agent, capabilities, published_at, last_seen, published_by, session?, changed}`. Authorized iff the caller **owns** the agent (its `owned-by` edge) OR is the agent itself (a self-publish under an agent token) — else `403`; `404` unknown agent; `422` a malformed map. A publish stamps both `published_at` (when the CAPS last changed) and `last_seen` (last contact); `last_seen` ALSO advances on the cheap `POST .../heartbeat` below, and the host-match keys staleness off `last_seen` not `published_at`. Beyond the manual verb, `session-start` AUTO-publishes here in remote mode whenever a `dispatch.agent` is configured (task-spor-fleet-capabilities-autopublish-session-start) — bounded + fail-open, so every session refreshes this box's caps and last-contact without a manual call; disable with `SPOR_CAPABILITIES_PUBLISH=0` |
| `GET /v1/agents/{id}/capabilities` | steward fleet view, debugging | read back an agent's published capabilities → `200 {agent, capabilities, published_at, last_seen, published_by, session?}`; `404` if none published. Readable by the **owner**, the **agent itself**, or an **admin** (a stewards→root fleet-capacity view) — else `403` |
| `POST /v1/agents/{id}/heartbeat` | post-tool mid-session liveness tick | **liveness ping** (task-spor-fleet-scheduler-hardening): refresh this box's `last_seen` WITHOUT re-uploading capabilities — the cheap "still here" signal, decoupled from a caps re-publish, so a box that published once and runs for hours stays a live fleet host. The host-match keys staleness off `last_seen`, so a box that keeps heartbeating is never demoted while a genuinely dead one ages out under `max_age` → `200 {agent, capabilities, published_at, last_seen, …}` (the refreshed record). Same owner/self gate as publish — else `403`; `404` unknown agent OR nothing published yet (publish before heartbeat — liveness without caps is meaningless to the scheduler); `422` a malformed agent id. The CLIENT caller (task-spor-fleet-scheduler-client-heartbeat-tick): the `post-tool` hook ticks this in REMOTE mode whenever a `dispatch.agent` is configured (the SAME opt-in as the session-start auto-publish), piggybacking on write-activity but THROTTLED to one ping per `dispatch.heartbeatIntervalMs` (default 5min) — so a long session keeps `last_seen` fresh between session-starts (which today refresh it the expensive way, via a full re-publish) without re-probing. Bounded + fail-open; disable with `SPOR_HEARTBEAT=0` |
| `GET /v1/profiles/{id}/hosts` `?owner=me\|person-X&max_age=<dur>` | `spor capabilities hosts <profile>`; `spor dispatch` (auto on a FORK B refusal) | **host-match** a `type: profile` against every agent's published capabilities using the SAME pure `satisfies()` matcher the client runs locally → `200 {profile, satisfiable: [{agent, owner, published_at, last_seen, age_seconds}], unsatisfiable: [{agent, owner, published_at, last_seen, age_seconds, reasons}], counts}`. Satisfiable hosts are freshest-first (by `last_seen`); the unsatisfiable carry the matcher's own reasons (the failing atoms), enabling **substitution-free re-routing** — pick a box that satisfies the profile, NEVER substitute a different one (dec-spor-machine-profile-satisfiability FORK B). The CLIENT consumer (task-spor-fleet-scheduler-autoroute-dispatch): `spor capabilities hosts` lists the re-route targets directly, and when `spor dispatch` refuses because THIS box can't satisfy the resolved profile it calls this endpoint and names the satisfiable hosts to re-route to — or, when none satisfy it, escalates to the owner (fail-soft: an unreachable scheduler degrades to a generic hint). **Visibility is steward-scoped** (task-spor-fleet-scheduler-hardening): the whole-fleet view (every member's boxes + caps) is a multi-tenant cross-member disclosure, so an **admin** (stewards→root) sees the whole fleet and may scope to any `owner=person-X`, while an ordinary **member** is scoped to THEIR OWN boxes (default `owner` = the caller's person; an agent token resolves to its owner; `owner=me` is the explicit form) and a member asking for a colleague's `owner=person-X` is `403`. `max_age` (`30m`/`12h`/`7d`/ms) demotes hosts whose `last_seen` is older than it to unsatisfiable (the liveness filter). `404` unknown/non-profile id; `422` bad `max_age`/`owner` |

Path parameters (node ids, project slugs) must match
`^[a-z0-9][a-z0-9-]*$`. Request bodies are capped at 1MB
(`413 too_large`).

### 3.1 Workflow runs

The run engine's claim/complete API. Full contract and the reference worker
live with [workers/shim/README.md](workers/shim/README.md); a worker is
anything with a token.

| Endpoint | Semantics |
|---|---|
| `POST /v1/workflows/{id}/run` `{inputs?}` | start a run on an ACTIVE workflow → `{run_id, revision, workflow, workflow_version, state}` |
| `GET /v1/work?capability=a,b` | claimable steps across live runs, filtered by capability → `{work, count, generated_at}`; approval steps are excluded (they surface in the queue, not as worker-claimable work) |
| `POST /v1/runs/{id}/steps/{sid}/claim` `{iteration?}` | claim a ready step → `{run_id, step, lease, state}`; a step that isn't claimable is a 409 |
| `POST /v1/runs/{id}/steps/{sid}/complete` `{lease, status, result?, log?, iteration?}` | report a verdict (`status: succeeded \| failed` only — anything else is 422). An expired/superseded lease is `409 lease_expired`; a same-generation retry that disagrees with the recorded outcome is `409 outcome_conflict` — redo the work under a fresh lease |
| `GET /v1/runs/{id}` | full run record: `{run_id, status, project, title, initiator, workflow, workflow_version, lineage, state, revision, timestamps?}` |

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
  label — the token endpoint requires the prefix, so the client setters
  (`spor agent use`, `--as`) reject a prefix-less id with a `did you mean
  agent-…?` hint rather than persist one every dispatch would 422 on. (Not to be
  confused with `spor dispatch --agent`, the unrelated `claude --agent` harness
  passthrough.) The
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
  `addGrant` mints. `--web` is a reserved localhost-loopback optimization (falls
  back to device-code today). `spor auth login <url> <token>` / `spor join <url>
  <token>` is the non-interactive paste path; CI stays `SPOR_TOKEN`. The minted
  credential is stored per-tenant (§6.2).
- **Render tickets (shared lens links).** `POST /v1/lens/{id}/ticket` (§3)
  mints a signed, expiring, **read-only** ticket carrying `{lens_id,
  sharer_person_id, exp}` — the credential a *shared* view link carries instead
  of the sharer's PAT. It binds `$viewer` to the recorded sharer (rendered with
  a "Viewing as" banner), is honored only on `GET /v1/lens/{id}/render`, and can
  never authorize a write. Stateless (HMAC over a server-held key — no
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
`x-substrate-skipped` when any entry was omitted). These header names are a
wire contract and were deliberately **not** renamed in the Spor rename —
clients should keep reading the `x-substrate-*` spellings.

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
- **Manage.** `spor auth list` (tenants + active + token health), `spor auth
  switch <org>`, `spor auth whoami [--all]`, `spor auth logout [<org>|--all]`.
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
