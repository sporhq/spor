// patch-verb.test.js — `spor patch <id> key=value…` (task-spor-cli-patch-verb-and-
// docs): the CLI wrapper for patch_node (PATCH /v1/nodes/{id}). Oracle = the
// request the CLI sends in remote mode and the on-disk node in local mode.
require("./helpers/tmp-cleanup");
const { hermeticEnv } = require("./helpers/env.js");
const { scrubbedEnv } = require("./helpers/git.js");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-patch-iso-"));
const bare = (extra = {}) => hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, ...extra });
const run = (args, extra) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-patch-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home], { env: scrubbedEnv() });
  fs.writeFileSync(path.join(nodes, "task-x.md"), `---
id: task-x
type: task
project: demo
title: A demo task
summary: A demo task used to exercise the patch verb end to end.
date: 2026-06-01
size: s
edges:
  - {type: relates-to, to: dec-y}
---
Body about the demo task.
`);
  return { home, nodes, file: path.join(nodes, "task-x.md") };
}

test("patch (local) sets and unsets scalars, leaving body and edges byte-intact", () => {
  const { home, file } = fixtureGraph();
  const r = run(["patch", "task-x", "size=m", "delivery_ref=PR-12", "--unset", "date_unused"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /patched: task-x/);
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /^size: m$/m);
  assert.match(md, /^delivery_ref: PR-12$/m);
  assert.match(md, /- \{type: relates-to, to: dec-y\}/);
  assert.match(md, /Body about the demo task\./);
  const r2 = run(["patch", "task-x", "--unset", "size"], { SPOR_HOME: home });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /^size:/m);
});

test("patch (local) with nothing changed is a no-op", () => {
  const { home, file } = fixtureGraph();
  const before = fs.readFileSync(file, "utf8");
  const r = run(["patch", "task-x", "size=s"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /patch skipped/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
});

test("patch (local) refuses fields with a dedicated door and writes nothing", () => {
  const { home, file } = fixtureGraph();
  const before = fs.readFileSync(file, "utf8");
  const r = run(["patch", "task-x", "status=done"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /dedicated door.*spor set-status/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
});

test("patch (local) usage errors: missing id, bad pair, missing node, stale revision", () => {
  const { home } = fixtureGraph();
  assert.match(run(["patch"], { SPOR_HOME: home }).stderr, /usage: spor patch/);
  assert.match(run(["patch", "task-x"], { SPOR_HOME: home }).stderr, /no fields to patch/);
  assert.match(run(["patch", "task-x", "oops"], { SPOR_HOME: home }).stderr, /expected key=value/);
  assert.match(run(["patch", "task-nope", "size=m"], { SPOR_HOME: home }).stderr, /no such node/);
  const r = run(["patch", "task-x", "size=m", "--revision", "deadbeef"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /conflict/);
});

function patchStub({ status = 200, body } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body: b });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body || { status: "updated", id: "task-x", revision: "abc", warnings: [] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token" });

test("patch (remote) PATCHes {patch, revision} with nulls for --unset", async () => {
  const { srv, hits, base } = await patchStub();
  try {
    const r = await runAsync(["patch", "task-x", "size=m", "--unset", "needed_by", "--revision", "abc"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /patched: task-x \(size, needed_by\)/);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].method, "PATCH");
    assert.strictEqual(hits[0].url, "/v1/nodes/task-x");
    assert.deepStrictEqual(JSON.parse(hits[0].body), { patch: { size: "m", needed_by: null }, revision: "abc" });
  } finally {
    srv.close();
  }
});

test("patch (remote) surfaces a refusal with its details", async () => {
  const { srv, base } = await patchStub({ status: 422, body: { error: { code: "invalid_node", message: "field 'status' has a dedicated door", details: ["status: use set_status"] } } });
  try {
    const r = await runAsync(["patch", "task-x", "size=m"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /patch error 422: field 'status' has a dedicated door/);
    assert.match(r.stderr, /status: use set_status/);
  } finally {
    srv.close();
  }
});

test("patch (local) refuses stamped fields and strips list brackets like the server", () => {
  const { home, file } = fixtureGraph();
  assert.match(run(["patch", "task-x", "author=me"], { SPOR_HOME: home }).stderr, /dedicated door/);
  assert.match(run(["patch", "task-x", "priority_by=me"], { SPOR_HOME: home }).stderr, /use spor priority/);
  assert.strictEqual(run(["patch", "task-x", "size=[a, b]"], { SPOR_HOME: home }).status, 0);
  assert.match(fs.readFileSync(file, "utf8"), /^size: a, b$/m);
});

test("patch (local) --revision matches the blob sha spor get reports, even for non-ASCII nodes", () => {
  const { home, file } = fixtureGraph();
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Body about", "Body — about"));
  const got = JSON.parse(run(["get", "task-x", "--json"], { SPOR_HOME: home }).stdout);
  const r = run(["patch", "task-x", "size=m", "--revision", got.revision], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
});
