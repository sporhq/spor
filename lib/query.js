// query.js — a pure, deterministic, filterable enumeration over a loaded
// graph's nodes AND edges (task-spor-local-graph-query-verb). The local-mode
// primitive under what remote mode offers as saved `render_lens` views: `get`
// is one node, `next` is the ranked queue, `compile --query` is semantic
// search — `query` is the structured, predicate-filtered list. No LLM, no
// ranking, no graph walk: it reads `graph.nodes` (and each node's `edges`)
// directly and returns plain data. Zero deps.
//
// Also a CLI (local mode / debugging):
//   node lib/query.js [--nodes <dir>]
//     # node selection (AND across distinct flags):
//     [--type <T> ...]            nodes of that type: (repeatable -> OR within type)
//     [--where key=value ...]     match a frontmatter field (repeatable -> AND);
//                                 a list field matches on membership
//     [--id-prefix <p>]           ids starting with <p>
//     # edge emission (switches output to edges):
//     [--edges]                   emit {from,type,to} edges, not nodes
//     [--edge-type <T>]           filter edges by type
//     [--from <id>]               out-edges whose SOURCE is <id>
//     [--to <id>]                 in-edges whose TARGET is <id>
//     # projection:
//     [--ids | --summary | --full | --json]

// Resolve a frontmatter field as a comparable. Lists (edges/pin/exclude and the
// parser's inline-list registers) match on membership; everything else compares
// as a string. Absent -> undefined (never matches).
function fieldMatches(node, key, value) {
  const v = node[key];
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.map(String).includes(value);
  return String(v) === value;
}

// queryGraph(graph, opts) -> { nodes } | { edges }
//   opts.types       : string[]  — OR set over node `type:` (empty = any)
//   opts.where       : [key, value][] — all must match (AND); list = membership
//   opts.idPrefix    : string    — id startsWith
//   opts.edges       : boolean   — emit edges instead of nodes
//   opts.edgeType    : string    — filter emitted edges by type
//   opts.from        : string    — out-edges from this source id
//   opts.to          : string    — in-edges to this target id
// Node predicates (types/where/idPrefix) restrict the candidate NODE set; in
// edge mode they restrict the SOURCE node of each emitted edge.
function queryGraph(graph, opts = {}) {
  const types = opts.types && opts.types.length ? opts.types : null;
  const where = opts.where || [];
  const idPrefix = opts.idPrefix || null;

  const nodeMatches = (n) => {
    if (types && !types.includes(n.type)) return false;
    if (idPrefix && !String(n.id).startsWith(idPrefix)) return false;
    for (const [k, val] of where) if (!fieldMatches(n, k, val)) return false;
    return true;
  };

  // Deterministic order: sort node ids once, reuse for nodes and edge sources.
  const ids = Object.keys(graph.nodes).sort();

  if (opts.edges) {
    const edges = [];
    for (const id of ids) {
      const n = graph.nodes[id];
      if (!nodeMatches(n)) continue; // node predicates restrict the edge SOURCE
      if (opts.to != null) continue; // --to walks INTO a target below, not out
      for (const e of n.edges || []) {
        if (opts.edgeType && e.type !== opts.edgeType) continue;
        if (opts.from != null && id !== opts.from) continue;
        edges.push({ from: id, type: e.type, to: e.to });
      }
    }
    // --to: in-edges whose target is <id>. Walk every source's out-edges (a
    // node only stores its own out-edges) and keep those pointing at --to.
    if (opts.to != null) {
      for (const id of ids) {
        const n = graph.nodes[id];
        if (!nodeMatches(n)) continue; // predicates still scope the SOURCE
        for (const e of n.edges || []) {
          if (e.to !== opts.to) continue;
          if (opts.edgeType && e.type !== opts.edgeType) continue;
          if (opts.from != null && id !== opts.from) continue;
          edges.push({ from: id, type: e.type, to: e.to });
        }
      }
    }
    return { edges };
  }

  const nodes = [];
  for (const id of ids) {
    const n = graph.nodes[id];
    if (nodeMatches(n)) nodes.push(n);
  }
  return { nodes };
}

