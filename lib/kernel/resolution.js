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
//   resolutionOf(graph, id)      -> that entry, or null (O(inbound), off the
//                                   per-graph reverse index below).
//   inboundResolvers(graph, id)  -> every eligible resolver onto id, hold
//                                   ignored (also off that index).
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
// (lib/kernel/coupling.js). The registry is its ONLY source
// (norm-cc-registry-is-contract, task-spor-registry-sole-terminal-status-
// source): the seed `register` schema `schema-register-terminal-status`
// declares the set under register name "terminal-status", and a graph-resident
// register override grows it with no code change. This module holds no copy of
// it. A caller that hands over no registry — a graph-less check (a
// REST-fetched single node, coupling.js scanning node files in the hook tool
// loop, dec-spor-coupling-norms-declared-first) or a hand-built graph with no
// `registry` — reads the SEED registry instead (fallbackRegistry below), so it
// sees exactly the seed's declarations, per-type partitions included, and can
// never drift from them. The hand-written TERMINAL_FALLBACK /
// FALLBACK_NON_RESOLVING sets that used to stand in for the seed here, and the
// test that pinned them to it, are gone (dec-cc-terminal-status-single-source).
//
// Only genuinely UNIVERSAL completion words belong in the register: since the
// per-type `status.inert` partition exists (dec-spor-status-inert-third-
// partition), a type-scoped status lives in its owning schema instead —
// artifact `released` (a delivery stage) lives in schema-artifact's own
// partition, so a non-artifact marked `released` does not silently die from
// the queue (task-spor-terminal-status-type-aware-migration).
//
// Distinct from BOTH registry.nonResolvingStatuses() (resolver semantics: does
// THIS node, acting as a resolver, retire OTHERS) and
// registry.terminalStatuses() (a node's OWN lifecycle completion, per
// node-schema `status.terminal`, read by work-analytics) — a decision's
// `settled` status is terminal for THAT partition but is deliberately absent
// here, so a settled decision keeps surfacing as live guidance in queues and
// briefings (dec-spor-decision-lifecycle-surfacing).

// Where a registry-less caller's registry comes from. The kernel reads no
// files, so the seed pack is INJECTED: lib/shell/seed.js installs a source on
// require (every façade that loads a graph requires it). A kernel-only host
// that never loaded it — a bare `require("lib/kernel/coupling.js")` — would
// otherwise have no vocabulary at all, and a status check that silently
// answered "nothing is terminal" is the worst reading available, so the
// getter loads the shell module itself as the last resort. A port of this
// kernel supplies its own source through useFallbackRegistry.
let fallbackSource = null;
let fallbackReg = null;
let universalVocab = null; // Set, the fallback registry's terminal-status register
let sortedTerminal = null; // frozen sorted array views of the two partitions
let sortedNonResolving = null;
let graphlessInert = new Map(); // type -> Set, inertVocabulary's graph-less cache

function useFallbackRegistry(source) {
  fallbackSource = source;
  fallbackReg = universalVocab = sortedTerminal = sortedNonResolving = null;
  graphlessInert = new Map();
}

function fallbackRegistry() {
  if (fallbackReg) return fallbackReg;
  if (!fallbackSource) require("../shell/seed.js"); // installs on require
  if (!fallbackSource) throw new Error("resolution: no fallback registry installed (lib/shell/seed.js)");
  fallbackReg = typeof fallbackSource === "function" ? fallbackSource() : fallbackSource;
  return fallbackReg;
}

// The registry a status question about `graph` is answered from: its own
// when it carries one that answers `method`, else the seed.
function registryOf(graph, method) {
  const reg = graph && graph.registry;
  return reg && typeof reg[method] === "function" ? reg : fallbackRegistry();
}

const lowerSet = (values) => new Set([...values].map((s) => String(s).toLowerCase()));

function universalVocabulary() {
  if (!universalVocab) {
    const reg = fallbackRegistry();
    universalVocab = lowerSet(typeof reg.registerClasses === "function" ? reg.registerClasses("terminal-status") : []);
  }
  return universalVocab;
}

// A resolver's non-resolving statuses (resolver semantics), for one `type` or
// — type omitted — the type-blind union across every node schema, off the
// graph's registry or the seed's.
function nonResolvingFor(graph, type) {
  return registryOf(graph, "nonResolvingStatuses").nonResolvingStatuses(type);
}

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

