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
const { hermeticEnv } = require("./helpers/env.js");
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

// ---------- kernel: member-of-program (dec-spor-program-membership-per-node-preference) ----------

test("walkProgram: a blocks-only graph carries no membership fields (envelope unchanged)", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-a", "task", { edges: [["blocks", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.deepEqual(Object.keys(r), ["found", "root_id", "root", "progress", "count", "truncated", "node_ids", "tree"]);
  assert.deepEqual(Object.keys(r.tree[0]), ["id", "type", "title", "depth", "parent", "bucket", "repeat"]);
});

test("walkProgram: declared member-of-program edges are preferred over blocks at that node", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    // a member that does not gate the hub — invisible to a blocks-only walk
    node("task-member", "task", { edges: [["member-of-program", "task-hub"]] }),
    // a member that also gates it
    node("task-both", "task", { status: "active", edges: [["member-of-program", "task-hub"], ["blocks", "task-hub"]] }),
    // a prerequisite of the hub that is NOT part of the program
    node("task-prereq", "task", { edges: [["blocks", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.deepEqual([...r.node_ids].sort(), ["task-both", "task-member"]);
  assert.equal(r.root_edge, "member-of-program");
  assert.ok(r.tree.every((t) => t.edge === "member-of-program"));
  assert.equal(r.outside, 1);
  assert.deepEqual(r.outside_ids, ["task-prereq"]);
  // gating stays blocks-only: a member gating nothing is open, not blocked
  assert.equal(r.tree.find((t) => t.id === "task-member").bucket, "open");
  assert.equal(r.tree.find((t) => t.id === "task-both").bucket, "active");
});

test("walkProgram: the preference is per node — an unmigrated sub-hub falls back to blocks", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-sub", "task", { edges: [["member-of-program", "task-hub"]] }),
    node("task-leaf", "task", { edges: [["blocks", "task-sub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.deepEqual(r.node_ids, ["task-sub", "task-leaf"]);
  const leaf = r.tree.find((t) => t.id === "task-leaf");
  assert.equal(leaf.parent, "task-sub");
  assert.equal(leaf.depth, 2);
  assert.equal(leaf.edge, undefined); // reached over blocks
  assert.equal(r.tree.find((t) => t.id === "task-sub").edge, "member-of-program");
  // task-leaf blocks task-sub, which is undeclared — never "outside"
  assert.equal(r.outside, undefined);
  // and task-sub is blocked by its live gate
  assert.equal(r.tree.find((t) => t.id === "task-sub").bucket, "blocked");
});

test("walkProgram: a blocker that is a member elsewhere in the tree is not outside", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-sub", "task", { edges: [["member-of-program", "task-hub"]] }),
    // a member of the sub-milestone that ALSO blocks the top umbrella
    node("task-x", "task", { edges: [["member-of-program", "task-sub"], ["blocks", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.deepEqual(r.node_ids, ["task-sub", "task-x"]);
  assert.equal(r.outside, undefined);
  assert.equal(r.outside_ids, undefined);
});

test("walkProgram: a truncated walk never names capped members as outside", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-sub", "task", { edges: [["member-of-program", "task-hub"]] }),
    node("task-x", "task", { edges: [["member-of-program", "task-sub"], ["blocks", "task-hub"]] }),
  ])).load();
  for (const opts of [{ maxDepth: 1 }, { maxNodes: 1 }]) {
    const r = walkProgram(g, "task-hub", opts);
    assert.equal(r.truncated, true);
    assert.equal(r.outside, undefined);
    assert.equal(r.outside_ids, undefined);
  }
});

test("walkProgram: a member-of-program cycle back to the root terminates", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task", { edges: [["member-of-program", "task-a"]] }),
    node("task-a", "task", { edges: [["member-of-program", "task-hub"]] }),
  ])).load();
  const r = walkProgram(g, "task-hub");
  assert.deepEqual(r.node_ids, ["task-a"]);
});

test("walkProgram: an injected lease table annotates every row with lease_state (issue-spor-program-envelope-missing-lease-state)", () => {
  const g = tmpGraph(
    Object.fromEntries([
      node("task-hub", "task"),
      node("task-live", "task", { edges: [["member-of-program", "task-hub"]] }),
      node("task-res", "task", { edges: [["member-of-program", "task-hub"]] }),
      node("task-lapsed", "task", { edges: [["member-of-program", "task-hub"]] }),
      node("task-free", "task", { edges: [["member-of-program", "task-hub"]] }),
    ])
  ).load();
  const plain = walkProgram(g, "task-hub");
  assert.ok(!("leases" in plain), "no table injected: no envelope flag");
  assert.ok(plain.tree.every((r) => !("lease_state" in r) && !("lease_by" in r)), "no table injected: rows unchanged");

  const leases = {
    "task-live": { by: "person-bob", expires: 2000 },
    "task-res": { by: "person-ann", expires: 2000, reserved: true },
    "task-lapsed": { by: "person-bob", expires: 500 },
  };
  const r = walkProgram(g, "task-hub", { leases, now: 1000 });
  assert.equal(r.leases, true);
  const byId = Object.fromEntries(r.tree.map((x) => [x.id, x]));
  assert.equal(byId["task-live"].lease_state, "in_progress");
  assert.equal(byId["task-live"].lease_by, "person-bob");
  assert.equal(byId["task-res"].lease_state, "reserved");
  assert.equal(byId["task-res"].lease_by, "person-ann");
  assert.equal(byId["task-lapsed"].lease_state, null, "a lapsed lease is not in force");
  assert.ok(!("lease_by" in byId["task-lapsed"]));
  assert.equal(byId["task-free"].lease_state, null);
  // The lease reading is additive: buckets and progress are unchanged by it.
  assert.deepEqual(r.progress, plain.progress);
  // An empty table still says the walk could read leases.
  assert.equal(walkProgram(g, "task-hub", { leases: {}, now: 1000 }).leases, true);

  const text = programLib.renderReport(r);
  assert.match(text, /task-live  Title of task-live  \[in progress by person-bob\]/);
  assert.match(text, /task-res  Title of task-res  \[reserved by person-ann\]/);
  assert.doesNotMatch(text, /task-free.*\[/);
});

test("renderReport: names blocking items outside a declared program", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task"),
    node("task-member", "task", { edges: [["member-of-program", "task-hub"]] }),
    node("task-prereq", "task", { edges: [["blocks", "task-hub"]] }),
  ])).load();
  const text = programLib.renderReport(walkProgram(g, "task-hub"));
  assert.match(text, /^ {2}open {4}task-member {2}Title of task-member$/m);
  assert.match(text, /^ {2}1 blocking item outside the program: task-prereq$/m);
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
  assert.match(text, /nothing hangs under this node yet/);
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

