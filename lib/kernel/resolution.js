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

// The type-blind terminal-status vocabulary — a status value that retires ANY
// node from queue liveness (queue.js isLive), briefing "live work" surfacing
// (graph.js statusTag/resolutionWarn), and coupling-norm matching
// (lib/kernel/coupling.js). Registry-backed (norm-cc-registry-is-contract,
// issue-spor-coupling-resolution-terminal-status-divergence): the seed
// `register` schema `schema-register-terminal-status` declares this exact set
// under register name "terminal-status", so a graph-resident register
// override grows it with no code change, and coupling.js — which scans node
// files in the hook tool loop WITHOUT a loaded graph/registry
// (dec-spor-coupling-norms-declared-first) — shares this ONE fallback instead
// of maintaining its own divergent list. TERMINAL_FALLBACK below is what a
// graph without a registry (hand-built test graphs), or a caller with no
// graph object at all (a REST-fetched single node), reads; the seed
// reproduces this exact set byte-identically (test/registry.test.js).
//
// Distinct from BOTH graph.registry.nonResolvingStatuses() (resolver
// semantics: does THIS node, acting as a resolver, retire OTHERS) and
// graph.registry.terminalStatuses() (a node's OWN lifecycle completion, per
// node-schema `status.terminal`, read only by work-analytics) — a decision's
// `settled` status is terminal for THAT partition but is deliberately absent
// here, so a settled decision keeps surfacing as live guidance in queues and
// briefings (dec-spor-decision-lifecycle-surfacing).
const TERMINAL_FALLBACK = new Set([
  "done", "resolved", "superseded", "rejected", "closed", "completed", "abandoned", "answered",
  "merged", // a triaged capture-pending: its content now lives in proper nodes
  "dismissed", // a gardener finding deliberately dismissed: drops from the queue
               // AND stays sticky — the server gardener's re-open branch only
               // revives `resolved` findings, never a dismissal
               // (issue-cc-dismissed-status-not-terminal,
               // dec-spor-gardener-reopen-warranted-resolved-finding)
  "retired", "deprecated", // coupling.js's prior extra values (a retired/deprecated norm
                           // stops matching) — folded in here so both consumers share ONE list
  "released", // an artifact's shipped delivery stage — previously missing, so a
              // released artifact never retired from queue liveness
              // (issue-spor-coupling-resolution-terminal-status-divergence)
]);
// Fallback resolving partition, used ONLY when a graph carries no registry
// (hand-built test graphs). The live partition is read off graph.registry
// (dec-spor-definition-of-done-org-policy): resolution.js no longer owns the
// table — it is compiled from each node-schema's `status.non_resolving`, and
// the seed reproduces this exact set byte-identically. The kernel never learns
// the words delivery/merged/in-review; it checks status against the partition.
const FALLBACK_NON_RESOLVING = new Set(["rejected", "abandoned"]);

// Same Symbol-registry convention as queue.js's QUEUE_INDEX (kernel/queue.js,
// kernel/graph.js applyNode): a global-registry Symbol key on the graph object
// itself, invisible to Object.keys/JSON/spread. Unlike QUEUE_INDEX this needs
// NO invalidation hook in applyNode — a schema write (which is the only thing
// that could change what the registry resolves for "terminal-status") makes
// applyNode return `reloadRequired: true` instead of patching in place
// (kernel/graph.js), so a resident graph's `graph.registry` — and therefore
// this cached vocabulary — never changes under a live graph object; a
// changed registry always arrives as a brand-new graph with no cache entry.
const TERMINAL_VOCAB_KEY = Symbol.for("spor.resolution.terminal-vocabulary");

// The live terminal-status vocabulary for `graph` — TERMINAL_FALLBACK UNIONED
// with the registry's "terminal-status" register when one is resolvable
// (never REPLACED: Registry.add() is winner-take-all per register name, so a
// resident override naming only its own new status — the documented growth
// path, "an org grows the vocabulary by editing a schema node" — would
// otherwise silently drop the seed's dozen values, un-terminaling every
// resolved/done/merged/… node in the graph). Cached per graph object (see
// TERMINAL_VOCAB_KEY above) since this is called from queue-ranking and
// briefing-compile hot paths.
function terminalVocabulary(graph) {
  if (!graph) return TERMINAL_FALLBACK;
  const cached = graph[TERMINAL_VOCAB_KEY];
  if (cached) return cached;
  const reg = graph.registry;
  const classes = reg && typeof reg.registerClasses === "function" ? reg.registerClasses("terminal-status") : [];
  const vocab = classes.length
    ? new Set([...TERMINAL_FALLBACK, ...classes.map((s) => String(s).toLowerCase())])
    : TERMINAL_FALLBACK;
  graph[TERMINAL_VOCAB_KEY] = vocab;
  return vocab;
}

// `graph` is optional — a caller without a loaded graph (or a graph whose
// registry carries no terminal-status register) gets TERMINAL_FALLBACK,
// byte-identical to the pre-registry behavior.
const isTerminalStatus = (s, graph) => terminalVocabulary(graph).has((s || "").toLowerCase());

// The terminal vocabulary as a stable sorted list — the analytics closed-at cache
// fingerprints it (task-spor-analytics-closed-at-cache) so a spor upgrade that
// changes which statuses are terminal invalidates a cache whose folded state baked
// in the old vocabulary. This is the FALLBACK vocabulary (not a graph-resident
// register's live extension of it) — the cache's terminal-vocabulary key.
const terminalStatuses = Object.freeze([...TERMINAL_FALLBACK].sort());

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
    if (f.type !== "finding" || graph.supersededBy[f.id] || isTerminalStatus(f.status, graph)) continue;
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
