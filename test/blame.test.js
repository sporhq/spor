// blame.test.js — `spor blame <sha>` (alias `spor commits <sha>`) is the shell
// verb for the commit->node REVERSE lookup (task-spor-blame-commit-lookup-cli-
// verb). It surfaces the commits: index that was reachable only over REST/MCP:
// which decisions/tasks/issues reference a git commit. Dual-mode like `get`
// (norm-spor-cli-mode-parity): local scans the graph home (the pure lib/query.js
// lookupCommit twin), remote dispatches to GET /v1/commits/{sha}.
//
// Oracle = the request the CLI makes (the GET path) + its rendered output + the
// fail-soft exits, never the server's framing (we script the responses). Local
// arm is asserted directly against a scratch graph; never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync, spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const isWin = process.platform === "win32";

// Env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip a
// local-mode test to remote or leak a token), config homes isolated to a temp
// dir. Mirrors spor-cli.test.js / capabilities-show.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-blame-iso-"));
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

// A scratch graph: two nodes referencing a shared spor commit (one stores the
// full sha, one abbreviated), and a second repo's commit on the decision.
function fixtureGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-blame-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "dec-x.md"), `---
id: dec-x
type: decision
project: demo
title: A decision linked to commits
summary: A decision referencing a spor commit and an api commit.
commits: [spor@b384469abc1234def, api@deadbeef1234567]
date: 2026-06-01
---
Body.
`);
  fs.writeFileSync(path.join(nodes, "task-y.md"), `---
id: task-y
type: task
project: demo
title: A task on the same spor commit
summary: A task referencing the spor commit abbreviated.
status: open
commits: [spor@b384469]
date: 2026-06-01
---
Body.
`);
  return { dir, nodes };
}

// --- local mode -------------------------------------------------------------

