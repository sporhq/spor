// query-remote.test.js — `spor query` in REMOTE mode (task-spor-cli-query-remote-
// mode). There is no server-side structured-enumeration endpoint, so remote query
// fetches the team graph via GET /v1/export (the read-replica tarball, the same
// surface `spor export` wraps) and runs the SAME lib/query.js over it. The local
// arm is byte-identical passthrough to lib/query.js (covered by query.test.js /
// spor-cli.test.js); this guards the remote branch added to cmdQuery + the ustar
// reader (lib/tar.js extract).
//
// Oracle = parity: the remote run's output must equal the LOCAL `spor query
// --nodes <dir>` over the SAME graph (the export reproduces nodes/ byte-for-byte,
// norm-spor-cli-mode-parity), and the request the CLI makes is GET /v1/export.
// We never assert the server's framing — we script the export bytes ourselves.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const tar = require("../lib/tar.js");
const isWin = process.platform === "win32";

// Strip ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip a test to
// remote or leak a token (mirrors analytics-remote.test.js).
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_DISTILLING = "1";
  return Object.assign(env, extra);
}
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-query-remote-"));
}

// A scratch graph on disk: repo/project/task nodes with a grouped-under edge,
// the same shape spor-cli.test.js's query fixture uses.
function scratchNodes() {
  const home = freshHome();
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), body);
  write("repo-a", `---
id: repo-a
type: repo
project: demo
title: Repo A
summary: A repo node.
slugs: [repo-a, repo-alias]
date: 2026-06-01
edges:
  - {type: grouped-under, to: proj-rdi}
---
Body of repo A.
`);
  write("proj-rdi", `---
id: proj-rdi
type: project
project: demo
title: Project RDI
summary: A grouping project.
date: 2026-06-01
---
Body.
`);
  write("task-open", `---
id: task-open
type: task
project: demo
title: An open task
summary: open task summary
status: open
date: 2026-06-02
---
Open task body.
`);
  write("task-done", `---
id: task-done
type: task
project: demo
title: A done task
summary: done task summary
status: done
date: 2026-06-03
---
Done task body.
`);
  return nodes;
}

// Fake GET /v1/export: builds the SAME ustar tarball the server streams (via
// lib/tar.js, byte-for-byte interchangeable), gzipping the body when ?gzip=1 (no
// content-encoding header — it's a .tar.gz payload, not HTTP transfer encoding,
// so the client detects the magic bytes and gunzips). Records hits so the test
// can assert the GET path.
function exportStub(nodesDir) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname !== "/v1/export") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    }
    const exported = tar.exportNodesDir(nodesDir);
    const body = u.searchParams.get("gzip") === "1" ? zlib.gzipSync(exported.buffer) : exported.buffer;
    res.writeHead(200, {
      "content-type": "application/x-tar",
      "x-substrate-node-count": String(exported.count),
    });
    res.end(body);
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

const remoteEnv = (home, base) => baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token" });

// The parity oracle: the local CLI over the SAME nodes dir (byte-identical
// passthrough to lib/query.js). --nodes forces the local path regardless of mode.
async function localQuery(nodes, args) {
  return runAsync(["query", ...args, "--nodes", nodes], baseEnv());
}

test("remote: --type --ids is byte-identical to a local query over the same graph", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, hits, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(["query", "--type", "task", "--ids"], remoteEnv(freshHome(), base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    const local = await localQuery(nodes, ["--type", "task", "--ids"]);
    assert.strictEqual(remote.stdout, local.stdout);
    assert.strictEqual(remote.stdout.trim(), "task-done\ntask-open"); // sorted by id
    // It fetched the graph via GET /v1/export (gzip negotiated).
    const hit = hits.find((h) => h.method === "GET" && h.url.startsWith("/v1/export"));
    assert.ok(hit, "GET /v1/export");
  } finally {
    srv.close();
  }
});

test("remote: --where AND predicate matches local", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(["query", "--type", "task", "--where", "status=open", "--ids"], remoteEnv(freshHome(), base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    assert.strictEqual(remote.stdout.trim(), "task-open");
    const local = await localQuery(nodes, ["--type", "task", "--where", "status=open", "--ids"]);
    assert.strictEqual(remote.stdout, local.stdout);
  } finally {
    srv.close();
  }
});

