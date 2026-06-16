# Deferred work, the decision queue, and the schema registry — design spec

Status: **all five rollout steps shipped** (registry core + seed pack,
capture path, decision queue, transitions + approval gating, gardener) ·
Roadmap Tier 2 · Companion to
[API.md](API.md) (the server's client contract) ·
**Partially supersedes [GRAPH.md](GRAPH.md)** (§2 —
GRAPH.md is demoted from contract to seed schema pack; the seed lives in
`lib/seed/`, the registry in `lib/registry.js`, and the repo's agent
instructions now name the registry as the contract).

This spec covers two things that turned out to be one thing:

1. The **task flow** that replaces Jira: work discovered mid-implementation →
   captured as nodes → prioritized → surfaced when deciding what to do next.
2. The **schema registry**: node/edge schemas that evolve per-organization,
   live server-side, and carry LLM-generated-but-deterministic code for
   validation, transformation, and actions.

They are one thing because the task flow is the first consumer of bespoke
schemas: every organization has its own workflows, statuses, approval gates,
and prioritization rules. A fixed GRAPH.md means the org adapts to the
schema. The registry inverts that — the schema adapts to the org — which is
the same inversion the lens/malleable-UI thesis makes for presentation.

Design lineage: the registry borrows deliberately from
[swamp](https://github.com/swamp-club)'s model system — typed schemas with
versions, agent-authored validation, pure upgrade functions for lazy
migration, and attached code that is reviewable before it runs.

## 1. The problem

Mid-implementation, an agent or human discovers work that should not happen
now: a refactoring opportunity, an optimization, a follow-up. Today that
knowledge dies in a TODO comment or maybe gets distilled at session end.
Jira's answer — stop, context-switch, file a ticket whose prose context is
frozen at filing time — has capture friction high enough that most discovered
work is never recorded, and tickets that are recorded rot.

Spor's structural advantages over a ticket system:

- A task node is a **pointer into the graph**, not a container. Its context
  is compiled on demand from lineage and stays current (supersession fixups).
  A ticket from March describes March; a task node compiled in June describes
  June.
- **Provenance is an edge.** `derived-from → <the work it was discovered
  during>` answers "where did this come from" mechanically.
- **The deferral is a decision.** "Ship without the optimization because of
  the release date" is a decision node the task hangs off — "why didn't we do
  this earlier?" becomes answerable.
- **The backlog comes to you.** The per-prompt digest already resurfaces a
  deferred task the moment a session touches its neighborhood (structural arm
  via shared artifact edges, content arm via vocabulary). Jira backlog items
  only exist when someone goes looking. This works today, with no new code.

## 2. The schema registry

### 2.1 Why GRAPH.md stops being the contract

GRAPH.md hardcodes one organization's ontology: eight node types, eleven edge
types, fixed weights, fixed status vocabulary. That was right for
bootstrapping; it is wrong as a foundation, because workflows, approval
chains, and process vocabulary are bespoke per org — and because every
hardcoded list in the codebase (the validator's `KNOWN_TYPES`, the compiler's
`EDGE_WEIGHTS`, the distiller prompt's type menu, the norm ride-along
special case) is a place where the org must adapt to us.

GRAPH.md becomes the **seed schema pack**: the schemas a fresh graph is born
with, expressed in the registry's own format. Orgs evolve from there.

### 2.2 Schemas are nodes

A schema is a node in the graph (`type: schema`), so schema history,
provenance, and review ride the existing machinery — schema changes are
visible in compiles, attributable, and supersedable like everything else.

```markdown
---
id: schema-task
type: schema
kind: node-schema          # node-schema | edge-schema
schema_version: 2026.06.10.1   # CalVer, swamp-style
title: Task — deferred or planned work
summary: A unit of work with a status lifecycle and queue participation.
---

```json
{
  "node_type": "task",
  "prefix": ["task-"],
  "fields": {
    "status":   { "enum": ["open", "in-progress", "blocked", "done", "superseded", "rejected"], "default": "open" },
    "effort":   { "enum": ["small", "medium", "large"], "required": false },
    "priority": { "enum": ["p1", "p2", "p3"], "required": false }
  },
  "queueable": true
}
```

(The declarative payload is a fenced ```` ```json ```` block, not YAML — the
client stays zero-dep, so `JSON.parse` beats a hand-rolled YAML subset. The
frontmatter above it stays within the regex parser's constructs. `priority`
is the human override; advisory signals come from code. As of step 1 the
registry parses and preserves `fields:` declarations but does not enforce
them — field/enum enforcement arrives with the write path in steps 2–4, and
the shipped seed task schema deliberately omits the status enum because live
graphs predate it.)

```js
// validate(node, graph) — pure, deterministic, sandboxed (§2.4)
export function validate(node, graph) { ... }

// transitions(node, proposed, graph) — gate status changes; org approval
// rules live here ("done requires a resolves edge or a linked commit")
export function transitions(node, proposed, graph) { ... }

// queueSignals(node, graph, activity) — contribute ranking signals (§4)
export function queueSignals(node, graph, activity) {
  return { blocking: ..., heat: ..., staleness: ..., age_days: ... };
}
```
```

Edge schemas carry what the compiler used to hardcode (payload of
`schema-edge-blocks`, `kind: edge-schema`):

```json
{
  "edge_type": "blocks",
  "weight": 0.7,
  "inverse_label": "blocked-by",
  "aliases": []
}
```

The compiler's `EDGE_WEIGHTS` table, the validator's known-type lists, the
id-prefix rules, the "norms ride along" special case (`always_on: true` on a
node-schema), and the briefing/correction traversal exclusion
(`traversable: false`) are registry lookups now (step 1, `lib/registry.js`).
`loadGraph()` loads schemas first, then nodes; the seed pack in `lib/seed/`
is the default and graph-resident schema nodes override/extend it. The
`schema` node type itself is recognized natively by the core — no
schema-for-schemas regress.

Resolution is **graph beats seed wholesale, regardless of version**: a
resident override replaces the seed entry for that type entirely, so a seed
behavior change (a new `transitions()` gate, a default, a prefix) does *not*
reach a graph that carries a stale override of the same type until the
override is bumped in lockstep (issue-cc-schema-override-seed-shadow). To
keep that shadow from going silent, `validateGraph` emits a warning when a
graph-resident schema's `schema_version` is **older** than the seed schema
it overrides — bump the resident in lockstep, or retire it to let the seed
become the single source again.

`aliases` (same-direction synonyms) and `inverse_label` (the edge's name
read from the target's side) feed the **write-path normalization table**
(API.md §1): aliases are renamed in place — the historic Haiku-variant
sed entries (`related-to`, `derives-from`, `supercedes`) live on their
schemas now — and an edge written in inverse form is flipped onto its
target node rather than rejected. Alias/inverse names may not collide with
canonical edge types; the registry rejects offending schemas at load. The
*compiler* still labels inbound traversal as `<type> (inbound)` — using
`inverse_label` there would break byte-compatibility, and stays deferred.

Versioning and migration are swamp's rules verbatim: CalVer
`YYYY.MM.DD.MICRO`; schemas must read data written by all earlier versions;
each schema carries an ordered chain of **upgrade functions** (pure
old-fields → new-fields transforms); migration is lazy — applied when a node
is next written, persisted so it runs once — and forward-only.

### 2.3 Writes become ingestion: raw text in, typed nodes out

Node creation moves **entirely server-side**. Clients stop writing node
files and stop needing to know the current schemas at all. The write surface
becomes:

```
capture (MCP) / POST /v1/capture (REST)
{
  "text":    "While wiring the SLA endpoints I noticed the validation logic
              is duplicated across three handlers. Out of scope now — the
              release is Friday — but it should be extracted. Touches the
              API surface and the requirements spec.",
  "context": { "project": "my-project", "during": "task-wire-auth-endpoint" }   # optional hints
}
```

The server runs an **ingestion model** (same tier logic as the distiller:
Haiku-class, ~cents) with the live schema registry in its prompt: pick the
schema(s) this text instantiates, draft the node(s) — fields, edges to
existing node ids from the index, summary — and emit them. Then the
deterministic half takes over: per-schema `validate()` runs, edge
normalization runs, attribution is stamped, the write queue commits.
Validation failures bounce back to the ingestion model once for
self-correction before surfacing to the caller.

**The LLM proposes; attached code disposes.** Non-determinism is confined to
drafting; everything that gates, transforms, or transitions a node is
reviewed deterministic code. That is the swamp pattern: agents author the
code, humans review it, then operations through it are mechanical.

Consequences:

- `put_node` (raw markdown) remains for trusted/mechanical writers — the
  backfill agent, migrations, the gardener — but `capture` is the default
  door for sessions and Cowork. The distiller becomes a thin client: its
  transcript-tail prompt now just *finds candidate facts* and sends each as
  raw text to `capture`; schema knowledge leaves the distiller prompt
  entirely (no more type-menu drift between distill.sh and GRAPH.md).
- Capture cost at the discovery moment approaches zero: the agent calls one
  tool with two sentences and keeps working. This is the property that makes
  the Jira-replacement flow real (§3).
- Idempotency: the ingester sees the node index and prefers
  edge-to-existing over create; `if_exists: skip` semantics remain the
  backstop for id collisions.
- When raw text fits **no schema well**, the ingester does not force it: it
  files the text as a `capture-pending` node *and* may propose a schema
  change (new schema or field addition) — which lands in the decision queue
  for a human (§2.5). This is the malleability loop: the org's actual
  process, observed in what people try to capture, grows the schema.

As shipped (step 2), the durability rule is strict: **ingestion-quality
failures never lose text.** NOFIT, an unparseable model response, and drafts
still invalid after the one correction bounce all file the raw text as a
`capture-pending` node (status `pending`, validator errors attached as
warnings) rather than erroring; only transport-level failures (ingestion
model unreachable → `503 ingestion_unavailable`) surface as errors, because
those the caller can retry or spool. Committed capture nodes are stamped
`authored_via: capture`. The deterministic half is the registry/structural
validator plus edge normalization — and, since step 4, the active schema's
attached `validate()` running in the §2.4 sandbox. The ingester's
schema-change proposal happens in the pending node's prose for now.

### 2.4 Attached code: execution and trust

Schema code is LLM-generated, so it gets the same two fences as everything
else in this system:

- **Review gate.** Schema nodes (including their code) are written through a
  proposal flow: a schema change is a queue item requiring human approval
  before activation — dogfooding the approval machinery the schemas
  themselves define. The git history of the graph repo is the audit trail.
- **Sandbox.** Functions are pure: `(node, graph-view, activity-view) →
  value`, no I/O, no clock, fuel-limited. v1 executed in `node:vm` with
  frozen intrinsics and a timeout (the server is a controlled box and the
  code is reviewed). The hardening path SHIPPED once the policy floor
  landed role separation (the trigger named in dec-lens-custom-wasm-timing):
  the server now executes attached code — schema verbs and lens `## custom`
  blocks alike — in a QuickJS-in-wasm sandbox (server-side,
  quickjs-emscripten), same capability surface so the swap was an engine
  change: JSON boundary, no clock/randomness, codegen neutralized, frozen
  guest intrinsics, deadline interrupt (the fuel limit), plus a per-runtime
  memory cap node:vm could not enforce. The wasm module instantiates once
  at boot; calls stay synchronous. `lib/sandbox.js` remains the zero-dep
  node:vm engine for local mode (`SPOR_SANDBOX=vm` is the server-side ops
  escape hatch — the server otherwise refuses to boot without the wasm
  engine rather than silently degrading). Sandboxing secures execution, not
  semantics — review is what secures semantics.

Action verbs beyond validate/transitions/queueSignals are deliberately not
enumerated yet; the registry stores named exports and surfaces (queue,
gardener, lenses) call the ones they know. New surfaces can demand new verbs
without a registry migration.

**The policy tiers.** Stepping back, "who may do what" lives at three
levels, and keeping them distinct is the design:

1. **Native floor** (hardcoded in the server, never data): attribution from
   the token only, schema creates forced to `proposed`, write
   serialization, and the **self-approval ban** — activating a schema (or
   future policy) node requires an identity different from the proposal's
   last author. The floor is native because the policy layer cannot govern
   its own approval without circularity: a proposer could otherwise
   propose a permissive policy and approve it. One ops escape hatch:
   `SPOR_SOLO=1` (a server-side env var — the legacy `SUBSTRATE_SOLO`
   spelling is still read)
   waives the self-approval ban for single-identity orgs, where the
   floor would deadlock every proposal. The waiver is
   loud — boot announces SOLO MODE, each waived approval carries a result
   warning and increments `solo_approvals` in `/v1/status` — and should be
   unset the moment a second identity exists.
2. **Declarative schema flags** (`queueable`, `capturable`, `traversable`,
   `always_on`, `aliases`/`inverse_label`) — per-type data, reviewed
   through the proposal flow.
3. **Attached code** — per-type `validate()`/`transitions()`/
   `queueSignals()`, with `view.actor` (the authenticated identity) in the
   gate context so identity-aware rules are expressible.

A wider org-defined **policy layer** — a reserved `policy` kind in the
schema family whose gate runs on a write AND-ed with the per-type
`transitions()`, carrying role lists, quorum rules, agent-vs-human
distinctions, and (eventually) the queue-blend override as one mechanism — was
deferred until a real org rule demanded more than the floor
(dec-cc-policy-floor-now-layer-deferred), then activated once one did
(dec-spor-policy-layer-activate). The first rule it expresses is the
**definition-of-done quorum gate** (dec-spor-definition-of-done-org-policy
Stage 2): a `policy` schema node, selected for a node by **governs-traversal**
(`governs.{types,projects}`; nearest scope wins, an org-wide policy still
applies), runs `gate(current, proposed, view)` AND-ed with the type's
`transitions()` — any deny stops the write, so a policy can only ADD a
constraint, never loosen the gate or the native floor beneath it. The
quorum gate requires a work node's `done` transition to carry a quorum of
approvals from qualified roles: `view.approvals` is the node's
`reviewed-by`/`approved-by` edges to `person` nodes joined to each person's
`roles` register, with the node's own author excluded (the self-approval floor).
The enabling hook (`view.actor`) shipped with the floor, so this was net-new
policy-kind work, not core surgery (GRAPH.md "The org-defined policy layer").

**Review as a graph object** (review-as-graph-object, Stage 3) supplies the
edges the gate counts. The seed pack ships three review-outcome edge types
(work node → `person`): `review-requested` (a review is pending of that
person), `reviewed-by` (they approved — what `view.approvals` carries and the
quorum counts), and `changes-requested-by` (they asked for changes — carried
separately as `view.changes_requested`, never an approval). A single edge
flips type in place across the lifecycle. An open `review-requested` edge
surfaces the node in that reviewer's `my_queue` `reviews` set, through the same
per-person routing filter questions and findings use — reviewer *selection* at
request time and quorum *enforcement* at gate time are distinct points.

Still on the layer's roadmap, beyond the quorum gate: the agent-vs-human
claim-eligibility promoted-set (task-cc-claim-eligibility-policy), the
queue-blend override absorbed as a `policy` rather than the separate
`queue-policy` singleton (task-cc-schema-queue-policy-override), the GitHub
review/merge reflection adapter that writes these same edges from PR events
(task-spor-github-review-adapter, Stage 4), and a fuller governs-traversal that
walks the project/path hierarchy via `governs`/`governed-by` edges rather than
matching the flat `governs.{types,projects}` scope.

## 3. The capture flow, end to end

1. **Discovery.** Mid-task, the agent notices deferrable work. The standing
   instruction for this arrives via the context the hooks already inject
   ("when you defer discovered work, capture it"). The agent calls `capture`
   with 2–3 sentences and the `during` hint. A human does the same in
   prose, or via `/spor:defer` (a thin skill over the same tool).
2. **Ingestion.** Server drafts against `schema-task`: status `open`,
   `derived-from → task-wire-sla-endpoints` (provenance), `relates-to →
   art-api, spec-requirements` (anchors), `constrained-by` as applicable.
   If the deferral rationale is itself load-bearing ("because release
   Friday"), the ingester emits a decision node alongside, edged to the task.
3. **Validation + commit.** `validate()` passes, attribution stamped, one
   git commit. The asker gets back ids + a one-line summary; total session
   overhead is one tool call.
4. **Dormancy with ambient resurfacing.** Nothing else happens — until a
   session works near the task's anchors, at which point the existing
   two-arm digest surfaces it unprompted. Deferred work re-ambushes you at
   the moment of relevance.
5. **Deliberate surfacing.** "What should I work on next?" hits the queue
   (§4).
6. **Lifecycle.** Status changes go through `transitions()` — org approval
   gates live there. Completion links the implementing artifact back via
   `derived-from`; the distiller's "tasks completed" extraction proposes
   these transitions through `capture` like everything else.

## 4. Prioritization: derived signals, advisory; humans override

No scoring formula owns the ranking. Each queueable node contributes
signals via its schema's `queueSignals()`:

- **blocking** — open work reachable through `blocks` edges.
- **blocked_by** — live, unresolved work with a `blocks` edge into this
  node: the inverse of blocking, so gated items demote instead of riding
  their (shared) neighborhood heat past their own unblocker
  (issue-cc-queue-ranking-asymmetry).
- **heat** — activity in the node's neighborhood, from the server request
  log and uploaded journals (the same append-only activity feed the server
  journals for observability). Reported raw; the default blend log-compresses it so hundreds
  of touches can't silence the other signals
  (issue-cc-queue-blend-heat-dominance). Read-class ops don't heat: queue
  reads, lens renders, and digest/briefing compiles all log node ids they
  merely retrieved — a single prompt-submit digest lists ~60 — so only
  work-class ops count (issue-cc-heat-amplification and its digest round).
- **front** — the viewer's own write-class ops on the node (puts, edges,
  status flips, captures during it) over a rolling window (default 7 days),
  identity-scoped. In **remote** mode the server injects it from the same
  request journal (`store.writeActivity`). In **local** mode there is no
  request log, so it is reconstructed from **git history**
  (`gitFront()` in `lib/queue.js`, task-cc-local-front-productionize): the
  graph home is a git repo the distiller auto-commits into, the local
  `git config user.email` is the viewer identity, and a commit that
  adds/modifies/renames `nodes/<id>.md` is a write-class op on that node.
  `git log --since=<days> days ago --author=<email> --diff-filter=ACMR
  --name-only -- nodes/` yields the same `{nodeId: count}` map the server
  builds; each commit lists a touched file once, so occurrences across the
  log = the node's write count. Pure deletes (D) are excluded — a removed
  node isn't live work — and there is no neighborhood spread, matching the
  server. It is best-effort and fail-open: not a git repo, no commits, or an
  unset `user.email` yields an empty map (front 0 everywhere, the pre-front
  ordering). The window and an on/off toggle live in the config cascade
  (`queue.front.days` / `queue.front.enabled`, env `SPOR_QUEUE_FRONT_DAYS` /
  `SPOR_QUEUE_FRONT`); the `lib/queue.js` CLI flags `--days` / `--no-front`
  override them. Counts the node itself only — no neighborhood propagation —
  so provenance hubs can't ride it; capped below the p1 bump so human
  priority stays supreme; and the why-line states the actual window
  ("N writes in the last D days") (dec-cc-queue-front-from-attribution).
- **staleness** — anchors superseded or gone; high staleness suggests
  closing, not doing.
- **age**, and any org-specific signal the schema's code adds (SLA clocks,
  sprint membership, whatever the org's process actually is).

The queue presents signals *and* the `priority:` field side by
side, ranked by a default blend the org can replace (the blend itself is
attached code on a `schema-queue-policy` node). `priority:` is ordinary
frontmatter writable by any token-holder, so its source is not assumed to be
human: when a `priority_by:` stamp is present (acting identity + door, set the
way `author`/`authored_via` are) the why-line attributes it — `priority p1
(set by <name> via <door>)`; absent the stamp the why-line says `(source
unrecorded)` rather than claiming human triage
(issue-cc-priority-attribution-gap). Computed signals are
advisory — same posture as the reliability-cost layer: the graph knows
structural urgency; it does not know business value.

Personal filtering is the viewer-sized counterpart of the org policy: a
person node may carry a `queue_mute` register — a flat inline list, e.g.
`queue_mute: [my-project, task-noisy-job@2026-07-01]` — and both queue doors apply it
to the authenticated viewer's results (`viewerFor`, the same token-derived
binding as `$viewer` and question routing). Entries name a project slug or
node id; an optional `@YYYY-MM-DD` makes the mute self-expiring, so
"sideline this project for now" can't silently rot into a permanent blind
spot. Muting is per-viewer presentation at queue-compile time, not graph
state — items stay live and visible to everyone else — and the hidden
count is reported (`muted: N` on the result, a trailing line on `my_queue`)
so the queue never silently truncates.