test("blame (local) lists nodes referencing a commit; prefix-matches both ways", () => {
  const { dir } = fixtureGraph();
  const r = run(["blame", "b384469"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /referenced by 2 nodes/);
  assert.match(r.stdout, /dec-x\s+\[decision\]/);
  assert.match(r.stdout, /task-y\s+\[task, open\]/);
  assert.match(r.stdout, /spor@b384469abc1234def/);
  assert.match(r.stdout, /project: demo/);
});

test("blame (local) --repo scopes to one repo slug", () => {
  const { dir } = fixtureGraph();
  // only dec-x carries an api@ commit, and only one whose sha prefix-matches.
  const r = run(["blame", "deadbeef1234567", "--repo", "api"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /referenced by 1 node/);
  assert.match(r.stdout, /dec-x/);
  assert.doesNotMatch(r.stdout, /task-y/);
  // the spor commit filtered out by --repo api yields nothing
  const none = run(["blame", "b384469", "--repo", "api"], { SPOR_HOME: dir });
  assert.strictEqual(none.status, 0);
  assert.match(none.stdout, /no nodes reference commit b384469 in api/);
});

test("blame (local) --json is mode-symmetric {sha, repo?, matches}", () => {
  const { dir } = fixtureGraph();
  const r = run(["blame", "b384469", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.sha, "b384469");
  assert.ok(!("repo" in j), "no repo key when --repo absent");
  assert.deepStrictEqual(j.matches.map((m) => m.id), ["dec-x", "task-y"]); // sorted by id
  assert.strictEqual(j.matches[1].status, "open");
  // with --repo, the key rides along
  const withRepo = JSON.parse(run(["blame", "b384469", "--repo", "spor", "--json"], { SPOR_HOME: dir }).stdout);
  assert.strictEqual(withRepo.repo, "spor");
});

test("blame (local) a full sha matches an abbreviated stored sha (q.startsWith(cs))", () => {
  const { dir } = fixtureGraph();
  // query a full sha sharing task-y's stored b384469 prefix but diverging from
  // dec-x's stored b384469abc1234def — only task-y (stored abbreviated) matches.
  const r = run(["blame", "b384469ffffffffff", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).matches.map((m) => m.id), ["task-y"]);
});

test("blame (local) commits alias resolves to the same verb", () => {
  const { dir } = fixtureGraph();
  const a = run(["commits", "b384469", "--json"], { SPOR_HOME: dir });
  const b = run(["blame", "b384469", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(a.stdout, b.stdout);
});

test("blame (local) an unlinked commit is a valid empty result (exit 0)", () => {
  const { dir } = fixtureGraph();
  const r = run(["blame", "0badf00d"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no nodes reference commit 0badf00d/);
});

test("blame (local) rejects a bad sha and a bad --repo (friendly, exit 1)", () => {
  const { dir } = fixtureGraph();
  const badSha = run(["blame", "xyz"], { SPOR_HOME: dir });
  assert.strictEqual(badSha.status, 1);
  assert.match(badSha.stderr, /bad sha 'xyz'/);
  assert.doesNotMatch(badSha.stderr, /at Object|Error:/);
  const badRepo = run(["blame", "b384469", "--repo", "Bad_Slug"], { SPOR_HOME: dir });
  assert.strictEqual(badRepo.status, 1);
  assert.match(badRepo.stderr, /bad --repo 'Bad_Slug'/);
});

test("blame (local) lowercases the sha before matching", () => {
  const { dir } = fixtureGraph();
  const r = run(["blame", "B384469", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.sha, "b384469");
  assert.deepStrictEqual(j.matches.map((m) => m.id), ["dec-x", "task-y"]);
});

test("blame with no sha exits 1 with usage", () => {
  const { dir } = fixtureGraph();
  const r = run(["blame"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor blame/);
});

test("blame (local) with no graph home points at init, no stack", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-blame-empty-"));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const r = run(["blame", "b384469"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no Spor graph/);
  assert.match(r.stderr, /spor init/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- remote mode ------------------------------------------------------------

// Records every request; GET /v1/commits/{sha} returns a scriptable match set,
// honoring ?repo= so the passthrough is observable.
function commitsStub(matches = []) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/v1\/commits\/([^/]+)$/);
    if (m && req.method === "GET") {
      const sha = decodeURIComponent(m[1]).toLowerCase();
      const repo = u.searchParams.get("repo");
      const out = matches.filter((x) => (x.sha.startsWith(sha) || sha.startsWith(x.sha)) && (!repo || x.repo === repo));
      return j(200, { sha, ...(repo ? { repo } : {}), matches: out });
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) =>
  bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("blame (remote) GETs /v1/commits/<sha> and renders the matches", { skip: isWin }, async () => {
  const { srv, hits, base } = await commitsStub([
    { repo: "spor", sha: "b384469abc1234", id: "art-x", type: "artifact", title: "Shipped X", summary: "s", status: null, project: "spor" },
  ]);
  try {
    const r = await runAsync(["blame", "b384469"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /referenced by 1 node/);
    assert.match(r.stdout, /art-x\s+\[artifact\]/);
    assert.match(r.stdout, /spor@b384469abc1234/);
    const hit = hits.find((h) => h.method === "GET" && h.url === "/v1/commits/b384469");
    assert.ok(hit, "GET /v1/commits/b384469");
  } finally {
    srv.close();
  }
});

test("blame (remote) forwards --repo as ?repo= and emits mode-symmetric --json", { skip: isWin }, async () => {
  const { srv, hits, base } = await commitsStub([
    { repo: "spor", sha: "b384469abc1234", id: "art-x", type: "artifact", title: "Shipped X", summary: "s", status: null, project: "spor" },
    { repo: "api", sha: "b384469abc1234", id: "task-z", type: "task", title: "API task", summary: "s", status: "open", project: "api" },
  ]);
  try {
    const r = await runAsync(["blame", "b384469", "--repo", "api", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.sha, "b384469");
    assert.strictEqual(j.repo, "api");
    assert.deepStrictEqual(j.matches.map((m) => m.id), ["task-z"]);
    const hit = hits.find((h) => h.url === "/v1/commits/b384469?repo=api");
    assert.ok(hit, "?repo=api forwarded");
  } finally {
    srv.close();
  }
});

test("blame (remote) an unlinked commit is a valid empty result (exit 0)", { skip: isWin }, async () => {
  const { srv, base } = await commitsStub([]);
  try {
    const r = await runAsync(["blame", "0badf00d"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no nodes reference commit 0badf00d/);
  } finally {
    srv.close();
  }
});

test("blame (remote) a dead server fails soft with a transport line, no stack", { skip: isWin }, async () => {
  const r = await runAsync(["blame", "b384469"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("blame (remote) validates the sha client-side before any request", { skip: isWin }, async () => {
  const { srv, hits, base } = await commitsStub([]);
  try {
    const r = await runAsync(["blame", "nothex"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bad sha 'nothex'/);
    assert.strictEqual(hits.length, 0, "no request made for an invalid sha");
  } finally {
    srv.close();
  }
});
