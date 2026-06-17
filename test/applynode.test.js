// applynode.test.js — the incremental cache update (SERVER.md §4.1,
// task-cc-spor-tier-2-scale). applyNode() patches a resident graph in place for
// one created/updated node so the server's write path never pays the O(corpus)
// loadGraph rebuild (~3-5s at 50k). These tests pin the guarantee that makes it
// safe: the patched graph is STRUCTURALLY IDENTICAL to a from-scratch rebuild
// (nodes, adjacency, supersession, dangling-edge activation, df, N), and the
// just-written doc's tf-idf weights match a rebuild EXACTLY. The only sanctioned
// divergence is the idf of already-resident docs, which stays at its last-build
// df/N until a full reload resyncs — verified bounded by checking df/N stay
// exact, so any reload makes the whole index consistent again.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const kernel = require(path.join(__dirname, "..", "lib", "kernel", "graph.js"));

// Build a node's raw text. edges: [{type,to}].
function NODE({ id, type, project = "demo", title = "title", summary = "summary", body = "body words here", date = "2026-06-12", status, edges = [], extra = "" }) {
  let fm = `id: ${id}\ntype: ${type}\nproject: ${project}\ntitle: ${title}\nsummary: ${summary}\ndate: ${date}\n`;
  if (status) fm += `status: ${status}\n`;
  if (extra) fm += extra;
  if (edges.length) fm += "edges:\n" + edges.map((e) => `  - {type: ${e.type}, to: ${e.to}}`).join("\n") + "\n";
  return `---\n${fm}---\n\n${body}\n`;
}

// Build a graph by applying a sequence of node texts incrementally (last write
// per id wins), and a from-scratch rebuild over the same final node set.
function buildBothWays(ops) {
  const inc = kernel.buildGraph({}, { nodesDir: "/g", seedSchemas: [] });
  for (const t of ops) {
    const r = kernel.applyNode(inc, t, "incoming.md");
    assert.ok(!r.reloadRequired, `applyNode unexpectedly required reload for ${r.id}`);
  }
  const finalById = {};
  for (const t of ops) { const n = kernel.parseFrontmatter(t, "x.md"); finalById[`${n.id}.md`] = t; }
  const full = kernel.buildGraph(finalById, { nodesDir: "/g", seedSchemas: [] });
  return { inc, full };
}

// Assert the two graphs are structurally identical (everything except the
// idf-sensitive posting WEIGHTS / norms, which drift on resident docs by design).
function assertStructurallyEqual(inc, full) {
  // node ids + the fields adjacency/relevance derive from
  assert.deepEqual(Object.keys(inc.nodes).sort(), Object.keys(full.nodes).sort(), "node id sets");
  for (const id of Object.keys(full.nodes)) {
    assert.deepEqual(inc.nodes[id].edges, full.nodes[id].edges, `edges of ${id}`);
    assert.equal(inc.nodes[id].body, full.nodes[id].body, `body of ${id}`);
    assert.equal(inc.nodes[id].status ?? null, full.nodes[id].status ?? null, `status of ${id}`);
  }
  // adjacency: compare as a SET per node (incremental append order differs)
  const adjSet = (g, id) => new Set((g.adj[id] || []).map((e) => `${e.to}|${e.type}|${e.weight}`));
  const adjIds = new Set([...Object.keys(inc.adj), ...Object.keys(full.adj)]);
  for (const id of adjIds) assert.deepEqual(adjSet(inc, id), adjSet(full, id), `adj[${id}]`);
  // supersededBy + dangling residue (filter empty arrays the splice path may leave)
  assert.deepEqual(inc.supersededBy, full.supersededBy, "supersededBy");
  const liveDangling = (g) => Object.fromEntries(Object.entries(g.danglingTo).filter(([, v]) => v && v.length).map(([k, v]) => [k, v.length]));
  assert.deepEqual(liveDangling(inc), liveDangling(full), "danglingTo (live)");
  // tf-idf backbone: df and N must be EXACT (idf is consistent after any resync)
  assert.equal(inc.N, full.N, "N");
  assert.deepEqual(inc.df, full.df, "df");
  // every doc present with a norm; same doc id set
  const docIds = (g) => new Set(g.docs.map((d) => d.id));
  assert.deepEqual(docIds(inc), docIds(full), "doc id sets");
}

