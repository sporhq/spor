// get.test.js — `spor get <id> --json` (issue-spor-cli-get-missing-json-flag).
// The plain verb prints raw markdown; --json emits one structured object
// ({id, frontmatter, body, edges:{outbound,inbound}, revision}) so scripts stop
// scraping frontmatter. Dual-mode like `blame`/`history` (norm-spor-cli-mode-
// parity): local reads the node file + scans the graph home for inbound edges and
// recomputes the git-blob-sha revision zero-dep; remote reads /v1/nodes/<id> for
// the body+revision and GET /v1/export for inbound (no inbound endpoint).
//
// Oracle = the rendered JSON shape + the requests the CLI makes + the fail-soft
// exits, and PARITY: remote --json equals local --json over the same graph (we
// script the server's responses, never assert its framing). Never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { spawnSync, spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const tar = require("../lib/tar.js");
const { gitBlobSha, getNodeJson } = require("../bin/spor.js");
const graphLib = require("../lib/graph.js");

// Bare env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip
// a local-mode test to remote or leak a token); config homes isolated. Mirrors
// blame.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-get-iso-"));
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
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env) });
}
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// A scratch graph: a decision with two outbound edges, an issue that points AT it
// (so the decision has an inbound edge), and an unrelated node. repo: stamp drives
// the synthesized project field.
function fixtureGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-get-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), body);
  write("dec-x", `---
id: dec-x
type: decision
repo: demo
title: A decision with edges
summary: A decision referencing two other nodes.
date: 2026-06-01
edges:
  - {type: relates-to, to: task-y}
  - {type: supersedes, to: dec-old}
---
The body of dec-x.

A second paragraph.
`);
  write("issue-z", `---
id: issue-z
type: issue
repo: demo
title: An issue that blocks the decision
summary: Points at dec-x with a blocks edge.
status: open
date: 2026-06-02
edges:
  - {type: blocks, to: dec-x}
---
Issue body.
`);
  write("task-y", `---
id: task-y
type: task
repo: demo
title: An unrelated open task
summary: task summary
status: open
date: 2026-06-03
---
Task body.
`);
  // A truly isolated node: no outbound edges and nothing points at it.
  write("art-iso", `---
id: art-iso
type: artifact
repo: demo
title: An isolated artifact
summary: nothing references it and it references nothing.
date: 2026-06-04
---
Isolated body.
`);
  return { dir, nodes };
}

// --- local mode -------------------------------------------------------------

test("get (local) --json emits the structured object: frontmatter, body, edges, revision", () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(["get", "dec-x", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.id, "dec-x");
  // frontmatter carries the parsed fields + the synthesized project (from repo:),
  // and excludes the broken-out edges/body and the parser's `file` artifact.
  assert.strictEqual(j.frontmatter.type, "decision");
  assert.strictEqual(j.frontmatter.title, "A decision with edges");
  assert.strictEqual(j.frontmatter.project, "demo");
  assert.ok(!("edges" in j.frontmatter), "edges broken out, not under frontmatter");
  assert.ok(!("body" in j.frontmatter), "body broken out, not under frontmatter");
  assert.ok(!("file" in j.frontmatter), "no load-time file artifact");
  assert.ok(!("pin" in j.frontmatter) && !("exclude" in j.frontmatter), "empty pin/exclude dropped");
  // body is the markdown after the frontmatter (trimmed by the parser).
  assert.match(j.body, /^The body of dec-x\./);
  assert.match(j.body, /A second paragraph\.$/);
  // outbound = the node's own edges; inbound = issue-z's blocks edge.
  assert.deepStrictEqual(j.edges.outbound, [
    { type: "relates-to", to: "task-y" },
    { type: "supersedes", to: "dec-old" },
  ]);
  assert.deepStrictEqual(j.edges.inbound, [{ from: "issue-z", type: "blocks" }]);
  // revision = the git blob SHA of the node file (== `git hash-object`).
  assert.strictEqual(j.revision, gitBlobSha(fs.readFileSync(path.join(nodes, "dec-x.md"))));
});

test("get (local) --json revision equals git hash-object", () => {
  const { dir, nodes } = fixtureGraph();
  const j = JSON.parse(run(["get", "dec-x", "--json"], { SPOR_HOME: dir }).stdout);
  let viaGit;
  try {
    viaGit = execFileSync("git", ["hash-object", path.join(nodes, "dec-x.md")], { encoding: "utf8" }).trim();
  } catch {
    return; // no git binary — the pure-Node path is still asserted above
  }
  assert.strictEqual(j.revision, viaGit);
});

