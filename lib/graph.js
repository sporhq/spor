// graph.js — IO façade over the pure graph kernel (REFACTOR.md §1 kernel/
// shell split). This path is the stable import for hooks, the server, and
// wf/lenses; the exact pre-split API is preserved. All computation lives in
// lib/kernel/graph.js (data in, data out); all filesystem access in
// lib/shell/files.js. Plain Node, zero deps.
//
// Exports (unchanged):
//   loadGraph(nodesDir)             -> { nodes, adj, supersededBy, docs, df, N, nodesDir, registry }
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

const SEED_DIR = path.join(__dirname, "seed");

// Parse the seed pack once per process. The seed ships with the repo, so a
// seed file that fails to parse is a bug — the kernel throws loudly.
let _seedSchemas = null;
function loadSeedSchemas() {
  return (_seedSchemas ??= kernel.parseSeedSchemas(shell.readGraphFiles(SEED_DIR)));
}

// Registry from the seed pack alone (what a graph with no schema nodes gets).
function seedRegistry() {
  return kernel.seedRegistry(loadSeedSchemas());
}

// Seed pack + graph-resident schema nodes layered on top.
function buildRegistry(schemaNodes = []) {
  return kernel.buildRegistry(loadSeedSchemas(), schemaNodes);
}

function loadGraph(nodesDir) {
  const dir = path.resolve(nodesDir);
  return kernel.buildGraph(shell.readGraphFiles(dir), { nodesDir: dir, seedSchemas: loadSeedSchemas() });
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
function validateGraph(graphOrDir) {
  const dir = typeof graphOrDir === "string" ? path.resolve(graphOrDir) : graphOrDir.nodesDir;
  return kernel.validateGraphFiles(shell.readGraphFiles(dir), loadSeedSchemas());
}

// Back-compat views of the SEED ontology (what the hardcoded tables used to
// hold). Live code paths use graph.registry, which also reflects
// graph-resident schema nodes; these only describe the defaults.
const EDGE_WEIGHTS = seedRegistry().edgeWeights();
const KNOWN_TYPES = seedRegistry().knownNodeTypes();
const KNOWN_EDGES = seedRegistry().knownEdgeTypes();

module.exports = {
  loadGraph,
  compile,
  validateNode: kernel.validateNode,
  validateGraph,
  renderSkeleton,
  parseFrontmatter: kernel.parseFrontmatter,
  rankAgainst: kernel.rankAgainst,
  // registry (QUEUE.md §2): seed pack + graph-resident schema nodes
  seedRegistry,
  buildRegistry,
  loadSeedSchemas,
  registry: kernel.registry,
  // decision queue (QUEUE.md §4/§5): re-exported so the server keeps one door.
  // (Safe non-cycle: queue.js only requires graph.js inside its CLI block.)
  rankQueue: require("./queue.js").rankQueue,
  EDGE_WEIGHTS,
  KNOWN_TYPES,
  KNOWN_EDGES,
  DIGEST_CAP: kernel.DIGEST_CAP,
  DEFAULT_MIN_SIM: kernel.DEFAULT_MIN_SIM,
};
