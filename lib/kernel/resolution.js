// Spor resolution truth — plain Node, zero deps.
//
// The status field is hand-set and lags the structural truth: completion
// lives in inbound `resolves` edges (a decision/artifact resolving a task or
// issue) and `answers` edges (a node answering a question). In one dogfood
// session that lag made queue consumers recommend already-finished work
// twice (issue-cc-status-lags-resolution-edges), so read surfaces and the
// queue derive actionability from edges, not status:
//
//   resolutionMap(graph)  -> { targetId: { by, edge, date, summary, title } }
//                            for every live node retired by a live resolver.
//                            `summary`/`title` are the RESOLVER's, so a read
//                            surface can show WHAT resolved/answered the target,
//                            not just that something did
//                            (task-spor-getnode-surface-resolution-on-terminal).
//                            `answers` only retires question nodes; `resolves`
//                            retires any target. Superseded or rejected/abandoned
//                            resolvers don't count — a withdrawn fix resolves
//                            nothing.
//   resolutionOf(graph, id)      -> that entry, or null.
//   openFindingsMap(graph)       -> { nodeId: [{id, title, summary}] } for
//                                   every node an OPEN gardener finding
//                                   relates to, so read surfaces can join
//                                   findings instead of hiding them behind a
//                                   separate compile.
//   openFindingsFor(graph, id)   -> that list, or [].
//
// Zero mutation by design (dec-cc-gardener-files-findings): these are
// read-time derivations; flipping the status stays a human act.

const TERMINAL = new Set([
  "done", "resolved", "superseded", "rejected", "closed", "completed", "abandoned", "answered",
  "merged", // a triaged capture-pending: its content now lives in proper nodes
  "dismissed", // a gardener finding deliberately dismissed: drops from the queue
               // AND stays sticky — the server gardener's re-open branch only
               // revives `resolved` findings, never a dismissal
               // (issue-cc-dismissed-status-not-terminal,
               // dec-spor-gardener-reopen-warranted-resolved-finding)
]);
// Fallback resolving partition, used ONLY when a graph carries no registry
// (hand-built test graphs). The live partition is read off graph.registry
// (dec-spor-definition-of-done-org-policy): resolution.js no longer owns the
// table — it is compiled from each node-schema's `status.non_resolving`, and
// the seed reproduces this exact set byte-identically. The kernel never learns
// the words delivery/merged/in-review; it checks status against the partition.
const FALLBACK_NON_RESOLVING = new Set(["rejected", "abandoned"]);

const isTerminalStatus = (s) => TERMINAL.has((s || "").toLowerCase());

// The terminal vocabulary as a stable sorted list — the analytics closed-at cache
// fingerprints it (task-spor-analytics-closed-at-cache) so a spor upgrade that
// changes which statuses are terminal invalidates a cache whose folded state baked
// in the old vocabulary. isTerminalStatus reads this fixed set (not graph.registry),
// so this list IS the cache's terminal-vocabulary key.
const terminalStatuses = Object.freeze([...TERMINAL].sort());

function resolutionMap(graph) {
  const out = {};
  const nonResolving = graph.registry && typeof graph.registry.nonResolvingStatuses === "function"
    ? graph.registry.nonResolvingStatuses()
    : FALLBACK_NON_RESOLVING;
  for (const r of Object.values(graph.nodes)) {
    if (graph.supersededBy[r.id]) continue;
    if (nonResolving.has((r.status || "").toLowerCase())) continue;
    for (const e of r.edges ?? []) {
      if (e.type !== "resolves" && e.type !== "answers") continue;
      const target = graph.nodes[e.to];
      if (!target || out[e.to]) continue;
      if (e.type === "answers" && target.type !== "question") continue;
      out[e.to] = { by: r.id, edge: e.type, date: r.date ?? null, summary: r.summary ?? null, title: r.title ?? null };
    }
  }
  return out;
}

function resolutionOf(graph, id) {
  return graph.nodes[id] ? resolutionMap(graph)[id] ?? null : null;
}

function openFindingsMap(graph) {
  const out = {};
  for (const f of Object.values(graph.nodes)) {
    if (f.type !== "finding" || graph.supersededBy[f.id] || isTerminalStatus(f.status)) continue;
    for (const e of f.edges ?? []) {
      if (e.type !== "relates-to" || !graph.nodes[e.to]) continue;
      (out[e.to] ??= []).push({ id: f.id, title: f.title ?? null, summary: f.summary ?? null });
    }
  }
  return out;
}

function openFindingsFor(graph, id) {
  return openFindingsMap(graph)[id] ?? [];
}

module.exports = { resolutionMap, resolutionOf, openFindingsMap, openFindingsFor, isTerminalStatus, terminalStatuses };
