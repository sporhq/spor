// Zero-dependency test suite for the schema introspection surface
// (lib/kernel/registry.js Registry.snapshot() + lib/schema.js renderers,
// task-spor-schema-introspection-surface). Run: node --test
//
// Covers: the snapshot shape over the seed registry (every node/edge type,
// prefixes, weights, flags, status partition, hook names, seed provenance, the
// native `schema` type), { code } embedding, graph-resident override provenance
// + custom types + the stale-override warning, the renderOverview/renderType/
// present dispatcher (human + json + the unknown-type error), filterBySource,
// and the lib/schema.js CLI exit codes.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const schemaLib = require(path.join(__dirname, "..", "lib", "schema.js"));
const SCHEMA_CLI = path.join(__dirname, "..", "lib", "schema.js");

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-schema-test-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  // one plain node so loadGraph has content; the registry stays pure seed unless
  // a schema node is added by the caller.
  fs.writeFileSync(path.join(nodesDir, "task-x.md"), "---\nid: task-x\ntype: task\nsummary: t\n---\nb\n");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

// A graph-resident schema node (kind: node-schema) with a JSON payload.
const schemaNode = (id, payload, { version = "2026.06.21.1", status = "active" } = {}) => [
  `${id}.md`,
  `---\nid: ${id}\ntype: schema\nkind: node-schema\nschema_version: ${version}\nstatus: ${status}\nsummary: ${id}\n---\n` +
    "```json\n" + JSON.stringify(payload) + "\n```\n",
];

// ---------------- snapshot over the seed registry ----------------

test("snapshot: exposes every node type with seed provenance, prefixes, flags, hooks", () => {
  const snap = graph.seedRegistry().snapshot();

  // The native `schema` type is surfaced so the list is complete.
  const schemaType = snap.node_types.find((n) => n.type === "schema");
  assert.ok(schemaType, "schema type present");
  assert.equal(schemaType.source, "native");
  assert.deepEqual(schemaType.prefix, ["schema-"]);
  assert.equal(schemaType.capturable, false);

  // A representative seed node type carries its prefix, flags, status partition,
  // hook names, and provenance.
  const task = snap.node_types.find((n) => n.type === "task");
  assert.equal(task.source, "seed");
  assert.equal(task.schema_id, "schema-task");
  assert.deepEqual(task.prefix, ["task-"]);
  assert.equal(task.queueable, true);
  assert.equal(task.traversable, true);
  assert.deepEqual(task.non_resolving, ["abandoned"]);
  assert.ok(task.hooks.includes("validate") && task.hooks.includes("transitions"));

  // Both status partitions are exposed: non_resolving (resolver semantics) and
  // terminal (own-lifecycle completion, incl. schema-only statuses like settled).
  const decision = snap.node_types.find((n) => n.type === "decision");
  assert.deepEqual(decision.non_resolving, ["rejected"]);
  assert.ok(decision.terminal.includes("settled"), "schema-declared terminal status surfaced");

  // norm carries always_on; briefing is not traversable / not capturable.
  assert.equal(snap.node_types.find((n) => n.type === "norm").always_on, true);
  const briefing = snap.node_types.find((n) => n.type === "briefing");
  assert.equal(briefing.traversable, false);
  assert.equal(briefing.capturable, false);

  // Sorted by type for stable output, and no code by default.
  const types = snap.node_types.map((n) => n.type);
  assert.deepEqual(types, [...types].sort((a, b) => a.localeCompare(b)));
  assert.equal("code" in task, false);
});

test("snapshot: exposes edge types with resolved weights, inverse/aliases, default marker", () => {
  const snap = graph.seedRegistry().snapshot();

  const blocks = snap.edge_types.find((e) => e.type === "blocks");
  assert.equal(blocks.weight, 0.7);
  assert.equal(blocks.weight_default, false);
  assert.equal(blocks.inverse_label, "blocked-by");
  assert.equal(blocks.source, "seed");

  const supersedes = snap.edge_types.find((e) => e.type === "supersedes");
  assert.ok(supersedes.aliases.includes("supercedes"));

  // A provenance-only edge with no explicit weight falls back to the default and
  // is marked as such.
  const compiledFor = snap.edge_types.find((e) => e.type === "compiled-for");
  assert.equal(compiledFor.weight, snap.default_edge_weight);
  assert.equal(compiledFor.weight_default, true);
});

test("snapshot({ code }): embeds each hook's source", () => {
  const snap = graph.seedRegistry().snapshot({ code: true });
  const task = snap.node_types.find((n) => n.type === "task");
  assert.ok(task.code && typeof task.code.validate === "string");
  assert.match(task.code.transitions, /function transitions/);
});

test("snapshot: registers are exposed with their class ids", () => {
  const snap = graph.seedRegistry().snapshot();
  const requires = snap.registers.find((r) => r.name === "requires");
  assert.ok(requires, "requires register present");
  assert.ok(requires.classes.length > 0);
  assert.ok(requires.classes.every((c) => typeof c.id === "string"));
});

// ---------------- graph-resident overrides (the point of the surface) ----------------

