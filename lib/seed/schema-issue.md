---
id: schema-issue
type: schema
kind: node-schema
schema_version: 2026.06.21.1
title: Seed schema for issue nodes
summary: Node schema for the issue type — a defect/finding and its resolution lineage; queueable, so open issues join the decision queue. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `issue` node type, shipped with the plugin as a
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

`queueable: true` (2026.06.12.1): discovered work must stay continuously
visible — without it, triaging a capture into an issue silently removed the
work from the decision queue (issue-cc-issues-not-queueable). Backward-
readable: the flag changes registry behavior, not node shape, so no upgrade
chain.

`validate()` (2026.06.20.1, issue-spor-node-create-bypasses-status-vocabulary):
the status-vocabulary MEMBERSHIP check moved to the `validate()` door so it runs
on **create as well as update**. `transitions()` then ran on UPDATE only, so its
vocabulary gate never saw a fresh create — a node could be BORN with an
off-vocabulary status that no write rejected, until a later re-validating write
hit the update-path gate and failed `transition_denied`. `validate()` and
`transitions()` now SHARE one `VALID` list (no drift), so the two paths agree on
the enum; the `resolved` resolver gate stays in `transitions()` — which the host
now also runs on create (passing `current` = the proposed node, since a create is
not a transition), so a born-`resolved` issue is gated too
(issue-spor-node-create-ungated-for-completion-resolver-gate). Backward-readable:
write-time only, no node-shape change, no upgrade chain.

`transitions()` (2026.06.14.1): two write-time gates. (1) Status is
constrained to the issue vocabulary (`open`/`active`/`resolved`, or none =
live) so the queue-terminal value (`resolved`) is not shadowed by synonyms —
the same class of drift that left captures ranking live under a then-non-terminal
`dismissed` (dec-cc-status-enforcement-via-transitions). (2) `resolved`
additionally requires a durable outcome ON THE GRAPH: a live inbound `resolves`
edge from a `decision` or `artifact` node, read off `view.resolvers`
(task-cc-terminal-status-requires-resolver) — a closed defect should say how it
was fixed, even in a few lines, where the neighborhood can surface it. (Issues
have no abandon path; `resolved` is the only terminal, so it is always gated.)
Both are write-time gates, backward-readable (no stored-shape change), no
upgrade chain.

`transitions()` + `status` (2026.06.21.1, dec-spor-definition-of-done-org-policy):
the `resolved` gate tightens to mirror schema-task's `done` gate
(task-spor-schema-issue-resolved-gate-tightening) — it requires the inbound
resolver to be in a *resolving* state, not merely present. The host supplies the
registry's resolving partition on the view as `non_resolving_statuses` (the same
`status.non_resolving` the kernel's `resolutionMap` reads), and the gate counts a
decision/artifact resolver only when its status is not named there. So a human
cannot hand-flip `resolved` past an in-review change — the write-time mirror of
the read-time retirement rule. Issues declare no `status.non_resolving` of their
own (the `open`/`active`/`resolved` vocabulary carries no withdrawn or in-review
state), so the type contributes nothing to the partition; the gate only READS it.
Absent the partition on the view (an older server) every resolver counts exactly
as before, so the gate is backward-readable with no node-shape change and no
upgrade chain.

`get()` (2026.06.19.1): the read-time enrichment hook
(task-spor-schema-get-hook-readtime-enrichment) — the single mechanism that
generalizes the old hardcoded `get_node` ride-alongs. On every read the server
hands the hook a bounded one-hop neighborhood (`ctx.neighbors`, not a live graph
handle — the §2.4 sandbox is a JSON-only boundary) and the hook attaches derived
context. For an issue that is the **resolving change**: the first live inbound
`resolves` edge from a non-superseded, resolving-status `decision`/`artifact`
rides along as `resolution` with its summary, with a `lagging` flag — ⚠ when an
open status contradicts the edge, an informational ✓ when the issue is healthily
`resolved` (task-spor-getnode-surface-resolution-on-terminal). Pure, read-only,
fail-soft; registry behavior only, backward-readable, no upgrade chain.

```json
{
  "node_type": "issue",
  "description": "a defect/finding and its resolution lineage",
  "prefix": [
    "issue-"
  ],
  "queueable": true
}
```

```js
// The issue status vocabulary, shared by validate() (membership; the door, runs
// on create AND update) and transitions() (transition legality + the
// resolved-resolver gate; run on create + update). Defining it ONCE is what makes the
// create path and the update path AGREE on the enum
// (issue-spor-node-create-bypasses-status-vocabulary): the membership check used
// to live only in the update-path gate, so a node could be BORN with an
// off-vocabulary status that a later re-validating write then rejected.
const VALID = ["open", "active", "resolved"];
function statusReason(next) {
  return "invalid issue status '" + next + "': valid statuses are open " +
    "(unaddressed), active (being worked), resolved (fixed) — or none, " +
    "meaning live. (dec-cc-status-enforcement-via-transitions)";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce status-vocabulary MEMBERSHIP here so an issue cannot be
// BORN with an off-vocabulary status that the update-path transitions() gate
// would later reject (issue-spor-node-create-bypasses-status-vocabulary). Empty
// status (status-less = live) is allowed; the resolved-resolver gate stays in
// transitions() — a transition concern the host runs on create + update.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}

// transitions(current, proposed, view) — issue status gate. Runs on every write
// (create AND update) in the §2.4 sandbox, JSON boundary, pure; on create the
// host passes `current` = the proposed node (a create is not a transition), so
// the state-framed `resolved` gate below applies to a born-`resolved` issue too
// (issue-spor-node-create-ungated-for-completion-resolver-gate). Empty status
// (status-less = live) is always allowed; denial reasons are actionable so a
// writing agent can correct and retry. The vocabulary check is SHARED with
// validate() above (which also enforces it on create); transitions() keeps it to
// gate the `resolved` branch below.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // (1) vocabulary gate (dec-cc-status-enforcement-via-transitions).
  if (VALID.indexOf(next) === -1) {
    return { allow: false, reason: statusReason(next) };
  }
  // (2) resolution must record a durable outcome on the graph: a decision or
  // artifact that resolves this issue (task-cc-terminal-status-requires-resolver),
  // AND that resolver must be in a RESOLVING state — not an in-review change
  // (dec-spor-definition-of-done-org-policy). This mirrors schema-task's `done`
  // gate (task-spor-schema-issue-resolved-gate-tightening). view.resolvers = live
  // inbound resolves/answers edges with their source type and status;
  // view.non_resolving_statuses = the registry's resolving partition the host
  // supplies (the same status.non_resolving the kernel's resolutionMap reads). A
  // resolver counts unless its status is named non-resolving, so an older host
  // that omits the partition behaves exactly as before (backward-readable). Issues
  // have no abandon path; `resolved` is the only terminal, so it is always gated.
  if (next === "resolved") {
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
        reason: "resolved requires a decision or artifact node in a RESOLVING " +
          "state that resolves this issue (an inbound resolves edge) — record " +
          "how it was fixed on the graph, even a few lines, so it surfaces in " +
          "the neighborhood; a change still in review keeps the issue open " +
          "until it lands. (task-cc-terminal-status-requires-resolver)",
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
  return {};
}
```
