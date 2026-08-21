// put-node.test.js - `spor put-node` full validated node writes.
// Remote mode is the shell twin of MCP put_node / REST POST /v1/nodes. Local
// mode writes nodes/<id>.md only after validation and revision/collision checks.
require("./helpers/tmp-cleanup");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { gitBlobSha } = require("../bin/spor.js");

const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-iso-"));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME;
  env.XDG_CONFIG_HOME = ISO_HOME;
  return Object.assign(env, extra);
}
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  fs.writeFileSync(path.join(nodes, "dec-old.md"), nodeMd("dec-old", "Old decision", "Old summary."));
  return { home, nodes };
}
function nodeMd(id, title = "Demo decision", summary = "A demo decision used by the put-node CLI tests.") {
  return `---
id: ${id}
type: decision
project: demo
title: ${title}
summary: ${summary}
date: 2026-06-01
---
Body for ${id}.
`;
}
function tmpNodeFile(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-file-"));
  const file = path.join(dir, "node.md");
  fs.writeFileSync(file, raw);
  return file;
}
function readNode(nodes, id) {
  return fs.readFileSync(path.join(nodes, `${id}.md`), "utf8");
}
function validateGraph(nodes) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
}

test("put-node (local) creates a new node from a markdown file and validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(nodeMd("dec-new"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node created: dec-new @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-new"), fs.readFileSync(file, "utf8"));
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("put-node (local) skips an existing node with --if-exists skip", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-old");
  const file = tmpNodeFile(nodeMd("dec-old", "Replacement", "Replacement summary."));
  const r = run(["put-node", file, "--if-exists", "skip"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node skipped: dec-old @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-old"), before);
});

test("put-node (local) updates only with a matching revision", () => {
  const { home, nodes } = fixtureGraph();
  const revision = gitBlobSha(fs.readFileSync(path.join(nodes, "dec-old.md")));
  const updated = nodeMd("dec-old", "Updated decision", "Updated summary.");
  const file = tmpNodeFile(updated);
  const r = run(["put-node", file, "--if-exists", "update", "--revision", revision], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node updated: dec-old @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-old"), updated);
});

test("put-node (local) rejects stale revisions without writing", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-old");
  const file = tmpNodeFile(nodeMd("dec-old", "Stale write", "Stale write summary."));
  const r = run(["put-node", file, "--if-exists", "update", "--revision", "0".repeat(40)], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /put-node conflict: stale revision for dec-old/);
  assert.strictEqual(readNode(nodes, "dec-old"), before);
});

test("put-node (local) rejects malformed nodes before writing", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(`---
id: dec-bad
type: decision
title: Missing summary
date: 2026-06-01
---
No summary.
`);
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /missing summary/);
  assert.ok(!fs.existsSync(path.join(nodes, "dec-bad.md")));
});

function putNodeStub({ status = 200, result } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/nodes" && req.method === "POST") {
        return j(status, result || { results: [{ ok: true, status: "updated", id: "dec-remote", revision: "rev-2", warnings: [] }] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("put-node (remote) POSTs a one-entry put_node batch with policy and revision", async () => {
  const raw = nodeMd("dec-remote");
  const file = tmpNodeFile(raw);
  const { srv, hits, base } = await putNodeStub();
  try {
    const r = await runAsync(["put-node", file, "--if-exists", "update", "--revision", "rev-1"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /put-node updated: dec-remote @ rev-2/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes");
    assert.ok(post, "POST /v1/nodes");
    assert.deepStrictEqual(JSON.parse(post.body), { nodes: [{ node: raw, if_exists: "update", revision: "rev-1" }] });
  } finally {
    srv.close();
  }
});

test("put-node (remote) surfaces a batch validation failure with details", async () => {
  const file = tmpNodeFile(nodeMd("dec-remote"));
  const result = { results: [{ ok: false, status: "error", id: "dec-remote", message: "invalid_node", details: ["dec-remote: bad edge"] }] };
  const { srv, base } = await putNodeStub({ status: 207, result });
  try {
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /put-node error 207: invalid_node; dec-remote: bad edge/);
  } finally {
    srv.close();
  }
});

// dec-spor-buildgraph-per-node-fault-isolation: the local put-node gate lints
// the WHOLE graph, so once the loader started SKIPPING a malformed node file
// instead of refusing to boot on it, an unrelated corrupt sibling would have
// locked the entire local graph read-only — with a banner naming a node the
// write never touched. Pre-existing skips are carried as warnings instead.
test("put-node (local): an unrelated unparseable node file does not block the write", () => {
  const { home, nodes } = fixtureGraph();
  fs.writeFileSync(
    path.join(nodes, "dec-corrupt.md"),
    `---
id: dec-corrupt
type: decision
project: demo
title: Corrupt
summary: A pre-existing node whose block-form edge entry never resolves a target.
date: 2026-06-01
edges:
  - type: relates-to
---
Body.
`
  );
  const file = tmpNodeFile(nodeMd("dec-fresh"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node created: dec-fresh/);
  assert.strictEqual(readNode(nodes, "dec-fresh"), fs.readFileSync(file, "utf8"));
  // the corruption is carried, not swallowed: named on stderr, both by the
  // loader's own skip warning and as a pre-existing lint error.
  assert.match(r.stderr, /SKIPPED unparseable node file .*dec-corrupt\.md/);
  assert.match(r.stderr, /warning: pre-existing: dec-corrupt\.md: unparseable edge entry/);
  // and `spor validate` still fails on it — the lint is the gate, not the writer.
  assert.strictEqual(validateGraph(nodes).status, 1);
});

// The complement: a fault in the node BEING WRITTEN still refuses the write.
test("put-node (local): an unparseable incoming node is still rejected", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(`---
id: dec-bad
type: decision
project: demo
title: Bad
summary: An incoming node whose block-form edge entry never resolves a target.
date: 2026-06-01
edges:
  - type: relates-to
---
Body.
`);
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /unparseable edge entry/);
  assert.ok(!fs.existsSync(path.join(nodes, "dec-bad.md")), "nothing written");
});
