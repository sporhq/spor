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
// Only genuinely UNIVERSAL completion words belong here: since the per-type
// `status.inert` partition exists (dec-spor-status-inert-third-partition), a
// type-scoped status lives in its owning schema instead — artifact `released`
// (a delivery stage) moved out of this set into schema-artifact's own
// partition, so a non-artifact marked `released` no longer silently dies from
// the queue (the cross-type contamination
// task-spor-terminal-status-type-aware-migration existed to remove).
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

// Per-(graph, type) inert vocabulary cache — same Symbol-registry convention
// and invalidation story as TERMINAL_VOCAB_KEY above (a registry change always
// arrives as a brand-new graph object). Holds a Map type -> Set.
const INERT_VOCAB_KEY = Symbol.for("spor.resolution.inert-vocabulary");

// The effective queue-liveness-dead vocabulary for one node TYPE
// (dec-spor-status-inert-third-partition): the type-blind vocabulary (the
// terminal-status register ∪ TERMINAL_FALLBACK, via terminalVocabulary)
// UNIONED with the registry's per-type inert overlay
// (graph.registry.inertStatuses(type): declared `status.inert`, or — the
// inheritance default — the schema's `status.terminal`). The union is
// one-way additive: a per-type declaration scopes a status to its own type
// (artifact `released`) without ever removing a universal word, and a type
// whose schema declares neither partition reads the type-blind vocabulary
// alone — byte-identical to the pre-inert behavior.
function inertVocabulary(graph, type) {
  if (!graph || !type) return terminalVocabulary(graph);
  let byType = graph[INERT_VOCAB_KEY];
  if (!byType) byType = graph[INERT_VOCAB_KEY] = new Map();
  const cached = byType.get(type);
  if (cached) return cached;
  const blind = terminalVocabulary(graph);
  const reg = graph.registry;
  const perType = reg && typeof reg.inertStatuses === "function" ? reg.inertStatuses(type) : null;
  // Reuse the blind Set when the overlay adds nothing new (e.g. decision's
  // declared inert values are both already universal words).
  const extra = perType ? [...perType].filter((v) => !blind.has(v)) : [];
  const vocab = extra.length ? new Set([...blind, ...extra]) : blind;
  byType.set(type, vocab);
  return vocab;
}

// Is this status queue-liveness-dead for a node of this TYPE? Type-aware
// (task-spor-terminal-status-type-aware-migration): callers pass the node's
// `type` so the registry's per-type inert partition applies; `type` and
// `graph` are each optional — a caller with neither (a REST-fetched single
// node, coupling.js's graph-less scan) gets TERMINAL_FALLBACK, and a graph
// without a per-type declaration behaves exactly as before. The typeof guard
// exists to catch stale pre-migration call sites that passed the GRAPH as the
// second argument — silently treating a graph object as a type would downgrade
// them to the fallback vocabulary instead of failing loudly.
const isTerminalStatus = (s, type, graph) => {
  if (type != null && typeof type !== "string") {
    throw new TypeError("isTerminalStatus(status, type, graph): `type` must be the node's type string (did a caller pass the graph as the second argument?)");
  }
  return inertVocabulary(graph, type).has((s || "").toLowerCase());
};

// The terminal vocabulary as a stable sorted list — the analytics closed-at cache
// fingerprints it (task-spor-analytics-closed-at-cache) so a spor upgrade that
// changes which statuses are terminal invalidates a cache whose folded state baked
// in the old vocabulary. This is the FALLBACK vocabulary (not a graph-resident
// register's live extension of it) — the cache's terminal-vocabulary key.
const terminalStatuses = Object.freeze([...TERMINAL_FALLBACK].sort());

