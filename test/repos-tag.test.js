// repos-tag.test.js — `spor repos tag|untag|tags` (task-cc-repos-tag-ergonomic):
// the ergonomic for repo-identity tags, the match key for a norm's
// applies_to_tags ride-along (schema-repo). Tags live on the repo-<slug> GRAPH
// node (not the machine-local dispatch map `spor repos add` maintains), so these
// verbs are dual-mode like set-status/edge: local rewrites the node file +
// validates; remote does a GET + put_node(if_exists:update) read-modify-write.
//
// Oracle = the on-disk frontmatter in local mode, and the REQUEST BODY the CLI
// PUTs in remote mode (never the server's framing — we script the responses).
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const tar = require("../lib/tar.js");
const isWin = process.platform === "win32";

// Env with no SPOR_*/SUBSTRATE_*/XDG leakage so a configured dev box can't flip a
// local-mode test to remote or leak a token.
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
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

// A scratch local graph home with one repo identity node (slugs, fingerprints,
// no tags yet). Returns { home, nodes }.
function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  fs.writeFileSync(path.join(nodes, "repo-foo.md"), `---
id: repo-foo
type: repo
title: foo
summary: Git-repo identity for foo, used to exercise the repos tag verbs end to end.
slugs: [foo]
fingerprints: [root:abc1234]
date: 2026-06-01
---
Body about foo.
`);
  return { home, nodes };
}
function readNode(nodes, id) {
  return fs.readFileSync(path.join(nodes, `${id}.md`), "utf8");
}
function validateGraph(nodes) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
}

// ---------------- tag/untag: local mode ----------------

test("repos tag (local) writes the inline tags list grouped with the identity registers, validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["repos", "tag", "foo", "python", "backend"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tags set: repo-foo -> \[python, backend\]/);
  const md = readNode(nodes, "repo-foo");
  assert.match(md, /^tags: \[python, backend\]$/m);
  // grouped right after fingerprints (the identity-register cluster), not at the end
  assert.match(md, /fingerprints: \[root:abc1234\]\ntags: \[python, backend\]/);
  assert.match(md, /Body about foo\./); // body survived
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test("repos tag (local) is set/replace semantics, not append", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python", "backend"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const r = run(["repos", "tag", "foo", "go"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = readNode(nodes, "repo-foo");
  assert.match(md, /^tags: \[go\]$/m);
  assert.strictEqual((md.match(/^tags: /gm) || []).length, 1, "exactly one tags line");
});

test("repos tag (local) lowercases, dedupes, and rejects an invalid tag without writing", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "repo-foo");
  const bad = run(["repos", "tag", "foo", "Bad Tag!"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid tag 'Bad Tag!'/);
  assert.strictEqual(readNode(nodes, "repo-foo"), before, "node untouched on a bad tag");
  // lowercase + dedupe of valid tokens
  const ok = run(["repos", "tag", "foo", "Python", "python", "BACKEND"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(readNode(nodes, "repo-foo"), /^tags: \[python, backend\]$/m);
});

test("repos tag (local) a no-op set skips the write entirely", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python", "backend"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const before = readNode(nodes, "repo-foo");
  const r = run(["repos", "tag", "foo", "backend", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }); // reordered
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tags unchanged: repo-foo -> \[python, backend\]/);
  assert.strictEqual(readNode(nodes, "repo-foo"), before, "node untouched on a no-op");
});

test("repos untag (local) removes the named tags, leaving the rest", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python", "backend", "go"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const r = run(["repos", "untag", "foo", "backend"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tags set: repo-foo -> \[python, go\]/);
  assert.match(readNode(nodes, "repo-foo"), /^tags: \[python, go\]$/m);
});

test("repos untag (local) with no tags clears the whole register (line removed)", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python", "backend"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const r = run(["repos", "untag", "foo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tags cleared: repo-foo/);
  assert.doesNotMatch(readNode(nodes, "repo-foo"), /^tags:/m);
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
});

test("repos untag (local) a tag that isn't present is a reported no-op", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const before = readNode(nodes, "repo-foo");
  const r = run(["repos", "untag", "foo", "rust"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tags unchanged: repo-foo -> \[python\]/);
  assert.strictEqual(readNode(nodes, "repo-foo"), before);
});

