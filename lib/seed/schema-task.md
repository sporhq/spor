---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.21.1
title: Seed schema for task nodes
summary: Node schema for the task type — active or planned work. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `task` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`readiness`/`readiness_by`/`readiness_at`/`readiness_via` (field documentation,
task-spor-readiness-stamp-verb — no schema-version bump: these fields are read
by the queue kernel's `deriveReadiness` in `lib/kernel/queue.js`, not by this
schema's own `validate()`/`transitions()`/`get()` hooks, so nothing here
changes behavior). The agent-readiness manual override
(dec-spor-agent-readiness-derived-classification): `readiness: agent`,
stamped by `spor ready <id>` / `POST /v1/nodes/{id}/readiness`, is the ONE
hand-settable value of the otherwise structurally-derived `agent|human|
untriaged` classification — mirroring `priority`/`priority_by` in shape
(`readiness_by`/`_at`/`_via` carry the same identity/timestamp/door
attribution). There is no hand-settable `readiness: human`: human is always
derived structurally (`requires: human`, `assigned → person`, held-task state,
an open question in the neighborhood) and always wins over the stamp, so a
later human-signal edit still flips a stamped item back. `spor ready <id>
--needs-input` clears the stamp, demoting back to whatever the structural
derivation produces. See QUEUE.md for the full derivation.

`validate()` (2026.06.20.1, issue-spor-node-create-bypasses-status-vocabulary):
the status-vocabulary MEMBERSHIP check moved to the `validate()` door so it runs
on **create as well as update**. `transitions()` then ran on UPDATE only, so the
vocabulary gate there never saw a fresh create — a node could be BORN with an
off-vocabulary status (e.g. `in_progress`) that no write rejected, until a later
re-validating write (a commit-link) hit the update-path gate and failed
`transition_denied`. `validate()` and `transitions()` now SHARE one `VALID`
list (no drift), so the two paths agree on the enum. Membership is a property of
the node in isolation (it belongs at the door); the completion-resolver gate
below stays in `transitions()` — which the host now also runs on create (passing
`current` = the proposed node, since a create is not a transition), so a
born-terminal task is gated too
(issue-spor-node-create-ungated-for-completion-resolver-gate).
Backward-readable: write-time only, no stored-shape change, no upgrade chain.