test("get (local) plain (no --json) prints the raw file verbatim, unchanged", () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(["get", "dec-x"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  // out() appends a newline (pre-existing behavior) — the file is emitted as-is.
  assert.strictEqual(r.stdout, fs.readFileSync(path.join(nodes, "dec-x.md"), "utf8") + "\n");
});

test("get (local) a node with no edges emits empty outbound/inbound arrays", () => {
  const { dir } = fixtureGraph();
  const j = JSON.parse(run(["get", "art-iso", "--json"], { SPOR_HOME: dir }).stdout);
  assert.deepStrictEqual(j.edges, { outbound: [], inbound: [] });
});

test("get (local) --json on a missing node exits 1 (no such node), no stack", () => {
  const { dir } = fixtureGraph();
  const r = run(["get", "nope", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such node: nope/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("get with no id exits 1 with usage", () => {
  const { dir } = fixtureGraph();
  const r = run(["get"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor get/);
});

// --- pure helpers -----------------------------------------------------------

test("gitBlobSha matches the documented git blob hash", () => {
  // `printf 'hello\n' | git hash-object --stdin` == ce013625...
  assert.strictEqual(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("getNodeJson splits edges and drops parser artifacts", () => {
  const node = graphLib.parseFrontmatter(
    "---\nid: dec-x\ntype: decision\nrepo: demo\ntitle: T\nsummary: S\nedges:\n  - {type: relates-to, to: task-y}\n---\nBody.\n",
    "dec-x.md"
  );
  const j = getNodeJson(node, [{ from: "issue-z", type: "blocks" }], "abc123");
  assert.strictEqual(j.id, "dec-x");
  assert.strictEqual(j.body, "Body.");
  assert.strictEqual(j.revision, "abc123");
  assert.deepStrictEqual(j.edges.outbound, [{ type: "relates-to", to: "task-y" }]);
  assert.deepStrictEqual(j.edges.inbound, [{ from: "issue-z", type: "blocks" }]);
  assert.ok(!("file" in j.frontmatter) && !("edges" in j.frontmatter) && !("body" in j.frontmatter));
  assert.strictEqual(j.frontmatter.project, "demo"); // synthesized from repo:
});

// --- remote mode ------------------------------------------------------------

// Serves the two routes the remote --json path uses: GET /v1/nodes/<id> →
// {id, raw, frontmatter, revision} (revision = the git blob sha of the file, so a
// stubbed server matches what local recomputes), and GET /v1/export → the ustar
// tarball (lib/tar.js, byte-for-byte the server's). Records hits.
function nodeStub(nodesDir) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/v1\/nodes\/([^/]+)$/);
    if (m && req.method === "GET") {
      const id = decodeURIComponent(m[1]);
      const f = path.join(nodesDir, `${id}.md`);
      if (!fs.existsSync(f)) return j(404, { error: { code: "not_found" } });
      const buf = fs.readFileSync(f);
      const node = graphLib.parseFrontmatter(buf.toString("utf8"), `${id}.md`);
      return j(200, { id, raw: buf.toString("utf8"), frontmatter: node, revision: gitBlobSha(buf) });
    }
    if (u.pathname === "/v1/export" && req.method === "GET") {
      const exported = tar.exportNodesDir(nodesDir);
      const body = u.searchParams.get("gzip") === "1" ? zlib.gzipSync(exported.buffer) : exported.buffer;
      res.writeHead(200, { "content-type": "application/x-tar", "x-substrate-node-count": String(exported.count) });
      return res.end(body);
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) =>
  bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("get (remote) --json reads /v1/nodes/<id> + /v1/export and matches local over the same graph", async () => {
  const { dir, nodes } = fixtureGraph();
  const { srv, hits, base } = await nodeStub(nodes);
  try {
    const remote = await runAsync(["get", "dec-x", "--json"], remoteEnv(base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    const j = JSON.parse(remote.stdout);
    assert.strictEqual(j.id, "dec-x");
    assert.deepStrictEqual(j.edges.inbound, [{ from: "issue-z", type: "blocks" }]);
    assert.strictEqual(j.revision, gitBlobSha(fs.readFileSync(path.join(nodes, "dec-x.md"))));
    // it hit BOTH endpoints (node for body+revision, export for inbound).
    assert.ok(hits.some((h) => h.method === "GET" && h.url === "/v1/nodes/dec-x"), "GET /v1/nodes/dec-x");
    assert.ok(hits.some((h) => h.method === "GET" && h.url.startsWith("/v1/export")), "GET /v1/export");
    // PARITY: byte-identical to the local --json over the same graph.
    const local = run(["get", "dec-x", "--json"], { SPOR_HOME: dir });
    assert.strictEqual(remote.stdout, local.stdout);
  } finally {
    srv.close();
  }
});

test("get (remote) plain (no --json) prints raw markdown and never fetches the export", async () => {
  const { nodes } = fixtureGraph();
  const { srv, hits, base } = await nodeStub(nodes);
  try {
    const r = await runAsync(["get", "dec-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, fs.readFileSync(path.join(nodes, "dec-x.md"), "utf8") + "\n");
    assert.ok(!hits.some((h) => h.url.startsWith("/v1/export")), "plain get stays a single cheap call");
  } finally {
    srv.close();
  }
});

test("get (remote) --json on a 404 exits 1 and never fetches the export", async () => {
  const { nodes } = fixtureGraph();
  const { srv, hits, base } = await nodeStub(nodes);
  try {
    const r = await runAsync(["get", "no-such", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: no-such/);
    assert.ok(!hits.some((h) => h.url.startsWith("/v1/export")), "404 short-circuits before the export");
  } finally {
    srv.close();
  }
});

test("get (remote) --json on a dead server fails soft with a transport line, no stack", async () => {
  const r = await runAsync(["get", "dec-x", "--json"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});
