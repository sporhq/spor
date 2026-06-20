---
name: triage
description: Actively WORK the Spor decision queue end-to-end, not just list it — process pending captures, consolidate duplicates, verify close-candidates, record missing blocks/blocked-by dependency edges, brief and answer open questions from their lineage, and set priorities so unblockers surface first. Use whenever the user wants to triage / groom / clean up / process / work through their queue or backlog — "can we triage my queue", "go through the backlog", "what needs attention", "clean up my captures", "merge the duplicates", "sort out dependencies" — even if the word "triage" isn't used. This is the action loop on top of /spor:next (which only PRESENTS the queue); reach for it any time queue cleanup or grooming is implied.
---

# Triage the queue

`/spor:next` *presents* the queue. Triage *works* it: a grooming pass that
leaves the graph cleaner than it found it — captures resolved, duplicates
collapsed, false close-flags cleared, real dependencies recorded as edges,
open questions answered, and priorities set so the highest-leverage work
surfaces first. The point is that a queue nobody grooms slowly fills with
noise (redundant captures, duplicate issues, stale anchors, unrecorded
blockers) until its ranking can't be trusted; one disciplined pass restores
the signal.

**Load `/spor:spor` first.** This skill is the *workflow*; `/spor:spor` carries
the syntax your training doesn't — the CLI verbs, the node/edge format, the
local-vs-remote resolution, and the MCP/REST surface. Don't re-derive any of
that here; pull it from there and from QUEUE.md (queue semantics) / GRAPH.md
(node + edge types) / API.md (the write endpoints).

## Stance: propose → confirm → act

Triage mutates a **shared** graph (merges, supersedes, status flips,
priorities). So work read-only first, then write deliberately:

- **Read before you write.** Pull the queue, then `spor get` (or `get_node`)
  the actual nodes. The queue line is a summary; the decision lives in the body
  and edges.
- **Act on the clearly-safe; confirm the judgment calls.** Closing a plainly
  redundant capture, recording an obvious blocker — do it and report. Anything
  that *destroys or reframes* meaning (superseding a node, flipping a terminal
  status, setting priorities) — surface your reasoning and confirm before a
  batch, exactly as a careful human groomer would. Never reset/checkout/delete
  a node you didn't create or can't explain.
- **Verify before destructive operations.** `spor get <id>` and check the real
  edges/revision before any supersede/close — the queue line can be stale.

Run the passes below in order; skip any with nothing to do. You don't have to
finish the whole queue in one sitting — say what you triaged and what's left.

## 1. Pull the queue and read the landscape

Get it with the queue's own resolver — `spor next --json` (or the `my_queue`
MCP tool in Cowork). Read the **aggregates**, not just the page: `total_count`,
`counts_by_type`, `counts_by_suggest`, and the side-channels `pending`
(unprocessed captures), `questions` (routed/unrouted to you), `findings`
(gardener observations), plus `dormant`/`muted` counts.

Translate signals into plain words and **never surface the raw `score` or the
internal coinages** (*heat*, *front*, *staleness*, *open front*) — they're
ranking internals, not terms a human reads. "Blocks three other tasks",
"nothing's touched it in months", "the oldest open piece" — that's the register.

Respect what the queue already tells you: honor `suggest: close` as "likely
done/abandonable" (pass 4), mention `muted`/`dormant` in passing (hidden by a
viewer mute or parked behind a `wake:` date — counted, never silently dropped),
and skip anything flagged `in_flight` from the top recommendation — an agent is
already on it; surfacing it invites duplicate work.

## 2. Pending captures → `merged` or `rejected`

Captures are raw prose the ingester couldn't type. Read each (`spor get <id>`)
and decide what it *should* have been. The capture schema's transitions gate
accepts exactly **two** terminal statuses, and nothing else:

- **`merged`** — the content now lives in a node (one you wrote this pass, or an
  existing one). Write the proper node(s) first if needed, then merge.
- **`rejected`** — there was no durable fact to keep.

Watch for **redundant clusters**: several near-identical captures from one
session. A reliable tell is an ingestion note like *"elaboration of `<id>` not
applied (body_full): would push body over the 8192B limit"* — those are repeated
re-captures that bounced because the target node is already at its size cap, so
the fact is *already on the graph*. Read one, confirm the target node holds it,
and `merged` the whole cluster. (`dismissed`/`resolved`/`closed` are rejected at
write time — they leave the capture ranking live; only `merged`/`rejected` are
terminal here.)

## 3. Duplicates → consolidate with a `supersedes` edge

