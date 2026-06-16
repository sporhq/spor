// Zero-dependency test suite for the local structured query verb
// (lib/query.js, task-spor-local-graph-query-verb). Run: node --test
//
// Covers: --type selection (single + OR), --where key=value (string + list
// membership), --id-prefix, edge emission (--edges --edge-type --to / --from),
// the --ids/--summary/--json projections, and the empty-result case.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { queryGraph } = require(path.join(__dirname, "..", "lib", "query.js"));

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-query-test-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

// A node helper: type, optional status/project, an inline-list `tags` field
// (exercises list-membership matching), and edges.
const node = (id, type, { status, project = "demo", tags, edges = [] } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: ${type}
project: ${project}
title: Title of ${id}
summary: Summary for ${id} used by query tests.
${status ? `status: ${status}\n` : ""}${tags ? `tags: [${tags.join(", ")}]\n` : ""}date: 2026-06-01
${edges.length ? `edges:\n${edges.map((e) => `  - {type: ${e[0]}, to: ${e[1]}}`).join("\n")}\n` : ""}---
Body of ${id}.
`,
];

// ---------------- node selection ----------------

test("query: --type selects nodes of that type", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo"),
    node("repo-b", "repo"),
    node("task-1", "task", { status: "open" }),
    node("dec-1", "decision"),
  ])).load();
  const ids = queryGraph(g, { types: ["repo"] }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["repo-a", "repo-b"]);
});

test("query: --type is an OR set across repeated values", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo"),
    node("task-1", "task", { status: "open" }),
    node("dec-1", "decision"),
  ])).load();
  const ids = queryGraph(g, { types: ["repo", "task"] }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["repo-a", "task-1"]);
});

test("query: no predicates returns every node, id-sorted", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-b", "task"),
    node("task-a", "task"),
    node("repo-z", "repo"),
  ])).load();
  const ids = queryGraph(g, {}).nodes.map((n) => n.id);
  assert.deepEqual(ids, ["repo-z", "task-a", "task-b"]);
});

test("query: --where key=value matches a frontmatter field as a string", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-open-1", "task", { status: "open" }),
    node("task-open-2", "task", { status: "open" }),
    node("task-done", "task", { status: "resolved" }),
  ])).load();
  const ids = queryGraph(g, { where: [["status", "open"]] }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["task-open-1", "task-open-2"]);
});

test("query: --where AND-combines and composes with --type", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", project: "spor" }),
    node("task-y", "task", { status: "open", project: "wf" }),
    node("issue-z", "issue", { status: "open", project: "spor" }),
  ])).load();
  const r = queryGraph(g, { types: ["task"], where: [["status", "open"], ["project", "spor"]] });
  assert.deepEqual(r.nodes.map((n) => n.id), ["task-x"]);
});

test("query: --where on a list field matches on membership", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo", { tags: ["infra", "backend"] }),
    node("repo-b", "repo", { tags: ["frontend"] }),
    node("repo-c", "repo", { tags: ["backend"] }),
  ])).load();
  const ids = queryGraph(g, { where: [["tags", "backend"]] }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["repo-a", "repo-c"]);
});

test("query: --id-prefix selects ids starting with the prefix", () => {
  const g = tmpGraph(Object.fromEntries([
    node("question-1", "question"),
    node("question-2", "question"),
    node("task-1", "task"),
  ])).load();
  const ids = queryGraph(g, { idPrefix: "question-" }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["question-1", "question-2"]);
});

test("query: an empty result is an empty node list, not an error", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-1", "task", { status: "open" }),
  ])).load();
  const r = queryGraph(g, { types: ["nonexistent-type"] });
  assert.deepEqual(r.nodes, []);
});

// ---------------- edge emission ----------------

test("query: --edges emits {from,type,to} edges from every source", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo", { edges: [["grouped-under", "proj-rdi"]] }),
    node("repo-b", "repo", { edges: [["grouped-under", "proj-rdi"]] }),
    node("proj-rdi", "project"),
  ])).load();
  const edges = queryGraph(g, { edges: true });
  assert.deepEqual(edges.edges.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: "repo-a", type: "grouped-under", to: "proj-rdi" },
    { from: "repo-b", type: "grouped-under", to: "proj-rdi" },
  ]);
});

test("query: --edges --edge-type --to answers 'what is grouped under X'", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo", { edges: [["grouped-under", "proj-rdi"]] }),
    node("repo-b", "repo", { edges: [["grouped-under", "proj-other"]] }),
    node("repo-c", "repo", { edges: [["relates-to", "proj-rdi"]] }),
    node("proj-rdi", "project"),
    node("proj-other", "project"),
  ])).load();
  const r = queryGraph(g, { edges: true, edgeType: "grouped-under", to: "proj-rdi" });
  assert.deepEqual(r.edges, [{ from: "repo-a", type: "grouped-under", to: "proj-rdi" }]);
});

test("query: --edges --from walks one source's out-edges", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task", { edges: [["blocks", "task-x"], ["relates-to", "art-y"]] }),
    node("task-x", "task"),
    node("art-y", "artifact"),
    node("task-other", "task", { edges: [["blocks", "task-z"]] }),
    node("task-z", "task"),
  ])).load();
  const r = queryGraph(g, { edges: true, from: "task-hub" });
  assert.deepEqual(
    r.edges.map((e) => `${e.from} ${e.type} ${e.to}`).sort(),
    ["task-hub blocks task-x", "task-hub relates-to art-y"],
  );
});

test("query: node predicates restrict the SOURCE of emitted edges", () => {
  const g = tmpGraph(Object.fromEntries([
    node("repo-a", "repo", { edges: [["grouped-under", "proj-rdi"]] }),
    node("task-b", "task", { edges: [["grouped-under", "proj-rdi"]] }),
    node("proj-rdi", "project"),
  ])).load();
  // only repo sources, even though both point at proj-rdi.
  const r = queryGraph(g, { edges: true, types: ["repo"], to: "proj-rdi" });
  assert.deepEqual(r.edges, [{ from: "repo-a", type: "grouped-under", to: "proj-rdi" }]);
});

test("query: edges empty result is an empty edge list", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-1", "task"),
  ])).load();
  assert.deepEqual(queryGraph(g, { edges: true, edgeType: "blocks" }).edges, []);
});

// ---------------- CLI projections (lib/query.js as a child process) ----------

const { spawnSync } = require("node:child_process");
const QUERY = path.join(__dirname, "..", "lib", "query.js");

function bareEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function cli(nodesDir, args) {
  return spawnSync(process.execPath, [QUERY, "--nodes", nodesDir, ...args], {
    encoding: "utf8", env: bareEnv(),
  });
}

test("query CLI: --ids prints one id per line", () => {
  const { nodesDir } = tmpGraph(Object.fromEntries([
    node("task-a", "task", { status: "open" }),
    node("task-b", "task", { status: "open" }),
    node("dec-1", "decision"),
  ]));
  const r = cli(nodesDir, ["--type", "task", "--ids"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").sort(), ["task-a", "task-b"]);
});

test("query CLI: --summary prints id + summary on one line each", () => {
  const { nodesDir } = tmpGraph(Object.fromEntries([
    node("task-a", "task", { status: "open" }),
  ]));
  const r = cli(nodesDir, ["--type", "task", "--summary"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /task-a\s+Summary for task-a/);
});

test("query CLI: --json emits a node array without the internal file field", () => {
  const { nodesDir } = tmpGraph(Object.fromEntries([
    node("task-a", "task", { status: "open" }),
  ]));
  const r = cli(nodesDir, ["--where", "status=open", "--type", "task", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const arr = JSON.parse(r.stdout);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].id, "task-a");
  assert.equal(arr[0].status, "open");
  assert.equal("file" in arr[0], false, "the load-time `file` artifact is stripped");
  // The regex parser initializes pin/exclude to [] on every node; empty ones are
  // noise and must be trimmed from JSON output.
  assert.equal("pin" in arr[0], false, "empty pin is trimmed");
  assert.equal("exclude" in arr[0], false, "empty exclude is trimmed");
});

test("query CLI: --json keeps a populated pin/exclude (only empties are trimmed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-query-pin-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  fs.writeFileSync(path.join(nodesDir, "brief-x.md"), `---
id: brief-x
type: briefing
project: demo
title: A briefing with a pin
summary: A briefing node that pins and excludes specific nodes.
pin: [dec-a, dec-b]
exclude: [task-stale]
date: 2026-06-01
---
Body of brief-x.
`);
  const r = cli(nodesDir, ["--id-prefix", "brief-", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const arr = JSON.parse(r.stdout);
  assert.equal(arr.length, 1);
  assert.deepEqual(arr[0].pin, ["dec-a", "dec-b"], "a populated pin survives");
  assert.deepEqual(arr[0].exclude, ["task-stale"], "a populated exclude survives");
});

test("query CLI: --edges --json emits {from,type,to} edges", () => {
  const { nodesDir } = tmpGraph(Object.fromEntries([
    node("repo-a", "repo", { edges: [["grouped-under", "proj-rdi"]] }),
    node("proj-rdi", "project"),
  ]));
  const r = cli(nodesDir, ["--edges", "--edge-type", "grouped-under", "--to", "proj-rdi", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ from: "repo-a", type: "grouped-under", to: "proj-rdi" }]);
});

test("query CLI: an empty result prints a clear no-match line, exit 0", () => {
  const { nodesDir } = tmpGraph(Object.fromEntries([
    node("task-a", "task", { status: "open" }),
  ]));
  const r = cli(nodesDir, ["--type", "nonesuch"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no matching nodes/);
});

test("query CLI: a missing nodes dir prints a clear message and exits 0", () => {
  const r = cli(path.join(os.tmpdir(), "spor-query-absent-" + Math.random()), ["--ids"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no Spor graph at /);
});
