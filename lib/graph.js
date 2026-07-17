// graph.js — IO façade over the pure graph kernel (REFACTOR.md §1 kernel/
// shell split). This path is the stable import for hooks, the server, and
// wf/lenses; the exact pre-split API is preserved. All computation lives in
// lib/kernel/graph.js (data in, data out); all filesystem access in
// lib/shell/files.js. Plain Node, zero deps.
//
// Exports (unchanged except the added lazy `timestamps` getter on loadGraph):
//   loadGraph(nodesDir)             -> { nodes, adj, supersededBy, docs, df, N, nodesDir, registry, [timestamps] }
//   compile(graph, opts)            -> { text, picks, meta }  (opts.relevant=false => "nothing")
//   validateNode(graph, candidate)  -> { ok, errors }
//   validateGraph(graph)            -> { errors, warnings, byType, count }
//   renderSkeleton(graph, rootId)   -> { briefId, version, text, sources, corrections }
//   parseFrontmatter(raw, file)     -> node object (the regex frontmatter parser)
//   seedRegistry() / buildRegistry(schemaNodes) -> Registry (lib/kernel/registry.js)
//   EDGE_WEIGHTS, KNOWN_TYPES, KNOWN_EDGES, DIGEST_CAP  (seed-derived back-compat constants)

const path = require("path");
const kernel = require("./kernel/graph.js");
const shell = require("./shell/files.js");
const kernelTs = require("./kernel/timestamps.js");
const gittime = require("./shell/gittime.js");
const kernelResolution = require("./kernel/resolution.js");

const SEED_DIR = path.join(__dirname, "seed");

// Parse the seed pack once per process. The seed ships with the repo, so a
// seed file that fails to parse is a bug — the kernel throws loudly.
let _seedSchemas = null;
function loadSeedSchemas() {
  return (_seedSchemas ??= kernel.parseSeedSchemas(shell.readGraphFiles(SEED_DIR)));
}

// Registry from the seed pack alone (what a graph with no schema nodes gets).
// NOT memoized, deliberately: callers (test/registry.test.js's "no code
// change" fixtures, among others) mutate the returned Registry in place via
// `.add()` to simulate a graph-resident schema override — a cached singleton
// here would leak those mutations across unrelated calls.
function seedRegistry() {
  return kernel.seedRegistry(loadSeedSchemas());
}

// Seed pack + graph-resident schema nodes layered on top.
function buildRegistry(schemaNodes = []) {
  return kernel.buildRegistry(loadSeedSchemas(), schemaNodes);
}

// Graph-less, type-aware terminal/inert check (issue-spor-type-blind-terminal-
// status-fallbacks): for a caller with no loaded graph — a REST-fetched single
// node, distill.js's session-lease cleanup, a remote dispatch pre-flight — the
// SEED registry alone is still enough to see a per-type declaration like
// artifact's `released` (schema-artifact's own status.terminal/inert
// partition), unlike the flat cross-type TERMINAL_FALLBACK
// (lib/kernel/resolution.js) that used to be the only option. This is a
// fallback, not a replacement for a server-computed field when one is in
// hand: it can't see graph-RESIDENT schema overrides (an org growing the
// vocabulary in a live graph node) — only a live registry (a loaded graph, or
// a future server-computed enrichment field) can. Falls back to the pure
// type-blind vocabulary only if the seed registry itself fails to build (the
// genuine last resort — should not happen in a working install).
function isTerminalStatusOffline(status, type) {
  try {
    return kernelResolution.isTerminalStatus(status, type, { registry: seedRegistry() });
  } catch {
    return kernelResolution.isTerminalStatus(status, type);
  }
}

// The full tiered decision (issue-spor-type-blind-terminal-status-
// fallbacks): `explicitInert` is a server-computed `inert` enrichment key
// when a caller has a server response in hand (API.md GET /v1/nodes/{id}),
// `null`/`undefined` when it doesn't (no server response, or an older server
// that doesn't send the key yet). A server verdict is trusted OUTRIGHT and
// BOTH ways — an explicit `false` is the server's authoritative "I checked
// the full type-aware partition, including graph-resident overrides, and
// this is NOT inert," which must win over the offline fallback below just as
// much as an explicit `true` short-circuits it; treating only `true` as
// meaningful would silently let the offline heuristic overrule a server's
// negative answer. Only when the server is silent (no boolean at all) does
// the offline seed-registry check run.
function isNodeInertOffline(explicitInert, status, type) {
  return typeof explicitInert === "boolean" ? explicitInert : isTerminalStatusOffline(status, type);
}

