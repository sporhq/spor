// seed.js — the seed schema pack, read off disk once per process (the IO half
// of the registry; the parse and the Registry itself are lib/kernel/graph.js +
// lib/kernel/registry.js). Plain Node, zero deps.
//
// Two consumers: lib/graph.js (every loadGraph/compile/validate folds the seed
// under the graph's resident schemas) and the kernel's resolution module,
// which needs a registry for the one case a caller hands it none — a
// graph-less status check (a REST-fetched node, coupling.js's hook-loop scan)
// or a hand-built graph with no `registry` (task-spor-registry-sole-terminal-
// status-source). The terminal/non-resolving partitions such a caller reads
// are then the SEED's own declarations — the `terminal-status` register and
// each node-schema's `status.*` — never a hand-mirrored table beside them.
//
// Installing on require (useFallbackRegistry below) keeps the kernel pure: it
// asks for a registry through an injected source and never reads a file
// itself. The installed source builds its OWN Registry instance, separate
// from the fresh one lib/graph.js's seedRegistry() hands callers, so a caller
// that mutates its copy (test fixtures simulating a resident override do)
// cannot change what every graph-less reader sees.

const path = require("path");
const kernel = require("../kernel/graph.js");
const resolution = require("../kernel/resolution.js");
const { readGraphFiles } = require("./files.js");

const SEED_DIR = path.join(__dirname, "..", "seed");

// The seed ships with the repo, so a seed file that fails to parse is a bug —
// the kernel throws loudly.
let seedSchemas = null;
function loadSeedSchemas() {
  return (seedSchemas ??= kernel.parseSeedSchemas(readGraphFiles(SEED_DIR)));
}

function installSeedFallback() {
  resolution.useFallbackRegistry(() => kernel.seedRegistry(loadSeedSchemas()));
}
installSeedFallback();

module.exports = { SEED_DIR, loadSeedSchemas, installSeedFallback };
