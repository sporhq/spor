---
id: schema-incident
type: schema
kind: node-schema
schema_version: 2026.06.19.1
title: Seed schema for incident nodes
summary: Node schema for the incident type — something that went wrong in operation; queueable, so live incidents join the decision queue. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `incident` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`queueable: true` (2026.06.12.1): same rationale as schema-issue —
discovered work stays continuously visible in the decision queue until a
terminal status retires it. Backward-readable: the flag changes registry
behavior, not node shape, so no upgrade chain.

`get()` (2026.06.19.1): the read-time enrichment hook
(task-spor-schema-get-hook-readtime-enrichment), identical in shape to
schema-issue/schema-task — an incident is a resolvable workitem, so the first
live inbound `resolves` edge from a non-superseded, resolving-status
`decision`/`artifact` rides along as `resolution` with its summary and a
`lagging` flag. This is the single read-time-enrichment mechanism that replaces
the hardcoded `get_node` ride-along; carrying it on `incident` (alongside
`question`/`issue`/`task`) keeps the post-incident fix surfaced and avoids a
silent narrowing of the old all-types behavior
(task-spor-getnode-surface-resolution-on-terminal). Pure, read-only, fail-soft;
registry behavior only, backward-readable, no upgrade chain.

```json
{
  "node_type": "incident",
  "description": "something that went wrong in operation",
  "prefix": [
    "inc-"
  ],
  "queueable": true
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
