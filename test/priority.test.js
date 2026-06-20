// priority.test.js — `spor priority <id> <p1|p2|p3|clear>` (task-spor-cli-priority-
// verb): the CLI wrapper for the set_priority micro-mutation, the one queue
// action that lacked a shell verb. Remote mode POSTs /v1/nodes/{id}/priority
// (the route REST + MCP already expose); local mode rewrites the node file's
// frontmatter in place, mirroring the server's rewritePriority.
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
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-prio-iso-"));
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
// Sync runner for local mode (no in-process server to talk to).
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

// A scratch local graph home (git-initialized with an identity, so the local
// priority_by stamp resolves). Returns { home, nodes }.
function fixtureGraph(email = "alice@example.com", name = "Alice") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-prio-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  spawnSync("git", ["-C", home, "config", "user.email", email]);
  spawnSync("git", ["-C", home, "config", "user.name", name]);
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---
id: task-x
type: task
project: demo
title: A demo task that wants a priority
summary: A demo task used to exercise the spor priority verb end to end.
date: 2026-06-01
---
Body about the demo task.
`);
  return { home, nodes };
}

// Records every request; POST /v1/nodes/{id}/priority echoes a set_priority result.
function prioStub({ status = 200, errCode = "invalid_node", message = "x" } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/nodes\/([^/]+)\/priority$/);
      if (m && req.method === "POST") {
        if (status !== 200) return j(status, { error: { code: errCode, message, details: ["allowed: p1, p2, p3 (or none/clear to remove)"] } });
        return j(200, { status: "updated", id: decodeURIComponent(m[1]), revision: "abc123", warnings: [] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// ---------------- local mode ----------------

test("priority (local) sets p1 and stamps priority_by/_at/_via, validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["priority", "task-x", "p1"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /priority set: task-x -> p1/);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.match(md, /^priority: p1$/m);
  assert.match(md, /^priority_by: Alice <alice@example\.com>$/m);
  assert.match(md, /^priority_at: \d{4}-\d\d-\d\dT/m);
  assert.match(md, /^priority_via: cli$/m);
  // the body survived the rewrite
  assert.match(md, /Body about the demo task\./);
  // and it still validates
  const v = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("priority (local) clear removes the priority and all its stamps", () => {
  const { home, nodes } = fixtureGraph();
  run(["priority", "task-x", "p2"], { SPOR_HOME: home });
  const r = run(["priority", "task-x", "clear"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /priority cleared: task-x/);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.doesNotMatch(md, /^priority:/m);
  assert.doesNotMatch(md, /^priority_by:/m);
  assert.doesNotMatch(md, /^priority_via:/m);
});

test("priority (local) re-setting replaces rather than duplicating the keys", () => {
  const { home, nodes } = fixtureGraph();
  run(["priority", "task-x", "p1"], { SPOR_HOME: home });
  run(["priority", "task-x", "p3"], { SPOR_HOME: home });
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.strictEqual((md.match(/^priority: /gm) || []).length, 1, "exactly one priority line");
  assert.match(md, /^priority: p3$/m);
});

test("priority (local) accepts the clearing aliases none/p0/0", () => {
  for (const form of ["none", "p0", "0"]) {
    const { home, nodes } = fixtureGraph();
    run(["priority", "task-x", "p1"], { SPOR_HOME: home });
    const r = run(["priority", "task-x", form], { SPOR_HOME: home });
    assert.strictEqual(r.status, 0, `${form}: ${r.stderr}`);
    const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
    assert.doesNotMatch(md, /^priority:/m, `${form} cleared`);
  }
});

test("priority (local) rejects an unknown value, writes nothing", () => {
  const { home, nodes } = fixtureGraph();
  const before = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  const r = run(["priority", "task-x", "p9"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /priority 'p9' not allowed/);
  assert.strictEqual(fs.readFileSync(path.join(nodes, "task-x.md"), "utf8"), before, "node untouched");
});

test("priority (local) on a missing node exits 1", () => {
  const { home } = fixtureGraph();
  const r = run(["priority", "task-nope", "p1"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such node: task-nope/);
});

test("priority (local) without a git identity omits priority_by, still sets the value", () => {
  // a graph home that is NOT a git repo, with global+system git config disabled
  // so `git config user.*` finds no identity (otherwise it walks up to the dev
  // box's ~/.gitconfig).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-prio-noid-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---\nid: task-x\ntype: task\nproject: demo\ntitle: t\nsummary: a task with no git identity around to stamp\ndate: 2026-06-01\n---\nbody\n`);
  const noGitId = path.join(home, "empty-gitconfig");
  fs.writeFileSync(noGitId, "");
  const r = run(["priority", "task-x", "p2"], { SPOR_HOME: home, GIT_CONFIG_GLOBAL: noGitId, GIT_CONFIG_NOSYSTEM: "1" });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.match(md, /^priority: p2$/m);
  assert.doesNotMatch(md, /^priority_by:/m);
  assert.match(md, /^priority_via: cli$/m);
});

test("priority with no value exits 1 with usage", () => {
  const { home } = fixtureGraph();
  const r = run(["priority", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor priority/);
});

test("priority --help prints the command page (table-driven)", () => {
  const r = run(["priority", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor priority <id> <p1\|p2\|p3\|clear>/m);
  assert.match(r.stdout, /set-priority/); // alias listed
});

// ---------------- remote mode ----------------

test("priority (remote) POSTs {priority: p1} to /v1/nodes/{id}/priority", async () => {
  const { srv, hits, base } = await prioStub();
  try {
    const r = await runAsync(["priority", "issue-86", "p1"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /priority set: issue-86 -> p1/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/issue-86/priority");
    assert.ok(post, "POSTed to the node's priority endpoint");
    assert.deepStrictEqual(JSON.parse(post.body), { priority: "p1" });
  } finally {
    srv.close();
  }
});

test("priority (remote) sends the canonical empty value for a clearing form", async () => {
  const { srv, hits, base } = await prioStub();
  try {
    const r = await runAsync(["priority", "issue-86", "none"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /priority cleared: issue-86/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/issue-86/priority");
    assert.deepStrictEqual(JSON.parse(post.body), { priority: "" }, "clear normalizes to empty before sending");
  } finally {
    srv.close();
  }
});

test("priority (remote) rejects an unknown value client-side, never reaching the server", async () => {
  const { srv, hits, base } = await prioStub();
  try {
    const r = await runAsync(["priority", "issue-86", "urgent"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /priority 'urgent' not allowed/);
    assert.strictEqual(hits.length, 0, "no request made for a bad value");
  } finally {
    srv.close();
  }
});

test("priority (remote) surfaces a server rejection's message", async () => {
  const { srv, base } = await prioStub({ status: 422, message: "priority 'p9' not allowed" });
  try {
    const r = await runAsync(["priority", "issue-86", "p2"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /priority error 422: priority 'p9' not allowed/);
  } finally {
    srv.close();
  }
});

test("priority (remote) maps a 404 to a clean 'no such node'", async () => {
  const { srv, base } = await prioStub({ status: 404, errCode: "not_found", message: "node does not exist" });
  try {
    const r = await runAsync(["priority", "issue-gone", "p1"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: issue-gone/);
  } finally {
    srv.close();
  }
});

test("priority (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["priority", "issue-86", "p1"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});