// The live terminal-status vocabulary for `graph` — the seed register UNIONED
// with the graph registry's "terminal-status" register when it carries one
// (never REPLACED: Registry.add() is winner-take-all per register name, so a
// resident override naming only its own new status — the documented growth
// path, "an org grows the vocabulary by editing a schema node" — would
// otherwise silently drop the seed's dozen values, un-terminaling every
// resolved/done/merged/… node in the graph). Cached per graph object (see
// TERMINAL_VOCAB_KEY above) since this is called from queue-ranking and
// briefing-compile hot paths.
function terminalVocabulary(graph) {
  const universal = universalVocabulary();
  if (!graph) return universal;
  const cached = graph[TERMINAL_VOCAB_KEY];
  if (cached) return cached;
  const reg = graph.registry;
  const classes = reg && typeof reg.registerClasses === "function" ? reg.registerClasses("terminal-status") : [];
  const extra = classes.map((s) => String(s).toLowerCase()).filter((s) => !universal.has(s));
  const vocab = extra.length ? new Set([...universal, ...extra]) : universal;
  graph[TERMINAL_VOCAB_KEY] = vocab;
  return vocab;
}

// Per-(graph, type) inert vocabulary cache — same Symbol-registry convention
// and invalidation story as TERMINAL_VOCAB_KEY above (a registry change always
// arrives as a brand-new graph object). Holds a Map type -> Set. The graph-less
// case caches on this module instead, reset by useFallbackRegistry.
const INERT_VOCAB_KEY = Symbol.for("spor.resolution.inert-vocabulary");

// The effective queue-liveness-dead vocabulary for one node TYPE
// (dec-spor-status-inert-third-partition): the type-blind vocabulary (via
// terminalVocabulary) UNIONED with the registry's per-type inert overlay
// (registry.inertStatuses(type): declared `status.inert`, or — the
// inheritance default — the schema's `status.terminal`), read off the graph's
// registry or, for a registry-less caller, the seed's. The union is one-way
// additive: a per-type declaration scopes a status to its own type (artifact
// `released`) without ever removing a universal word, and a type whose schema
// declares neither partition reads the type-blind vocabulary alone.
function inertVocabulary(graph, type) {
  if (!type) return terminalVocabulary(graph);
  let byType;
  if (graph) {
    byType = graph[INERT_VOCAB_KEY];
    if (!byType) byType = graph[INERT_VOCAB_KEY] = new Map();
  } else {
    byType = graphlessInert;
  }
  const cached = byType.get(type);
  if (cached) return cached;
  const blind = terminalVocabulary(graph);
  const perType = registryOf(graph, "inertStatuses").inertStatuses(type);
  // Reuse the blind Set when the overlay adds nothing new (e.g. decision's
  // declared inert values are both already universal words).
  const extra = [...perType].filter((v) => !blind.has(v));
  const vocab = extra.length ? new Set([...blind, ...extra]) : blind;
  byType.set(type, vocab);
  return vocab;
}

// Is this status queue-liveness-dead for a node of this TYPE? Type-aware
// (task-spor-terminal-status-type-aware-migration): callers pass the node's
// `type` so the registry's per-type inert partition applies; `type` and
// `graph` are each optional — a caller with no graph (a REST-fetched single
// node, coupling.js's graph-less scan) reads the seed registry, per-type
// partition included. The typeof guard exists to catch stale pre-migration
// call sites that passed the GRAPH as the second argument — silently treating
// a graph object as a type would read the wrong vocabulary instead of failing
// loudly.
const isTerminalStatus = (s, type, graph) => {
  if (type != null && typeof type !== "string") {
    throw new TypeError("isTerminalStatus(status, type, graph): `type` must be the node's type string (did a caller pass the graph as the second argument?)");
  }
  return inertVocabulary(graph, type).has((s || "").toLowerCase());
};

// The seed's terminal vocabulary as a stable sorted list — the analytics
// closed-at cache fingerprints it (task-spor-analytics-closed-at-cache) so a
// spor upgrade that changes which statuses are terminal invalidates a cache
// whose folded state baked in the old vocabulary — and the seed's type-blind
// non-resolving union beside it. Both are read-only VIEWS of the seed
// registry's declarations (exported as lazy getters below), not tables of
// their own.
function terminalStatusesView() {
  return (sortedTerminal ??= Object.freeze([...universalVocabulary()].sort()));
}
function nonResolvingStatusesView() {
  return (sortedNonResolving ??= Object.freeze([...nonResolvingFor(null)].sort()));
}

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

// A give-up status must be BOTH non-resolving for this node's type and
// inert for that type. Resolver-only stages (artifact in-review/approved)
// cannot withdraw an execution hold. Universal terminal words remain part
// of the inert reading; task abandoned therefore needs no new declaration.
// No type means no evidence of giving up. A graph-less typed caller reads the
// seed registry's partitions for that type.
function isGiveUpStatus(status, type, graph) {
  if (type != null && typeof type !== "string") {
    throw new TypeError("isGiveUpStatus(status, type, graph): `type` must be the node's type string");
  }
  if (!type) return false;
  return nonResolvingFor(graph, type).has((status || "").toLowerCase()) && isTerminalStatus(status, type, graph);
}