test("applyNode: incremental build is structurally identical to a full rebuild (creates, updates, dangling-then-created, supersession, non-traversable, repo/project)", () => {
  const ops = [
    NODE({ id: "dec-a", type: "decision", body: "pricing catalogue reliability", edges: [{ type: "relates-to", to: "dec-b" }] }), // dangling -> dec-b
    NODE({ id: "task-x", type: "task", body: "latency budget scale", edges: [{ type: "blocks", to: "dec-a" }, { type: "derived-from", to: "art-spec" }] }), // dangling -> art-spec
    NODE({ id: "dec-b", type: "decision", body: "provider neutral composed" }), // creates dec-b: activates dec-a's edge
    NODE({ id: "art-spec", type: "artifact", body: "reliability cost spec" }), // creates art-spec: activates task-x's edge
    NODE({ id: "dec-c", type: "decision", body: "supersedes beta", edges: [{ type: "supersedes", to: "dec-b" }] }),
    NODE({ id: "dec-a", type: "decision", title: "alpha v2", body: "pricing latency scale", edges: [{ type: "mentions", to: "art-spec" }] }), // UPDATE dec-a: drop edge to dec-b, add to art-spec
    NODE({ id: "person-p", type: "person", body: "non traversable", extra: "email: p@x.io\n" }),
    NODE({ id: "repo-demo", type: "repo", body: "the repo", extra: "slugs: [demo, demo-app]\n" }),
    NODE({ id: "proj-demo", type: "project", body: "grouping" }),
    NODE({ id: "task-x", type: "task", status: "in-progress", body: "latency budget scale", edges: [{ type: "blocks", to: "dec-a" }, { type: "derived-from", to: "art-spec" }] }), // UPDATE status
  ];
  const { inc, full } = buildBothWays(ops);
  assertStructurallyEqual(inc, full);
  // dec-a dropped its relates-to dec-b on update; the inbound mirror must be gone
  assert.ok(!(inc.adj["dec-b"] || []).some((e) => e.to === "dec-a"), "stale inbound mirror removed on update");
  // project alias map reflects the repo node's slugs
  assert.equal(graph.resolveProject(inc, "demo-app"), "repo-demo");
});

test("applyNode: a created node's OWN tf-idf weights and norm match a full rebuild exactly (it is scored against the final df/N including itself)", () => {
  const base = {};
  for (let i = 0; i < 60; i++) base[`dec-b${i}.md`] = NODE({ id: `dec-b${i}`, type: "decision", body: `reliability cost provider neutral term${i % 11} budget scale` });
  const inc = kernel.buildGraph(base, { nodesDir: "/g", seedSchemas: [] });
  const newText = NODE({ id: "task-new", type: "task", title: "incremental cache", body: "latency budget scale reliability term3 provider" });
  kernel.applyNode(inc, newText, "task-new.md");
  const full = kernel.buildGraph({ ...base, "task-new.md": newText }, { nodesDir: "/g", seedSchemas: [] });

  const idI = inc.docIndex["task-new"], idF = full.docIndex["task-new"];
  assert.equal(inc.docs[idI].norm.toExponential(14), full.docs[idF].norm.toExponential(14), "new-doc norm exact");
  const weightOf = (g, term, id) => {
    const p = g.postings[term]; if (!p) return null;
    for (let k = 0; k < p.docs.length; k++) if (g.docs[p.docs[k]].id === id) return p.w[k];
    return null;
  };
  const newNode = kernel.parseFrontmatter(newText, "x");
  const terms = new Set(`${newNode.title} ${newNode.summary} ${newNode.body}`.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2));
  for (const t of terms) {
    const a = weightOf(inc, t, "task-new"), b = weightOf(full, t, "task-new");
    assert.equal(a === null ? null : a.toExponential(12), b === null ? null : b.toExponential(12), `weight[${t}] exact for the new doc`);
  }
});

