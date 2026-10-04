// validate-remote.test.js — `spor validate` in REMOTE mode and its --summary /
// --json read (task-spor-cli-remote-validate-summary). Remote mode has no
// whole-graph lint endpoint (and a gardener sweep is far too expensive to
// trigger on demand), so it fetches the team graph via GET /v1/export and runs
// the SAME lib/validate.js over it — the pattern `spor query` established.
//
// Oracle = parity: the remote run's output must equal the LOCAL `spor validate
// --nodes <dir>` over the same graph, and the only request is GET /v1/export.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { hermeticEnv } = require("./helpers/env.js");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const tar = require("../lib/tar.js");

function baseEnv(extra = {}) {
  const env = hermeticEnv(extra);
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-validate-remote-"));
}

// Two linked tasks, one task whose only edge dangles (an orphan: a dangling
// edge is no connection), one undated edgeless decision (an orphan + a
// missing-date warning), and a person whose only edge is the virtual
// `stewards -> org-root` anchor (connected, not an orphan, no warning).
function scratchNodes() {
  const nodes = path.join(freshHome(), "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const node = (id, type, extra, edges = []) =>
    fs.writeFileSync(path.join(nodes, `${id}.md`), [
      "---", `id: ${id}`, `type: ${type}`, "project: demo", `title: ${id}`, `summary: ${id} summary.`,
      ...extra,
      ...(edges.length ? ["edges:", ...edges.map(([t, to]) => `  - {type: ${t}, to: ${to}}`)] : []),
      "---", `${id} body.`, "",
    ].join("\n"));
  node("task-a", "task", ["status: open", "date: 2026-06-01"], [["blocks", "task-b"]]);
  node("task-b", "task", ["status: open", "date: 2026-06-01"]);
  node("task-lonely", "task", ["status: open", "date: 2026-06-01"], [["relates-to", "ghost-node"]]);
  node("dec-undated", "decision", []);
  node("person-op", "person", ["date: 2026-06-01"], [["stewards", "org-root"]]);
  return nodes;
}

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
    res.writeHead(200, { "content-type": "application/x-tar" });
    res.end(u.searchParams.get("gzip") === "1" ? zlib.gzipSync(exported.buffer) : exported.buffer);
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

const remoteEnv = (base) => {
  const home = freshHome();
  return baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token" });
};
const local = (nodes, args) => runAsync(["validate", ...args, "--nodes", nodes], baseEnv());

test("remote: validate lints the exported team graph, byte-identical to a local lint", async () => {
  const nodes = scratchNodes();
  const { srv, hits, base } = await exportStub(nodes);
  try {
    const r = await runAsync(["validate"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, (await local(nodes, [])).stdout);
    assert.match(r.stdout, /WARN {2}task-lonely\.md: dangling edge relates-to -> ghost-node/);
    // One read, the documented graph-wide sweep path — never POST /v1/gardener.
    assert.deepStrictEqual(hits.map((h) => `${h.method} ${h.url}`), ["GET /v1/export?gzip=1"]);
  } finally {
    srv.close();
  }
});

test("--summary tallies warnings by kind and counts orphans (remote == local)", async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const r = await runAsync(["validate", "--summary"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, (await local(nodes, ["--summary"])).stdout);
    assert.doesNotMatch(r.stdout, /WARN/); // the tally replaces the per-warning lines
    assert.match(r.stdout, /^5 nodes \(/);
    assert.match(r.stdout, /warnings by kind: (?=.*1 dangling-edge)(?=.*1 missing-date)/);
    assert.match(r.stdout, /orphans: 2 \((?=.*1 task)(?=.*1 decision)/);
    assert.match(r.stdout, /0 errors, 2 warnings\n$/);
  } finally {
    srv.close();
  }
});

test("--json carries counts, warnings, the kind tally and orphan ids", async () => {
  const nodes = scratchNodes();
  const { srv, base } = await exportStub(nodes);
  try {
    const r = await runAsync(["validate", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.count, 5);
    assert.deepStrictEqual(j.byType, { decision: 1, person: 1, task: 3 });
    assert.deepStrictEqual(j.errors, []);
    assert.strictEqual(j.warnings.length, 2);
    assert.deepStrictEqual(j.warnings_by_kind, { "missing-date": 1, "dangling-edge": 1 });
    assert.deepStrictEqual([...j.orphans.ids].sort(), ["dec-undated", "task-lonely"]);
    assert.deepStrictEqual(j.orphans.byType, { decision: 1, task: 1 });
  } finally {
    srv.close();
  }
});

test("--summary still lists ERROR lines and exits 1 on errors", async () => {
  const nodes = scratchNodes();
  fs.writeFileSync(path.join(nodes, "bad.md"), "no frontmatter here\n");
  const r = await local(nodes, ["--summary"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /ERROR bad\.md: no frontmatter/);
  assert.match(r.stdout, /1 errors, 2 warnings\n$/);
});

test("remote: a non-200 export is one clean error line, exit 1", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "forbidden", message: "export needs a member token" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runAsync(["validate", "--summary"], remoteEnv(`http://127.0.0.1:${srv.address().port}`));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /validate error 403: export needs a member token/);
    assert.strictEqual(r.stdout, "");
  } finally {
    srv.close();
  }
});
