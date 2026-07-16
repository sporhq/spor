# Spor graph format

> **Status: seed schema pack, not the contract.** As of QUEUE.md §2 rollout
> step 1, the ontology below (node types, prefixes, edge types, weights, the
> norm ride-along, briefing/correction traversal exclusion) is data, not code:
> it ships as schema nodes in `lib/seed/` and is loaded as the registry
> default for any graph that carries no schema nodes of its own. A
> graph-resident `type: schema` node overrides or extends any entry here.
> This file remains accurate documentation of the seed pack and of the node
> file format, but when this prose and the registry disagree, the registry
> wins — see QUEUE.md §2. To read the LIVE registry (seed + resident overrides
> merged, provenance-tagged) rather than this prose, run `spor schema`
> (`spor schema <type>` for one type's gates) or `GET /v1/schema` — don't
> reverse-engineer the contract from `lib/seed/` files
> (task-spor-schema-introspection-surface).

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
  System `created_at`/`updated_at` are NOT stored in node bytes — they are
  derived from the graph repo's git history into an in-memory `graph.timestamps`
  index at `loadGraph` (the FIRST commit touching `nodes/<id>.md` is `created_at`,
  the LAST is `updated_at`), so node files stay byte-identical and git stays the
  single source of truth (dec-spor-git-derived-timestamps). The index is lazy
  (off the no-LLM prompt path), HEAD-keyed and cached under `cache/`. An optional
  explicit frontmatter `created_at`/`updated_at` OVERRIDES the git-derived value
  (the escape hatch for squash/rebase graphs); `date` is the last-resort fallback
  when git has nothing — it stays distinct from the system `created_at`.
- `author` and `authored_via` are optional. The remote server (see API.md
  §1) stamps `author: Name <email>` and `authored_via:
  mcp|rest|capture|gardener` from the authenticated identity on every node
  it writes (`capture` marks nodes drafted by the ingestion path, QUEUE.md
  §2.3; `gardener` marks sweep findings, §6); any payload-supplied value is
  discarded. Both are simple `key: value` scalars. Locally written nodes may
  omit them.
- Edges may point at ids that don't exist yet; the compiler skips them. Don't
  delete an edge just because the target is missing — it marks a node worth
  creating. An edge may also carry extra flat attributes after `to:` —
  `- {type: assigned, to: agent-X, profile: profile-Y}` — preserved on the edge
  object (the per-assignment profile override; see "The agent orchestration
  layer"). Plain `{type, to}` edges are unchanged.
- `commits` is an optional list of repo-qualified git shas (kebab-case repo
  slug + 7–40 hex), inline (`commits: [wf@1a2b3c4d, ...]`) or as a YAML block
  list (`commits:` followed by indented `- wf@1a2b3c4d` lines — both forms
  parse to the same array), linking the node to the code commits that
  implement it (task-cc-commit-linking).
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
| decision   | `dec-`    | a choice that was made, with the why (status `active`/`superseded`/`rejected`/`settled`, gated; `settled` = in force but acknowledged as just-context, exempt from the gardener decay-sweep — optional `reviewed_at` ISO scalar snoozes that sweep) |
| task       | `task-`   | active or planned work (status `open`/`active`/`done`/`abandoned`, gated; `done` requires a `decision`/`artifact` resolver — see below) |
| issue      | `issue-`  | a defect/finding and its resolution lineage (queueable: open issues join the decision queue; status `open`/`active`/`resolved`, gated; `resolved` requires a `decision`/`artifact` resolver — see below) |
| incident   | `inc-`    | something that went wrong in operation (queueable: live incidents join the decision queue) |
| artifact   | `spec-`, `art-` | a document, spec, module, or build product worth referencing; when it represents a change it may carry an optional delivery-stage status `in-review`/`approved`/`merged`/`released` — see below |
| norm       | `norm-`   | a standing convention or constraint (rides along in every project-relevant compile) |
| briefing   | `brief-`  | a compiled briefing (output of this system; never traversed) |
| correction | `corr-`   | standing fix to a briefing: pin/exclude/guidance (never traversed) |
| question   | `question-` | a routed ask the graph could not answer (queueable; status `open`/`answered`, gated) |
| person     | `person-` | a member of the org — mutable display name plus the identity anchor for `$viewer` binding and Tier-2 question routing (team mode; see "People, routing, and onboarding") |
| organization | `org-` | a durable organization identity anchor; people connect with `member-of-org` for membership and `stewards` for org-admin authority (`org-root` remains the virtual graph-wide operator anchor) |
| agent      | `agent-`  | a person-owned automation principal — a dispatched session's durable identity, owned by a person via an `owned-by` edge; its writes attribute "agent on behalf of person" (see "Agents") |
| profile    | `profile-`| a reusable runtime+capability bundle an agent runs under: `harness`, `model`, `skills`/`plugins`/`mcp`. Its runtime fields ARE the dispatch satisfiability spec; `capturable: false` (see "The agent orchestration layer") |
| routine    | `routine-`| owner-scoped trigger→action automation (`owned-by` a person): declarative `when → do` rules over graph events that dispatch only the owner's agents, AND-ed with org policy; `capturable: false` (see "The agent orchestration layer") |
| capture-pending | `cap-` | raw captured text that fit no schema; filed by the server for later triage (QUEUE.md §2.3); born status-less, closed only as `merged` (content now in proper node(s)) or `rejected` (no durable fact) — a `transitions()` gate rejects other statuses at write time |
| finding    | `find-`   | a gardener observation about another node, filed as a queue item (QUEUE.md §6) |
| repo       | `repo-`   | durable git-repo identity: slug aliases + repo fingerprints; heals renames at read time (below) |
| project    | `proj-`   | a grouping above repos; owns its member repos via inbound `grouped-under` edges (below) |
| lens       | `lens-`   | a saved view over the graph — declarative `## query`/`## render` json blocks, an optional sandboxed `## custom` js block, and an optional `## actions` block; `traversable: false` and `capturable: false` (see "Lenses") |

## Completing work needs a durable why (the resolver gate)

A `task` reaching `done`, or an `issue` reaching `resolved`, requires a **live
inbound `resolves` edge from a `decision` or `artifact` node** — the
completion-resolver gate in those types' `transitions()`
(task-cc-terminal-status-requires-resolver). The point is that the outcome
lives ON THE GRAPH, where the neighborhood can surface it, instead of evaporating
into a status flip: a heavyweight closure earns a `decision` (the why), a
trivial one earns a few-line `artifact` (what was done, like a commit message) —
either satisfies the gate. `abandoned` (task) is exempt: won't-do work produces
nothing to record. The gate runs at write time on **both create and update**
(issue-spor-node-create-ungated-for-completion-resolver-gate): a node may no more
be BORN terminal without a resolver than flipped there. A create is not a
transition, so the host calls `transitions()` with `current` = the proposed node —
state-framed gates like this one apply to the born status, while change-framed
gates (status-change-requires-author) see no transition. It is backward-readable,
so existing terminal nodes are untouched.

Because the gate runs per node at write time, **a born-terminal node needs its
resolver to already exist on the graph**, which has one ordering consequence for
automated multi-node writers. A batch `POST /v1/nodes` applies its entries
sequentially — each is fully validated before the next — so a batch that lists a
born-terminal node BEFORE the `decision`/`artifact` that resolves it is rejected
(`transition_denied`) on that node, even though the resolver appears later in the
same batch. The batch path does **not** defer the gate to end-of-batch
(dec-spor-batch-create-gate-resolver-first-ordering): the contract is
**resolver-first ordering** — emit each resolver before the terminal node it
resolves, or build the node open→resolve→done. The normal authoring flow
(create-open → record outcome → set_status) and `/spor:backfill` (whose
`spor-backfill` subagent orders resolvers first) both satisfy this by
construction; local-mode file writes are ungated and so order-free.

The resolver must also be in a **resolving** state, not merely present
(dec-spor-definition-of-done-org-policy). Completion bundled three axes —
*recorded* (a why exists), *reviewed*, and *delivered* — and a resolver that is
a change still in review has not delivered. So:

- An `artifact` representing a change may carry a delivery-stage status:
  `in-review`/`approved` are **non-resolving** (they keep the resolved target
  live); `merged`/`released`, and any other/empty status, are **resolving**.
  Plus flat scalar metadata the regex frontmatter parser already supports —
  `delivery_ref` (PR url/commit/tag), `delivery_source` (e.g. `github`),
  `size`, `labels`, `paths` (comma-scalars). The shape is source-blind, so a
  GitHub reflection adapter and a native Spor review surface write the same
  thing. Who may assert `merged`/`released` (the self-approval trust seam) is
  later-stage policy, not a write gate here.
- The read-time truth (`resolutionMap`) and the write-time completion gate (a
  task reaching `done`, an issue reaching `resolved`) both read this
  **resolving-status partition off `graph.registry`** — never a hardcoded
  table. The partition is the union of each node-schema's `status.non_resolving`
  list; the seed declares `decision: [rejected]`, `task: [abandoned]`,
  `artifact: [in-review, approved]`, reproducing the prior behavior
  byte-identically (`issue` carries no `status.non_resolving` of its own — its
  `open`/`active`/`resolved` vocabulary names no withdrawn or in-review state, so
  the type only READS the partition). An org or team retunes the bar by editing a
  schema node, no code change. A resolver with no delivery stage (the common
  case) resolves exactly as before, so a change still in review keeps its task or
  issue live without any hand-managed `open` status.

## The org-defined policy layer

"What it takes to reach a resolving/done state" beyond the native floor —
quorum, qualified approvers, agent-vs-human distinctions — lives in **`policy`
nodes**, a reserved schema kind layered ON TOP of the per-type
`transitions()` gate (task-cc-policy-layer, dec-spor-policy-layer-activate;
dec-spor-definition-of-done-org-policy Stage 2). A policy node is an ordinary
`type: schema` node with `kind: policy`, a `governs` scope block in its fenced
`json` payload, and an attached fenced `js` block exporting
`gate(current, proposed, view) -> { allow, reason? }`. The payload declares the
scope; the gate is the rule. For example, a policy `governs`-ing tasks in
project `my-team` with a payload `{ "governs": { "types": ["task"], "projects":
["my-team"] } }` and a `gate` that, on a `done` transition, counts
`view.approvals` whose `roles` include `reviewer` and denies unless there are at
least two — the definition-of-done quorum gate.

- **Selection is governs-traversal.** `governs.types` restricts the policy to
  those node types, `governs.projects` to those project slugs; an absent or
  empty axis means "any". A node is governed by every policy whose every
  present axis matches it — so an org-wide policy (no `governs`) and a
  team-scoped one can both apply, most-specific first.
- **The gate is AND-ed with `transitions()`, never replaces it.** Every
  governing policy's `gate()` must also `allow` the write; any deny stops it.
  A policy can only ADD a constraint — it can never loosen a type's
  `transitions()` or the native self-approval floor beneath both
  (dec-cc-policy-floor-now-layer-deferred). Like `transitions()`, the gate is
  fail-closed (a crashing gate denies) and runs on UPDATE only.
- **Approvals are review edges.** The gate context carries `view.approvals`:
  the node's own `reviewed-by`/`approved-by` edges to `person` nodes, each
  joined to that person's `roles` register, with the node's own author
  excluded (the self-approval floor — a policy can't be used to launder it).
  The first concrete rule is the **definition-of-done quorum gate**: a work
  node's `done` transition additionally requires a quorum of approvals from
  qualified roles. The `review-requested`/`reviewed-by`/`changes-requested-by`
  edge types ship in the seed pack (review-as-graph-object); a single edge
  flips type in place across the review lifecycle, `reviewed-by` is what the
  quorum counts, and an open `review-requested` edge surfaces the node in the
  named reviewer's queue. The gate context also carries `view.changes_requested`
  (the `changes-requested-by` edges, same author-excluded shape) so a policy
  may block `done` while a qualified reviewer's change request is outstanding.
- **Policy nodes go through the same proposal/activation flow they govern** —
  a proposed policy is inert until a *different* identity activates it (the
  native floor protects against self-amendment circularity).

## Authoring a custom schema

A team extends the ontology by writing a `type: schema` node into its graph (it
overrides or extends the seed pack; QUEUE.md §2). This section assembles one
end-to-end — the seed pack documents the JSON payload and the attached code
separately, but never shows a complete custom type in one piece.

**The constraint model is procedural, not declarative.** A schema's `json`
payload declares only *registry knobs* — `node_type`, `prefix`, `queueable`,
`traversable`, `always_on`, `capturable`, an edge `weight`, and the three status
partitions: `status.non_resolving` (resolver semantics — whether a node in this
status retires the targets it points at), `status.terminal` (own-lifecycle
completion — the statuses in which a node of this type is *done*, unioned with the
kernel's legacy set and read by work-analytics so a schema-only terminal status
like decision `settled` counts as completed,
issue-spor-analytics-completion-ignores-schema-terminal-status), and
`status.inert` (queue-liveness-dead — the per-type overlay the type-aware
`isTerminalStatus(status, type, graph)` unions with the type-blind
`terminal-status` register below; a schema that declares no `inert` set
INHERITS its `terminal` set, so only a schema whose two sets genuinely differ
declares it — the seed decision schema pins `settled` terminal but NOT inert,
dec-spor-status-inert-third-partition). There is **no
declarative field list and no status enum.** Custom fields are free-form: any flat frontmatter key the
regex parser accepts (simple `key: value` scalars, YAML-folded multi-line
values, `pin:`/`exclude:` inline lists, `- {type: X, to: Y}` edges — and nothing
fancier) is carried verbatim on the node. What a field MUST contain, and which
status changes are legal, are enforced **in attached code** — two pure functions
the server runs on the write path:

- **`validate(node) -> string[]`** — the door. Runs on **every write (create
  AND update)**. It receives the parsed proposed node and returns an array of
  human-readable error strings; `[]` means accept. A non-empty array rejects the
  write (`invalid_node`), each string surfaced to the writer as
  `<schema-id> validate(): <your message>`. This is where required/typed custom
  fields — and **status-vocabulary membership** — are enforced. Membership is a
  property of the node in isolation, so it belongs at the door, where create and
  update see it alike; the seed `task`/`issue`/`decision`/`question`/
  `capture-pending` schemas check it here. Putting it ONLY in `transitions()`
  (update-only) let a node be BORN with an off-vocabulary status that a later
  re-validating write then rejected (issue-spor-node-create-bypasses-status-
  vocabulary); `validate()` and `transitions()` share one `VALID` list so the
  two paths can't drift.
- **`transitions(current, proposed, view) -> { allow, reason? }`** — the
  *transition* gate. Runs on **every write (create AND update)**. On UPDATE
  `current` is the stored node (or `null` if its file is unparseable); on CREATE
  there is no prior state, so the server passes `current` = the proposed node — a
  create is *not* a transition. This is where state-machine legality and the
  completion-resolver gate live. Frame each rule by what it judges:
  **state-framed** rules read `proposed.status` (the completion-resolver gate, a
  quorum policy) and so apply to a node's status however it was reached —
  including a BORN-terminal create, so a task cannot be created `done` nor an
  issue `resolved` without a resolver
  (issue-spor-node-create-ungated-for-completion-resolver-gate); **change-framed**
  rules read `current.status !== proposed.status` (status-change-requires-author,
  no-reopen) and, seeing `current === proposed` on a create, correctly pass.
  `proposed` is the incoming node, and `view` is a read-only join the server
  computes for the gate:
  - `view.targets[id]` — `{ exists, type, status, superseded }` for each node
    this one points an edge at (outbound);
  - `view.resolvers` — live **inbound** `resolves`/`answers` edges pointing at
    this node, each `{ id, type, status }`, already filtered to *resolving*
    states (a withdrawn or in-review resolver is excluded). This is how a type
    requires a durable outcome on the graph before going terminal (the resolver
    gate the seed `task`/`issue` schemas use);
  - `view.non_resolving_statuses` — the registry's resolving-status partition,
    if the gate wants to judge resolver states itself;
  - `view.actor` — `{ name, email, via }`, the authenticated writer (for
    ownership/role gates);
  - `view.approvals` — the node's review edges to `person` nodes joined to their
    `roles` (the quorum-gate input; the writer's own self-approval is excluded).
  Return `{ allow: true }` to permit, or `{ allow: false, reason: "…" }` to deny
  with an actionable message.

Both hooks are **sandboxed, pure, and fail-closed**: the server runs them in a
QuickJS-in-wasm sandbox (`SPOR_SANDBOX=vm` is an ops-only escape hatch) across a
strict JSON boundary — arguments arrive as plain guest data and only JSON-clonable
return values cross back, so `require`, `process`, `eval`, the `Function`
constructor, host prototypes, ambient time/IO, and unbounded loops are all
unavailable (a runaway hits a fuel/memory interrupt). A hook that throws does not
wave the write through — it **rejects** it. Write the functions accordingly: no
external state, no side effects, decide only from the arguments. Three more
attached exports are recognized: `queueSignals(node, ctx)` (a `{ name: number }`
map blended into the decision-queue ranking); `get(node, ctx)` — the **read-time
enrichment** hook, run on `get_node`, returning an object whose keys ride along on
the read. Where `transitions()` is the write-time gate, `get()` is its read-time
peer: the server hands it a *bounded one-hop neighborhood* (`ctx.neighbors` — this
node's inbound + outbound edges each with the neighbor's `{id, edge, dir, type,
status, title, summary, date, superseded}`, capped — plus `ctx.non_resolving_statuses`
and `ctx.terminal`), and the hook attaches derived context — e.g. an answered
`question` surfacing WHAT answered it. It is read-only and **fail-soft** (a throw
drops the enrichment, never breaks the read; the only hook that fails open rather
than closed); reserved core keys (`id`/`raw`/`frontmatter`/`revision`) can't be
clobbered. The seed `question`/`issue`/`task`/`incident` schemas carry one, the
single mechanism that expresses the resolution ride-along. Finally, named upgrade
functions referenced from `payload.upgrades` (lazy, forward-only field migrations
on a `schema_version` bump). The **client** half (hooks, the `spor` CLI, `lib/`)
only *parses and indexes* this code for the registry knobs — it never executes it;
the server is the sole executor.

Resolution and rollout: a graph-resident schema always beats the seed pack, and
within a source the higher CalVer `schema_version` wins, so an override must be
bumped in lockstep with seed changes or it silently shadows them (`validateGraph`
warns). A schema node goes through the same propose→activate flow it governs — a
*different* identity must activate it (or a trusted admin git-writes it `active`);
bump the CalVer and add an `upgrades` chain only when the change is not
backward-readable.

A complete worked example — a `escalation` type with a required `severity`
field (enforced in `validate`) and an `open → mitigated → closed` status machine
whose terminal `closed` demands a resolver (enforced in `transitions`):

````markdown
---
id: schema-escalation
type: schema
kind: node-schema
schema_version: 2026.06.16.1
title: Custom schema for customer-escalation nodes
summary: A customer escalation with a severity field and an open/mitigated/closed status machine; closing one requires a decision or artifact that resolves it.
status: active
date: 2026-06-16
---

Escalation nodes track a customer-facing incident from raise to close.
`severity` is a free-form frontmatter field this schema makes mandatory and
constrains in `validate()`, alongside status-vocabulary membership (the door
runs on create AND update, so the two paths agree on the enum); the close-time
resolver gate lives in `transitions()`, which also runs on create (with `current`
= the proposed node). Because that gate is *state-framed* — it reads
`proposed.status` — it stops a born-`closed` escalation exactly as it stops a
close transition. Both are the same procedural model the seed types use — there is
no declarative field or status enum to fill in.

```json
{
  "node_type": "escalation",
  "description": "a customer-facing escalation and its resolution lineage",
  "prefix": ["esc-"],
  "queueable": true
}
```

```js
// The status vocabulary, shared by validate() (membership; create AND update)
// and transitions() (the close-time gate; runs on every write) so the two paths
// agree on the enum (issue-spor-node-create-bypasses-status-vocabulary).
const VALID = ["open", "mitigated", "closed"];

// validate(node) — runs at the door on EVERY write (create and update). Returns
// an array of error strings; [] accepts. Enforce node-in-isolation properties
// here: the free-form custom field (no payload field list, so a required/typed
// field is code) AND status-vocabulary membership — checking membership at the
// door is what makes create and update agree on the enum (a node can never be
// born with an off-vocabulary status that the close gate below would reject).
export function validate(node) {
  const errors = [];
  const VALID_SEVERITY = ["sev1", "sev2", "sev3"];
  if (!node.severity) {
    errors.push("escalation requires a severity field (sev1 | sev2 | sev3)");
  } else if (VALID_SEVERITY.indexOf(String(node.severity)) === -1) {
    errors.push("invalid severity '" + node.severity + "': use sev1, sev2, or sev3");
  }
  const s = ((node && node.status) || "").toLowerCase();
  if (s !== "" && VALID.indexOf(s) === -1) {
    errors.push("invalid escalation status '" + s + "': valid statuses are " +
      "open, mitigated, closed — or none, meaning live");
  }
  return errors;
}

// transitions(current, proposed, view) — runs on every write; returns
// { allow, reason? }. On create there is no prior state, so `current` is the
// proposed node (a create is not a transition). Gates the *transition*, not
// membership (validate() owns that): closing requires a durable outcome on the
// graph, and because the check is state-framed (it reads proposed.status) it
// also stops a born-`closed` create. Empty status (status-less = live) is allowed.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // closed must record a durable outcome on the graph: a decision or artifact
  // that resolves this escalation (an inbound resolves edge). view.resolvers is
  // already filtered to resolving states, so an in-review fix does not count.
  if (next === "closed") {
    const rs = (view && view.resolvers) || [];
    const ok = rs.some((r) => r.type === "decision" || r.type === "artifact");
    if (!ok) {
      return {
        allow: false,
        reason: "closed requires a decision or artifact node that resolves this " +
          "escalation (an inbound resolves edge) — record how it was handled on " +
          "the graph so the neighborhood can surface it",
      };
    }
  }
  return { allow: true };
}
```
````

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

Project scope resolves to the whole home-project **grouping union**, so a
grouping that deliberately spans heterogeneous repos (a terraform IaC repo, a
Go service, a Python service) would still cross-pollinate norms. A norm may
**narrow** its ride-along with optional flat `applies_to_*` selectors, matched
against the session's OWN repo (task-cc-norm-ride-along-repo-tag-scope):
`applies_to_tags: [python]` (∩ the session repo node's `tags`, schema-repo),
`applies_to_repos: [repo-x]` (the session repo), `applies_to_projects:
[proj-y]` (a grouping the session repo belongs to). Matching is OR across axes,
ANY within an axis — deliberately unlike the policy layer's `governs`
(AND-across-axes). A norm that declares any `applies_to_*` and matches none is
**excluded** (strict, including in a repo with no `tags` — repo tagging is the
opt-in that turns scoped norms on; set them with `spor repos tag <slug>
<tag...>` rather than hand-editing the `repo-<slug>` node); a norm with none
keeps the project-scoped behavior above, so a graph using no `applies_to_*` is
byte-identical (norm-cc-byte-identical-refactor).

A norm may also declare **coupling anchors**
(dec-spor-coupling-norms-declared-first): two flat inline lists, `couples_when:`
(trigger file globs — "when files matching these change") and `couples_also:`
(the coupled artifacts that should change in the same edit, or be consciously
dismissed). A norm carrying both becomes a **coupling norm**: the post-tool
hook glob-matches every Write/Edit's repo-relative path against the trigger
sets and, on a hit, injects the targets as an edit-time nudge — once per
session per norm, deterministic, no LLM (task-spor-coupling-nudge-posttool;
`SPOR_COUPLING_NUDGE=0` disables). The glob dialect is small: `**` crosses
path segments, `*` stays within one, `?` is one character, a trailing `/`
means the whole subtree, and a bare `API.md` anchors at the repo root. An
entry may be **repo-qualified** as `<slug>:<glob>` (or `repo-<slug>:<glob>`)
so one norm couples artifacts across repos — a qualified trigger fires only in
that repo and bypasses the norm's scope (the pin IS the scope), while an
unqualified trigger applies wherever the norm itself applies: its
`applies_to_*` selectors when declared, else its `project:` stamp (unstamped =
every repo — the org-wide case, e.g. `couples_when: [.nvmrc]` /
`couples_also: [Dockerfile]`). Targets may be qualified the same way for
display. Either key alone, a scalar value, or the keys on a non-norm type are
inert (validate warns). The matcher is `lib/kernel/coupling.js`; a graph with
no coupling norms is byte-identical.

The boundary-time consumer of the same anchors is **`spor check`**
(task-spor-cli-check-coupling-verb): given a change set (uncommitted vs HEAD
by default; `--staged`, `--range a..b`, or `--files`), it reports each
coupling norm whose triggers are touched while its same-repo targets are not —
advisory by default, `--strict` exits 1 for CI/pre-commit; targets pinned to
another repo surface as reminders, never failures. A coupling norm may
additionally declare a machine-checkable **value invariant** — two scalar
keys, `couples_value_a:`/`couples_value_b:`, each `<path>#<regex>` (first
capture group = the value, e.g. `couples_value_a: .nvmrc#v?(\d+)` /
`couples_value_b: Dockerfile#FROM node:(\d+)`) — and `spor check` compares the
two extracted values: "these now disagree" beats "you probably forgot", an
agreeing invariant suppresses the untouched heuristic, and a disagreement
reports even when both files were touched. A half-declared or malformed pair
is inert (validate warns).

An in-repo tracked symlink (`frontend -> packages/web`) has two valid
repo-relative spellings for the same file, and the matcher tests a glob
against every candidate spelling it is HANDED
(task-spor-coupling-matcher-symlink-alias) — but deriving those candidates is
one-way: it can turn an alias spelling into its git-resolved canonical form,
never the reverse. A coupling glob authored against an alias
(`couples_when: [frontend/**]`) therefore still misses an edit reported only
under its canonical path (`packages/web/app.js`) — the environment may hand
the matcher an already-resolved path with no alias spelling left to derive
from — because discovering which alias points at a given canonical path would
need a filesystem-wide symlink scan, rejected as too expensive for the
edit-time hot path (dec-spor-dismiss-reverse-symlink-path-lookup,
issue-spor-coupling-matcher-reverse-symlink-gap). The declared fix is a
**coupling alias map**: `.spor.json`'s `coupling.aliases`, a flat `{ "<alias
prefix>": "<canonical prefix>" }` object (repo-root-relative on both sides,
e.g. `{ "frontend": "packages/web" }`). Every declared entry is expanded in
BOTH directions at match time, at zero runtime cost (no scanning) — a path
under either side also produces the spelling under the other side, for both
`couples_when` triggers and `couples_also` targets. **Declaring nothing is
the default posture**, and it keeps the one-way limitation above: only
author coupling globs against the canonical (git-resolved) spelling of a
symlinked subtree unless its alias is declared in `coupling.aliases`.

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
- The same flat marker can also carry a `graph: <path>` key — a per-repo
  **graph home binding** (NOT identity), for free local-mode graph sharing over
  plain git. It points the repo at a shared graph home (resolved relative to the
  marker dir) and overrides `SPOR_HOME` in local mode; a contributor with their
  own personal `SPOR_HOME` still inherits the shared graph inside the repo. See
  API.md §6.1 for the full contract (precedence, the generated `.gitignore`, and
  the distiller's PR-flow behavior).
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

- **Reads.** Every read surface (queue, brief, digest) resolves its scope token
  through one shared up-resolution step (dec-spor-queue-slug-resolves-to-grouping):
  a BARE repo slug resolves up to its home-project grouping and reads the union
  over every repo `grouped-under` it — the intuitive token returns the whole
  product, matching the project brief session-start already injects. The repo
  NODE id (`repo-<slug>`) is the escape hatch back to single-repo scope; an exact
  grouping id (`proj-<slug>`) is used directly; an ungrouped repo (or a slug no
  repo node claims) falls back to itself. So project-scoped = the grouping union,
  single-repo-scoped = that one repo via its node id. Session-start injects the
  repo brief AND the project brief.
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
read time* (API.md §4). `name` is the mutable user-facing display label; clients
render `name || title || email || id`, leaving the opaque `person-…` id as the
stable machine reference for graph edges, URLs, filters, and token subjects.
Tier-2 question routing and `$viewer`-scoped views (your queue, your mutes,
"what am I blocking") all key off the person node the caller's token is bound
to.

On a shared identity front door, organization authority is also graph-native.
Each org slug has a durable `organization` node (`org-<slug>`, carrying
`slug: <slug>`). A person's `member-of-org -> org-<slug>` edge records membership;
an additional `stewards -> org-<slug>` edge records org-admin authority.
`stewards -> org-root` keeps its distinct graph-wide operator meaning. Provider
roles, token bits, and email-domain mappings do not confer either relation.
`org-root` is a **virtual** anchor — no node ever carries that id — so the
graph-wide lint (`spor validate` / `validateGraphFiles`) special-cases
`stewards -> <rootId>` (default `org-root`, override with `SPOR_ROOT_ID`) and
never flags it as a dangling edge.

```markdown
---
id: person-anthony
type: person
name: Anthony Allen
title: Anthony Allen
summary: Maintainer; stewards the schema registry and the hook engines.
email: losthammer@gmail.com
github: losthammer
roles: [reviewer, maintainer]
queue_mute: [some-noisy-project, task-noisy-job@2026-07-01]
register: Non-technical founder. Plain everyday language, no graph jargon;
  use node titles, never raw ids. Analogies over precision.
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
- **`register` is the language-register field** (free-text folded scalar): the
  reader's role and preferred language style. Viewer-facing surfaces (the
  server's MCP instructions block and the conversational read tools' `Audience
  note` preamble) render it verbatim so the model adapts how it talks about
  graph content to this person — a non-technical user gets plain language
  instead of node-type jargon (task-spor-viewer-register-adaptation).
  Presentation only: it never changes what is returned. Settable from chat by
  updating your own person node.
- **`stewards` edges are the routing key.** A `person → node` `stewards` edge
  declares ownership of an area, spec, or norm. When a question can't be
  answered from the graph and is filed (`ask_question` / `POST /v1/questions`),
  the deterministic router walks `stewards` edges from the question's relevance
  neighborhood to the closest steward and writes a `routed-to` edge to that
  person; an unrouted question (no steward matched) surfaces to everyone.
  The question schema's `validate()` door rejects a title/summary/body that is
  ONLY an unfilled template token (`<question>`, `{{text}}`, `[id]`) so a docs
  example run verbatim can't mint an information-free routed ask
  (issue-spor-ask-question-template-placeholder-validation).
- **`assigned`** points work (task/issue) at a person; per-person queues filter
  on it (the queue's `assignee` parameter — `GET /v1/queue?assignee=<person>`,
  unioned with the person's `stewards` edges; QUEUE.md §5). **`answers`** points
  any answer node back at the `question-` it
  resolves — the answer loop is lineage, not messaging, so the asker's next
  compile pulls the answer through the question's neighborhood.
- **`queue_mute`** (flat inline list of project slugs or node ids, each with an
  optional `@YYYY-MM-DD` expiry) is per-viewer presentation only: the queue
  hides those items for this person and reports how many it hid; they stay live
  and visible to everyone else (QUEUE.md §4).
- **`roles`** (flat inline list, e.g. `roles: [reviewer, maintainer]`) is the
  qualification register the org-defined policy layer reads. A scoped `policy`
  node's gate counts approvals from persons holding a named role — the
  definition-of-done quorum gate is the first such rule (see "The org-defined
  policy layer" below). Declarative data only; absent it, a person holds no
  roles and the field has no effect.
- **`github`** (flat inline scalar, e.g. `github: octocat`) is the person's
  GitHub handle — the login→person key the Spor server's GitHub review
  reflection maps by. When a GitHub review or merge is reflected into the graph,
  the event's GitHub login is matched (case-insensitively) to the person whose
  `github` equals it, so the approval attaches to the right person's review
  edges and counts toward the policy quorum gate; `github_login` is an accepted
  alias, and an operator login→email map is the fallback. Declarative data only;
  absent it, the person can't be resolved from a GitHub login and the field has
  no effect.

### Onboarding a team member

Joining someone to a team graph is three deliberate steps — do all three or
routing degrades quietly:

1. **Author the `person-…` node** (frontmatter above), using the stable canonical
   subject chosen by the org. Prefer the CLI/admin minting paths, which default
   new ids to opaque email-derived subjects instead of mutable display-name
   slugs. Set `name` to the person's display label and `email` to the address
   the member commits and authenticates under.
2. **Add `stewards` edges** from that node to the areas/specs/norms they own.
   Without at least one steward in a topic's neighborhood, questions there route
   to no one and fall back to surfacing for everybody — answerable, but not
   *directed*.
3. **Mint a token bound to the node:** an admin runs `spor invite --person
   person-…` / `spor invite --name <name> --email <email>`, or
   `POST /v1/admin/tokens {person}` over REST (admin-only; API.md §3/§4). The
   plaintext token is returned once.

If a member is reading and writing but **never receives routed questions, sees
an empty personal queue, or has no mutes take effect**, their token did not bind
to a person node (no node, or a token minted before the node existed). That is
the failure this section exists to prevent: today it degrades silently — the
client surfaces no warning when the authenticated identity maps to no person
node. Surfacing that unbound state in queue and briefing responses is tracked
server-side (issue-cc-onboarding-email-mismatch-silent-degradation).

### Agents (person-owned principals)

An `agent` node (prefix `agent-`) is a person's automation principal — the
durable identity of a dispatched `claude --bg` session
(dec-spor-agent-identity-nodes). It generalizes the workflow-run principal: a
dispatched session is just another principal kind owned by a person, so work it
creates reads "agent **on behalf of** person" rather than person-direct.

```markdown
---
id: agent-anthony-laptop
type: agent
title: Anthony's laptop agent
summary: Dispatched-session principal on Anthony's laptop; owned by person-anthony.
spiffe: spiffe://spor.sporhq/person/person-anthony/agent/anthony-laptop
pubkey: ""
status: active
date: 2026-06-16
edges:
  - {type: owned-by, to: person-anthony}
---
```

- **Grain: persistent, one per machine/install.** An agent node is created once
  (`spor agent create <label>`, or the admin endpoint) and REUSED across every
  dispatch — NOT one node per session. Each dispatch's Claude Code `session_id`
  is the ephemeral which-run, recorded as an additive `session:` stamp on the
  nodes it writes, not as its own node (promote to a `run-<id>` node only if run
  metadata later needs a home).
- **`owned-by` is the ownership edge** (agent → person, inverse `owns`). Like
  `grouped-under` it is a low-weight (0.3) structural identity binding, not a
  work dependency — the owner is not pulled into the agent's work neighborhoods.
  Ownership lives on this edge, NOT in frontmatter.
- **`spiffe:` / `pubkey:` are forward-compat shape, unenforced.** The `spiffe:`
  URI encodes the binding in its path
  (`spiffe://spor.<org>/person/<id>/agent/<label>`, extended to
  `…/session/<uuid>` per dispatch); `pubkey:` records the agent's key
  fingerprint (may be empty). Both adopt the SHAPE (dec-cc-spiffe-forward-compat)
  — no signature verification, JWKS, or signed commits ship in this cut.
- **Attribution stamps (additive).** Work an agent creates keeps `author:` = the
  owning person (so `$viewer`, routing, history, and the queue are unchanged) and
  ADDS `authored_by_agent: agent-<id>`, `authored_via: dispatch`, and `session:
  <id>`. These are token-derived, never from the payload
  (dec-cc-attribution-from-token); old nodes lack them and read as person-direct.
  This is purely additive — the stamp itself needs no `schema_version` bump.
- `capturable: false` (agent node and `owned-by` edge): both are created
  deliberately, never drafted from a capture or distilled from a transcript —
  mirroring `person`, `repo`, and `workflow-run`. (So the distiller's emit
  vocabulary deliberately omits `agent`/`owned-by`.)

## The agent orchestration layer

The layer ABOVE agent identity (dec-spor-agent-orchestration-layer): how work is
routed to agents, and how per-person automation fires on graph events. The node
model is `person ──owns──▶ agent ──uses-profile──▶ profile`, with owner-scoped
`routine` nodes driving automation. It composes with — never bypasses — the org
policy layer. The schemas ship in the seed pack, and so do the machine-local
`dispatch.capabilities` map + `satisfies()` matcher + fail-soft dispatch
(task-spor-dispatch-capabilities-satisfiability); the routine engine and the
remote fleet scheduler are still deferred.

### profile — the reusable runtime+capability bundle

A `profile` node (prefix `profile-`) is "the HOW" an agent dispatches under,
factored out of the agent node so a toolset is reusable across agents and people.

```markdown
---
id: profile-docs-writer
type: profile
title: Docs-writer profile
summary: Claude-code on Opus with the writing + spor skills and the spor MCP server.
harness: claude-code
model: opus
skills: [writing, brief]
plugins: [spor]
mcp: [spor]
status: active
date: 2026-06-18
---
```

- `harness:` (`claude-code` | `codex` | `opencode` | …) selects the launcher
  (dec-cc-portable-core-adapters: claude-code → `claude --bg`, others → their
  CLIs); `model:` → the harness `--model`; `skills`/`plugins` are preloaded;
  `mcp` is merged into the strict `--mcp-config` dispatch writes, so the agent's
  toolset is exactly the profile plus the agent-spor server, nothing ambient
  (dec-spor-session-identity-active-record).
- **The runtime fields ARE the satisfiability spec** — there is no separate
  requirements block (dec-spor-machine-profile-satisfiability). A machine
  declares ATOMIC capabilities in a machine-local `dispatch.capabilities` map
  (built like `dispatch.repos`, never committed), and `satisfies(machine,
  profile)` checks `profile.harness ∈ machine.harnesses ∧ profile.mcp ⊆
  machine.reachable_mcp ∧ profile.skills ⊆ machine.skills ∧ profile.plugins ⊆
  machine.plugins ∧ profile ∉ machine.deny`. No satisfying machine → dispatch
  fails soft and LOUD, leaves the assignment intact, NEVER substitutes a
  different profile. The probe seeds `reachable_mcp: [spor]` from CONFIGURED-ness
  (a bound Spor server/connector, remote mode) rather than a network ping — the
  agent-spor server is part of every dispatched session's toolset by construction
  (above), so an `mcp: [spor]` profile satisfies on a fresh box with no manual
  `allow-mcp` (task-spor-mcp-reachability-deterministic-seed). Forward-compatible
  with the deferred remote fleet scheduler (each agent publishes its capabilities;
  same vocabulary).
- **Reusable + both-scoped, with override.** Profiles are PERSONAL and
  ORG-PUBLISHED (a curated, vetted toolset), with personal override. Org-published
  profiles are where this meets policy: a policy can require that work of a risk
  class go to an agent whose profile is org-approved (curated-toolset-as-governance).
- `status:` is declarative (`active` default); `capturable: false` (created
  deliberately, never distilled).

### routine — owner-scoped trigger→action automation

A `routine` node (prefix `routine-`), `owned-by` a person, holds declarative
`when → do` rules. Triggers are graph events (a status change — e.g. to a
resolving state, or to `done` — or an edge like `reviewed-by`/
`changes-requested-by`) with `where:` filters; actions are the bounded verb set
`create-node` / `assign` (to a SPECIFIC agent, optionally with a `profile:`
override) / `dispatch` / `set-status` / `reassign` / `escalate`. Because the
regex frontmatter parser is flat, an instance carries its `rules` as a fenced
` ```json ` block in its BODY, parsed by the deferred routine engine.

Two invariants (dec-spor-agent-orchestration-layer): (1) **only the owner's
agents are ever dispatched** — the `person → routine → agent` RFC 8693 act-chain
is the audit trail; (2) **personal routines accelerate, org policy gates — they
AND, never bypass** — agent-on-behalf-of-X counts as X for the self-approval ban
and the definition-of-done quorum, so an owner's reviewer-agent cannot
auto-approve their implementer-agent's work past the org bar. Per
dec-spor-orchestration-routine-requires-threads (thread 1) the bounded
declarative register ships FIRST; attached sandboxed code is a later
schema-gated escape hatch. The routine ENGINE and its vetting (dry-run, mandatory
retry budget, self-approval-floor activation review, fire-time org-policy gate —
thread 2) are deferred, so this seed schema is declarative and UNGATED;
`capturable: false`.

### Routing is explicit assignment; the profile cascade

Routing is EXPLICIT `assigned` to a SPECIFIC target, not an eligibility match:
`assigned → person` is human work (the default human pool); `assigned → agent-X`
makes the task a dispatch candidate (X's profile says how and what it may touch).
An agent-targeted `assigned` edge may carry an optional `profile:` attribute —
the durable per-assignment override (`{type: assigned, to: agent-X, profile:
profile-Y}`, thread 3). Profile precedence, explicit wins: `--profile` dispatch
flag > assignment-edge `profile:` attribute > the agent's default `uses-profile`
edge.

### The `requires:` risk-class register

`requires:` is a flat list on a WORK node naming the risk/permission classes the
work may touch (`requires: [shell, prod-creds]`). It is a **registry-declared
extensible enum** — a `type: schema` node with `kind: register` and `register:
requires` (seed: `schema-requires`), so an org grows the vocabulary by editing a
schema node, never a code change. The kernel exposes it as a partition
(`graph.registry.requiresClasses()`); it stays policy-free. The register is
**DISTINCT from machine-satisfiability**: satisfiability asks "can this box LAUNCH
the profile"; `requires:` asks "what may this work touch", validated against the
assigned profile (a task's `requires:` must be ⊆ the profile's granted classes,
else warn/refuse) and gated by org policy via the same governs-traversal the
definition-of-done quorum uses (dec-spor-orchestration-routine-requires-threads
thread 4). The seed set is small — `shell`, `prod-creds`, `browser`, `network`,
`human`, `filesystem-write`, `paid-api`. `human` is unsatisfiable by any agent:
assign that work to a person.

### The `terminal-status` register

A second registry-declared enum (seed: `schema-register-terminal-status`,
`register: terminal-status`) names the **type-blind** status vocabulary that
retires ANY node from queue liveness (`lib/kernel/queue.js` `isLive`), briefing
"live work" surfacing (`lib/kernel/graph.js` status tag/warning), and
coupling-norm matching (`lib/kernel/coupling.js`) — the single source those two
kernel modules read (`graph.registry.registerClasses("terminal-status")`)
instead of two separately hardcoded, previously-divergent tables
(issue-spor-coupling-resolution-terminal-status-divergence). The seed set is
`abandoned`, `answered`, `closed`, `completed`, `deprecated`, `dismissed`,
`done`, `merged`, `rejected`, `resolved`, `retired`, `superseded` — only
genuinely universal completion words; a type-scoped status belongs in its
owning schema's `status.inert`/`status.terminal` instead (artifact `released`
lives there, so a non-artifact marked `released` stays live,
task-spor-terminal-status-type-aware-migration).

The full liveness check is **type-aware**
(dec-spor-status-inert-third-partition): `isTerminalStatus(status, type,
graph)` unions this register with the registry's per-type `status.inert`
overlay (declared, or inherited from `status.terminal`). The union is one-way
additive — a per-type declaration scopes a status to its own type but can
never remove a universal word. The register is **DISTINCT** from the
per-node-schema partitions above: a decision's `settled` status is terminal
for its OWN lifecycle (`status.terminal`, read by work-analytics) but is
deliberately absent from this register AND from the decision schema's
declared `inert`, so a settled decision keeps surfacing as live guidance in
queues and briefings (dec-spor-decision-lifecycle-surfacing).
`lib/kernel/coupling.js` scans node files in the hook tool loop without a
loaded graph/registry, so it (and any other graph-less caller) reads a
hardcoded fallback that reproduces this register's seed classes
byte-identically; a graph-resident override — and every per-type overlay —
only reaches callers that pass a loaded `graph`.

## Lenses

A saved view over the graph is itself a graph node (dec-lenses-as-nodes), so it
is versioned, attributed, shareable, and forkable by copying the node — the same
inversion the queue makes for prioritization, made for presentation. The seed
ships the vocabulary (`schema-lens`, `schema-edge-focuses-on`) so a fresh graph
can author views without importing a schema first; the runner that executes them
is a server surface (`render_lens`, API.md §2).

A lens body carries fenced blocks:

- `## query` — declarative select/traverse/group/sort, JSON. Required.
- `## render` — builtin renderer config, JSON. `as: custom` requires a `##
  custom` block.
- `## custom` — an optional js escape hatch, executed in the same
  no-clock/no-randomness sandbox as schema attached code, so a render is a pure
  function of (graph snapshot, lens node, params, now).
- `## actions` — optional write affordances `{id, label, on?, set, confirm?}`
  (dec-ui-actions-as-transitions): `on` selects which rendered items carry the
  affordance, `set` is a flat object of frontmatter changes (scalars or
  `"$param"` bindings; never `id`/`type`). Invoking one is exactly one
  revision-checked node update through the ordinary write path, arbitrated
  fail-closed by the TARGET schema's `transitions()` gate. The lens declares
  intent, the renderer surfaces it, the registry decides legality — only trusted
  renderer hosts turn actions into controls, and the `## custom` sandbox never
  sees them.

A lens is parameterized by an edge, not config: `{type: focuses-on, to: <node>}`
points it at the node it watches, and the runner resolves `"$focus"` in the query
from that edge when no runtime parameter is given. Re-pointing a view is then an
edge edit, and "which lenses watch this node" is graph traversal.

`traversable: false` keeps lenses out of compiler lineage walks — a lens says
what someone wants to look at, not what the graph knows. `capturable: false` for
the reason briefing and correction opt out: a lens is authored deliberately
against a query language, never drafted from a capture or a distilled transcript.

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
| `assigned`       | 0.5    | work is assigned to this person OR agent (the explicit-routing edge; an agent target may carry a `profile:` per-assignment override) |
| `reviewed-by`    | 0.5    | this person reviewed and approved the node — counts toward a policy quorum |
| `changes-requested-by` | 0.5 | this person reviewed the node and requested changes — not an approval |
| `relates-to`     | 0.5    | weak association                                 |
| `mentions`       | 0.5    | weakest association                              |
| `stewards`       | 0.4    | this person stewards an area/spec/norm — the Tier-2 question-routing key |
| `member-of-org`  | 0.3    | this person is a member of the target organization (inverse `has-org-member`); structural identity binding, not admin authority |
| `grouped-under`  | 0.3    | this repo's home project grouping (inverse `groups`); structural membership, not work dependency |
| `owned-by`       | 0.3    | this agent is owned by that person (inverse `owns`); structural identity binding, not work dependency |
| `uses-profile`   | 0.3    | this agent's default profile (the runtime+capability bundle it dispatches under); structural config binding, overridable per assignment/dispatch |
| `routed-to`      | 0.3    | a question routed to this person for answering   |
| `review-requested` | 0.3  | a review of this node is requested of this person (pending) — surfaces in their queue |
| `focuses-on`     | 0.2    | this lens is parameterized on that node (see "Lenses"); a view watching a node says little about the node's own lineage |
| `compiled-for`   | —      | briefing → its task/query (provenance only)      |
| `shaped-by`      | —      | briefing → corrections applied (provenance only) |

`answers`, `assigned`, `stewards`, `member-of-org`, and `routed-to` are person-graph
edges of Tier-2 question routing; they ship in the seed pack and are
documented under "People, routing, and onboarding" above. `assigned` and
`routed-to` point at a `person-` node; `stewards` points from a person to
the area or organization they own; `member-of-org` points from a person to an
`organization` identity anchor; `answers` points from any answer node back at the
`question-` it resolves.

`review-requested`, `reviewed-by`, and `changes-requested-by` are the
review-as-graph-object edges (a work node → a `person-`): a single edge that
flips type in place across the review lifecycle — `review-requested` while a
reviewer's verdict is pending (surfaced into their queue), `reviewed-by` once
they approve (counted by the definition-of-done quorum gate), or
`changes-requested-by` once they ask for changes. They are the canonical,
source-blind record a native review surface and the GitHub adapter both write;
a review *node* is deferred to when Spor owns the thread
(dec-spor-definition-of-done-org-policy).

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

A node whose `authored_via` is `capture`, `distill`, or `gardener` — written
with no human review at write time — is labeled `machine·<via>` (e.g.
`machine·capture`) in every compiled digest/briefing line, the same
machine-vs-human taxonomy `spor changes` already surfaces
(task-cc-digest-render-authorship-marker). Without it a Haiku-distilled
capture rendered typographically identical to a human-reviewed decision in
the ambient session-start context; `mcp`/`rest`/`dispatch` writes and nodes
with no `authored_via` at all render exactly as before (unmarked).

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
`supercedes` → `supersedes`, `approved-by` → `reviewed-by`) — and **inverse
labels** — the edge read from
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

**Lifecycle** (`status`, 2026.07.15.1, issue-spor-corrections-no-applied-
lifecycle): `active` (or no `status` at all) is the default and means the
guidance is still standing — it keeps injecting at every in-scope compile.
`applied` means a recompile already absorbed the correction's guidance into
the target's briefing body, so it is retired and stops injecting — otherwise
an absorbed correction is dead weight that keeps re-injecting into every
future compile/serve of its target forever. Both the client compile
(`correctionInScope`/`corrections` in `lib/kernel/graph.js`) and the server's
serve-time gate (`correctionsForBriefing`/`applyBriefingCorrections`) filter
out non-`active` corrections — keep the two in sync, held-guard-style. A
node-targeted correction (`target: <node-id>`, not `global`/`project:<slug>`)
is flipped to `applied` by the recompile flow that absorbs it (`/spor:brief`
step 3); `global`/`project:<slug>` corrections are standing, broad-scope
guidance and are not auto-retired by any single recompile.

## Briefing nodes

Created by the distiller or `/spor:brief`. Carry `derived-from` edges to
every source node and `shaped-by` edges to the corrections that fired for this
compile (not necessarily `status: applied` yet — a `global`/`project:<slug>`
correction can `shaped-by` many briefings over its lifetime), plus a
`version:` integer. On recompile the old version is archived to
the graph home's `history/` and the version bumps. `brief-project` is the standing
project briefing injected at session start.
