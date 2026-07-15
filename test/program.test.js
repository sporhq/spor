// program.test.js — `spor program <id>`, the birds-eye program/progress view
// over `blocks` topology (task-spor-cli-program-verb). Three layers:
//   1. the pure kernel (lib/kernel/program.js) — the gating-tree walk over a
//      hand-built graph: bucket derivation (done/active/blocked/open), shared-
//      blocker dedup + repeat rendering, cycle safety, unknown root, the empty
//      "nothing blocks this yet" result, and max-depth/max-nodes truncation;
//   2. the façade's renderReport (lib/program.js);
//   3. the CLI arms (bin/spor.js) — the LOCAL arm over a real (git-free) scratch
//      graph, and the REMOTE arm wrapping GET /v1/program/{id} (oracle = the
//      request the CLI makes, never the fake server's framing), over a fake
//      server / scratch home so a configured dev box can't flip a test remote.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const graphLib = require("../lib/graph.js");
const programLib = require("../lib/program.js");
const { walkProgram } = require("../lib/kernel/program.js");
const CLI = path.join(__dirname, "..", "bin", "spor.js");

// ---------- hand-built graph fixture (queue.test.js's convention) ----------

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-program-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graphLib.loadGraph(nodesDir) };
}

const node = (id, type, { status, project = "spor", edges = [] } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: ${type}
project: ${project}
title: Title of ${id}
summary: Standalone summary for ${id} used by program tests.
${status ? `status: ${status}\n` : ""}${edges.length ? `edges:\n${edges.map((e) => `  - {type: ${e[0]}, to: ${e[1]}}`).join("\n")}\n` : ""}---
Body of ${id}.
`,
];

// ---------- kernel: walkProgram ----------

test("walkProgram: unknown root is found:false with the attempted root_id", () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")])).load();
  const r = walkProgram(g, "nope");
  assert.deepEqual(r, { found: false, error: "unknown_root", root_id: "nope" });
});

test("walkProgram: a root nothing blocks is a successful empty result", () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")])).load();
  const r = walkProgram(g, "task-hub");
  assert.equal(r.found, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.node_ids, []);
  assert.equal(r.progress.total, 0);
  assert.equal(r.progress.pct, 0);
});

test("walkProgram: buckets — done (terminal status), active, open, and blocked overrides active", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-done", "task", { status: "done", edges: [["blocks", "task-hub"]] }),
    node("task-active", "task", { status: "active", edges: [["blocks", "task-hub"]] }),
    node("task-open", "task", { edges: [["blocks", "task-hub"]] }),
    // task-gated is status:active but has its OWN live blocker -> blocked wins
    node("task-gated", "task", { status: "active", edges: [["blocks", "task-hub"]] }),
    node("task-gate", "task", { edges: [["blocks", "task-gated"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  const bucketOf = (id) => r.tree.find((t) => t.id === id && !t.repeat).bucket;
  assert.equal(bucketOf("task-done"), "done");
  assert.equal(bucketOf("task-active"), "active");
  assert.equal(bucketOf("task-open"), "open");
  assert.equal(bucketOf("task-gated"), "blocked");
  assert.equal(bucketOf("task-gate"), "open");
  assert.deepEqual(r.progress, {
    total: 5, done: 1, active: 1, blocked: 1, open: 2, pct: 20,
    statuses: { done: 1, active: 2, "(none)": 2 },
  });
});

test("walkProgram: a live resolves edge counts as done even while status lags open", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }), // status-less = live, but resolved below
    node("dec-a", "decision", { edges: [["resolves", "task-a"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  const a = r.tree.find((t) => t.id === "task-a");
  assert.equal(a.bucket, "done");
  assert.equal(r.progress.done, 1);
});

test("walkProgram: a superseded blocker counts as done", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-old", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-new", "task", { edges: [["supersedes", "task-old"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  const old = r.tree.find((t) => t.id === "task-old");
  assert.equal(old.bucket, "done");
});

test("walkProgram: a shared blocker is counted once but rendered again as a repeat leaf", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-b", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-shared", "task", { edges: [["blocks", "task-a"], ["blocks", "task-b"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.equal(r.count, 3); // task-a, task-b, task-shared — counted ONCE
  assert.deepEqual(r.node_ids.sort(), ["task-a", "task-b", "task-shared"]);
  const sharedRows = r.tree.filter((t) => t.id === "task-shared");
  assert.equal(sharedRows.length, 2); // rendered once per occurrence
  assert.equal(sharedRows.filter((t) => t.repeat).length, 1); // one of them marked repeat
  assert.equal(sharedRows.filter((t) => !t.repeat).length, 1);
});

test("walkProgram: a blocks cycle back to the root never re-enters it (terminates)", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task", { edges: [["blocks", "task-a"]] }), // hub also blocks task-a: a cycle
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.equal(r.found, true);
  assert.deepEqual(r.node_ids, ["task-a"]); // task-hub itself is never counted as its own blocker
});

test("walkProgram: --max-nodes caps the walk and sets truncated", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-b", "task", { edges: [["blocks", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub", { maxNodes: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.truncated, true);
  const full = walkProgram(g, "task-hub");
  assert.equal(full.truncated, false);
});

test("walkProgram: --max-depth stops expansion past the cap and sets truncated", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-b", "task", { edges: [["blocks", "task-a"]] }), // depth 2 — beyond a depth-1 cap
  ])).load();
  const r = walkProgram(g, "task-hub", { maxDepth: 1 });
  assert.deepEqual(r.node_ids, ["task-a"]);
  assert.equal(r.truncated, true);
  const full = walkProgram(g, "task-hub");
  assert.deepEqual(full.node_ids.sort(), ["task-a", "task-b"]);
  assert.equal(full.truncated, false);
});

// ---------- façade: renderReport ----------

test("renderReport: unknown root reports the attempted id", () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")])).load();
  const text = programLib.renderReport(walkProgram(g, "nope"));
  assert.match(text, /program: unknown root 'nope'/);
});

test("renderReport: an empty program says how to model one", () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")])).load();
  const text = programLib.renderReport(walkProgram(g, "task-hub"));
  assert.match(text, /^program task-hub — Title of task-hub/);
  assert.match(text, /nothing blocks this node yet/);
});

test("renderReport: a progress bar header plus an indented gating tree", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { status: "done", edges: [["blocks", "task-hub"]] }),
    node("task-b", "task", { edges: [["blocks", "task-a"]] }),
  ])).load();
  const text = programLib.renderReport(walkProgram(g, "task-hub"));
  assert.match(text, /\[#+-*\] 50% {2}\(1\/2 done, 0 active, 0 blocked, 1 open\)/);
  assert.match(text, /^ {2}done {4}task-a {2}Title of task-a$/m);
  assert.match(text, /^ {4}open {4}task-b {2}Title of task-b$/m); // one deeper indent
});

// ---------- CLI: local arm ----------

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
function freshHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "spor-program-home-")); }

test("program (local): renders the gating tree over --nodes", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { status: "done", edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /program task-hub/);
  assert.match(r.stdout, /done {4}task-a/);
});

test("program (local): an unknown root exits 1 with a clear message", async () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "nope", "--nodes", g.nodesDir], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /program: unknown root 'nope'/);
});

test("program (local): --json prints the structured envelope", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir, "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.found, true);
  assert.equal(j.count, 1);
  assert.equal(j.node_ids[0], "task-a");
});

test("program (local): --max-depth/--max-nodes flags reach the kernel", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
    node("task-b", "task", { edges: [["blocks", "task-a"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir, "--max-depth", "1", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.node_ids, ["task-a"]);
  assert.equal(j.truncated, true);
});

test("program (local): --nodes before the id still resolves the id correctly", async () => {
  // Regression: the naive `args.find(a => !a.startsWith("--"))` (cmdLens's
  // convention) grabs a preceding flag's bare VALUE as the id whenever that flag
  // takes one — --nodes/--max-depth/--max-nodes all do, unlike lens's --format.
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "--nodes", g.nodesDir, "task-hub"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /program task-hub/);
  assert.match(r.stdout, /open {4}task-a/);
});

test("program (local): --max-depth before the id still resolves the id correctly", async () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "--max-depth", "3", "--nodes", g.nodesDir, "task-hub"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /program task-hub/);
});

test("program (local): a non-numeric --max-depth falls back to the kernel default instead of disabling the cap", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir, "--max-depth", "abc", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.truncated, false); // NaN would have disabled the cap silently; this proves the default (20) still applied
  assert.deepEqual(j.node_ids, ["task-a"]);
});

test("program (local): an empty --max-nodes value falls back to the default instead of Number('')===0", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir, "--max-nodes", "", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.truncated, false); // an empty value coercing to 0 would truncate everything immediately
  assert.deepEqual(j.node_ids, ["task-a"]);
});

test("program (local): a negative --max-nodes value falls back to the default instead of truncating to zero", async () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ]));
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir, "--max-nodes", "-1", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.truncated, false);
  assert.deepEqual(j.node_ids, ["task-a"]);
});

// ---------- CLI: remote arm (fake server) ----------

// Records every request; GET /v1/program/{id} echoes a scriptable response.
function programStub({ status = 200, text, json } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    if (req.url.startsWith("/v1/program/") && req.method === "GET") {
      if (status === 404) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ found: false, error: "unknown_root" }));
      }
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "boom" } }));
      }
      const wantJson = new URLSearchParams(req.url.split("?")[1]).get("format") === "json";
      if (wantJson) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(json ?? { found: true, root_id: "task-hub" }));
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(text ?? "program task-hub (server rendering)");
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (home, base, extra = {}) =>
  baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("program (remote): GETs /v1/program/{id}?format=text and prints the server's rendering verbatim", async () => {
  const { srv, hits, base } = await programStub({ text: "program task-hub (server rendering)" });
  try {
    const r = await runAsync(["program", "task-hub"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "program task-hub (server rendering)\n");
    const hit = hits.find((h) => h.url.startsWith("/v1/program/task-hub"));
    assert.ok(hit, "GET /v1/program/task-hub");
    assert.equal(new URLSearchParams(hit.url.split("?")[1]).get("format"), "text");
  } finally { srv.close(); }
});

test("program (remote): --json requests format=json and prints the server envelope verbatim", async () => {
  const body = { found: true, root_id: "task-hub", progress: { total: 1, done: 1, pct: 100 } };
  const { srv, hits, base } = await programStub({ json: body });
  try {
    const r = await runAsync(["program", "task-hub", "--json"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), body);
    const hit = hits.find((h) => h.url.startsWith("/v1/program/task-hub"));
    assert.equal(new URLSearchParams(hit.url.split("?")[1]).get("format"), "json");
  } finally { srv.close(); }
});

test("program (remote): --max-depth/--max-nodes map to depth/max_nodes query params", async () => {
  const { srv, hits, base } = await programStub({});
  try {
    const r = await runAsync(["program", "task-hub", "--max-depth", "2", "--max-nodes", "10"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.url.startsWith("/v1/program/task-hub"));
    const qs = new URLSearchParams(hit.url.split("?")[1]);
    assert.equal(qs.get("depth"), "2");
    assert.equal(qs.get("max_nodes"), "10");
  } finally { srv.close(); }
});

test("program (remote): a 404 (unknown root) reports a clear line, not an outage", async () => {
  const { srv, base } = await programStub({ status: 404 });
  try {
    const r = await runAsync(["program", "nope"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /program: unknown root 'nope'/);
    assert.doesNotMatch(r.stderr, /offline/);
  } finally { srv.close(); }
});

test("program (remote): a dead server fails soft with an offline line", async () => {
  const r = await runAsync(["program", "task-hub"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /offline — could not reach server/);
});

test("program (remote): an explicit --nodes forces the local path even under a server", async () => {
  const g = tmpGraph(Object.fromEntries([node("task-hub", "task")]));
  const { srv, hits, base } = await programStub({});
  try {
    const r = await runAsync(["program", "task-hub", "--nodes", g.nodesDir], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing blocks this node yet/);
    assert.equal(hits.length, 0); // never reached the server
  } finally { srv.close(); }
});

test("program: no id argument is a usage error, not a crash", async () => {
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program"], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: spor program <id>/);
});
