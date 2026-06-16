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
  `authored_via: mcp|rest|capture` from the authenticated token — any
  `author:` supplied in the payload is discarded.
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
"to": "<target>" }` — accepts canonical, alias, and inverse forms; inverse
forms are flipped onto the target before writing. No revision echo is needed.
Output `{ "status": "updated|skipped", "id": <node actually modified>,
"revision", "warnings" }` (`skipped` = edge already present — the call is
idempotent). Both nodes must exist. The tool description carries the same
registry-generated vocabulary as `put_node`.

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
"limit"?: 20, "offset"?: 0 }` → `{ "items": [{id, title, type, status,
priority, score, signals: {blocking, heat, staleness, age_days}, suggest:
"do|close", why}], "count": N, "offset": 0, "returned_count": N,
"total_count": N, "truncated": false, "next_offset": null, "questions": []
}` — queueable live nodes ranked by the default blend, each with a one-line
*why*. Items already retired by a live inbound resolves/answers edge are
excluded whatever their status field reads; open gardener findings ride
along per item as `findings`. Structured output additionally carries
`view` — the queue projected into the view-tree catalog for the MCP-app
widget (below).

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

### `ask_question`

File a question the graph could not answer. Input `{ "text": "<the
question>", "title"?: "<short title>", "mentions"?: ["<node id>", ...] }`
(routing considers `mentions` first). The question becomes a durable node,
deterministically routed to the steward of the closest relevant node
(unrouted if none matches), and joins the decision queue until answered.
Answer by writing a node with an `answers` edge to the question.

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
| `GET /v1/me` | `spor whoami`/`status`, onboarding | identity echo for the bearer token → `{person, name, email, bound, is_admin}`. `bound:false` means the token authenticates but maps to **no person node** (legacy/OAuth, or minted before the node existed), so routed questions and the personal queue will be empty — the client warns on it (the silent identity-degradation signal). `is_admin` reflects the `stewards→root` edge that gates the token-admin surface |
| `GET /v1/briefing/{project}` | session-start | read the `brief-<project>` node → `{found, version, body, project_brief?, graph_status}`. The slug resolves through project-node aliases (GRAPH.md "Project identity nodes") before lookup. A BARE repo slug also rides up to its home-project grouping: the grouping's `brief-<grouping>` node returns alongside as `project_brief` (the product context spanning sibling repos), matching the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping); passing the repo NODE id (`repo-<slug>`) is the escape hatch that returns only the repo brief, no `project_brief`. Optional `?fp=root:<sha>,remote:<host/path>,...` carries the repo's fingerprints: the server learns them onto the owning project node, and an unknown slug with a known fingerprint files an alias proposal in the queue |
| `POST /v1/digest` `{query, min_sim?}` | prompt-context | digest-mode compile → `{found, text}`; `found: false` is a successful empty result |
| `GET /v1/nodes/{id}` | /spor:brief | `get_node` semantics; when a live inbound resolves/answers edge contradicts a still-open status the response carries `resolution`, and open gardener findings about the node ride along as `open_findings` |
| `POST /v1/nodes` | drain-outbox, mechanical writers | `put_node` semantics, batch: `{nodes: [...], if_exists: "skip"}` (entries may be raw strings or `{node, if_exists, revision}`) → `{results: [...]}`, 207 when any entry failed |
| `POST /v1/nodes/{id}/edges` `{type, to}` | scripts, mechanical writers | `add_edge` semantics (§1): normalize/flip, dedupe, append — no revision echo |
| `POST /v1/nodes/{id}/status` `{status}` | scripts, mechanical writers | `set_status` semantics (§1): one-scalar update through the `transitions()` gate |
| `POST /v1/nodes/{id}/commits` `{repo, sha}` | post-tool / link-commits | `link_commit`: append `repo@sha` to the node's `commits:` list (kebab-case repo slug, 7–40 lowercase hex, ≤40 commits per node); idempotent, prefix-aware dedup |
| `GET /v1/commits/{sha}?repo=` | sessions doing git archaeology | sha → nodes lookup over the `commits:` fields (≥7 hex, abbreviated or full); each match carries `{repo, sha, id, type, title, summary, status, project}` — blame a line, get the why |
| `GET /v1/changes?since=&project=&limit=` | `recent_changes`'s REST twin; audit review | the remote audit trail: a git-log projection over `nodes/` → `{changes: [{id, change, commit, date, committed_by, type, title, authored_via, author}], count, head, since, generated_at}`, newest change per node first. `since` is a 7–40 hex sha (`sha..HEAD`) or a date/relative phrase git understands (`--since`); an unresolvable sha is `422`. `project` scopes to one project's nodes (deletions are omitted when scoped, their project being gone). `limit` bounds nodes returned (default 100, **max 500**). Each entry's `authored_via` is the current machine-vs-human signal (`capture`/`distill`/`gardener` = machine). Lets a remote client review what agents wrote without the whole `/v1/export` tarball |
| `POST /v1/capture` | distill, /spor:defer | `capture` semantics: `{text, context: {project, during, blocks?, needed_by?}, source?}` → ingestion model + validate + commit → `{status, ids, nodes, summary, warnings}`. `source: "distill"` marks backstop captures in the journal. `context.blocks` (a node id, must exist) and `context.needed_by` (`YYYY-MM-DD`) declare a cross-project dependency (task-cc-xproject-dependency-loop): set `context.project` to the SERVING project and the server attaches a `blocks` edge to the requester + the deadline deterministically (not via the model) onto the primary node. A missing `blocks` target is `404`; a non-date `needed_by` is `422` — both rejected before any model call |
| `POST /v1/distill/report` | distill | sweep telemetry, journal-only (no store mutation): `{facts, captured?, spooled?, rejected?, project?, session?}` → `{status: "reported"}`; zero-fact sweeps report too |
| `POST /v1/corrections` | /spor:correct | `propose_correction` semantics → 201 `{status, id, revision, warnings}` |
| `GET /v1/queue?project=&assignee=&limit=&offset=` | /spor:next, session-start | the ranked decision queue: `{items, count, offset, returned_count, total_count, truncated, next_offset, counts_by_type, counts_by_project, counts_by_suggest, muted?, dormant?, questions, findings, policy?, generated_at}` — items retired by a live resolves/answers edge are excluded; items hidden by the viewer's `queue_mute` or parked by a future `wake:` date (QUEUE.md §4) are counted, never silently dropped; `questions`/`findings` are the routed-to-me-plus-unrouted views for the authenticated identity. `limit` is the page size (default 20, **max 100**, clamped not rejected) and `offset` skips that many items in the ranked order (default 0); the `counts_*`/`total_count` aggregates always cover the FULL ranked set regardless of the page, so one call answers "how many issues vs tasks" without paging, while `truncated`/`next_offset` let a client walk the rest by re-requesting with `offset=next_offset` until `next_offset` is null. Pagination is offset over a point-in-time ranked slice (the queue re-ranks every call), not a cursor — it resumes the same slice only across an unchanged ranking. `project` resolves through the shared up-resolution (dec-spor-queue-slug-resolves-to-grouping): a bare repo slug unions its home-project grouping's member queues, the repo NODE id (`repo-<slug>`) pins one repo, a grouping id (`proj-<slug>`) is used directly. `assignee=<person-id>` scopes to the work that person carries (their `assigned`/`stewards` edges) — a manager's "who is carrying what"; `assignee=me` binds to the caller (empty if the token maps to no person node) |
| `POST /v1/questions` `{text, title?, mentions?}` | ask_question's REST twin | file a question node; deterministically routed to the steward of the closest relevance-neighborhood node, unrouted if none → 201 `{status, id, routed_to, via, asker, revision, warnings}` |
| `POST /v1/gardener` | ops cron / on demand | run a gardener sweep now; findings filed as queue items → `{filed, resolved, ..., generated_at}` |
| `GET /v1/lens/{id}/render?format=html\|text\|json` | browsers, teammates without a checkout | run a lens OR workspace node and render its view tree (html default, plain text, or the raw tree as json). Read-only — no action forms; writes stay with `/v1/nodes` and the MCP tools. Auth is the caller's bearer header OR a signed read-only **render ticket** for shared links (browser links can't carry an Authorization header): `?ticket=<blob>` is accepted once and exchanged via a 302 for an HttpOnly `spor_render_ticket` cookie (kept out of URLs, logs, and view-to-view hrefs). The ticket binds `$viewer` to the recorded sharer and the render shows a "Viewing as &lt;sharer&gt;" banner. The former `?token=<PAT>` sharing path is **removed** — a shared link can never carry a write-capable credential |
| `POST /v1/lens/{id}/ticket` `{expires?}` | sharing a view | mint a signed, expiring, read-only render ticket for the lens/workspace, recording the authenticated caller as the sharer → `{ticket, url, lens_id, sharer_person_id, exp}`. `expires` is `<N>d` or an ISO date (default `7d`, max `30d`); the caller must be bound to a person node (else `422 no_person`). The ticket carries no write scope and is honored only on the render route |
| `GET /v1/export` | bootstrap/offline | ustar tarball of `nodes/` for seeding a local read replica (`?gzip=1` compresses); see §5 for the response headers. `curl … \| tar x` reproduces `nodes/` byte-for-byte |
| `GET /v1/admin/tokens` | offboarding / audit | list PATs → `{tokens: [{hash_prefix, person, name, email, created, expires, expired}], count}` — never plaintext, never full hashes. Admin-only (§4) |
| `POST /v1/admin/tokens` `{person, expires?}` | onboarding | mint a PAT bound to an existing person node (`expires` is `<N>d` or an ISO date) → 201 `{token, hash_prefix, person, name, email, expires}`; the plaintext `token` is returned **once**. Admin-only |
| `DELETE /v1/admin/tokens/{hash-prefix}` | offboarding / rotation | revoke the single PAT matching the hash prefix (≥8 hex chars; an ambiguous prefix is a 409) → `{revoked, hash_prefix}`. Admin-only |

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
SPOR_SERVER=https://spor.example.com
SPOR_TOKEN=spor_pat_...                # per-user token (§4)
```

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