function loadGraph(nodesDir) {
  const dir = path.resolve(nodesDir);
  const graph = kernel.buildGraph(shell.readGraphFiles(dir), { nodesDir: dir, seedSchemas: loadSeedSchemas() });
  attachTimestamps(graph, dir);
  return graph;
}

// Hang a lazy, memoized, non-enumerable `timestamps` index off the graph
// (dec-spor-git-derived-timestamps, task-spor-git-derived-timestamp-index),
// alongside graph.registry/graph.supersededBy. LAZY so it stays OFF the no-LLM
// prompt path (norm-cc-no-llm-prompt-path / the 30s UserPromptSubmit budget):
// compile/digest never touch graph.timestamps, so the git fold never runs there;
// only the queue and analytics, which DO read it, trigger the (cache-backed)
// derivation. NON-ENUMERABLE so nothing that spreads or JSON-serializes the
// graph silently spawns git. Memoized for the life of the graph object (a fresh
// loadGraph re-derives at the new HEAD); a `null` result (non-git home) is cached
// too, so a markerless dir pays the rev-parse probe at most once.
function attachTimestamps(graph, nodesDir) {
  let computed = false, value = null;
  Object.defineProperty(graph, "timestamps", {
    enumerable: false,
    configurable: true,
    get() {
      if (!computed) {
        computed = true;
        // Fail-open (dec-cc-fail-open-hooks): a git/cache error degrades the
        // index to null, never throws onto the queue/analytics read that touched
        // it. The inner shell calls already swallow; this is belt-and-suspenders.
        try { value = deriveTimestamps(graph, nodesDir); } catch { value = null; }
      }
      return value;
    },
  });
}

// Resolve the git-derived index, cache-backed and HEAD-keyed
// (dec-spor-git-derived-timestamps): an exact-HEAD cache hit reuses it (no git
// log); a cached HEAD that is an ancestor of current folds only OLD..NEW and
// merges (the fast-forward path, modeled on the tier-2 applyNode incremental
// update); anything else — a history rewrite, a cold/torn cache — does a full
// rebuild. The cache under cache/ stores PURE git values, so the frontmatter
// override is re-applied every load over the live node bytes and a node pinning
// created_at takes effect WITHOUT invalidating the git cache. Returns null when
// the home is not a git repo (no derivable history -> graph.timestamps is null
// -> every consumer byte-identical). Fail-open like gitFront: any git/cache error
// degrades to the override-only or null map, never throws onto a load.
function deriveTimestamps(graph, nodesDir) {
  const repoDir = path.dirname(nodesDir);
  const nodesName = path.basename(nodesDir);
  const cacheDir = path.join(repoDir, "cache");
  const head = gittime.gitHead(repoDir);
  if (!head) return null; // not a git repo / no commits -> no git-derived timestamps
  let gitTs;
  const cached = gittime.readCache(cacheDir);
  if (cached && cached.head === head) {
    gitTs = cached.ts; // exact HEAD -> reuse, no git log
  } else if (cached && gittime.isAncestor(repoDir, cached.head, head)) {
    const range = kernelTs.foldGitTimestamps(
      gittime.logTimestamps(repoDir, nodesName, `${cached.head}..${head}`), nodesName);
    gitTs = kernelTs.mergeTimestampMaps(cached.ts, range);
    gittime.writeCache(cacheDir, head, gitTs);
  } else {
    gitTs = kernelTs.foldGitTimestamps(gittime.logTimestamps(repoDir, nodesName), nodesName);
    gittime.writeCache(cacheDir, head, gitTs);
  }
  return kernelTs.mergeTimestampOverrides(gitTs, graph.nodes);
}

// Incremental single-node cache update (SERVER.md §4.1, task-cc-spor-tier-2-scale):
// mutate a resident graph in place for one created/updated node instead of the
// O(corpus) loadGraph rebuild. Returns { id, mode } or { id, reloadRequired }.
// The kernel owns the tf-idf/adjacency representation, so the incremental twin
// of buildGraph lives beside it; the server reaches it through this seam.
function applyNode(graph, text, file) {
  return kernel.applyNode(graph, text, file);
}

function compile(graph, opts = {}) {
  return kernel.compile(graph, { ...opts, seedSchemas: opts.seedSchemas ?? loadSeedSchemas() });
}

