// ready.test.js — `spor ready <id> [--needs-input]` (task-spor-readiness-stamp-
// verb): the CLI wrapper for the agent-readiness manual override, a verbatim
// sibling of `spor priority`. Remote mode POSTs /v1/nodes/{id}/readiness (the
// route the REST + MCP twin expose in spor-server); local mode rewrites the
// node file's frontmatter in place, mirroring the server's rewriteReadiness.
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
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ready-iso-"));
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
// readiness_by stamp resolves). Returns { home, nodes }.
function fixtureGraph(email = "alice@example.com", name = "Alice") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ready-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  spawnSync("git", ["-C", home, "config", "user.email", email]);
  spawnSync("git", ["-C", home, "config", "user.name", name]);
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---
id: task-x
type: task
project: demo
title: A demo task that wants a readiness stamp
summary: A demo task used to exercise the spor ready verb end to end.
date: 2026-06-01
---
Body about the demo task.
`);
  return { home, nodes };
}

// Records every request; POST /v1/nodes/{id}/readiness echoes a set_readiness result.
function readyStub({ status = 200, errCode = "invalid_node", message = "x" } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/nodes\/([^/]+)\/readiness$/);
      if (m && req.method === "POST") {
        if (status !== 200) return j(status, { error: { code: errCode, message, details: [] } });
        return j(200, { status: "updated", id: decodeURIComponent(m[1]), revision: "abc123", warnings: [] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// ---------------- local mode ----------------

test("ready (local) stamps readiness: agent with readiness_by/_at/_via, validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["ready", "task-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /readiness set: task-x -> agent/);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.match(md, /^readiness: agent$/m);
  assert.match(md, /^readiness_by: Alice <alice@example\.com>$/m);
  assert.match(md, /^readiness_at: \d{4}-\d\d-\d\dT/m);
  assert.match(md, /^readiness_via: cli$/m);
  // the body survived the rewrite
  assert.match(md, /Body about the demo task\./);
  // and it still validates
  const v = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("ready (local) --needs-input clears the readiness stamp and all its provenance", () => {
  const { home, nodes } = fixtureGraph();
  run(["ready", "task-x"], { SPOR_HOME: home });
  const r = run(["ready", "task-x", "--needs-input"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /readiness cleared: task-x/);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.doesNotMatch(md, /^readiness:/m);
  assert.doesNotMatch(md, /^readiness_by:/m);
  assert.doesNotMatch(md, /^readiness_at:/m);
  assert.doesNotMatch(md, /^readiness_via:/m);
});

test("ready (local) re-stamping replaces rather than duplicating the keys", () => {
  const { home, nodes } = fixtureGraph();
  run(["ready", "task-x"], { SPOR_HOME: home });
  run(["ready", "task-x"], { SPOR_HOME: home });
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.strictEqual((md.match(/^readiness: /gm) || []).length, 1, "exactly one readiness line");
  assert.strictEqual((md.match(/^readiness_by: /gm) || []).length, 1, "exactly one readiness_by line");
});

test("ready (local) on a missing node exits 1", () => {
  const { home } = fixtureGraph();
  const r = run(["ready", "task-nope"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such node: task-nope/);
});

test("ready (local) without a git identity omits readiness_by, still sets the value", () => {
  // a graph home that is NOT a git repo, with global+system git config disabled
  // so `git config user.*` finds no identity (otherwise it walks up to the dev
  // box's ~/.gitconfig).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ready-noid-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---\nid: task-x\ntype: task\nproject: demo\ntitle: t\nsummary: a task with no git identity around to stamp\ndate: 2026-06-01\n---\nbody\n`);
  const noGitId = path.join(home, "empty-gitconfig");
  fs.writeFileSync(noGitId, "");
  const r = run(["ready", "task-x"], { SPOR_HOME: home, GIT_CONFIG_GLOBAL: noGitId, GIT_CONFIG_NOSYSTEM: "1" });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(nodes, "task-x.md"), "utf8");
  assert.match(md, /^readiness: agent$/m);
  assert.doesNotMatch(md, /^readiness_by:/m);
  assert.match(md, /^readiness_via: cli$/m);
});

test("ready with no id exits 1 with usage", () => {
  const { home } = fixtureGraph();
  const r = run(["ready"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor ready/);
});

test("ready --help prints the command page (table-driven)", () => {
  const r = run(["ready", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor ready <id> \[--needs-input\]/m);
  assert.match(r.stdout, /--needs-input/);
});

// ---------------- remote mode ----------------

test("ready (remote) POSTs {readiness: agent} to /v1/nodes/{id}/readiness", async () => {
  const { srv, hits, base } = await readyStub();
  try {
    const r = await runAsync(["ready", "issue-86"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /readiness set: issue-86 -> agent/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/issue-86/readiness");
    assert.ok(post, "POSTed to the node's readiness endpoint");
    assert.deepStrictEqual(JSON.parse(post.body), { readiness: "agent" });
  } finally {
    srv.close();
  }
});

test("ready (remote) --needs-input sends the canonical empty value", async () => {
  const { srv, hits, base } = await readyStub();
  try {
    const r = await runAsync(["ready", "issue-86", "--needs-input"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /readiness cleared: issue-86/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes/issue-86/readiness");
    assert.deepStrictEqual(JSON.parse(post.body), { readiness: "" });
  } finally {
    srv.close();
  }
});

test("ready (remote) surfaces a server rejection's message", async () => {
  const { srv, base } = await readyStub({ status: 422, message: "readiness 'bogus' not allowed" });
  try {
    const r = await runAsync(["ready", "issue-86"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /readiness error 422: readiness 'bogus' not allowed/);
  } finally {
    srv.close();
  }
});

test("ready (remote) maps a 404 to a clean 'no such node'", async () => {
  const { srv, base } = await readyStub({ status: 404, errCode: "not_found", message: "node does not exist" });
  try {
    const r = await runAsync(["ready", "issue-gone"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: issue-gone/);
  } finally {
    srv.close();
  }
});

test("ready (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["ready", "issue-86"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});