Scan for near-identical nodes (same title/summary, same edges, same date,
different provenance — e.g. one filed via `capture`, its twin via `dispatch`).
**Confirm by reading both** — don't merge on a title match alone. Then keep the
**canonical** one (the more precisely-titled, more wired-in node — the one other
edges already point at) and add a `supersedes` edge from keeper → duplicate.

Superseding marks the dup stale ("trust the replacement") and drops it out of
the actionable queue, while preserving it for lineage (it is **not** deleted).

**Never fake a resolution to clear a duplicate.** For issues the status
vocabulary is only `open`/`active`/`resolved`, and `resolved` means *fixed* and
is resolver-gated — so marking a duplicate (or any still-unfixed bug) `resolved`
is a lie the graph will surface. Supersede instead; it's the honest "this node
is replaced by that one" signal.

## 4. Disposition flags → verify close-candidates, decide held tasks

`suggest: close` is a **staleness** signal — the node's *anchors* were
superseded or went away — **not** "this is done". Treat it as "look at me", not
"delete me". Read the node and walk its anchors (`get_node` enrichment shows
`superseded_by` / `resolution`; or `spor brief <id>`). Two outcomes:

- **The concern is genuinely moot** — the work that rotted the anchor also
  handled this. Close it honestly (pass below).
- **The concern is still live, the anchor just rotted** (a related node got
  renamed/resolved, but *this* gap is untouched) — keep it, and **refresh the
  anchor**: add a fresh `relates-to`/edge to the live replacement node. That
  adds a non-stale anchor, drops staleness back under the close threshold, and
  flips the item back to `do` — silencing a false "close?" without faking work.

**To genuinely close** a `task` (`done`) or `issue` (`resolved`), the
completion gate needs a **resolver on the graph first**: write a `decision` (the
why, for a substantive close) or a short `artifact` (a few lines, commit-message
grade, for a trivial one) carrying a `resolves` edge to the item, *then* flip the
status. A bare status flip with no resolver is denied at the door. `abandoned`
(task only) is exempt — won't-do work records nothing, so a plain status flip is
fine.