// lookupCommit(graph, sha, repo) -> [{repo, sha, id, type, title, summary, status, project}]
// The commit→node REVERSE lookup over the `commits:` fields (each a repo@sha
// list per node) — the pure local-mode twin of the server's GET /v1/commits/{sha}
// (store.lookupCommit), wrapped by the `spor blame` CLI verb
// (task-spor-blame-commit-lookup-cli-verb). Mirrors the server algorithm exactly:
// prefix-aware so an abbreviated query matches a full stored sha and vice versa
// (the same `startsWith` dedup link_commit uses), with an optional `repo` slug
// scoping to one repo. Deterministic order (node id, then stored sha) so the CLI
// output is stable — the only divergence from the server's insertion-order scan.
function lookupCommit(graph, sha, repo = null) {
  const q = String(sha || "").toLowerCase();
  if (!q) return [];
  const out = [];
  for (const n of Object.values(graph.nodes)) {
    for (const c of n.commits || []) {
      const at = c.indexOf("@");
      if (at < 0) continue; // a commit entry is repo@sha; skip a malformed bare value
      const cr = c.slice(0, at), cs = c.slice(at + 1);
      if (repo && cr !== repo) continue;
      if (!(cs.startsWith(q) || q.startsWith(cs))) continue;
      out.push({
        repo: cr, sha: cs, id: n.id, type: n.type ?? null, title: n.title ?? null,
        summary: n.summary ?? null, status: n.status ?? null, project: n.project ?? null,
      });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return out;
}

module.exports = { queryGraph, fieldMatches, lookupCommit };

// ---------- CLI (local mode / debugging) ----------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const graphLib = require(path.join(__dirname, "graph.js"));

  const argv = process.argv.slice(2);
  // single-value flag reader (last wins), mirroring lib/queue.js's opt().
  const opt = (n, d) => {
    let v = d;
    for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${n}`) v = argv[i + 1];
    return v;
  };
  // repeatable-value flag reader (collect every --flag VALUE pair).
  const optAll = (n) => {
    const out = [];
    for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${n}`) out.push(argv[i + 1]);
    return out;
  };
  const has = (n) => argv.includes(`--${n}`);

  // Client config cascade (dec-spor-client-config-cascade); nodesDir() honors
  // config.nodes / SPOR_NODES then the graph-home default — byte-identical when
  // no config is set. --nodes is the highest-precedence override (like queue.js).
  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
  if (!fs.existsSync(NODES_DIR)) {
    console.error(`no Spor graph at ${NODES_DIR}`);
    process.exit(0);
  }
  const g = graphLib.loadGraph(NODES_DIR);

  // --where key=value (repeatable). Split on the FIRST '=' so a value may
  // itself contain '='.
  const where = optAll("where").map((s) => {
    const i = s.indexOf("=");
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
  });

  const r = queryGraph(g, {
    types: optAll("type"),
    where,
    idPrefix: opt("id-prefix", null),
    edges: has("edges"),
    edgeType: opt("edge-type", null),
    from: has("from") ? opt("from", null) : null,
    to: has("to") ? opt("to", null) : null,
  });

  // Project a loaded node for JSON output: drop the parser's load-time `file`
  // artifact, and drop pin/exclude when empty — the regex parser initializes
  // both to [] on every node, so they are noise unless a briefing/correction
  // actually populated them (a non-empty list is kept). Deletes from a shallow
  // copy so the original key order is preserved.
  const cleanNode = (n) => {
    const out = { ...n };
    delete out.file;
    if (Array.isArray(out.pin) && !out.pin.length) delete out.pin;
    if (Array.isArray(out.exclude) && !out.exclude.length) delete out.exclude;
    return out;
  };

  if (has("json")) {
    if (r.edges) process.stdout.write(JSON.stringify(r.edges, null, 2) + "\n");
    else process.stdout.write(JSON.stringify(r.nodes.map(cleanNode), null, 2) + "\n");
    process.exit(0);
  }

  if (r.edges) {
    if (!r.edges.length) console.log("no matching edges");
    for (const e of r.edges) console.log(`${e.from} --${e.type}--> ${e.to}`);
    process.exit(0);
  }

  const nodes = r.nodes;
  if (has("ids")) {
    for (const n of nodes) console.log(n.id);
    process.exit(0);
  }
  if (has("summary")) {
    if (!nodes.length) console.log("no matching nodes");
    for (const n of nodes) console.log(`${n.id}  ${n.summary || n.title || ""}`.trimEnd());
    process.exit(0);
  }
  if (has("full")) {
    if (!nodes.length) console.log("no matching nodes");
    // Compact frontmatter dump: the node's own raw file if readable, else a
    // reconstructed key/edge view. Mirrors the spirit of `spor get`.
    for (const n of nodes) {
      const file = n.file && path.join(NODES_DIR, n.file);
      let raw = null;
      try { if (file) raw = fs.readFileSync(file, "utf8"); } catch { /* fall through */ }
      if (raw != null) {
        process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
      } else {
        process.stdout.write(JSON.stringify(cleanNode(n), null, 2) + "\n"); // raw file unreadable: reconstructed view
      }
      console.log("---");
    }
    process.exit(0);
  }

  // default human table.
  if (!nodes.length) {
    console.log("no matching nodes");
    process.exit(0);
  }
  const idW = Math.max(...nodes.map((n) => n.id.length), 2);
  const tyW = Math.max(...nodes.map((n) => (n.type || "").length), 4);
  for (const n of nodes) {
    const title = n.title || n.summary || "";
    console.log(`${n.id.padEnd(idW)}  ${(n.type || "").padEnd(tyW)}  ${title}`.trimEnd());
  }
  console.log(`(${nodes.length} node${nodes.length === 1 ? "" : "s"})`);
}
