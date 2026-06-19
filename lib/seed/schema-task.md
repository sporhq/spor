---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.19.1
title: Seed schema for task nodes
summary: Node schema for the task type — active or planned work. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `task` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`transitions()` (2026.06.14.1): two write-time gates. (1) Status is
constrained to the task vocabulary (`open`/`active`/`done`/`abandoned`, or
none = live) so the queue-terminal value (`done`) is not shadowed by synonyms
— the same class of drift that left captures ranking live under a non-terminal
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
// transitions(current, proposed, view) — task status gate. Runs on every
// UPDATE in the §2.4 sandbox, JSON boundary, pure. Empty status (status-less =
// live) and the create path are always allowed; denial reasons are actionable
// so a writing agent can correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["open", "active", "done", "abandoned"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // (1) vocabulary gate (dec-cc-status-enforcement-via-transitions).
  if (VALID.indexOf(next) === -1) {
    return {
      allow: false,
      reason: "invalid task status '" + next + "': valid statuses are open " +
        "(planned), active (in progress), done (completed), abandoned (won't do) " +
        "— or none, meaning live. (dec-cc-status-enforcement-via-transitions)",
    };
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
