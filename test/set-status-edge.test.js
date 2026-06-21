// set-status-edge.test.js — `spor set-status <id> <status>` and `spor edge <id>
// <type> <to>` (task-spor-set-status-edge-cli-verbs): the CLI wrappers for the
// set_status (POST /v1/nodes/{id}/status) and add_edge (POST /v1/nodes/{id}/edges)
// micro-mutations — the precise-write counterparts to the prose-only `spor add`.
// Remote mode POSTs the route REST + MCP already expose (and surfaces the claim
// the server takes on an active status); local mode does the read-modify-write
// itself against the node file, mirroring the server's forceStatus / insertEdgeLine.
//
// Oracle = the REQUEST BODY the CLI POSTs in remote mode (never the server's
// framing — we script the response) + the on-disk frontmatter in local mode.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage, isolated config homes so the dev box's
// real ~/.spor/config.json can't flip a local-mode test to remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-sse-iso-"));
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
// Async runner for remote mode — a blocking spawnSync would deadlock against the
// in-process fake server (the event loop can't accept the connection).
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// A scratch local graph home with a task and a decision (the decision is a
// resolves-edge target). Returns { home, nodes }.
function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-sse-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---
id: task-x
type: task
project: demo
title: A demo task
summary: A demo task used to exercise the set-status and edge verbs end to end.
date: 2026-06-01
---
Body about the demo task.
`);
  fs.writeFileSync(path.join(nodes, "dec-y.md"), `---