// Side-effecting like the original: archives the prior briefing version to
// history/ and bumps the version (lib/shell/files.js archiveBrief), stamps
// the clock, and hands the kernel pure data. Returns the skeleton text and
// metadata; the CLI writes the skeleton file and prints the stderr note.
function renderSkeleton(graph, rootId) {
  if (!graph.nodes[rootId]) return { unknownRoot: true };
  const briefId = `brief-${rootId}`;
  const version = shell.archiveBrief(graph.nodesDir, briefId, kernel.parseFrontmatter);
  return kernel.renderSkeleton(graph, rootId, {
    version,
    date: new Date().toISOString().slice(0, 10),
    compiledAt: new Date().toISOString(),
    seedSchemas: loadSeedSchemas(),
  });
}

// validateGraph keeps the original contract: takes either a loaded graph
// object or a { nodesDir } / plain dir string — it re-reads the directory
// itself (so it tolerates malformed files that loadGraph would throw on,
// exactly like the original inline validator).
//
// rootId names the virtual graph-wide operator anchor (server/auth.js
// rootId(), API.md §4) so `stewards -> <rootId>` isn't flagged as a dangling
// edge; SPOR_ROOT_ID is a pure ops env var (CLAUDE.md "Client config
// cascade"), not part of the config cascade, matching the server's own
// resolution.
function validateGraph(graphOrDir) {
  const dir = typeof graphOrDir === "string" ? path.resolve(graphOrDir) : graphOrDir.nodesDir;
  const rootId = process.env.SPOR_ROOT_ID || "org-root";
  return kernel.validateGraphFiles(shell.readGraphFiles(dir), loadSeedSchemas(), { rootId });
}

// Back-compat views of the SEED ontology (what the hardcoded tables used to
// hold). Live code paths use graph.registry, which also reflects
// graph-resident schema nodes; these only describe the defaults.
const EDGE_WEIGHTS = seedRegistry().edgeWeights();
const KNOWN_TYPES = seedRegistry().knownNodeTypes();
const KNOWN_EDGES = seedRegistry().knownEdgeTypes();

module.exports = {
  loadGraph,
  applyNode,
  compile,
  validateNode: kernel.validateNode,
  validateGraph,
  renderSkeleton,
  parseFrontmatter: kernel.parseFrontmatter,
  rankAgainst: kernel.rankAgainst,
  // agent-on-behalf-of authorship read-out (dec-spor-agent-identity-nodes)
  authorshipLine: kernel.authorshipLine,
  // machine-authorship "via capture" marker (task-cc-digest-render-authorship-marker)
  machineAuthorshipTag: kernel.machineAuthorshipTag,
  MACHINE_AUTHORED_VIA: kernel.MACHINE_AUTHORED_VIA,
  // project identity (task-cc-project-identity-nodes): slug-alias resolution
  resolveProject: kernel.resolveProject,
  // grouping membership (task-cc-grouping-brief-digest-reads): repo<->grouping
  groupingOf: kernel.groupingOf,
  // shared read scope resolver (dec-spor-queue-slug-resolves-to-grouping):
  // bare slug -> home grouping union; repo node id -> single repo
  scopeFor: kernel.scopeFor,
  // zero-match --project detection (issue-spor-next-project-token-not-roundtrippable):
  // is a project token a known repo/grouping/alias, or scopeFor's fall-to-self?
  projectKnown: kernel.projectKnown,
  // project end-of-life (issue-cc-project-lifecycle-queue-pollution)
  isArchivedProject: kernel.isArchivedProject,
  // registry (QUEUE.md §2): seed pack + graph-resident schema nodes
  seedRegistry,
  buildRegistry,
  loadSeedSchemas,
  registry: kernel.registry,
  // graph-less type-aware terminal/inert check (issue-spor-type-blind-
  // terminal-status-fallbacks): the seed-registry-backed fallback for callers
  // with no loaded graph.
  isTerminalStatusOffline,
  // the full tiered decision: a server-computed `inert` boolean when present
  // (either value, trusted outright), else the offline fallback above.
  isNodeInertOffline,
  // decision queue (QUEUE.md §4/§5): re-exported so the server keeps one door.
  // (Safe non-cycle: queue.js only requires graph.js inside its CLI block.)
  rankQueue: require("./queue.js").rankQueue,
  // warm the queue's memoized HEAD-pure indexes on a resident graph
  // (task-cc-rankqueue-memoization); the server calls it from store.reload().
  warmQueueIndex: require("./queue.js").warmQueueIndex,
  EDGE_WEIGHTS,
  KNOWN_TYPES,
  KNOWN_EDGES,
  DIGEST_CAP: kernel.DIGEST_CAP,
  DEFAULT_MIN_SIM: kernel.DEFAULT_MIN_SIM,
};