Scheduled dormancy is the graph-state counterpart of the mute: a queueable
node may carry `wake: YYYY-MM-DD` — "nothing to do against this until that
date". Before the date the queue counts it (`dormant: N`) instead of
ranking it; from the date on it surfaces to **every** viewer with its
priority and signals intact, why-line flagged `woke <date> (was dormant)`.
This is the renew-the-cert / schedule-the-audit shape: the classic failure
is a reminder in one person's calendar — the owner leaves, the reminder
leaves with them, the expiry becomes an incident. `wake:` keeps the
schedule with the work, not the person: no scheduler or calendar exists
anywhere, the queue simply compares dates at read time, and whoever looks
at the queue after the wake date sees the item. An unparseable date fails
open to awake (surfaced work beats silently hidden work; the validator
warns), and a dormant item is still live graph state — compiles, briefings,
and edges see it normally; only queue ranking waits.

## 5. Surfacing: the decision queue

The queue is a compile mode, not a new store:

- `rankQueue(graph, {assignee?, project?, ...})` in the core: collect nodes
  whose schema says `queueable: true` and status is live, run `queueSignals()`,
  blend, return ranked items each carrying its one-line *why* ("blocks 3
  open tasks; anchors hot this week"). `assignee` (a person node id) narrows
  the queue to the work that person carries — see "Per-person queues" below.
- The `project` filter resolves through the one shared up-resolution step every
  read surface shares (dec-spor-queue-slug-resolves-to-grouping): a BARE repo
  slug resolves up to its home-project grouping and unions the member repos'
  queues — the intuitive token returns the whole product; the repo NODE id
  (`repo-<slug>`) is the escape hatch back to one repo; an exact grouping id
  (`proj-<slug>`) is used directly; an ungrouped repo falls back to itself.
- Exposed as `GET /v1/queue` (hooks, session-start "open front" line),
  `my_queue` (the registered MCP stub finally does work — and when Tier 2
  routing lands, routed questions and stewarded items join the same queue),
  and `/spor:next` (presents the queue; picking an item triggers a
  full `--root <task-id>` compile so work starts pre-briefed).
- Queue items are not only tasks: schema-change proposals (§2.3), gardener
  findings (§6), merge reviews (the lens-spike BLOCKER's review queue), and
  Tier-2 routed questions are all queueable schemas. "Home is a decision
  queue" falls out of one mechanism.

**Per-person queues** (task-cc-queue-assignee-filtering). `rankQueue`'s
`assignee` parameter — and `GET /v1/queue?assignee=<person-id>` /
`my_queue {assignee}` (use `assignee=me` to bind to the caller) — scopes the
ranked queue to the work one person carries: the union of nodes with an
outbound `assigned` edge to them (work→person) and the nodes they `steward`
(person→node). Assignment is an edge like everything else (Tier-2's person
nodes plus the seed `assigned`/`stewards` schemas), so this needed no new
store — the same blend, signals, and why-lines, narrowed to a person. A
manager answers "who is carrying what" and "what is X blocked on" by naming
each person in turn; an unknown or departed person id returns an empty queue,
never the whole team's work. The filter is a hard scope like `project` (it
composes with it) and never overrides liveness — a terminal task assigned to
the person still leaves the queue.

A **grouped** team-capacity view (everyone's open work at once, bucketed by
owner) is a first-party manager need, not merely a customer illustration —
the `lens-team-capacity` example (in the meridian fixture corpus) is the
shape. Shipping it as a live-native default lens is deferred: the lens engine
groups by a frontmatter field, so a live grouping by the `assigned` *edge*
awaits group-by-edge-target support; the meridian fixture works because it
also carries an `owner:` field. Until then the `assignee` filter is the
shipped per-person surface (iterate it per person for the capacity picture).

## 6. The gardener

A periodic server-side sweep (cron, or post-write debounce) that runs each
schema's staleness-relevant checks and *files its findings as queue items*
rather than acting: tasks whose anchors were superseded ("close this?"),
statuses contradicted by the graph (a `done` task whose resolving artifact
was reverted), captures pending schema decisions, cold `in-progress` items.
Backlog grooming stops being a meeting and becomes queue items with
compiled context.

As shipped (step 5, the server-side gardener): findings are ordinary
`type: finding` nodes (queueable seed schema, prefix `find-`), written
through the validated/attributed write path (`authored_via: gardener`) with
deterministic ids so re-sweeps are idempotent; when a finding's condition
clears, the gardener resolves its own finding — the only mutation it
performs, and never on human-authored findings. v1 files only what the
queue cannot already express as an item: **stale-anchors** (a live
non-queueable node edged to a superseded target — its own `supersedes`
edges excluded) and **cold-work** (`in-progress` with no neighborhood
activity over 14 days). Stale *tasks*, capture-pending nodes, and proposed
schemas already self-surface in the queue, so no duplicate findings are
filed for them. Trigger: `POST /v1/gardener` on demand, or
`SPOR_GARDENER_MS` (a server-side env var) for
an in-process interval (off by default — the schedule is ops' choice). Deferred: "done but contradicted" (needs
git-history analysis of resolving artifacts).

Findings route to stewards the same way questions do
(task-cc-findings-steward-routing): at filing time the finding's edge
targets — subject first — form its relevance neighborhood, the first
stewarded node wins (the server's deterministic Tier-2 routing walk), and
the route materializes as a `routed-to` edge plus a body note. No steward
anywhere leaves the finding unrouted. The queue surfaces (`GET /v1/queue`,
`my_queue`) carry a `findings` field mirroring `questions`: open findings
routed to the authenticated identity plus unrouted ones — a finding routed
to someone else stays out of your view, so gardener output lands with the
people who steward what it observed instead of everyone.

Two gate checks joined the sweep with the edge-write UX work
(issue-cc-edge-write-ux-friction):

- **inert-gate** — a `blocks` edge whose source has reached a terminal
  status while its target is still live. The gate has cleared but the
  graph still says "blocked": the finding (on the target's side,
  `find-inert-gate-<source>-<target>`) says the target can proceed — drop
  the edge or pick up the work. This is the "the blocker was already done"
  discovery made manually during dogfooding, mechanized.
- **unedged-gate** — a live decision whose body uses gate vocabulary
  (`gate`/`gated`/`blocks`/`blocked`) and literally mentions two or more
  *live, queueable* node ids, none of which are connected to another
  mentioned id by a `blocks` edge in either direction. Decisions that
  sequence work in prose without materializing the edge starve the queue's
  blocking signal; the finding asks a human to add the edge (one
  `add_edge` call now) or dismiss. Deliberately conservative — pairs with
  a terminal member don't fire (the gate is moot), and one mentioned id is
  not enough to infer the other endpoint.

A third joined with issue-cc-status-lags-resolution-edges, where queue
consumers recommended already-finished work because the status field lags
the structural truth:

- **resolved-open** — a live node retired by a live inbound
  `resolves`/`answers` edge whose status still reads open/in-progress.
  Resolution truth is read-time everywhere else (lib/resolution.js: the
  queue excludes such items however their status reads, and
  `get_node` on both doors annotates the contradiction as `resolution`
  plus any `open_findings`); this finding is the complementary nag that
  gets the field flipped by a human (`set_status`, one call) — filed,
  never acted, per the no-machine-mutation posture. A rejected, abandoned,
  or superseded resolver retires nothing; `answers` only retires
  questions. Native auto-transition on resolve stays deferred to the
  policy floor discussion unless the manual flip proves a recurring miss.

## 7. Rollout

1. **Registry core** — ✅ SHIPPED. Schema nodes, CalVer + upgrade chains,
   registry-aware `loadGraph()`; the seed schema pack in `lib/seed/`
   expresses current GRAPH.md exactly (validator/compiler output verified
   byte-identical against the live graph before/after — same bar as the
   lib/graph.js core extraction). GRAPH.md got its demotion notice; the
   agent-instructions hard rule was updated in the same change. Attached ```js code (validate /
   transitions / queueSignals / upgrade fns) is parsed and preserved but not
   executed — the §2.4 sandbox arrives with the first consumer.
2. **Capture path** — ✅ SHIPPED. `capture` MCP tool + `POST /v1/capture` +
   server-side ingestion model (injected fn → `SPOR_INGEST_CMD` →
   `ANTHROPIC_API_KEY` direct API → `claude -p` fallback, all
   server-side) with one-bounce self-correction and the capture-pending
   durability rule (§2.3); the remote-mode distiller is a capture client
   (fact-finder prompt, schema knowledge left the script; local mode
   unchanged); `/spor:defer` skill; standing capture instruction in the
   remote session-start context; `capture-pending` seed schema (prefix
   `cap-`). (Measure capture rate in dogfooding — if discoveries still die
   in TODOs, that's evidence for a post-tool TODO-comment nudge, not more
   prompt.)
3. **Queue** — ✅ SHIPPED. `rankQueue()` in the core (`lib/queue.js`, also a
   CLI for local mode), `GET /v1/queue`, real `my_queue`, `/spor:next`.
   The task and capture-pending seed schemas are `queueable: true`; the §4
   signals (blocking / heat / staleness / age) are computed natively in the
   core for now — per-schema `queueSignals()` attached code joins via the
   §2.4 sandbox in step 4 alongside `transitions()`. The blend shipped
   opinionated (§8): `priority bump + 3·blocking − 3·blocked_by +
   min(log₂(1+front), 5) + log₂(1+heat) + age/30 (capped) + neededBy urgency (0-5)`, with staleness ≥ 0.5 flipping the item's suggestion to
   "close". The `needed_by: YYYY-MM-DD` deadline term is the inverse of
   `wake`: where `wake` hides a node until its date, `needed_by` keeps it
   visible from creation and ramps its score linearly over a 30-day window to
   3 at the date, then on to a hard cap of 5 once overdue — surfacing
   cross-cutting dependencies in the serving team's queue early
   (task-cc-xproject-dependency-loop). Kept single-digit so it never dominates
   (issue-cc-queue-blend-heat-dominance); hard overdue escalation past the cap
   is the gardener's job (task-cc-dormancy-escalation). The blocking boost has its inverse
   (issue-cc-queue-ranking-asymmetry): an item gated by a live, unresolved
   blocker is penalized per blocker, flips to `suggest: blocked`, names its
   blockers in the why, and — because heat is neighborhood-shared and would
   otherwise drown the additive terms — is capped just below any blocker
   present in the same ranking, so the unblocker always surfaces first. Heat
   comes from the §11 request log (server-side only; queue reads are
   excluded so the queue can't heat itself). The session-start "open front"
   line (initially deferred) shipped with the edge-write UX work: it rides
   the queue response the hook already fetches for routed questions — top
   item + its why, one line, no extra request, fail open.
4. **Transitions + approval gating** — ✅ SHIPPED. Attached schema code
   executes in the §2.4 v1 sandbox (`lib/sandbox.js`: fresh `node:vm`
   context per schema, code-generation disabled, no clock/randomness/host
   globals, frozen intrinsics, per-call timeout, JSON-only boundary).
   `validate()` runs at the server door on every write (capture drafts
   included), `transitions(current, proposed, view)` gates updates (view
   carries edge-target liveness; must return `{allow, reason?}`; fail
   CLOSED — crashing gate code denies, `409 transition_denied`), and
   `queueSignals(node, ctx)` adds org signals to the queue blend
   (fail-soft). Schema-change proposal flow: schema nodes CREATED through
   the server are forced to `status: proposed` (payload status discarded,
   like attribution) and are inert — the registry only loads active schemas
   — until a human reviews and flips status to `active` via an ordinary
   revision-checked update; proposals surface in the queue as
   `suggest: approve` items. Originally any token holder could approve
   (including the proposer); since the §2.4 policy-floor work the
   self-approval ban applies — the approver must differ from the
   proposal's last author (`SPOR_SOLO=1` waives this for
   single-identity orgs, loudly — see the policy tiers in §2.4). Admin
   hand-edits to the graph repo bypass the flow by design (trusted path).
   No seed schema carries code, so existing graphs see zero behavior
   change.
5. **Gardener** — ✅ SHIPPED (see §6 as-shipped notes).

Steps 1–2 are the pivot; 3–5 are each small once the registry exists —
which held: each landed as one commit on top of the registry.

## 8. Open questions

- **Ingestion credential** — RESOLVED with step 2: the server invokes its
  ingestion model (all server-side) via, in precedence order, `SPOR_INGEST_CMD` (ops
  escape hatch), `ANTHROPIC_API_KEY` (direct Messages API, headless
  deploys), or a `claude -p` CLI fallback (boxes with Claude Code auth, the
  dogfood case). The server design spec's non-goal was rewritten to the coherent line:
  transcripts never leave the client; the server's LLM only ever sees 2-4
  sentences of distilled prose per capture.
- **Schema sprawl**: what stops 40 near-duplicate task schemas? Probably the
  same review gate plus a gardener check (schema similarity), but
  unproven.
- **Compiler semantics under bespoke edges**: weights are registry-supplied,
  but do org-invented edge types need traversal-direction or decay hints
  beyond a weight? Defer until a real org schema demands it.
- **Cross-org seed evolution**: when the seed pack improves upstream, do
  org-evolved registries take upgrades? (Swamp's answer: versioned models
  with migrations; ours may be "no — the seed is a fork point, not a
  dependency.")
- **Queue blend defaults** — RESOLVED with step 3: shipped opinionated
  (priority bump 6/3/1 + 3·blocking − 3·blocked_by + min(log₂(1+front), 5)
  + log₂(1+heat) + age/30 capped at 3; staleness ≥ 0.5 inverts to "close?";
  blocked items demoted below their in-ranking blockers and flipped to
  "blocked" — issue-cc-queue-ranking-asymmetry; front is the viewer's own
  write-class activity, no propagation, capped below p1 —
  dec-cc-queue-front-from-attribution). Heat enters the blend log-compressed:
  live-server raw counts run into the hundreds and drowned every other
  signal (issue-cc-queue-blend-heat-dominance) — the log keeps heat's
  ordering while priority, blocking, and age stay influential; the raw
  count still rides on `signals.heat` for display and policy code. The `schema-queue-policy` override SHIPPED
  after step 4: a `kind: queue-policy` schema node (singleton; graph beats
  seed, higher version wins) whose attached `rank(items)` re-scores the
  computed item list in the sandbox — accepts `[{id, score}]` or an
  `{id: score}` map; unmentioned items keep their default-blend score.
  Fail-soft: a broken policy annotates the result (`policy: {id, applied,
  error?}` on `/v1/queue` and `my_queue`) and the built-in blend stands; a
  proposed policy is inert until approved like any schema node.