// The EXECUTION HOLD (dec-spor-factory-implementation-stage-contract,
// FACTORY-IMPLEMENTATION-STAGE.md §4.5; task-spor-factory-controller-
// completion-boundary). Under `completion.by: controller` a factory worker
// stamps the item it is about to implement with `execution: <execution_id>`
// (a flat frontmatter key, CAS-written) BEFORE any dispatch, and clears it in
// the SAME write as the terminal status once every declared gate — and the
// integration stage, where declared — has passed. Between those two writes
// the item is HELD: no inbound resolving edge retires it and no terminal
// status kills it, whoever wrote either. That is the whole guarantee that
// "a pending or refused pipeline releases nothing" rests on, and it is a READ
// rule, because liveness is edge-derived and this client cannot un-release a
// dependent after a write it did not interpose on — local mode has no write
// door at all, only the read side, and the read side is these two functions
// (resolutionMap here, queue.isLive). An implementer that writes its
// `resolves` edge anyway — or hand-flips `status: done` — has broken the
// contract, but the write is INERT from the instant it lands, on every reader
// running this lib, in both modes. The runner then retypes the edge as
// evidence (`resolves` -> `relates-to`) and restores the status; neither is
// load-bearing for dependents, the hold is.
//
// ONE predicate, read by BOTH halves of liveness, so the two can never
// disagree about what "held" means. A hold is a non-empty string; anything
// else (absent, empty, a stray boolean) is not a hold.
function executionHeld(node) {
  return !!node && typeof node.execution === "string" && node.execution.trim() !== "";
}

// The give-up statuses — the registry's non-resolving partition (abandoned,
// rejected; FALLBACK_NON_RESOLVING without a registry). A hold keeps a
// premature COMPLETION inert; it does not keep a person's decision to DROP the
// work alive: `set_status abandoned` is the person's door out of an execution
// (§4.5), so an abandoned item is dead on the status half even while held,
// and the controller's withdraw branch then clears the hold after the fact.
function isGiveUpStatus(status, graph) {
  const nonResolving = graph && graph.registry && typeof graph.registry.nonResolvingStatuses === "function"
    ? graph.registry.nonResolvingStatuses()
    : FALLBACK_NON_RESOLVING;
  return nonResolving.has((status || "").toLowerCase());
}

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
      // An OPEN execution hold on the target: no inbound resolving edge
      // retires a held item (the edge half of the hold, above).
      if (executionHeld(target)) continue;
      out[e.to] = { by: r.id, edge: e.type, date: r.date ?? null, summary: r.summary ?? null, title: r.title ?? null };
    }
  }
  return out;
}

// Every inbound resolving edge onto `id` that WOULD retire it were it not
// held — the same resolver/edge filter resolutionMap applies, minus the hold
// rule. This is what the controller compares against its claim-time snapshot
// to find a PREMATURE resolution (§4.5: any inbound `resolves`/`answers`
// whose source is not in the snapshot is premature, whoever wrote it), and
// what `spor get` lists as the resolvers a hold is keeping inert. Oldest
// declaration order (graph.nodes iteration), one entry per (source, edge).
function inboundResolvers(graph, id) {
  const target = graph && graph.nodes ? graph.nodes[id] : null;
  if (!target) return [];
  const nonResolving = graph.registry && typeof graph.registry.nonResolvingStatuses === "function"
    ? graph.registry.nonResolvingStatuses()
    : FALLBACK_NON_RESOLVING;
  const out = [];
  for (const r of Object.values(graph.nodes)) {
    if (graph.supersededBy[r.id]) continue;
    if (nonResolving.has((r.status || "").toLowerCase())) continue;
    for (const e of r.edges ?? []) {
      if (e.type !== "resolves" && e.type !== "answers") continue;
      if (e.to !== id) continue;
      if (e.type === "answers" && target.type !== "question") continue;
      out.push({ by: r.id, edge: e.type, type: r.type ?? null, status: r.status ?? null });
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
    if (f.type !== "finding" || graph.supersededBy[f.id] || isTerminalStatus(f.status, f.type, graph)) continue;
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

module.exports = {
  resolutionMap, resolutionOf, openFindingsMap, openFindingsFor, isTerminalStatus, terminalStatuses,
  executionHeld, inboundResolvers, isGiveUpStatus,
  // Exposed for lib/shell/dispatch-terminal.js's verifyLocalResolution
  // (issue-spor-terminal-status-validation-regressions): a caller that
  // already has a loaded graph and wants the UNION of the type-blind
  // fallback with a resident "terminal-status" register override, without
  // also pulling in the per-type queue-liveness `inert` overlay
  // isTerminalStatus/inertVocabulary apply (which would wrongly read a
  // decision's own-lifecycle-complete `settled` as not-done, the exact
  // partition dec-spor-decision-lifecycle-surfacing keeps distinct).
  terminalVocabulary,
};