**Held tasks — `suggest: triage`.** The queue's *other* disposition flag, a
sibling to `close`. It fires (the front-loop churn guard,
`task-spor-queue-front-loop-self-limit-on-held-tasks`) when an OPEN task has
recent write activity (`front`), no live blocker, AND an inbound **non-resolving
outcome** — an artifact/decision recorded against it that resolved nothing. That
is the structural mark of "work was done on this but nothing closed it": the loop
that normally settles work ("do X → X earns a resolver → X drops off") fails to
terminate, so rather than let it churn at the top the queue hands it to a human.
The why-line names the four exits: **resolve** (write a resolver if it's
actually done), **gate with `blocked-by`** (if it waits on a queued prerequisite
— pass 5), **set `wake:`** (if it waits on a date/window/external milestone), or
**abandon** (won't-do).

Decide from the node, not the flag. If none of the four exits honestly fit — the
task is genuinely ready, unblocked, and never actually churned — the honest move
is to **start it** (claim/dispatch, which puts it on a real resolver path) or let
`front` decay (the writes age out of the 7-day window and it returns to `do`);
don't fake a `wake:` or a resolver to silence it. One structural false positive
— an inbound artifact that merely *resolves other work* and cross-references the
task — was fixed in `issue-spor-queue-held-guard-false-positive-referenced-outcome`,
so a bare reference no longer trips this; a genuine non-resolving outcome still
does. The one thing triage must not do is leave the flag with no decision — it's
a question addressed to you.

## 5. Latent dependencies → record missing `blocks` edges

Find tasks that should carry a `blocks`/`blocked-by` edge but don't — work the
queue surfaces as actionable that actually can't start until something else
lands. Read task summaries and existing edges across the queue and look for true
**prerequisites**: B builds on a primitive/endpoint/migration/schema that A
produces; B is a later "Stage N" of a pipeline whose earlier stage is A; B
operationalizes or monitors a thing A creates. Be strict — shared topic or
sibling-ness is **not** a dependency; only a real "can't proceed until A is done"
counts. Exclude pairs already joined by `blocks`/`blocked-by` (a bare
`relates-to`/`derived-from` does *not* record a blocker — those pairs are still
fair game).

Watch the **duplicate-task trap**: when a dependency is recorded on one node but
that node has an un-linked duplicate twin, the twin leaks past the queue's
blocked-hiding and gets recommended as actionable. Deduping (pass 3) and the
missing edge are the same fix.

For a large queue this is a broad read — **delegate the sweep** to a subagent
(give it: pull the queue, `spor get` every task, build the existing
blocks/derived-from topology, propose prerequisite pairs with evidence,
write nothing), then **verify each candidate pair yourself** before recording.
Record a confirmed one as a `blocks` edge from the prerequisite to the dependent
(mirroring how an issue records its block). The dependent then leaves the
actionable queue until its blocker resolves — which is the point.

## 6. Open questions → brief the lineage, then answer

This is where triage earns its keep: the queue's `questions` are decisions
waiting on a human, and a bare list of them is useless — the reader can't answer
"which provisioning seam should we use?" cold. **Give them the context to
decide.** For each open question:

- **Compile its neighbourhood/lineage** — `spor brief <question-id>` (or
  `query_graph root_id=<question-id>`, or `spor compile --root <id>`). This
  pulls what the question is *blocking*, the fork it sits on, the decisions and
  prior art around it, and any constraints — the "why this is even being asked".
- **Present** the question *plus that distilled context*: state the decision at
  stake, lay out the concrete options it names (often the question body already
  enumerates the fork — a/b/c), surface the relevant prior decisions and norms
  the lineage turned up, and give your own recommendation when the evidence
  supports one. The user should be able to answer from your message without
  going digging.
- **Close the loop** when they answer: write the answer as a node (usually a
  `decision`, or an `artifact` if it records what was done) carrying an
  `answers` edge to the question, then set the question `answered`. An open
  status with a live inbound `answers` edge is contradictory — the edge is what
  actually retires it from the queue, so don't skip it.

(If `questions` is empty there's nothing to do here — but it's the step most
often forgotten, so check it every pass.)

## 7. Prioritise → unblockers first

Once you understand the dependency shape, set explicit `priority:` (`p1`/`p2`/
`p3`) so the queue sequences correctly. The highest-leverage move is to **bump
the unblockers**: a task/issue that `blocks` other queued work clears the most
downstream when done, so it earns the top priority. Blocked dependents need no
priority — they're hidden until their blocker lands. Standalone high-value items
that gate nothing sit a tier below the unblockers.

Priority is ordinary frontmatter and (today) has no dedicated CLI verb, so set
it via `put_node`/the `set_priority` MCP tool (see the cheat-sheet). It blends
into ranking as roughly +6/+3/+1 for p1/p2/p3 on top of the graph signals
(+3·blocking, −3·blocked_by), and a human `priority:` stays supreme over the
computed signals — which is exactly why you set it deliberately rather than
letting heat alone rank the work.

**A `priority:` write feeds the `front` signal.** So bumping a task that *also*
carries an inbound non-resolving outcome (pass 4) can tip it into the held
`triage` flag — the queue asking you to confirm its state, not a bug. If it's
genuinely ready work, start/claim it or let `front` decay; don't fake a resolver
to undo it. (A bare reference no longer trips this —
`issue-spor-queue-held-guard-false-positive-referenced-outcome`.)

## 8. Present the outcome

Talk to a human, in plain language. Lead with what you did and what to pick up
next, one short reason each. Give a compact before/after (queue size, what
merged/consolidated/linked) so the grooming is legible. End with the honest top
picks to *do* (not the blocked or dormant ones) and offer a briefing on one.

## Writes cheat-sheet

Reading resolves mode on its own (`spor next`, `spor get`, `spor brief`). The
*write* verbs below have no `spor` CLI form yet, so in a shell (remote mode) hit
the REST endpoint against the resolved server; in Cowork use the MCP tool. See
`/spor:spor` + API.md for the authoritative contract.

| Action | REST (shell, remote) | MCP (Cowork) |
|---|---|---|
| Read a node (raw + revision + enrichment) | `GET /v1/nodes/<id>` | `get_node` |
| Set status (merged/rejected/resolved/…) | `POST /v1/nodes/<id>/status {status}` | `set_status` |
| Add edge (supersedes/blocks/relates-to/answers) | `POST /v1/nodes/<id>/edges {type, to}` | `add_edge` |
| Edit a field (priority, body) | `POST /v1/nodes {nodes:[{node, if_exists:"update", revision}]}` | `put_node` / `set_priority` |
| Compile a question's lineage | `spor brief <id>` | `query_graph root_id=<id>` |

Edges normalize/flip/dedupe server-side, so write a `blocks` from the
prerequisite's perspective and let it record the inverse. `put_node` needs
`if_exists:"update"` **and** the current `revision` — without the explicit mode
it skips an existing node. Status flips run through the schema `transitions()`
gate (and terminal closes through the completion-resolver gate), so a denied
write means the graph is protecting an invariant — read the reason, don't fight
it.