test("snapshot: a graph-resident override is tagged graph and shadows the seed", () => {
  const g = tmpGraph(Object.fromEntries([
    // override at a version ABOVE seed -> graph wins cleanly, no stale warning.
    schemaNode("schema-decision", { node_type: "decision", description: "RESIDENT", prefix: ["dec-"] }, { version: "2099.01.01.1" }),
    // a brand-new org-local type.
    schemaNode("schema-experiment", { node_type: "experiment", description: "exp", prefix: ["exp-"], queueable: true }),
  ])).load();
  const snap = g.registry.snapshot();

  const dec = snap.node_types.find((n) => n.type === "decision");
  assert.equal(dec.source, "graph");
  assert.equal(dec.description, "RESIDENT");

  const exp = snap.node_types.find((n) => n.type === "experiment");
  assert.ok(exp, "custom type surfaced");
  assert.equal(exp.source, "graph");
  assert.deepEqual(exp.prefix, ["exp-"]);
  assert.equal(exp.queueable, true);
});

test("snapshot: a stale resident override surfaces a registry warning", () => {
  const g = tmpGraph(Object.fromEntries([
    // override OLDER than seed -> graph still wins, but it is stale.
    schemaNode("schema-task", { node_type: "task", description: "STALE", prefix: ["task-"], queueable: true }, { version: "2026.06.10.1" }),
  ])).load();
  const snap = g.registry.snapshot();
  assert.ok(snap.stale_overrides.some((w) => w.includes("schema-task")), "stale override warned");
  assert.equal(snap.node_types.find((n) => n.type === "task").source, "graph");
});

// ---------------- renderers + present() dispatcher ----------------

test("renderOverview: lists node and edge tables and notes provenance", () => {
  const snap = graph.seedRegistry().snapshot();
  const text = schemaLib.renderOverview(snap);
  assert.match(text, /NODE TYPES/);
  assert.match(text, /EDGE TYPES/);
  assert.match(text, /seed pack/); // pure seed -> "(seed pack)"
  assert.match(text, /\btask\b/);
});

test("renderOverview({ only }): narrows to one table", () => {
  const snap = graph.seedRegistry().snapshot();
  const edges = schemaLib.renderOverview(snap, { only: "edges" });
  assert.match(edges, /EDGE TYPES/);
  assert.doesNotMatch(edges, /NODE TYPES/);
});

test("renderType: node detail shows flags, provenance, and hook source", () => {
  const snap = graph.seedRegistry().snapshot({ code: true });
  const text = schemaLib.renderType(snap, "task");
  assert.match(text, /task {3}\(node type\)/);
  assert.match(text, /schema-task @ /);
  assert.match(text, /flags:.*queueable/);
  assert.match(text, /function transitions/); // hook source inlined
  assert.equal(schemaLib.renderType(snap, "no-such-type"), null);
});

test("renderType: edge detail shows weight and inverse", () => {
  const snap = graph.seedRegistry().snapshot();
  const text = schemaLib.renderType(snap, "blocks");
  assert.match(text, /blocks {3}\(edge type\)/);
  assert.match(text, /weight: {6}0\.70/);
  assert.match(text, /inverse: {5}blocked-by/);
});

test("present: dispatches type/overview x human/json and the unknown-type error", () => {
  const snap = graph.seedRegistry().snapshot({ code: true });

  // overview json
  const ovJson = schemaLib.present(snap, { json: true });
  assert.equal(ovJson.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(ovJson.text)).sort(), [
    "alias_collisions", "default_edge_weight", "edge_types", "node_types", "policies", "queue_policy", "registers", "stale_overrides",
  ]);

  // single-type json -> just that entry
  const typeJson = schemaLib.present(snap, { type: "task", json: true });
  assert.equal(JSON.parse(typeJson.text).type, "task");

  // single-type human
  assert.match(schemaLib.present(snap, { type: "blocks" }).text, /edge type/);

  // unknown type -> stderr + code 1, both human and json
  const bad = schemaLib.present(snap, { type: "zzz" });
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, true);
  assert.equal(schemaLib.present(snap, { type: "zzz", json: true }).code, 1);
});

test("filterBySource: restricts entries to a provenance", () => {
  const g = tmpGraph(Object.fromEntries([
    schemaNode("schema-experiment", { node_type: "experiment", prefix: ["exp-"] }),
  ])).load();
  const snap = g.registry.snapshot();
  const graphOnly = schemaLib.filterBySource(snap, "graph");
  assert.deepEqual(graphOnly.node_types.map((n) => n.type), ["experiment"]);
  assert.equal(graphOnly.edge_types.length, 0);
  // native filter surfaces only the schema type
  assert.deepEqual(schemaLib.filterBySource(snap, "native").node_types.map((n) => n.type), ["schema"]);
});

// ---------------- the lib/schema.js CLI (exit codes) ----------------

test("CLI: overview exits 0, unknown type exits 1", () => {
  const { dir, nodesDir } = tmpGraph({});
  const ok = spawnSync(process.execPath, [SCHEMA_CLI, "--nodes", nodesDir], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Spor schema registry/);

  const bad = spawnSync(process.execPath, [SCHEMA_CLI, "--nodes", nodesDir, "zzz"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no node or edge type 'zzz'/);

  const json = spawnSync(process.execPath, [SCHEMA_CLI, "--nodes", nodesDir, "task", "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).type, "task");
  fs.rmSync(dir, { recursive: true, force: true });
});