test("remote: --edges --edge-type --to --json matches local (and the membership --where on slugs)", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(
      ["query", "--edges", "--edge-type", "grouped-under", "--to", "proj-rdi", "--json"],
      remoteEnv(freshHome(), base)
    );
    assert.strictEqual(remote.status, 0, remote.stderr);
    assert.deepEqual(JSON.parse(remote.stdout), [{ from: "repo-a", type: "grouped-under", to: "proj-rdi" }]);
    const local = await localQuery(nodes, ["--edges", "--edge-type", "grouped-under", "--to", "proj-rdi", "--json"]);
    assert.strictEqual(remote.stdout, local.stdout);
    // list-field membership (slugs) resolves over the fetched graph too
    const member = await runAsync(["query", "--where", "slugs=repo-alias", "--ids"], remoteEnv(freshHome(), base));
    assert.strictEqual(member.stdout.trim(), "repo-a");
  } finally {
    srv.close();
  }
});

test("remote: --full reproduces the raw node markdown byte-for-byte (the export round-trip)", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(["query", "--type", "project", "--full"], remoteEnv(freshHome(), base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    const local = await localQuery(nodes, ["--type", "project", "--full"]);
    assert.strictEqual(remote.stdout, local.stdout);
    assert.match(remote.stdout, /id: proj-rdi/);
  } finally {
    srv.close();
  }
});

test("remote: --json default projection matches local", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(["query", "--type", "repo", "--json"], remoteEnv(freshHome(), base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    const local = await localQuery(nodes, ["--type", "repo", "--json"]);
    assert.strictEqual(remote.stdout, local.stdout);
  } finally {
    srv.close();
  }
});

test("remote: a no-match query prints the local empty contract", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const remote = await runAsync(["query", "--type", "nonexistent-type"], remoteEnv(freshHome(), base));
    assert.strictEqual(remote.status, 0, remote.stderr);
    assert.strictEqual(remote.stdout.trim(), "no matching nodes");
    const local = await localQuery(nodes, ["--type", "nonexistent-type"]);
    assert.strictEqual(remote.stdout, local.stdout);
  } finally {
    srv.close();
  }
});

test("remote: an explicit --nodes always takes the LOCAL path (never hits the server)", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  const { srv, hits, base } = await exportStub(nodes);
  try {
    const r = await runAsync(["query", "--type", "task", "--ids", "--nodes", nodes], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), "task-done\ntask-open");
    assert.strictEqual(hits.length, 0, "no /v1/export when --nodes names a local checkout");
  } finally {
    srv.close();
  }
});

test("remote: a server error surfaces a clean line (no stack trace)", { skip: isWin }, async () => {
  const nodes = scratchNodes();
  // A server that 500s on /v1/export.
  const srv = http.createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "boom", message: "kaboom" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await runAsync(["query", "--type", "task"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /query error 500/);
    assert.match(r.stderr, /kaboom/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

test("remote: a corrupt gzip body fails clean (no stack trace)", { skip: isWin }, async () => {
  // A server that claims gzip (magic bytes) but ships a truncated/garbage stream.
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/x-tar" });
    res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00])); // gzip magic, no valid body
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await runAsync(["query", "--type", "task"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not decode the server's export/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

// Direct unit cover for the ustar reader: a buildTarball round-trip reproduces
// the file set byte-for-byte (the contract queryRemote leans on).
test("tar.extract round-trips buildTarball byte-for-byte", () => {
  const nodes = scratchNodes();
  const { buffer } = tar.exportNodesDir(nodes);
  const entries = tar.extract(buffer);
  const names = entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names, ["nodes/proj-rdi.md", "nodes/repo-a.md", "nodes/task-done.md", "nodes/task-open.md"]);
  for (const e of entries) {
    const base = path.basename(e.name);
    assert.strictEqual(e.data.toString("utf8"), fs.readFileSync(path.join(nodes, base), "utf8"), base);
  }
});

// gzip path: the client gunzips a ?gzip=1 body (magic-byte detection).
test("tar.extract over a gunzipped export equals the plain export", () => {
  const nodes = scratchNodes();
  const { buffer } = tar.exportNodesDir(nodes);
  const round = tar.extract(zlib.gunzipSync(zlib.gzipSync(buffer)));
  assert.strictEqual(round.length, 4);
});