id: dec-y
type: decision
project: demo
title: A demo decision
summary: A decision node used as a resolves-edge target in the local edge test.
date: 2026-06-01
---
Body about the decision.
`);
  return { home, nodes };
}
function readNode(nodes, id) {
  return fs.readFileSync(path.join(nodes, `${id}.md`), "utf8");
}
function validateGraph(nodes) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
}

const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// ---------------- set-status: local mode ----------------

test("set-status (local) rewrites the status field and validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["set-status", "task-x", "active"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /status set: task-x -> active/);
  const md = readNode(nodes, "task-x");
  assert.match(md, /^status: active$/m);
  assert.match(md, /Body about the demo task\./); // body survived
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("set-status (local) replaces an existing status rather than duplicating it", () => {
  const { home, nodes } = fixtureGraph();
  run(["set-status", "task-x", "active"], { SPOR_HOME: home });
  const r = run(["set-status", "task-x", "done"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = readNode(nodes, "task-x");
  assert.strictEqual((md.match(/^status: /gm) || []).length, 1, "exactly one status line");
  assert.match(md, /^status: done$/m);
});

test("set-status (local) on a missing node exits 1, writes nothing", () => {
  const { home } = fixtureGraph();
  const r = run(["set-status", "task-nope", "active"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such node: task-nope/);
});

test("set-status (local) with no status exits 1 with usage", () => {
  const { home } = fixtureGraph();
  const r = run(["set-status", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor set-status/);
});

// ---------------- set-status: remote mode ----------------

// POST /v1/nodes/{id}/status echoes a set_status result; on an active status it
// rides along a lease (the claim), mirroring the server.
function statusStub({ status = 200, errCode = "invalid_node", message = "x", details = [], lease } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/nodes\/([^/]+)\/status$/);
      if (m && req.method === "POST") {
        if (status !== 200) return j(status, { error: { code: errCode, message, details } });
        const id = decodeURIComponent(m[1]);
        const out = { status: "updated", id, revision: "abc123", warnings: [] };
        if (lease !== undefined) out.lease = lease;
        return j(200, out);
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("set-status (remote) POSTs {status} and reports the claim on an active status", async () => {
  const lease = { node_id: "task-x", by: "person-anthony", expires_at: "2026-06-21T12:00:00.000Z" };
  const { srv, hits, base } = await statusStub({ lease });
  try {
    const r = await runAsync(["set-status", "task-x", "active"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /status set: task-x -> active/);
    assert.match(r.stdout, /claimed \(lease expires 2026-06-21T12:00:00\.000Z\)/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/task-x/status");
    assert.ok(post, "POSTed to the node's status endpoint");
    assert.deepStrictEqual(JSON.parse(post.body), { status: "active" });
  } finally {
    srv.close();
  }
});

test("set-status (remote) surfaces an already-claimed lease conflict as a note", async () => {
  const lease = { error: "already_claimed", holder: "person-bob" };
  const { srv, base } = await statusStub({ lease });
  try {
    const r = await runAsync(["set-status", "task-x", "active"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr); // the status flip still landed
    assert.match(r.stdout, /status set: task-x -> active/);
    assert.match(r.stderr, /not claimed \(already_claimed, held by person-bob\)/);
  } finally {
    srv.close();
  }
});

test("set-status (remote) on a terminal status reports no claim line", async () => {
  const { srv, base } = await statusStub({}); // no lease field
  try {
    const r = await runAsync(["set-status", "task-x", "done"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /status set: task-x -> done/);
    assert.doesNotMatch(r.stdout, /claimed/);
  } finally {
    srv.close();
  }
});

test("set-status (remote) surfaces a transitions_denied rejection with its details", async () => {
  const { srv, base } = await statusStub({ status: 422, errCode: "transition_denied", message: "done requires a resolving decision or artifact", details: ["set abandoned if it won't be done"] });
  try {
    const r = await runAsync(["set-status", "task-x", "done"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /set-status error 422: done requires a resolving decision or artifact/);
    assert.match(r.stderr, /set abandoned if it won't be done/);
  } finally {
    srv.close();
  }
});

test("set-status (remote) maps a 404 to a clean 'no such node'", async () => {
  const { srv, base } = await statusStub({ status: 404, errCode: "not_found", message: "node does not exist" });
  try {
    const r = await runAsync(["set-status", "task-gone", "active"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: task-gone/);
  } finally {
    srv.close();
  }
});

test("set-status (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["set-status", "task-x", "active"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// ---------------- edge: local mode ----------------

test("edge (local) appends a canonical edge and validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["edge", "dec-y", "resolves", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /edge added: dec-y -\[resolves\]-> task-x/);
  assert.match(readNode(nodes, "dec-y"), /- \{type: resolves, to: task-x\}/);
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("edge (local) inverse form stores the canonical edge on the OTHER node", () => {
  const { home, nodes } = fixtureGraph();
  // task-x blocked-by dec-y => canonical 'blocks' lives on dec-y -> task-x
  const r = run(["edge", "task-x", "blocked-by", "dec-y"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /edge added: task-x -\[blocked-by\]-> dec-y \(stored on dec-y\)/);
  assert.match(readNode(nodes, "dec-y"), /- \{type: blocks, to: task-x\}/);
  assert.doesNotMatch(readNode(nodes, "task-x"), /edges:/);
});

test("edge (local) re-adding an existing edge is an idempotent no-op", () => {
  const { home, nodes } = fixtureGraph();
  run(["edge", "dec-y", "resolves", "task-x"], { SPOR_HOME: home });
  const before = readNode(nodes, "dec-y");
  const r = run(["edge", "dec-y", "resolves", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /edge already present: dec-y -\[resolves\]-> task-x/);
  assert.strictEqual(readNode(nodes, "dec-y"), before, "node untouched on a dup");
});

test("edge (local) rejects an unknown edge type, listing the known ones", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-y");
  const r = run(["edge", "dec-y", "frobnicates", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown edge type 'frobnicates'/);
  assert.match(r.stderr, /known edge types: .*resolves/);
  assert.strictEqual(readNode(nodes, "dec-y"), before, "node untouched");
});

test("edge (local) refuses a dangling target", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-y");
  const r = run(["edge", "dec-y", "resolves", "task-ghost"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /edge target 'task-ghost' does not exist/);
  assert.strictEqual(readNode(nodes, "dec-y"), before, "node untouched");
});

test("edge (local) carries a flat --attr override on the edge line", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["edge", "dec-y", "relates-to", "task-x", "--attr", "weight=3"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(readNode(nodes, "dec-y"), /- \{type: relates-to, to: task-x, weight: 3\}/);
});

test("edge (local) rejects a malformed --attr", () => {
  const { home } = fixtureGraph();
  const r = run(["edge", "dec-y", "relates-to", "task-x", "--attr", "noequals"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--attr must be key=value/);
});

test("edge (local) on a missing source node exits 1", () => {
  const { home } = fixtureGraph();
  const r = run(["edge", "dec-gone", "resolves", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such node: dec-gone/);
});

test("edge with too few args exits 1 with usage", () => {
  const { home } = fixtureGraph();
  const r = run(["edge", "dec-y", "resolves"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor edge/);
});

// ---------------- edge: remote mode ----------------

function edgeStub({ status = 200, errCode = "invalid_node", message = "x", details = [], echoId, resultStatus = "updated" } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/nodes\/([^/]+)\/edges$/);
      if (m && req.method === "POST") {
        if (status !== 200) return j(status, { error: { code: errCode, message, details } });
        return j(200, { status: resultStatus, id: echoId || decodeURIComponent(m[1]), revision: "abc123", warnings: [] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("edge (remote) POSTs {type, to} to the node's edges endpoint", async () => {
  const { srv, hits, base } = await edgeStub();
  try {
    const r = await runAsync(["edge", "dec-y", "resolves", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /edge added: dec-y -\[resolves\]-> task-x/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/dec-y/edges");
    assert.ok(post, "POSTed to the node's edges endpoint");
    assert.deepStrictEqual(JSON.parse(post.body), { type: "resolves", to: "task-x" });
  } finally {
    srv.close();
  }
});

test("edge (remote) sends --attr as body.attrs", async () => {
  const { srv, hits, base } = await edgeStub();
  try {
    const r = await runAsync(["edge", "task-x", "assigned", "agent-z", "--attr", "profile=profile-fast"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/task-x/edges");
    assert.deepStrictEqual(JSON.parse(post.body), { type: "assigned", to: "agent-z", attrs: { profile: "profile-fast" } });
  } finally {
    srv.close();
  }
});

test("edge (remote) notes when the canonical edge lands on a different node (inverse form)", async () => {
  const { srv, base } = await edgeStub({ echoId: "dec-y" }); // server flipped task-x blocked-by dec-y onto dec-y
  try {
    const r = await runAsync(["edge", "task-x", "blocked-by", "dec-y"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /edge added: task-x -\[blocked-by\]-> dec-y \(stored on dec-y\)/);
  } finally {
    srv.close();
  }
});

test("edge (remote) reports an idempotent skip", async () => {
  const { srv, base } = await edgeStub({ resultStatus: "skipped" });
  try {
    const r = await runAsync(["edge", "dec-y", "resolves", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /edge already present: dec-y -\[resolves\]-> task-x/);
  } finally {
    srv.close();
  }
});

test("edge (remote) surfaces an unknown-edge-type rejection with its details", async () => {
  const { srv, base } = await edgeStub({ status: 422, message: "unknown edge type 'frobnicates'", details: ["known edge types: blocks, relates-to, resolves"] });
  try {
    const r = await runAsync(["edge", "dec-y", "frobnicates", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /edge error 422: unknown edge type 'frobnicates'/);
    assert.match(r.stderr, /known edge types: blocks, relates-to, resolves/);
  } finally {
    srv.close();
  }
});

test("edge (remote) rejects a malformed --attr client-side, never reaching the server", async () => {
  const { srv, hits, base } = await edgeStub();
  try {
    const r = await runAsync(["edge", "dec-y", "relates-to", "task-x", "--attr", "bad"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--attr must be key=value/);
    assert.strictEqual(hits.length, 0, "no request made for a bad attr");
  } finally {
    srv.close();
  }
});

test("edge (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["edge", "dec-y", "resolves", "task-x"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// ---------------- help pages ----------------

test("set-status --help prints the command page with its alias", () => {
  const r = run(["set-status", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor set-status <id> <status>/m);
  assert.match(r.stdout, /status-set/); // alias listed
});

test("edge --help prints the command page with its alias", () => {
  const r = run(["edge", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor edge <id> <type> <to>/m);
  assert.match(r.stdout, /add-edge/); // alias listed
});
