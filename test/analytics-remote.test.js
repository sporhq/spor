// analytics-remote.test.js — `spor analytics` in REMOTE mode dispatches to the
// server's GET /v1/analytics and renders the returned report with the SAME
// lib/analytics renderReport the local consumer uses, so remote and local output
// match (task-spor-analytics-remote-cli-dispatch, norm-spor-cli-mode-parity). The
// local arm is byte-identical passthrough to lib/analytics.js (covered by
// analytics.test.js); this guards the remote branch added to cmdAnalytics.
//
// Oracle = the request the CLI makes (the GET path + query) and its rendered
// output, computed in-process from the SAME analyze() the fake server runs over
// the SAME graph and a PINNED `now`, never the server's framing (we script it).

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const graphLib = require("../lib/graph.js");
const analyticsLib = require("../lib/analytics.js");
const isWin = process.platform === "win32";

// A fixed instant so analyze()'s week bucketing is deterministic across the
// client process and the in-process oracle.
const NOW = Date.parse("2026-06-21T12:00:00.000Z");

// Strip ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip a test to
// remote or leak a token (mirrors capabilities-show.test.js).
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-analytics-remote-"));
}

// A scratch graph (no git — analyze() falls back to frontmatter dates, which is
// all the remote-render contract needs: deterministic given a pinned `now`).
function scratchGraph() {
  const home = freshHome();
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const node = (id, type, status, date) =>
    fs.writeFileSync(
      path.join(nodes, `${id}.md`),
      `---\nid: ${id}\ntype: ${type}\nproject: demo\ntitle: ${id}\nsummary: ${id} summary\nstatus: ${status}\ndate: ${date}\n---\nbody\n`
    );
  node("task-alpha", "task", "done", "2026-06-08");
  node("task-beta", "task", "open", "2026-06-15");
  node("issue-gamma", "issue", "open", "2026-05-30");
  return graphLib.loadGraph(nodes);
}

// Fake GET /v1/analytics: the in-process server twin of spor-server/server/rest.js,
// computing the report via the SAME analyze() + a pinned now, and mirroring the
// param handling (type comma-split, weeks/top/aging clamp, ?format=text, the
// additive project_warning). Records hits so the test can assert the GET path.
function analyticsStub(g) {
  const hits = [];
  const intParam = (sp, key, min, max) => {
    const v = sp.get(key);
    if (v == null) return undefined;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  };
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname !== "/v1/analytics") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    }
    const project = u.searchParams.get("project");
    const types = u.searchParams.getAll("type").flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
    let inScope = null, projectWarning = null;
    if (project) {
      if (!graphLib.projectKnown(g, project)) {
        projectWarning = `project '${project}' matched no repo or grouping — analytics is empty (try a repo slug, a repo-<slug> node id, or a grouping id)`;
      }
      const scope = graphLib.scopeFor(g, project);
      inScope = (node) => scope.has(graphLib.resolveProject(g, node.project));
    }
    const report = analyticsLib.analyze(g, {
      now: NOW,
      weeks: intParam(u.searchParams, "weeks", 1, 52),
      topN: intParam(u.searchParams, "top", 1, 100),
      agingDays: intParam(u.searchParams, "aging", 1, 365),
      types: types.length ? types : null,
      inScope,
    });
    if (u.searchParams.get("format") === "text") {
      let text = analyticsLib.renderReport(report);
      if (projectWarning) text = `# ${projectWarning}\n\n${text}`;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(text + "\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(projectWarning ? { ...report, project_warning: projectWarning } : report));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
// What a correct client should print for the same params — the parity oracle.
function oracle(g, opts) {
  return analyticsLib.analyze(g, { now: NOW, ...opts });
}
const remoteEnv = (home, base) => baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token" });

test("remote: default render is byte-identical to renderReport over the server's report", { skip: isWin }, async () => {
  const g = scratchGraph();
  const { srv, hits, base } = await analyticsStub(g);
  try {
    const r = await runAsync(["analytics", "--weeks", "6"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, analyticsLib.renderReport(oracle(g, { weeks: 6 })) + "\n");
    assert.strictEqual(r.stderr, "");
    const hit = hits.find((h) => h.method === "GET" && h.url === "/v1/analytics?weeks=6");
    assert.ok(hit, "GET /v1/analytics?weeks=6");
  } finally {
    srv.close();
  }
});

test("remote: --json emits the machine report, byte-identical to local --json", { skip: isWin }, async () => {
  const g = scratchGraph();
  const { srv, base } = await analyticsStub(g);
  try {
    const r = await runAsync(["analytics", "--weeks", "6", "--json"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, JSON.stringify(oracle(g, { weeks: 6 }), null, 2) + "\n");
  } finally {
    srv.close();
  }
});

test("remote: maps --type (comma/repeatable) and --weeks/--top/--aging to the query", { skip: isWin }, async () => {
  const g = scratchGraph();
  const { srv, hits, base } = await analyticsStub(g);
  try {
    const r = await runAsync(
      ["analytics", "--type", "task,issue", "--type", "decision", "--weeks", "6", "--top", "5", "--aging", "14"],
      remoteEnv(freshHome(), base)
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.method === "GET");
    const q = new URL(hit.url, "http://x").searchParams;
    assert.deepStrictEqual(q.getAll("type"), ["task", "issue", "decision"]);
    assert.strictEqual(q.get("weeks"), "6");
    assert.strictEqual(q.get("top"), "5");
    assert.strictEqual(q.get("aging"), "14");
  } finally {
    srv.close();
  }
});

test("remote: a zero-match --project surfaces the warning on stderr (parity with local), stripped from the report", { skip: isWin }, async () => {
  const g = scratchGraph();
  const { srv, base } = await analyticsStub(g);
  try {
    const r = await runAsync(["analytics", "--project", "zzz-nope", "--json"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /project 'zzz-nope' matched no repo or grouping — analytics is empty/);
    const j = JSON.parse(r.stdout); // valid JSON ...
    assert.ok(!("project_warning" in j), "project_warning stripped from the rendered report");
  } finally {
    srv.close();
  }
});

test("remote: a dead server fails soft with an offline line, exit 1", { skip: isWin }, async () => {
  const r = await runAsync(["analytics"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline — could not reach server/);
});

test("remote: a non-200 (e.g. an older server without the route) reports the error, exit 1", { skip: isWin }, async () => {
  // The stub 404s any path but /v1/analytics; point the client at a bogus path by
  // standing up a server that 404s the route to simulate a pre-analytics server.
  const srv = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await runAsync(["analytics"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /analytics error 404: no such route/);
  } finally {
    srv.close();
  }
});

test("remote: an explicit --nodes takes the LOCAL path even under a configured server", { skip: isWin }, async () => {
  // --nodes names a local checkout on purpose, so it bypasses the server (and keeps
  // local output byte-identical) — mirror cmdCompile/cmdQuery/cmdValidate.
  const g = scratchGraph();
  const nodesDir = g.nodesDir;
  const r = await runAsync(["analytics", "--nodes", nodesDir, "--weeks", "6"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Work analytics ·/); // rendered locally, never hit the (dead) server
});
