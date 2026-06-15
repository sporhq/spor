// queue.js — façade + CLI over the pure queue kernel (REFACTOR.md §1
// kernel/shell split; QUEUE.md §4/§5). This path is the stable import; the
// ranking lives in lib/kernel/queue.js. The façade's only job is host
// defaults: the zero-dep node:vm sandbox engine for attached code when the
// caller injects none (the server passes its hardened wasm engine instead).
//
// Also a CLI (local mode / debugging):
//   node lib/queue.js [--nodes <dir>] [--project <slug>] [--assignee <person-id>] [--limit <n>] [--json]

const kernel = require("./kernel/queue.js");

function rankQueue(graph, opts = {}) {
  return kernel.rankQueue(graph, {
    ...opts,
    // lazy: sandbox.js (node:vm) loads only if attached code actually runs
    sandboxFor: opts.sandboxFor ?? ((schema) => require("./sandbox.js").sandboxFor(schema)),
  });
}

module.exports = { rankQueue, PRIORITY_BUMP: kernel.PRIORITY_BUMP, DEFAULT_LIMIT: kernel.DEFAULT_LIMIT };

// ---------- CLI (local mode / debugging; new entry point, existing CLIs untouched) ----------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const graphLib = require(path.join(__dirname, "graph.js"));

  const argv = process.argv.slice(2);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d;
  };
  const home = require(path.join(__dirname, "shell", "home.js"));
  // Client config cascade (dec-spor-client-config-cascade); nodesDir() honors
  // config.nodes / SPOR_NODES then the graph-home default — byte-identical when
  // no config is set.
  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
  if (!fs.existsSync(NODES_DIR)) {
    console.error(`no Spor graph at ${NODES_DIR}`);
    process.exit(0);
  }
  const g = graphLib.loadGraph(NODES_DIR);
  const r = rankQueue(g, {
    project: opt("project", null),
    assignee: opt("assignee", null),
    limit: parseInt(opt("limit", String(kernel.DEFAULT_LIMIT)), 10),
  });
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    if (!r.items.length) console.log("queue empty — nothing queueable and live");
    for (const [i, it] of r.items.entries()) {
      console.log(`${i + 1}. [${it.score}] ${it.id} — ${it.title} (${it.type}${it.status ? `, ${it.status}` : ""}${it.suggest === "close" ? ", suggest: close" : ""})`);
      console.log(`   ${it.why}`);
    }
    if (r.count > r.items.length) console.log(`(${r.count - r.items.length} more — raise --limit)`);
  }
}
