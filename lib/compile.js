#!/usr/bin/env node
// Spor compile — two-arm context compiler, plugin edition.
// Thin CLI wrapper over lib/graph.js. All logic lives in
// graph.js; this file owns only the CLI contract:
//   - nodes dir is a parameter (--nodes, $SPOR_NODES, or $SPOR_HOME/nodes;
//     legacy $SUBSTRATE_HOME still read — see lib/shell/home.js)
//   - root can be a node id (--root) OR free text (--query). Query mode builds
//     a virtual root: the content arm ranks the whole corpus against the query
//     text, and the top hits seed the structural walk.
//   - --digest emits a compact summary-resolution digest (for prompt-time
//     injection, capped); default emits the full neighborhood document.
//   - --skeleton (root mode) writes a versioned briefing-node skeleton.
//
// Exit 0 with empty stdout means "nothing relevant" — callers treat that as
// "inject nothing".

const fs = require("fs");
const path = require("path");
const graph = require(path.join(__dirname, "graph.js"));

// ---------- args ----------

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d;
};

const home = require(path.join(__dirname, "shell", "home.js"));
// Client config cascade (dec-spor-client-config-cascade): supplies the nodes
// dir, the relevance gate, and neighborhood-search project controls when set.
// With no config files present every resolved value equals the prior default,
// so output stays byte-identical (norm-cc-byte-identical-refactor).
const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
const ROOT_ID = opt("root", null);
const QUERY = opt("query", null);
const PROJECT = opt("project", null); // session slug; scopes project: corrections
const DIGEST = flag("digest");
const SKELETON = flag("skeleton");
const OUT = opt("out", null);
const QUIET = flag("quiet");
const MIN_TOP_SIM = parseFloat(opt("min-sim", String(cfg.getNum("search.minSim", 0.08)))); // query-mode relevance gate
const SEARCH_PROJECTS = {
  include: cfg.getList("search.projects.include"),
  exclude: cfg.getList("search.projects.exclude"),
  boost: cfg.get("search.projects.boost", {}),
};

if (!ROOT_ID && !QUERY) {
  console.error("usage: compile.js [--nodes <dir>] (--root <id> | --query \"text\") [--project <slug>] [--digest] [--skeleton] [--out <file>]");
  process.exit(1);
}
if (!fs.existsSync(NODES_DIR)) {
  if (!QUIET) console.error(`no Spor graph at ${NODES_DIR}`);
  process.exit(0);
}

const g = graph.loadGraph(NODES_DIR);

const result = graph.compile(g, {
  rootId: ROOT_ID,
  query: QUERY,
  project: PROJECT,
  digest: DIGEST,
  minSim: MIN_TOP_SIM,
  searchProjects: SEARCH_PROJECTS,
});

if (result.unknownRoot) {
  console.error(`unknown root ${ROOT_ID}`);
  process.exit(1);
}
if (!result.relevant) process.exit(0); // nothing relevant

const out = result.text;

// ---------- briefing skeleton + versioning (root mode only) ----------

if (SKELETON && ROOT_ID) {
  const skel = graph.renderSkeleton(g, ROOT_ID);
  const skelPath = path.join(NODES_DIR, "..", `skeleton-${skel.briefId}.md`);
  fs.writeFileSync(skelPath, skel.text);
  if (!QUIET) console.error(`skeleton: ${skelPath} (v${skel.version}, ${skel.sources.length} source edges)`);
}

// ---------- output ----------

if (OUT) fs.writeFileSync(OUT, out);
else process.stdout.write(out);

if (!QUIET) {
  const m = result.meta;
  console.error(`nodes: ${m.nodes} | structural: ${m.structural} | content: ${m.content} | pinned: ${m.pinned} | corrections: ${m.corrections} | ~${m.tokens} tokens`);
}
