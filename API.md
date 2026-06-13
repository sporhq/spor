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
  "target":   "node id or \"global\"",
  "pin":      ["spec-actor-model"],
  "exclude":  ["art-stale-notes"],
  "guidance": "free text injected into compiles for the target",
  "title":    "one line"
}
```

The server generates the `corr-<target>-<n>` id (next free ordinal), builds
the node per GRAPH.md, and routes it through the same write path. `target`
must exist or be `global`.

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
"limit"?: 20 }` → `{ "items": [{id, title, type, status, priority, score,
signals: {blocking, heat, staleness, age_days}, suggest: "do|close", why}],
"count": N, "questions": [] }` — queueable live nodes ranked by the default
blend, each with a one-line *why*. Items already retired by a live inbound
resolves/answers edge are excluded whatever their status field reads; open
gardener findings ride along per item as `findings`. Structured output
additionally carries `view` — the queue projected into the view-tree catalog
for the MCP-app widget (below).

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
terminal rendering for the model. Unknown `lens_id` errors with the list of
available lenses; engine failures (missing param, broken blocks) error with
the message verbatim.

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
| `GET /v1/briefing/{project}` | session-start | read the `brief-<project>` node → `{found, version, body, graph_status}`. The slug resolves through project-node aliases (GRAPH.md "Project identity nodes") before lookup. Optional `?fp=root:<sha>,remote:<host/path>,...` carries the repo's fingerprints: the server learns them onto the owning project node, and an unknown slug with a known fingerprint files an alias proposal in the queue |
| `POST /v1/digest` `{query, min_sim?}` | prompt-context | digest-mode compile → `{found, text}`; `found: false` is a successful empty result |
| `GET /v1/nodes/{id}` | /spor:brief | `get_node` semantics; when a live inbound resolves/answers edge contradicts a still-open status the response carries `resolution`, and open gardener findings about the node ride along as `open_findings` |
| `POST /v1/nodes` | drain-outbox, mechanical writers | `put_node` semantics, batch: `{nodes: [...], if_exists: "skip"}` (entries may be raw strings or `{node, if_exists, revision}`) → `{results: [...]}`, 207 when any entry failed |
| `POST /v1/nodes/{id}/edges` `{type, to}` | scripts, mechanical writers | `add_edge` semantics (§1): normalize/flip, dedupe, append — no revision echo |
| `POST /v1/nodes/{id}/status` `{status}` | scripts, mechanical writers | `set_status` semantics (§1): one-scalar update through the `transitions()` gate |
| `POST /v1/nodes/{id}/commits` `{repo, sha}` | post-tool / link-commits | `link_commit`: append `repo@sha` to the node's `commits:` list (kebab-case repo slug, 7–40 lowercase hex, ≤40 commits per node); idempotent, prefix-aware dedup |
| `GET /v1/commits/{sha}?repo=` | sessions doing git archaeology | sha → nodes lookup over the `commits:` fields (≥7 hex, abbreviated or full); each match carries `{repo, sha, id, type, title, summary, status, project}` — blame a line, get the why |
| `POST /v1/capture` | distill, /spor:defer | `capture` semantics: `{text, context: {project, during}, source?}` → ingestion model + validate + commit → `{status, ids, nodes, summary, warnings}`. `source: "distill"` marks backstop captures in the journal |
| `POST /v1/distill/report` | distill | sweep telemetry, journal-only (no store mutation): `{facts, captured?, spooled?, rejected?, project?, session?}` → `{status: "reported"}`; zero-fact sweeps report too |
| `POST /v1/corrections` | /spor:correct | `propose_correction` semantics → 201 `{status, id, revision, warnings}` |
| `GET /v1/queue?project=&limit=` | /spor:next, session-start | the ranked decision queue: `{items, count, muted?, dormant?, questions, findings, policy?, generated_at}` — items retired by a live resolves/answers edge are excluded; items hidden by the viewer's `queue_mute` or parked by a future `wake:` date (QUEUE.md §4) are counted, never silently dropped; `questions`/`findings` are the routed-to-me-plus-unrouted views for the authenticated identity |
| `POST /v1/questions` `{text, title?, mentions?}` | ask_question's REST twin | file a question node; deterministically routed to the steward of the closest relevance-neighborhood node, unrouted if none → 201 `{status, id, routed_to, via, asker, revision, warnings}` |
| `POST /v1/gardener` | ops cron / on demand | run a gardener sweep now; findings filed as queue items → `{filed, resolved, ..., generated_at}` |
| `GET /v1/lens/{id}/render?format=html\|text\|json` | browsers, teammates without a checkout | run a lens OR workspace node and render its view tree (html default, plain text, or the raw tree as json). Read-only — no action forms; writes stay with `/v1/nodes` and the MCP tools. Accepts `?token=<PAT>` on this route only (browser links can't carry an Authorization header; the request log records the pathname, never the query) |
| `GET /v1/export` | bootstrap/offline | ustar tarball of `nodes/` for seeding a local read replica (`?gzip=1` compresses); see §5 for the response headers. `curl … \| tar x` reproduces `nodes/` byte-for-byte |

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
  admin with `spor-mint-token` on the server box. Send
  `Authorization: Bearer <token>` on every request. Tokens grant full
  read/write — the trust model is "everyone on the team can read and write
  the team graph", same as a shared repo. Transport is HTTPS only.
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

Unauthenticated MCP calls are hard-rejected — there is no anonymous author.

## 5. Errors and wire constants

Non-2xx responses carry the envelope:

```json
{ "error": { "code": "...", "message": "...", "details": [...] } }
```

Codes and their HTTP statuses: `unauthorized` 401, `not_found` 404,
`conflict` 409, `transition_denied` 409, `lease_expired` 409,
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
