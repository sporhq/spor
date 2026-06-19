---
id: schema-issue
type: schema
kind: node-schema
schema_version: 2026.06.19.1
title: Seed schema for issue nodes
summary: Node schema for the issue type — a defect/finding and its resolution lineage; queueable, so open issues join the decision queue. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `issue` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`queueable: true` (2026.06.12.1): discovered work must stay continuously
visible — without it, triaging a capture into an issue silently removed the
work from the decision queue (issue-cc-issues-not-queueable). Backward-
readable: the flag changes registry behavior, not node shape, so no upgrade
chain.

`transitions()` (2026.06.14.1): two write-time gates. (1) Status is
constrained to the issue vocabulary (`open`/`active`/`resolved`, or none =
live) so the queue-terminal value (`resolved`) is not shadowed by synonyms —
the same class of drift that left captures ranking live under a non-terminal
`dismissed` (dec-cc-status-enforcement-via-transitions). (2) `resolved`
additionally requires a durable outcome ON THE GRAPH: a live inbound `resolves`
edge from a `decision` or `artifact` node, read off `view.resolvers`
(task-cc-terminal-status-requires-resolver) — a closed defect should say how it
was fixed, even in a few lines, where the neighborhood can surface it. (Issues
have no abandon path; `resolved` is the only terminal, so it is always gated.)
Both are write-time gates, backward-readable (no stored-shape change), no
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
// transitions(current, proposed, view) — issue status gate. Runs on every
// UPDATE in the §2.4 sandbox, JSON boundary, pure. Empty status (status-less =
// live) and the create path are always allowed; denial reasons are actionable
// so a writing agent can correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["open", "active", "resolved"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // (1) vocabulary gate (dec-cc-status-enforcement-via-transitions).
  if (VALID.indexOf(next) === -1) {
    return {
      allow: false,
      reason: "invalid issue status '" + next + "': valid statuses are open " +
        "(unaddressed), active (being worked), resolved (fixed) — or none, " +
        "meaning live. (dec-cc-status-enforcement-via-transitions)",
    };
  }
  // (2) resolution must record a durable outcome on the graph: a decision or
  // artifact that resolves this issue (task-cc-terminal-status-requires-resolver).
  if (next === "resolved") {
    const rs = (view && view.resolvers) || [];
    let ok = false;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].type === "decision" || rs[i].type === "artifact") { ok = true; break; }
    }
    if (!ok) {
      return {
        allow: false,
        reason: "resolved requires a decision or artifact node that resolves " +
          "this issue (an inbound resolves edge) — record how it was fixed on " +
          "the graph, even a few lines, so it surfaces in the neighborhood. " +
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