`transitions()` (2026.06.14.1): two write-time gates. (1) Status is
constrained to the task vocabulary (`open`/`active`/`done`/`abandoned`, or
none = live) so the queue-terminal value (`done`) is not shadowed by synonyms
— the same class of drift that left captures ranking live under a then-non-terminal
`dismissed` (dec-cc-status-enforcement-via-transitions). (2) Completion
(`done`) additionally requires a durable outcome ON THE GRAPH: a live inbound
`resolves` edge from a `decision` or `artifact` node, read off `view.resolvers`
(task-cc-terminal-status-requires-resolver). Even a few lines of artifact —
what was done, like a commit message — beats a bare status flip, because the
node surfaces in the neighborhood. `abandoned` (won't do) is exempt; nothing
was produced to record. Both are write-time gates, backward-readable (no
stored-shape change; existing `done` tasks are untouched), no upgrade chain.

`transitions()` + `status` (2026.06.15.1, dec-spor-definition-of-done-org-policy):
the completion gate tightens — `done` requires the inbound resolver to be in a
*resolving* state, not merely present. The host supplies the registry's
resolving partition on the view as `non_resolving_statuses` (the same
`status.non_resolving` the kernel's `resolutionMap` reads), and the gate counts a
decision/artifact resolver only when its status is not named there. So a human
cannot hand-flip `done` past an in-review change — the write-time mirror of the
read-time retirement rule. `status.non_resolving: [abandoned]` declares the
type's half of the partition: an abandoned task resolves nothing. Absent the
partition on the view (an older server) every resolver counts exactly as before,
so the gate is backward-readable with no node-shape change and no upgrade chain.

`get()` (2026.06.19.1): the read-time enrichment hook
(task-spor-schema-get-hook-readtime-enrichment) — the single mechanism that
generalizes the old hardcoded `get_node` ride-alongs. On every read the server
hands the hook a bounded one-hop neighborhood (`ctx.neighbors`, not a live graph
handle — the §2.4 sandbox is a JSON-only boundary) and the hook attaches derived
context. For a task that is the **resolving outcome**: the first live inbound
`resolves` edge from a non-superseded, resolving-status `decision`/`artifact`
rides along as `resolution` with its summary, with a `lagging` flag — ⚠ when an
open status contradicts the edge, an informational ✓ when the task is healthily
`done` (task-spor-getnode-surface-resolution-on-terminal). The read-time twin of
the `transitions()` completion gate above; pure, read-only, fail-soft; registry
behavior only, backward-readable, no upgrade chain.

`get()` (2026.06.19.2): the **held-task churn** note
(task-spor-queue-front-loop-self-limit-on-held-tasks). When the same read finds
NO live resolving edge but the task is still open and carries an inbound
non-resolving outcome (an `artifact`/`decision` work product) with no live
blocker, it rides along `held` — a `⚠ stays queued — close the loop` note naming
the four de-queue actions (resolve, gate with `blocked-by`, set `wake:`, or
`abandon`). This is the read-time twin of the queue's `do → triage` flip and
front damping (lib/kernel/queue.js) for a task held open on an external gate, and
the inverse of the definition-of-done gate (`done` *requires* a resolving
resolver; a *non*-resolving outcome announces the task stays live). A pending
in-review resolver is excluded — it is a resolution in flight, not a held
outcome. Pure, read-only, fail-soft; backward-readable, no upgrade chain.

`get()` (2026.06.21.1, task-spor-queue-held-guard-residual-reference-and-priority-
front): the held-note outcome test narrows to keep step with the queue's
`hasInboundOutcome` — a `relates-to`/`derived-from`/`mentions` inbound edge is a
bare reference (a prior-art citation, an "informed by", a passing mention), NOT a
work product produced while holding the task, so it no longer rides a `held` note.
This is fix (a) of the residual the 194b252 referenced-resolver fix left: a ready,
never-worked task that some unrelated artifact merely references no longer reads as
held. The surviving outcome edge is `decided-in` (a choice reached while doing the
task). The queue's complementary front-floor guard (fix b) has no twin here — the
read hook carries no `front` signal — but the edge narrowing keeps get_node and the
queue consistent. Pure, read-only, fail-soft; backward-readable, no upgrade chain.

```json
{
  "node_type": "task",
  "description": "active or planned work",
  "prefix": [
    "task-"
  ],
  "queueable": true,
  "status": {
    "non_resolving": [
      "abandoned"
    ]
  }
}
```

```js
// The task status vocabulary, shared by validate() (membership; the door, runs
// on create AND update) and transitions() (transition legality + the completion
// gate; run on create + update). Defining it ONCE is what makes the create path and the
// update path AGREE on the enum (issue-spor-node-create-bypasses-status-
// vocabulary): the membership check used to live only in the update-path gate,
// so a node could be BORN with an off-vocabulary status that a later
// re-validating write then rejected with transition_denied.
const VALID = ["open", "active", "done", "abandoned"];
function statusReason(next) {
  return "invalid task status '" + next + "': valid statuses are open " +
    "(planned), active (in progress), done (completed), abandoned (won't do) " +
    "— or none, meaning live. (dec-cc-status-enforcement-via-transitions)";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce status-vocabulary MEMBERSHIP here so a task cannot be
// BORN with an off-vocabulary status that the update-path transitions() gate
// would later reject (issue-spor-node-create-bypasses-status-vocabulary). Empty
// status (status-less = live) is allowed; the completion-resolver gate stays in
// transitions() — a transition concern the host runs on create + update.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}

// transitions(current, proposed, view) — task status gate. Runs on every write
// (create AND update) in the §2.4 sandbox, JSON boundary, pure; on create the
// host passes `current` = the proposed node (a create is not a transition), so
// the state-framed `done` gate below applies to a born-`done` task too
// (issue-spor-node-create-ungated-for-completion-resolver-gate). Empty status
// (status-less = live) is always allowed; denial reasons are actionable so a
// writing agent can correct and retry. The vocabulary check is SHARED with
// validate() above (which also enforces it on create); transitions() keeps it to
// gate the `done` branch below.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // (1) vocabulary gate (dec-cc-status-enforcement-via-transitions).
  if (VALID.indexOf(next) === -1) {
    return { allow: false, reason: statusReason(next) };
  }
  // (2) completion must record a durable outcome on the graph: a decision or
  // artifact that resolves this task (task-cc-terminal-status-requires-resolver),
  // AND that resolver must be in a RESOLVING state — not an in-review change
  // (dec-spor-definition-of-done-org-policy). `abandoned` is exempt.
  // view.resolvers = live inbound resolves/answers edges with their source type
  // and status; view.non_resolving_statuses = the registry's resolving partition
  // the host supplies (the same status.non_resolving the kernel's resolutionMap
  // reads). A resolver counts unless its status is named non-resolving, so an
  // older host that omits the partition behaves exactly as before
  // (backward-readable).
  if (next === "done") {
    const rs = (view && view.resolvers) || [];
    const nonResolving = (view && view.non_resolving_statuses) || [];
    let ok = false;
    for (let i = 0; i < rs.length; i++) {
      const isChange = rs[i].type === "decision" || rs[i].type === "artifact";
      const st = ((rs[i] && rs[i].status) || "").toLowerCase();
      if (isChange && nonResolving.indexOf(st) === -1) { ok = true; break; }
    }
    if (!ok) {
      return {
        allow: false,
        reason: "done requires a decision or artifact node in a RESOLVING state " +
          "that resolves this task (an inbound resolves edge) — record the " +
          "outcome on the graph, even a few lines like a commit message, so it " +
          "surfaces in the neighborhood; a change still in review keeps the task " +
          "live until it lands. Or set abandoned if it won't be done. " +
          "(task-cc-terminal-status-requires-resolver)",
      };
    }
  }
  return { allow: true };
}
```

```js
// get(node, ctx) — read-time enrichment, run on get_node in the §2.4 sandbox
// (task-spor-schema-get-hook-readtime-enrichment). JSON boundary, pure, read-only.
// The host hands in a BOUNDED one-hop neighborhood rather than a live graph handle:
//   ctx.neighbors[] = this node's edges, each { id, edge, dir:"in"|"out", type,
//                     status, title, summary, date, superseded } (capped fan-out)
//   ctx.non_resolving_statuses = the registry's resolving partition (a resolver in
//                     one of these statuses retires nothing)
//   ctx.terminal    = whether THIS node's status is terminal (drives the note)
// The returned object's keys ride along on the get_node result. Fail-soft: a throw
// or non-object return drops enrichment, never breaks the read.
//
// Re-expresses the resolution ride-along store.getNode used to hardcode: the FIRST
// live inbound resolves/answers edge from a non-superseded, resolving-status node
// becomes `resolution`, carrying the resolver's summary, with a `lagging` flag —
// ⚠ when an open status contradicts the edge (status lags), an informational ✓ when
// the node is healthily terminal (task-spor-getnode-surface-resolution-on-terminal).
// `answers` retires only questions; `resolves` retires any target — the same
// partition the kernel's resolutionMap applies, so reads stay byte-consistent.
//
// (2026.06.19.2, task-spor-queue-front-loop-self-limit-on-held-tasks) The
// held-task churn note. After the loop above (no live resolving edge retires
// this task), if the node is still open and carries an inbound NON-resolving
// outcome (an artifact/decision work product) with no live blocker, work was
// recorded but the loop never closed — the task stays queued forever
// (dec-cc-queue-front-from-attribution's continuity loop has nothing to resolve).
// Ride along `held` naming the four de-queue actions: the read-time twin of the
// queue's do->triage flip (lib/kernel/queue.js), and the inverse of the
// definition-of-done gate above (done REQUIRES a resolving resolver; a
// non-resolving outcome announces the task stays live). A pending (in-review)
// resolver is excluded — a resolves edge is a resolution in flight, not a held
// outcome. (2026.06.21.1, task-spor-queue-held-guard-residual-reference-and-
// priority-front, fix a) The outcome test ALSO skips bare-reference edges
// (relates-to/derived-from/mentions): a referenced artifact/decision is not a
// work product of held work on this task, so it no longer held-flags ready,
// never-worked tasks — keeping this hook in lockstep with the queue's
// hasInboundOutcome narrowing. The blocker suppressor is conservative (any inbound
// non-superseded `blocks` edge, since the hook is not handed the terminal
// vocabulary): a named gate is a "do the unblocker first" story, not "close the
// loop", and a stale gate edge is the gardener's inert-gate finding to retire.
export function get(node, ctx) {
  const neighbors = (ctx && ctx.neighbors) || [];
  const nonResolving = (ctx && ctx.non_resolving_statuses) || [];
  for (let i = 0; i < neighbors.length; i++) {
    const nb = neighbors[i];
    if (nb.dir !== "in") continue;
    if (nb.edge !== "resolves" && nb.edge !== "answers") continue;
    if (nb.superseded) continue;
    if (nonResolving.indexOf((nb.status || "").toLowerCase()) !== -1) continue;
    if (nb.edge === "answers" && node.type !== "question") continue;
    const lagging = !(ctx && ctx.terminal);
    const note = lagging
      ? "resolved by " + nb.id + (nb.date ? " (" + nb.date + ")" : "") + " via " +
        nb.edge + " edge — the status field has not been updated; trust the edge."
      : (nb.edge === "answers" ? "answered" : "resolved") + " by " + nb.id +
        (nb.date ? " (" + nb.date + ")" : "") + (nb.summary ? " — " + nb.summary : "");
    return {
      resolution: {
        by: nb.id,
        edge: nb.edge,
        date: nb.date != null ? nb.date : null,
        summary: nb.summary != null ? nb.summary : null,
        title: nb.title != null ? nb.title : null,
        lagging: lagging,
        note: note,
      },
    };
  }
  // Held-task churn note: reaching here means no live resolving edge retires this
  // task. Open task + a recorded non-resolving outcome + no live blocker = held
  // open with nothing to resolve; surface the four de-queue actions.
  if (!(ctx && ctx.terminal) && node.type === "task") {
    var outcomes = [];
    var blocked = false;
    for (var j = 0; j < neighbors.length; j++) {
      var n2 = neighbors[j];
      if (n2.dir !== "in" || n2.superseded) continue;
      if (n2.edge === "blocks") { blocked = true; continue; }
      if (n2.edge === "resolves" || n2.edge === "answers") continue;
      // Bare-reference edges are not held outcomes (task-spor-queue-held-guard-
      // residual-reference-and-priority-front, fix a): a citation or loose
      // provenance, not a work product produced while holding the task. Keeps this
      // hook in lockstep with the queue's hasInboundOutcome narrowing.
      if (n2.edge === "relates-to" || n2.edge === "derived-from" || n2.edge === "mentions") continue;
      if (n2.type === "artifact" || n2.type === "decision") outcomes.push(n2.id);
    }
    if (outcomes.length && !blocked) {
      return {
        held: {
          outcomes: outcomes,
          note: "⚠ stays queued — close the loop. " + outcomes.length + " outcome" +
            (outcomes.length === 1 ? "" : "s") + " (artifact/decision) recorded " +
            "against this task but nothing resolves it, and nothing blocks it, so " +
            "the queue keeps re-surfacing it. Resolve it (a decision/artifact with " +
            "a resolves edge), gate it (a blocked-by edge naming the blocker), " +
            "defer it (wake: YYYY-MM-DD), or set status: abandoned. See: " +
            outcomes.join(", ") + ".",
        },
      };
    }
  }
  return {};
}
```