function resolutionMap(graph) {
  const out = {};
  const nonResolving = nonResolvingFor(graph);
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

// The per-graph REVERSE INDEX of resolving edges
// (task-spor-kernel-inbound-resolvers-reverse-index): Map(target id ->
// [{from, edge}]), one entry per (source, `resolves`/`answers` edge), in
// graph.nodes declaration order and each source's edge order — exactly the
// order a full scan meets them. Built lazily on first use and cached on the
// graph object under a global-registry Symbol, so a caller that asks about
// many ids (the gardener's terminal pass, `spor get` over a list) pays ONE
// O(edges) build instead of an O(N) scan per id — the scan made a loop over
// nodes O(N²), 64 s of CPU at 6.8k nodes.
//
// The index holds EDGES only. Everything a resolver's eligibility depends on
// that is not an edge — the source's status, its supersession, the target's
// type and execution hold — is read LIVE at query time, so the cache can only
// go stale when an edge set changes. Lifecycle is the queue index's
// (queue.js QUEUE_INDEX): a full reload is a fresh graph object with no
// cache, and applyNode — the one in-place edge mutator — deletes it
// (kernel/graph.js). Two guards beyond that: the property is NON-enumerable,
// so a `{...graph, nodes}` view (the gardener narrows graphs that way) never
// inherits a full graph's index, and the cached index remembers the
// `graph.nodes` object it was built over, so a graph whose `nodes` was
// swapped wholesale rebuilds rather than answering for the old set.
const INBOUND_INDEX_KEY = Symbol.for("spor.resolution.inbound-index");

function inboundIndex(graph) {
  const cached = graph[INBOUND_INDEX_KEY];
  if (cached && cached.nodes === graph.nodes) return cached.byTarget;
  const byTarget = new Map();
  for (const r of Object.values(graph.nodes)) {
    for (const e of r.edges ?? []) {
      if (e.type !== "resolves" && e.type !== "answers") continue;
      let list = byTarget.get(e.to);
      if (!list) byTarget.set(e.to, (list = []));
      list.push({ from: r.id, edge: e.type });
    }
  }
  Object.defineProperty(graph, INBOUND_INDEX_KEY, {
    value: { nodes: graph.nodes, byTarget }, writable: true, configurable: true, enumerable: false,
  });
  return byTarget;
}

// The eligible resolver NODES onto `id`, with their edge, in scan order —
// the shared core of inboundResolvers and resolutionOf. Applies the same
// resolver/edge filter resolutionMap does (a superseded or non-resolving
// source resolves nothing; `answers` only onto a question), minus the hold.
function eligibleInbound(graph, id, target) {
  const entries = inboundIndex(graph).get(id);
  if (!entries) return [];
  const nonResolving = nonResolvingFor(graph);
  const out = [];
  for (const { from, edge } of entries) {
    const r = graph.nodes[from];
    if (!r) continue;
    if (graph.supersededBy[r.id]) continue;
    if (nonResolving.has((r.status || "").toLowerCase())) continue;
    if (edge === "answers" && target.type !== "question") continue;
    out.push({ r, edge });
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
// Reads the per-graph reverse index above, so it is O(inbound edges), not
// O(N).
function inboundResolvers(graph, id) {
  const target = graph && graph.nodes ? graph.nodes[id] : null;
  if (!target) return [];
  return eligibleInbound(graph, id, target).map(({ r, edge }) =>
    ({ by: r.id, edge, type: r.type ?? null, status: r.status ?? null }));
}

// resolutionMap(graph)[id], without building the whole map: the FIRST
// eligible inbound resolver in scan order is exactly the one resolutionMap's
// first-wins loop records, and a held target has no entry there.
function resolutionOf(graph, id) {
  const target = graph.nodes[id];
  if (!target || executionHeld(target)) return null;
  const first = eligibleInbound(graph, id, target)[0];
  if (!first) return null;
  const { r, edge } = first;
  return { by: r.id, edge, date: r.date ?? null, summary: r.summary ?? null, title: r.title ?? null };
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
  resolutionMap, resolutionOf, openFindingsMap, openFindingsFor, isTerminalStatus,
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
  // The per-type queue-liveness vocabulary isTerminalStatus tests against
  // (coupling.js's back-compat TERMINAL alias reads it for type "norm").
  inertVocabulary,
  // The injection point for the registry a registry-less caller reads
  // (lib/shell/seed.js installs the seed pack; a test or a kernel port may
  // install its own), and that registry itself.
  useFallbackRegistry, fallbackRegistry,
};
// Lazy, so requiring this module reads no seed until a caller asks.
Object.defineProperty(module.exports, "terminalStatuses", { enumerable: true, get: terminalStatusesView });
Object.defineProperty(module.exports, "nonResolvingStatuses", { enumerable: true, get: nonResolvingStatusesView });