test("program (remote): an older server ignoring format=envelope falls back to format=text, printed verbatim", async () => {
  const { srv, hits, base } = await programStub({ text: "program task-hub (server rendering)" });
  try {
    const r = await runAsync(["program", "task-hub"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "program task-hub (server rendering)\n");
    const formats = hits.filter((h) => h.url.startsWith("/v1/program/task-hub")).map((h) => new URLSearchParams(h.url.split("?")[1]).get("format"));
    assert.deepEqual(formats, ["envelope", "text"]);
  } finally { srv.close(); }
});

test("program (remote): --json against an older server falls back to format=json, printed verbatim", async () => {
  const body = { found: true, root_id: "task-hub", progress: { total: 1, done: 1, pct: 100 } };
  const { srv, hits, base } = await programStub({ json: body });
  try {
    const r = await runAsync(["program", "task-hub", "--json"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), body);
    const formats = hits.filter((h) => h.url.startsWith("/v1/program/task-hub")).map((h) => new URLSearchParams(h.url.split("?")[1]).get("format"));
    assert.deepEqual(formats, ["envelope", "json"]);
  } finally { srv.close(); }
});

test("program (remote): an envelope-serving server is rendered through renderReport", async () => {
  const env = { found: true, root_id: "task-hub", root: { title: "Hub" }, progress: { total: 1, done: 1, active: 0, blocked: 0, open: 0, pct: 100 }, count: 1, truncated: false, tree: [{ id: "task-a", depth: 0, bucket: "done", title: "A" }], outside_ids: [] };
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(env));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runAsync(["program", "task-hub"], remoteEnv(freshHome(), `http://127.0.0.1:${srv.address().port}`));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, require("../lib/program.js").renderReport(env) + "\n");
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
    assert.match(r.stdout, /nothing hangs under this node yet/);
    assert.equal(hits.length, 0); // never reached the server
  } finally { srv.close(); }
});

test("program: no id argument is a usage error, not a crash", async () => {
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["program"], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: spor program <id>/);
});
