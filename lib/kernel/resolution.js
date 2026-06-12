// Spor resolution truth — plain Node, zero deps.
//
// The status field is hand-set and lags the structural truth: completion
// lives in inbound `resolves` edges (a decision/artifact resolving a task or
// issue) and `answers` edges (a node answering a question). In one dogfood
// session that lag made queue consumers recommend already-finished work
// twice (issue-cc-status-lags-resolution-edges), so read surfaces and the
// queue derive actionability from edges, not status:
//
//   resolutionMap(graph)  -> { targetId: { by, edge, date } } for every live
//                            node retired by a live resolver. `answers` only
//                            retires question nodes; `resolves` retires any
//                            target. Superseded or rejected/abandoned
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
]);
const NON_RESOLVING = new Set(["rejected", "abandoned"]);

const isTerminalStatus = (s) => TERMINAL.has((s || "").toLowerCase());

function resolutionMap(graph) {
  const out = {};
  for (const r of Object.values(graph.nodes)) {
    if (graph.supersededBy[r.id]) continue;
    if (NON_RESOLVING.has((r.status || "").toLowerCase())) continue;
    for (const e of r.edges ?? []) {
      if (e.type !== "resolves" && e.type !== "answers") continue;
      const target = graph.nodes[e.to];
      if (!target || out[e.to]) continue;
      if (e.type === "answers" && target.type !== "question") continue;
      out[e.to] = { by: r.id, edge: e.type, date: r.date ?? null };
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

module.exports = { resolutionMap, resolutionOf, openFindingsMap, openFindingsFor, isTerminalStatus };