test("applyNode: df and N stay EXACT across a long create/update sequence (idf backbone is rebuild-consistent, so any resync is sound)", () => {
  const inc = kernel.buildGraph({}, { nodesDir: "/g", seedSchemas: [] });
  const final = {};
  const types = [["dec", "decision"], ["task", "task"], ["issue", "issue"], ["art", "artifact"]];
  for (let i = 0; i < 300; i++) {
    const [pre, type] = types[i % 4];
    const id = `${pre}-s${i % 180}`; // collisions -> updates
    const t = NODE({ id, type, body: `reliability budget scale term${i % 23} term${i % 7} provider neutral` });
    kernel.applyNode(inc, t, `${id}.md`);
    final[`${id}.md`] = t;
  }
  const full = kernel.buildGraph(final, { nodesDir: "/g", seedSchemas: [] });
  assert.equal(inc.N, full.N, "N exact after 300 ops");
  assert.deepEqual(inc.df, full.df, "df exact after 300 ops");
});

test("applyNode: rankAgainst over the incrementally-built graph returns the planted needle top-1", () => {
  const inc = kernel.buildGraph({}, { nodesDir: "/g", seedSchemas: [] });
  for (let i = 0; i < 80; i++) kernel.applyNode(inc, NODE({ id: `dec-n${i}`, type: "decision", body: "ordinary corpus filler reliability cost catalogue pricing" }), `dec-n${i}.md`);
  kernel.applyNode(inc, NODE({ id: "dec-needle", type: "decision", title: "zorblax frobnicate", body: "zorblax frobnicate quuxology zorblax frobnicate" }), "dec-needle.md");
  const ranked = kernel.rankAgainst(inc, "zorblax frobnicate quuxology", new Set());
  assert.equal(ranked[0].id, "dec-needle", "the unique-vocabulary needle is top-ranked from the incremental graph");
});

test("applyNode: a schema node signals reloadRequired (registry-altering, not locally patchable)", () => {
  const inc = kernel.buildGraph({}, { nodesDir: "/g", seedSchemas: [] });
  const schemaText = `---\nid: schema-widget\ntype: schema\nkind: node-schema\nschema_version: 2026.06.17.1\nproject: demo\ntitle: Widget type\nsummary: A new node type.\nstatus: active\ndate: 2026-06-17\n---\n\n\`\`\`json\n{ "node_type": "widget", "prefix": ["widget-"], "traversable": true }\n\`\`\`\n`;
  const r = kernel.applyNode(inc, schemaText, "schema-widget.md");
  assert.equal(r.reloadRequired, true, "schema write asks the caller to full-reload");
});

test("applyNode: updating a node's body re-scores only that doc and keeps it findable under its new terms", () => {
  const inc = kernel.buildGraph({}, { nodesDir: "/g", seedSchemas: [] });
  for (let i = 0; i < 40; i++) kernel.applyNode(inc, NODE({ id: `dec-f${i}`, type: "decision", body: "filler reliability cost" }), `dec-f${i}.md`);
  kernel.applyNode(inc, NODE({ id: "dec-m", type: "decision", body: "original alpha beta gamma" }), "dec-m.md");
  // before update: not findable under the new vocabulary
  assert.notEqual(kernel.rankAgainst(inc, "wibble wobble", new Set())[0]?.id, "dec-m");
  kernel.applyNode(inc, NODE({ id: "dec-m", type: "decision", body: "wibble wobble wibble wobble" }), "dec-m.md");
  assert.equal(kernel.rankAgainst(inc, "wibble wobble", new Set())[0].id, "dec-m", "re-scored under new terms");
  // and no longer dominant under the old vocabulary
  assert.notEqual(kernel.rankAgainst(inc, "alpha beta gamma", new Set())[0]?.id, "dec-m", "old terms removed from the index");
});