test("repos tag (local) on a missing repo node exits 1 with a self-register hint", () => {
  const { home } = fixtureGraph();
  const r = run(["repos", "tag", "nope", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no repo identity node 'repo-nope'/);
  assert.match(r.stderr, /self-registers/);
});

test("repos tag (local) rejects a malformed slug", () => {
  const { home } = fixtureGraph();
  const r = run(["repos", "tag", "Bad_Slug", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid slug 'Bad_Slug'/);
});

// ---------------- tags listing: local mode ----------------

test("repos tags (local) lists every repo node with its slugs and tags", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  fs.writeFileSync(path.join(nodes, "repo-bar.md"), `---
id: repo-bar
type: repo
title: bar
summary: Another repo identity node, untagged, to prove the listing surfaces both.
slugs: [bar, bar-old]
date: 2026-06-01
---
Body.
`);
  const r = run(["repos", "tags"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  // sorted by id: repo-bar before repo-foo
  assert.match(r.stdout, /repo-bar\tslugs: \[bar, bar-old\]\ttags: \[\]/);
  assert.match(r.stdout, /repo-foo\tslugs: \[foo\]\ttags: \[python\]/);
  assert.ok(r.stdout.indexOf("repo-bar") < r.stdout.indexOf("repo-foo"), "sorted by id");
});

test("repos tags (local) on a graph with no repo nodes prints the empty contract", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  const r = run(["repos", "tags"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /no repo identity nodes yet/);
});

// ---------------- auto-suggest: local mode ----------------

test("repos tag (local) bare shows current tags + auto-suggests from a mapped checkout, writing nothing", () => {
  const { home, nodes } = fixtureGraph();
  run(["repos", "tag", "foo", "python"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  // a checkout on disk with terraform + go markers (python is already a tag)
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "spor-foo-checkout-"));
  fs.writeFileSync(path.join(checkout, "main.tf"), "");
  fs.writeFileSync(path.join(checkout, "go.mod"), "module foo\n");
  fs.writeFileSync(path.join(checkout, "pyproject.toml"), "");
  run(["repos", "add", "foo", checkout], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const before = readNode(nodes, "repo-foo");
  const r = run(["repos", "tag", "foo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo-foo: \[python\]/);
  assert.match(r.stdout, /suggested.*terraform/);
  assert.match(r.stdout, /suggested.*\bgo\b/);
  assert.doesNotMatch(r.stdout, /suggested.*python/); // already tagged, filtered out
  assert.match(r.stdout, /apply: spor repos tag foo python terraform go/);
  assert.strictEqual(readNode(nodes, "repo-foo"), before, "suggest writes nothing");
});

test("repos tag (local) bare with no mapped checkout reports it can't auto-suggest", () => {
  const { home } = fixtureGraph();
  const r = run(["repos", "tag", "foo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo-foo: \(no tags\)/);
  assert.match(r.stdout, /no checkout mapped for 'foo'/);
});

// ---------------- tag/untag: remote mode ----------------

const remoteEnv = (base, home, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", SPOR_HOME: home, XDG_CONFIG_HOME: home, ...extra });

// Fake server: GET /v1/nodes/repo-foo returns raw markdown + a revision; POST
// /v1/nodes is the put_node update (batch results shape). Records hits so the
// test asserts the read-modify-write round-trip.
function nodeStub({ raw, revision = "rev-1", getStatus = 200, postFail } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const g = req.url.match(/^\/v1\/nodes\/([^/]+)$/);
      if (g && req.method === "GET") {
        if (getStatus !== 200) return j(getStatus, { error: { code: "not_found", message: "nope" } });
        return j(200, { raw, revision, frontmatter: {} });
      }
      if (req.url === "/v1/nodes" && req.method === "POST") {
        const parsed = JSON.parse(body);
        const node = parsed.nodes[0];
        if (postFail) {
          // batch put_node partial-failure entry shape: 207 + {ok:false, message, details}
          return j(207, { results: [{ ok: false, status: "error", id: "repo-foo", message: postFail.message, details: postFail.details || [] }] });
        }
        return j(200, { results: [{ ok: true, status: "updated", id: "repo-foo", revision: "rev-2", warnings: [], _echo: node }] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

const REPO_RAW = `---
id: repo-foo
type: repo
title: foo
summary: Git-repo identity for foo.
slugs: [foo]
fingerprints: [root:abc1234]
date: 2026-06-01
---
Body about foo.
`;

test("repos tag (remote) GETs the node then put_node-updates it with the revision", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const { srv, hits, base } = await nodeStub({ raw: REPO_RAW, revision: "rev-1" });
  try {
    const r = await runAsync(["repos", "tag", "foo", "python", "backend"], remoteEnv(base, home));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /tags set: repo-foo -> \[python, backend\]/);
    const get = hits.find((h) => h.method === "GET" && h.url === "/v1/nodes/repo-foo");
    assert.ok(get, "GET /v1/nodes/repo-foo");
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes");
    assert.ok(post, "POST /v1/nodes (put_node)");
    const node = JSON.parse(post.body).nodes[0];
    assert.strictEqual(node.if_exists, "update");
    assert.strictEqual(node.revision, "rev-1"); // the revision from the GET (optimistic concurrency)
    assert.match(node.node, /^tags: \[python, backend\]$/m);
    assert.match(node.node, /Body about foo\./); // rest of the node preserved
  } finally {
    srv.close();
  }
});

test("repos tag (remote) a no-op set skips the put_node entirely", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const tagged = REPO_RAW.replace(/^slugs: \[foo\]$/m, "slugs: [foo]\ntags: [python]");
  const { srv, hits, base } = await nodeStub({ raw: tagged });
  try {
    const r = await runAsync(["repos", "tag", "foo", "python"], remoteEnv(base, home));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /tags unchanged: repo-foo -> \[python\]/);
    assert.ok(!hits.some((h) => h.method === "POST"), "no put_node on a no-op");
  } finally {
    srv.close();
  }
});

test("repos untag (remote) removes a tag via the same round-trip", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const tagged = REPO_RAW.replace(/^slugs: \[foo\]$/m, "slugs: [foo]\ntags: [python, backend]");
  const { srv, hits, base } = await nodeStub({ raw: tagged });
  try {
    const r = await runAsync(["repos", "untag", "foo", "backend"], remoteEnv(base, home));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /tags set: repo-foo -> \[python\]/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes");
    assert.match(JSON.parse(post.body).nodes[0].node, /^tags: \[python\]$/m);
  } finally {
    srv.close();
  }
});

test("repos tag (remote) surfaces a put_node validation failure with the server's message + details", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const { srv, base } = await nodeStub({ raw: REPO_RAW, postFail: { message: "invalid_node", details: ["repo-foo: bad tags"] } });
  try {
    const r = await runAsync(["repos", "tag", "foo", "python"], remoteEnv(base, home));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /tag error 207: invalid_node; repo-foo: bad tags/);
  } finally {
    srv.close();
  }
});

test("repos tag (remote) maps a GET 404 to a clean 'no repo identity node'", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const { srv, base } = await nodeStub({ getStatus: 404 });
  try {
    const r = await runAsync(["repos", "tag", "gone", "python"], remoteEnv(base, home));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no repo identity node 'repo-gone'/);
  } finally {
    srv.close();
  }
});

test("repos tag (remote) fails open against an unreachable server (no stack trace)", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const r = await runAsync(["repos", "tag", "foo", "python"], remoteEnv("http://127.0.0.1:1", home));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// ---------------- tags listing: remote mode (GET /v1/export) ----------------

function exportStub(nodesDir) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname !== "/v1/export") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "not_found" } }));
    }
    const exported = tar.exportNodesDir(nodesDir);
    const body = u.searchParams.get("gzip") === "1" ? zlib.gzipSync(exported.buffer) : exported.buffer;
    res.writeHead(200, { "content-type": "application/x-tar" });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("repos tags (remote) lists repo nodes from the team graph export", { skip: isWin }, async () => {
  const { nodes } = fixtureGraph(); // repo-foo on disk = the server's graph here
  fs.writeFileSync(path.join(nodes, "repo-foo.md"), REPO_RAW.replace(/^slugs: \[foo\]$/m, "slugs: [foo]\ntags: [python, backend]"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-repos-tag-r-"));
  const { srv, hits, base } = await exportStub(nodes);
  try {
    const r = await runAsync(["repos", "tags"], remoteEnv(base, home));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /repo-foo\tslugs: \[foo\]\ttags: \[python, backend\]/);
    assert.ok(hits.some((h) => h.method === "GET" && h.url.startsWith("/v1/export")), "fetched the export");
  } finally {
    srv.close();
  }
});

// ---------------- help ----------------

test("repos --help documents the tag/untag/tags subcommands", () => {
  const r = run(["repos", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /spor repos tag <slug> <tag\.\.\.>/);
  assert.match(r.stdout, /spor repos untag <slug>/);
  assert.match(r.stdout, /spor repos tags/);
  assert.match(r.stdout, /applies_to_tags/); // the why
});
