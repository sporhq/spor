// Zero-dependency test suite for the schema registry (lib/registry.js + the
// registry-aware parts of lib/graph.js). Run: node --test
//
// Covers: CalVer parse/compare, upgrade-chain validation, lazy applyUpgrades
// with synthetic schemas, schema-node parsing (json payload, preserved js
// code), seed-pack-equals-GRAPH.md integrity, override-vs-seed resolution,
// and registry-driven loadGraph/compile/validateGraph behavior.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const registry = require(path.join(__dirname, "..", "lib", "registry.js"));
const { sandboxFor } = require(path.join(__dirname, "..", "lib", "sandbox.js"));

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-test-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

// ---------- CalVer ----------

test("parseCalVer: accepts YYYY.MM.DD.MICRO and rejects malformed versions", () => {
  assert.deepEqual(registry.parseCalVer("2026.06.10.1"), { year: 2026, month: 6, day: 10, micro: 1 });
  assert.deepEqual(registry.parseCalVer("2026.12.31.42"), { year: 2026, month: 12, day: 31, micro: 42 });
  for (const bad of ["2026.6.10.1", "2026.06.10", "2026.13.01.1", "2026.06.32.1", "2026.06.10.0", "v1", "", null]) {
    assert.equal(registry.parseCalVer(bad), null, `should reject ${bad}`);
  }
});

test("compareCalVer: orders numerically per component (micro is not lexicographic)", () => {
  assert.equal(registry.compareCalVer("2026.06.10.1", "2026.06.10.1"), 0);
  assert.equal(registry.compareCalVer("2026.06.10.2", "2026.06.10.10"), -1); // 2 < 10
  assert.equal(registry.compareCalVer("2026.06.11.1", "2026.06.10.9"), 1);
  assert.equal(registry.compareCalVer("2025.12.31.99", "2026.01.01.1"), -1);
  assert.throws(() => registry.compareCalVer("nope", "2026.06.10.1"), /invalid CalVer/);
});

// ---------- upgrade chain validation ----------

test("validateUpgradeChain: accepts an ordered chain ending at schema_version", () => {
  const chain = [
    { from: "2026.06.01.1", to: "2026.06.05.1" },
    { from: "2026.06.05.1", to: "2026.06.10.2" },
  ];
  assert.deepEqual(registry.validateUpgradeChain(chain, "2026.06.10.2"), []);
  assert.deepEqual(registry.validateUpgradeChain([], "2026.06.10.2"), []);
  assert.deepEqual(registry.validateUpgradeChain(null, "2026.06.10.2"), []);
});

test("validateUpgradeChain: rejects non-forward, out-of-order, and dangling chains", () => {
  const backward = registry.validateUpgradeChain(
    [{ from: "2026.06.10.2", to: "2026.06.01.1" }], "2026.06.01.1");
  assert.ok(backward.some((e) => /not forward/.test(e)));

  const shuffled = registry.validateUpgradeChain([
    { from: "2026.06.05.1", to: "2026.06.10.2" },
    { from: "2026.06.01.1", to: "2026.06.05.1" },
  ], "2026.06.05.1");
  assert.ok(shuffled.some((e) => /chronological order/.test(e)));

  const dangling = registry.validateUpgradeChain(
    [{ from: "2026.06.01.1", to: "2026.06.05.1" }], "2026.06.10.2");
  assert.ok(dangling.some((e) => /!= schema_version/.test(e)));
});

// ---------- applyUpgrades (synthetic schemas; no seed schema has a chain) ----------

function widgetSchema() {
  return {
    id: "schema-widget", kind: "node-schema", version: "2026.06.10.3",
    payload: { node_type: "widget" },
    upgrades: [
      { from: "2026.06.01.1", to: "2026.06.05.1", fn: (n) => ({ color: n.colour ?? "blue" }) },
      { from: "2026.06.05.1", to: "2026.06.10.3", fn: (n) => ({ size: "medium" }) },
    ],
  };
}

test("applyUpgrades: unversioned node gets the whole chain, lazily stamped to current", () => {
  const node = { id: "widget-a", type: "widget", colour: "red" };
  const r = registry.applyUpgrades(node, widgetSchema());
  assert.deepEqual(r.applied, ["2026.06.05.1", "2026.06.10.3"]);
  assert.equal(r.node.color, "red");
  assert.equal(r.node.size, "medium");
  assert.equal(r.node.schema_version, "2026.06.10.3");
  assert.equal(node.schema_version, undefined, "input node must not be mutated");
});

test("applyUpgrades: mid-chain node only gets the remaining hops", () => {
  const node = { id: "widget-b", type: "widget", schema_version: "2026.06.05.1", color: "green" };
  const r = registry.applyUpgrades(node, widgetSchema());
  assert.deepEqual(r.applied, ["2026.06.10.3"]);
  assert.equal(r.node.color, "green", "first upgrade must not re-run");
  assert.equal(r.node.size, "medium");
});

test("applyUpgrades: node already at schema_version is a no-op", () => {
  const node = { id: "widget-c", type: "widget", schema_version: "2026.06.10.3" };
  const r = registry.applyUpgrades(node, widgetSchema());
  assert.deepEqual(r.applied, []);
  assert.equal(r.node, node);
});

test("applyUpgrades: forward-only — a node newer than the schema throws", () => {
  const node = { id: "widget-d", type: "widget", schema_version: "2027.01.01.1" };
  assert.throws(() => registry.applyUpgrades(node, widgetSchema()), /forward-only/);
});

test("applyUpgrades: empty chain with an older node just restamps the version", () => {
  const schema = { id: "schema-gadget", kind: "node-schema", version: "2026.06.10.1", payload: { node_type: "gadget" }, upgrades: [] };
  const r = registry.applyUpgrades({ id: "gadget-a", type: "gadget", schema_version: "2026.06.01.1" }, schema);
  assert.deepEqual(r.applied, []);
  assert.equal(r.node.schema_version, "2026.06.10.1");
});

test("applyUpgrades: markdown-attached upgrade code (no fn) throws instead of executing", () => {
  const schema = {
    id: "schema-widget", kind: "node-schema", version: "2026.06.10.1",
    payload: { node_type: "widget" },
    upgrades: [{ from: "2026.06.01.1", to: "2026.06.10.1", fnName: "upgrade1" }],
  };
  assert.throws(() => registry.applyUpgrades({ id: "widget-e", type: "widget" }, schema), /not executed/);
});

// ---------- schema-node parsing ----------

const TASK_OVERRIDE_MD = `---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Task schema override
summary: Org-local task schema overriding the seed pack entry for tasks.
date: 2026-06-10
---

Override body.

\`\`\`json
{
  "node_type": "task",
  "prefix": ["task-"],
  "queueable": true
}
\`\`\`

\`\`\`js
// validate(node, graph) — parsed and preserved, not executed in step 1
export function validate(node, graph) { return []; }
export function queueSignals(node, graph, activity) { return { age_days: 0 }; }
\`\`\`
`;

test("parseSchemaNode: extracts json payload and preserves (does not run) js code", () => {
  const n = graph.parseFrontmatter(TASK_OVERRIDE_MD, "schema-task.md");
  const r = registry.parseSchemaNode(n);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.schema.kind, "node-schema");
  assert.equal(r.schema.key, "task");
  assert.equal(r.schema.version, "2026.06.10.2");
  assert.deepEqual(r.schema.payload.prefix, ["task-"]);
  assert.equal(r.schema.payload.queueable, true);
  // code: preserved verbatim as strings, indexed by export name.
  assert.equal(typeof r.schema.code.validate, "string");
  assert.equal(typeof r.schema.code.queueSignals, "string");
  assert.match(r.schema.code.validate, /export function validate/);
  assert.equal(r.schema.codeBlocks.length, 1);
});

test("parseSchemaNode: rejects bad kind, bad CalVer, missing/broken payload, native type", () => {
  const make = (over, body) => {
    const base = { id: "schema-x", kind: "node-schema", schema_version: "2026.06.10.1",
      body: body ?? '```json\n{"node_type": "x"}\n```', ...over };
    return registry.parseSchemaNode(base);
  };
  assert.ok(make({ kind: "field-schema" }).errors.some((e) => /kind/.test(e)));
  assert.ok(make({ schema_version: "1.2.3" }).errors.some((e) => /CalVer/.test(e)));
  assert.ok(make({}, "no payload here").errors.some((e) => /json payload/.test(e)));
  assert.ok(make({}, '```json\n{not json}\n```').errors.some((e) => /does not parse/.test(e)));
  assert.ok(make({}, '```json\n{"edge_type": "x"}\n```').errors.some((e) => /missing node_type/.test(e)));
  assert.ok(make({}, '```json\n{"node_type": "schema"}\n```').errors.some((e) => /native/.test(e)),
    "redefining the schema type itself must be rejected (no schema-for-schemas regress)");
  assert.ok(make({ kind: "edge-schema" }, '```json\n{"edge_type": "zaps", "weight": "heavy"}\n```')
    .errors.some((e) => /weight must be a number/.test(e)));
});

// ---------- queue-policy kind (QUEUE.md §4/§8) ----------

test("parseSchemaNode: queue-policy kind parses to the singleton key, requires rank()", () => {
  const make = (body) => registry.parseSchemaNode({
    id: "schema-queue-policy", kind: "queue-policy", schema_version: "2026.06.11.1", body,
  });
  const ok = make('```json\n{"description": "org blend"}\n```\n\n```js\nexport function rank(items) { return {}; }\n```');
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(ok.schema.key, "queue-policy");
  assert.equal(typeof ok.schema.code.rank, "string");
  // a policy with no rank() export is inert by construction — reject it.
  const noRank = make('```json\n{}\n```\n\n```js\nexport function score() { return {}; }\n```');
  assert.ok(noRank.errors.some((e) => /rank\(\)/.test(e)));
});

test("Registry: queue-policy is a singleton slot with graph-beats-seed precedence", () => {
  const reg = new registry.Registry();
  const policy = (id, version) => ({
    id, kind: "queue-policy", version, key: "queue-policy",
    payload: {}, code: { rank: "export function rank() {}" }, codeBlocks: [], upgrades: [],
  });
  assert.equal(reg.add(policy("schema-qp-seed", "2026.06.11.5"), "seed"), true);
  assert.equal(reg.queuePolicy.id, "schema-qp-seed");
  // graph beats seed even at a lower version
  assert.equal(reg.add(policy("schema-qp-org", "2026.06.11.1"), "graph"), true);
  assert.equal(reg.queuePolicy.id, "schema-qp-org");
  // seed never displaces graph
  assert.equal(reg.add(policy("schema-qp-seed2", "2026.06.12.1"), "seed"), false);
  // within graph, higher version wins
  assert.equal(reg.add(policy("schema-qp-org2", "2026.06.12.1"), "graph"), true);
  assert.equal(reg.queuePolicy.id, "schema-qp-org2");
  // queue-policy does not register a node TYPE
  assert.equal(reg.isKnownType("queue-policy"), false);
});

// ---------- the org-defined policy layer (task-cc-policy-layer) ----------

test("parseSchemaNode: policy kind keys by id, requires gate(), validates governs", () => {
  const make = (id, body) => registry.parseSchemaNode({
    id, kind: "policy", schema_version: "2026.06.15.1", body,
  });
  const ok = make("policy-dod-quorum",
    '```json\n{"governs": {"types": ["task"], "projects": ["spor"]}}\n```\n\n' +
    '```js\nexport function gate(c, p, v) { return { allow: true }; }\n```');
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(ok.schema.kind, "policy");
  assert.equal(ok.schema.key, "policy-dod-quorum", "policy is keyed by its node id");
  assert.equal(typeof ok.schema.code.gate, "string");
  // a policy with no gate() export is inert by construction — reject it.
  const noGate = make("policy-x", '```json\n{"governs": {"types": ["task"]}}\n```\n\n```js\nexport function other() {}\n```');
  assert.ok(noGate.errors.some((e) => /gate\(\)/.test(e)));
  // governs must be an object of string arrays
  const badGov = make("policy-y", '```json\n{"governs": ["task"]}\n```\n\n```js\nexport function gate() { return {allow:true}; }\n```');
  assert.ok(badGov.errors.some((e) => /governs must be an object/.test(e)));
  const badTypes = make("policy-z", '```json\n{"governs": {"types": [1, 2]}}\n```\n\n```js\nexport function gate() { return {allow:true}; }\n```');
  assert.ok(badTypes.errors.some((e) => /governs\.types must be an array/.test(e)));
  // governs is OPTIONAL — an org-wide policy omits it (governs everything).
  const orgWide = make("policy-w", '```json\n{}\n```\n\n```js\nexport function gate() { return {allow:true}; }\n```');
  assert.equal(orgWide.ok, true, orgWide.errors.join("; "));
});

test("Registry.policiesFor: governs-traversal selects by type/project, most-specific-first", () => {
  const reg = new registry.Registry();
  const policy = (id, governs) => ({
    id, kind: "policy", version: "2026.06.15.1", key: id,
    payload: governs ? { governs } : {}, code: { gate: "export function gate(){}" },
    codeBlocks: [], upgrades: [],
  });
  reg.add(policy("policy-org-wide", null), "graph");                                  // governs all
  reg.add(policy("policy-tasks", { types: ["task"] }), "graph");                      // type-scoped
  reg.add(policy("policy-spor-tasks", { types: ["task"], projects: ["spor"] }), "graph"); // type+project
  reg.add(policy("policy-other-proj", { projects: ["meridian"] }), "graph");          // project-scoped, other proj

  // a spor task is governed by org-wide + task + spor-task (NOT the meridian one)
  const forSporTask = reg.policiesFor({ type: "task", project: "spor" }).map((p) => p.id);
  assert.deepEqual(forSporTask, ["policy-spor-tasks", "policy-tasks", "policy-org-wide"],
    "most-specific first: type+project (2) > type (1) > org-wide (0); meridian excluded");

  // a meridian decision is governed by org-wide + the meridian project policy only
  const forMerDec = reg.policiesFor({ type: "decision", project: "meridian" }).map((p) => p.id);
  assert.deepEqual(forMerDec.sort(), ["policy-org-wide", "policy-other-proj"]);

  // a node with no project still matches type-only and org-wide policies
  const noProj = reg.policiesFor({ type: "task" }).map((p) => p.id);
  assert.deepEqual(noProj.sort(), ["policy-org-wide", "policy-tasks"]);
});

test("Registry: a policy is keyed by id (many coexist) with graph-beats-seed precedence", () => {
  const reg = new registry.Registry();
  const policy = (id, version) => ({
    id, kind: "policy", version, key: id,
    payload: {}, code: { gate: "export function gate() {}" }, codeBlocks: [], upgrades: [],
  });
  // distinct ids coexist (NOT a singleton, unlike queue-policy)
  assert.equal(reg.add(policy("policy-a", "2026.06.15.1"), "graph"), true);
  assert.equal(reg.add(policy("policy-b", "2026.06.15.1"), "graph"), true);
  assert.equal(reg.policySchemas.size, 2);
  // same id: graph beats seed even at a lower version
  assert.equal(reg.add(policy("policy-a", "2026.06.16.1"), "seed"), false, "seed never displaces a graph policy");
  // within graph, higher version wins for the same id
  assert.equal(reg.add(policy("policy-a", "2026.06.16.1"), "graph"), true);
  assert.equal(reg.policySchemas.get("policy-a").version, "2026.06.16.1");
  // a policy does not register a node TYPE
  assert.equal(reg.isKnownType("policy-a"), false);
  // no policies present => policiesFor is [] (the no-policy-node path)
  assert.deepEqual(new registry.Registry().policiesFor({ type: "task" }), []);
});

test("seed pack ships NO policy (the no-policy-node default is byte-identical)", () => {
  // The policy layer is org-AUTHORED data resident in a graph, never a seed
  // default — so a graph with no policy node sees an empty policy set and every
  // existing path is unchanged (dec-spor-policy-layer-activate: additive).
  const reg = graph.seedRegistry();
  assert.equal(reg.policySchemas.size, 0);
  assert.deepEqual(reg.policiesFor({ type: "task", project: "spor" }), []);
});

// ---------- seed pack integrity: expresses GRAPH.md exactly ----------

test("seed pack: edge weights match the historic EDGE_WEIGHTS table exactly", () => {
  const reg = graph.seedRegistry();
  assert.deepEqual(reg.edgeWeights(), {
    "supersedes": 1.0, "constrained-by": 1.0, "governed-by": 0.95,
    "derived-from": 0.9, "decided-in": 0.9, "resolves": 0.9,
    "blocks": 0.7, "relates-to": 0.5, "mentions": 0.5,
    // Tier-2 question routing (38428bf) joined the seed after the historic
    // table froze: answers + the person-graph edges.
    "answers": 0.7, "assigned": 0.5, "stewards": 0.4, "routed-to": 0.3,
    // The workflow-run rollout added run lineage edges to the seed:
    // a run performs a workflow and is triggered-by its cause.
    "performs": 0.8, "triggered-by": 0.7,
    // The repo/project two-layer identity (dec-cc-repo-project-two-layer-
    // identity) added the structural membership edge: a repo is grouped-under
    // its home project. Weak association weight (structure, not work dependency).
    "grouped-under": 0.3,
    // Review as a graph object (task-spor-review-as-graph-object,
    // dec-spor-definition-of-done-org-policy) added the review-outcome edges:
    // reviewed-by/changes-requested-by carry a real verdict (0.5), an open
    // review-requested is routing wiring like routed-to (0.3).
    "reviewed-by": 0.5, "changes-requested-by": 0.5, "review-requested": 0.3,
    // Agent identity (dec-spor-agent-identity-nodes) added the ownership edge:
    // an agent is owned-by its person. Structural identity binding, not work
    // dependency — same low weight as grouped-under (0.3).
    "owned-by": 0.3,
    // The agent orchestration layer (dec-spor-agent-orchestration-layer) added
    // uses-profile: an agent → its default profile (the runtime+capability
    // bundle it dispatches under). Structural config binding like owned-by (0.3).
    "uses-profile": 0.3,
  });
  // provenance-only edges are known but unweighted (historic ?? 0.3 default)
  assert.equal(reg.isKnownEdge("compiled-for"), true);
  assert.equal(reg.isKnownEdge("shaped-by"), true);
  assert.equal(reg.edgeWeight("compiled-for"), 0.3);
  assert.equal(reg.edgeWeight("invented-edge"), 0.3);
});

test("seed pack: node types, prefixes, ride-along, and traversal match GRAPH.md", () => {
  const reg = graph.seedRegistry();
  for (const t of ["decision", "task", "issue", "incident", "artifact", "norm", "briefing", "correction"]) {
    assert.equal(reg.isKnownType(t), true, `${t} known`);
  }
  assert.equal(reg.isKnownType("contraption"), false);
  assert.deepEqual(reg.prefixesFor("artifact"), ["spec-", "art-"]);
  assert.deepEqual(reg.prefixesFor("incident"), ["inc-"]);
  // Two-layer identity (dec-cc-repo-project-two-layer-identity,
  // dec-cc-repo-project-id-prefix-scheme): git identity is `repo` (repo-),
  // the grouping above repos is `project` (proj-, the freed prefix).
  assert.equal(reg.isKnownType("repo"), true);
  assert.equal(reg.isKnownType("project"), true);
  assert.deepEqual(reg.prefixesFor("repo"), ["repo-"]);
  assert.deepEqual(reg.prefixesFor("project"), ["proj-"]);
  // Agent identity (dec-spor-agent-identity-nodes): a person-owned automation
  // principal, prefix agent-. Created deliberately (spor agent create), never
  // from a capture — capturable: false, like person/repo/workflow-run.
  assert.equal(reg.isKnownType("agent"), true);
  assert.deepEqual(reg.prefixesFor("agent"), ["agent-"]);
  assert.equal(reg.isCapturableType("agent"), false);
  assert.equal(reg.isCapturableEdge("owned-by"), false);
  // Agent orchestration layer (dec-spor-agent-orchestration-layer): the profile
  // (runtime+capability bundle, prefix profile-) and routine (owner-scoped
  // automation, prefix routine-) node types, plus the uses-profile edge. All
  // created deliberately, never from a capture — capturable: false, like agent.
  assert.equal(reg.isKnownType("profile"), true);
  assert.equal(reg.isKnownType("routine"), true);
  assert.deepEqual(reg.prefixesFor("profile"), ["profile-"]);
  assert.deepEqual(reg.prefixesFor("routine"), ["routine-"]);
  assert.equal(reg.isCapturableType("profile"), false);
  assert.equal(reg.isCapturableType("routine"), false);
  assert.equal(reg.isKnownEdge("uses-profile"), true);
  assert.equal(reg.isCapturableEdge("uses-profile"), false);
  // profile/routine carry no resolving-status declaration, so the partition is
  // unchanged (asserted exhaustively in the resolving-partition test below).
  assert.equal(reg.isAlwaysOn("norm"), true);
  assert.equal(reg.isAlwaysOn("decision"), false);
  assert.equal(reg.isTraversable("briefing"), false);
  assert.equal(reg.isTraversable("correction"), false);
  assert.equal(reg.isTraversable("decision"), true);
  assert.equal(reg.isTraversable("never-heard-of-it"), true, "unknown types traverse, as before");
});

test("seed pack: resolving partition reproduces {rejected, abandoned} + artifact stages", () => {
  // dec-spor-definition-of-done-org-policy: resolution.js no longer owns the
  // NON_RESOLVING table — it is compiled from each node-schema's
  // status.non_resolving. The seed must reproduce the historic set exactly,
  // plus the new artifact delivery non-resolving stages.
  const reg = graph.seedRegistry();
  assert.deepEqual([...reg.nonResolvingStatuses()].sort(),
    ["abandoned", "approved", "in-review", "rejected"]);
  // withdrawn statuses (the historic set) do not resolve
  assert.equal(reg.isResolvingStatus("rejected"), false);
  assert.equal(reg.isResolvingStatus("abandoned"), false);
  // in-review / approved keep the task live; merged / released retire it
  assert.equal(reg.isResolvingStatus("in-review"), false);
  assert.equal(reg.isResolvingStatus("approved"), false);
  assert.equal(reg.isResolvingStatus("merged"), true);
  assert.equal(reg.isResolvingStatus("released"), true);
  // empty / live / done statuses resolve, as before (byte-identical)
  assert.equal(reg.isResolvingStatus(""), true);
  assert.equal(reg.isResolvingStatus("active"), true);
  assert.equal(reg.isResolvingStatus("done"), true);
  // case-insensitive, matching the kernel's lowercasing
  assert.equal(reg.isResolvingStatus("In-Review"), false);
});

test("Registry: an org schema extends the resolving partition (no code change)", () => {
  const reg = graph.seedRegistry();
  const ok = reg.add({
    id: "schema-task", kind: "node-schema", version: "2026.07.01.1", key: "task",
    payload: { node_type: "task", status: { non_resolving: ["abandoned", "shelved"] } },
    code: {}, codeBlocks: [], upgrades: [],
  }, "graph");
  assert.equal(ok, true);
  assert.equal(reg.isResolvingStatus("shelved"), false, "org-added non-resolving status honored");
  assert.equal(reg.isResolvingStatus("rejected"), false, "other schemas' declarations still union in");
});

test("parseSchemaNode: rejects a malformed status.non_resolving", () => {
  const bad = registry.parseSchemaNode({
    id: "schema-x", kind: "node-schema", schema_version: "2026.06.15.1",
    body: '```json\n{"node_type":"x","status":{"non_resolving":[1,""]}}\n```',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /non_resolving must be an array of non-empty strings/.test(e)));
  const bad2 = registry.parseSchemaNode({
    id: "schema-y", kind: "node-schema", schema_version: "2026.06.15.1",
    body: '```json\n{"node_type":"y","status":["nope"]}\n```',
  });
  assert.ok(bad2.errors.some((e) => /status must be an object/.test(e)));
});

test("seed pack: the schema type itself is native — known, prefixed, traversable", () => {
  const reg = graph.seedRegistry();
  assert.equal(reg.isKnownType("schema"), true);
  assert.deepEqual(reg.prefixesFor("schema"), ["schema-"]);
  assert.equal(reg.isTraversable("schema"), true);
  assert.equal(reg.isAlwaysOn("schema"), false);
});

test("seed pack: back-compat constant exports are derived from the seed", () => {
  assert.deepEqual(graph.EDGE_WEIGHTS, graph.seedRegistry().edgeWeights());
  assert.ok(graph.KNOWN_TYPES.has("decision") && graph.KNOWN_TYPES.has("schema"));
  assert.ok(graph.KNOWN_EDGES.has("compiled-for"));
});

// ---------- register kind: the requires risk-class enum (thread 4) ----------

test("parseSchemaNode: register kind parses to its register name, validates classes", () => {
  const make = (body) => registry.parseSchemaNode({
    id: "schema-requires", kind: "register", schema_version: "2026.06.18.1", body,
  });
  const ok = make('```json\n{"register":"requires","classes":[{"id":"shell","description":"x"}]}\n```');
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(ok.schema.kind, "register");
  assert.equal(ok.schema.key, "requires"); // keyed by register name, not node_type
  // a register without a name is rejected
  assert.ok(make('```json\n{"classes":[]}\n```').errors.some((e) => /missing register name/.test(e)));
  // classes must be { id, description } objects with a non-empty id
  assert.ok(make('```json\n{"register":"requires","classes":["shell"]}\n```')
    .errors.some((e) => /classes must be an array of \{ id, description \}/.test(e)));
  assert.ok(make('```json\n{"register":"requires","classes":[{"description":"no id"}]}\n```')
    .errors.some((e) => /classes must be an array of \{ id, description \}/.test(e)));
});

test("seed pack: the requires register declares the seed risk classes", () => {
  const reg = graph.seedRegistry();
  assert.deepEqual(reg.registerClasses("requires"),
    ["shell", "prod-creds", "browser", "network", "human", "filesystem-write", "paid-api"]);
  assert.deepEqual([...reg.requiresClasses()].sort(),
    ["browser", "filesystem-write", "human", "network", "paid-api", "prod-creds", "shell"]);
  // an undeclared register is empty, never throws (a graph with neither the
  // register nor any requires: fields is unaffected — byte-identical)
  assert.deepEqual(reg.registerClasses("nope"), []);
  assert.equal(reg.register("nope"), null);
  assert.equal(reg.register("requires").description.length > 0, true);
});

test("Registry: a graph register schema overrides/extends the seed (no code change)", () => {
  const reg = graph.seedRegistry();
  const installed = reg.add({
    id: "schema-requires", kind: "register", version: "2026.07.01.1", key: "requires",
    payload: { register: "requires", classes: [{ id: "shell", description: "s" }, { id: "gpu", description: "g" }] },
    code: {}, codeBlocks: [], upgrades: [],
  }, "graph");
  assert.equal(installed, true, "graph beats seed");
  assert.deepEqual(reg.registerClasses("requires"), ["shell", "gpu"]);
  assert.equal(reg.requiresClasses().has("gpu"), true);
  // registers do not leak into the node/edge type vocabularies
  assert.equal(reg.isKnownType("requires"), false);
  assert.equal(reg.isKnownEdge("requires"), false);
});

// ---------- override-vs-seed resolution ----------

test("Registry.add: graph source beats seed regardless of version; higher CalVer wins within a source", () => {
  const reg = graph.seedRegistry();
  const seedBlocks = reg.edgeSchemas.get("blocks");
  const mk = (version, weight) => ({
    id: "schema-edge-blocks", kind: "edge-schema", version,
    key: "blocks", payload: { edge_type: "blocks", weight }, code: {}, codeBlocks: [], upgrades: [],
  });
  // older graph schema still beats the seed
  assert.equal(reg.add(mk("2026.01.01.1", 0.9), "graph"), true);
  assert.equal(reg.edgeWeight("blocks"), 0.9);
  // seed never reclaims a graph-owned entry
  assert.equal(reg.add({ ...seedBlocks }, "seed"), false);
  assert.equal(reg.edgeWeight("blocks"), 0.9);
  // within graph source, higher version wins; lower does not
  assert.equal(reg.add(mk("2026.06.10.1", 0.95), "graph"), true);
  assert.equal(reg.edgeWeight("blocks"), 0.95);
  assert.equal(reg.add(mk("2026.03.01.1", 0.2), "graph"), false);
  assert.equal(reg.edgeWeight("blocks"), 0.95);
});

// ---------- registry-aware loadGraph / compile / validateGraph ----------

const BASE_NODES = {
  "spec-a.md": `---
id: spec-a
type: artifact
title: Spec A
summary: The base spec other nodes relate to in this fixture.
date: 2026-06-01
---
Spec body.
`,
  "dec-b.md": `---
id: dec-b
type: decision
title: Decision B
summary: A decision weakly related to spec A.
date: 2026-06-02
edges:
  - {type: relates-to, to: spec-a}
---
Decision body.
`,
};

test("loadGraph: a graph-resident edge schema actually changes the traversal weight", () => {
  const before = tmpGraph(BASE_NODES).load();
  assert.equal(before.adj["dec-b"][0].weight, 0.5, "seed relates-to weight");

  const after = tmpGraph({
    ...BASE_NODES,
    "schema-edge-relates-to.md": `---
id: schema-edge-relates-to
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: relates-to override
summary: Org override raising relates-to to a strong association.
date: 2026-06-10
---

\`\`\`json
{
  "edge_type": "relates-to",
  "weight": 0.95
}
\`\`\`
`,
  }).load();
  assert.equal(after.adj["dec-b"][0].weight, 0.95, "overridden relates-to weight");
  assert.equal(after.registry.edgeWeight("relates-to"), 0.95);
  // and the override propagates to compile: 0.95 from a 1.0 root clears the
  // 0.6 full-body threshold that seed-weight 0.5 missed.
  const r = graph.compile(after, { rootId: "dec-b", digest: false });
  assert.match(r.text, /relates-to from dec-b, score 0\.95/);
});

test("loadGraph: a graph-resident node schema adds a new type with prefix and ride-along", () => {
  const fx = tmpGraph({
    ...BASE_NODES,
    "schema-runbook.md": `---
id: schema-runbook
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Runbook node type
summary: Org-specific runbook node type that rides along in every compile.
date: 2026-06-10
---

\`\`\`json
{
  "node_type": "runbook",
  "prefix": ["run-"],
  "always_on": true
}
\`\`\`
`,
    "run-restore.md": `---
id: run-restore
type: runbook
title: Restore runbook
summary: How to restore the service from a cold backup.
date: 2026-06-05
---
Restore steps.
`,
  });
  const g = fx.load();
  assert.equal(g.registry.isKnownType("runbook"), true);
  assert.deepEqual(g.registry.prefixesFor("runbook"), ["run-"]);
  // always_on: the runbook rides along in a compile it has no edges into.
  const r = graph.compile(g, { rootId: "dec-b", digest: false });
  assert.match(r.text, /## ORG NORMS \(always-on\)/);
  assert.match(r.text, /run-restore/);
  // and the validator no longer warns about the type.
  const v = graph.validateGraph(fx.nodesDir);
  assert.deepEqual(v.errors, []);
  assert.ok(!v.warnings.some((w) => /unknown type 'runbook'/.test(w)));
});

test("loadGraph: schema nodes are ordinary graph nodes (resident, traversable)", () => {
  const fx = tmpGraph({
    ...BASE_NODES,
    "schema-edge-relates-to.md": `---
id: schema-edge-relates-to
type: schema
kind: edge-schema
schema_version: 2026.06.10.2
title: relates-to override
summary: Org override of the relates-to edge weight.
date: 2026-06-10
---

\`\`\`json
{ "edge_type": "relates-to", "weight": 0.6 }
\`\`\`
`,
  });
  const g = fx.load();
  assert.ok(g.nodes["schema-edge-relates-to"], "schema node is resident in the graph");
  assert.ok(g.docs.some((d) => d.id === "schema-edge-relates-to"), "schema node participates in the content arm");
});

test("loadGraph: a malformed schema node throws (same strictness as malformed frontmatter)", () => {
  const fx = tmpGraph({
    ...BASE_NODES,
    "schema-broken.md": `---
id: schema-broken
type: schema
kind: node-schema
schema_version: not-calver
title: Broken schema
summary: A schema node whose version and payload are invalid.
date: 2026-06-10
---
No payload block at all.
`,
  });
  assert.throws(() => fx.load(), /invalid schema node/);
});

test("validateGraph: malformed schema node is an error; valid one is silent", () => {
  const bad = tmpGraph({
    ...BASE_NODES,
    "schema-broken.md": `---
id: schema-broken
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Broken schema
summary: Schema node with an unparseable payload.
date: 2026-06-10
---

\`\`\`json
{ this is not json }
\`\`\`
`,
  });
  const vBad = graph.validateGraph(bad.nodesDir);
  assert.ok(vBad.errors.some((e) => /schema-broken\.md: payload json block does not parse/.test(e)));

  const good = tmpGraph({ ...BASE_NODES, "schema-task.md": TASK_OVERRIDE_MD });
  const vGood = graph.validateGraph(good.nodesDir);
  assert.deepEqual(vGood.errors, []);
  assert.ok(!vGood.warnings.some((w) => /unknown type/.test(w)), "schema type is known, no unknown-type warning");
  // The override is at 2026.06.10.2 but the seed task schema is newer, so the
  // stale-shadow warning fires (issue-cc-schema-override-seed-shadow).
  assert.ok(
    vGood.warnings.some((w) => /schema 'schema-task'.*shadows a newer seed schema/.test(w)),
    "stale resident override is flagged"
  );
});

test("staleOverrides: a resident override below the seed version is flagged; at/above is silent", () => {
  // Seed task schema version (the bar a resident override must keep up with).
  const seedTask = graph.seedRegistry().nodeSchemas.get("task").version;
  const overrideAt = (ver) =>
    graph.parseFrontmatter(
      `---\nid: schema-task\ntype: schema\nkind: node-schema\nschema_version: ${ver}\n` +
        `title: Task override\nsummary: Org task override.\ndate: 2026-06-10\n---\n\nBody.\n\n` +
        '```json\n{ "node_type": "task", "prefix": ["task-"], "queueable": true }\n```\n',
      "schema-task.md"
    );

  // Strictly older than the seed -> shadow warning (graph still wins).
  const stale = graph.buildRegistry([overrideAt("2026.01.01.1")]);
  assert.deepEqual(stale.errors, []);
  assert.equal(stale.registry.nodeSchemas.get("task").source, "graph");
  assert.ok(
    stale.registry.staleOverrides().some((w) => /'schema-task'.*shadows a newer seed schema/.test(w)),
    "older resident override warns"
  );

  // At the seed version -> no shadow (override is current).
  const current = graph.buildRegistry([overrideAt(seedTask)]);
  assert.deepEqual(current.registry.staleOverrides(), [], "current override is silent");
});

test("validateNode: schema node structural + payload rules", () => {
  const n = graph.parseFrontmatter(TASK_OVERRIDE_MD, "schema-task.md");
  assert.equal(graph.validateNode(null, n).ok, true);

  const bad = graph.parseFrontmatter(`---
id: schema-bad
type: schema
kind: nonsense
schema_version: 2026.06.10.1
title: Bad
summary: Schema node with a bad kind and no payload.
date: 2026-06-10
---
body
`, "schema-bad.md");
  const r = graph.validateNode(null, bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /kind/.test(e)));
  assert.ok(r.errors.some((e) => /json payload/.test(e)));
});

test("no-schema graph behaves exactly as the seed pack (registry default)", () => {
  const g = tmpGraph(BASE_NODES).load();
  assert.equal(g.registry.edgeWeight("relates-to"), 0.5);
  assert.equal(g.registry.isAlwaysOn("norm"), true);
  assert.equal(g.registry.isTraversable("briefing"), false);
});

// dec-cc-status-enforcement-via-transitions: the seed capture-pending schema
// ships a transitions() gate restricting triage to merged/rejected. dismissed
// (issue-cc-dismissed-status-not-terminal) and the other historical drift
// values are denied at write time, with an actionable reason for retry.
test("seed pack: capture-pending transitions() gates triage to merged/rejected", () => {
  const schema = graph.seedRegistry().nodeSchemas.get("capture-pending");
  const sb = sandboxFor(schema);
  assert.deepEqual(sb.names, ["transitions"]);
  const SLACK = { timeoutMs: 5000 };
  const gate = (status) =>
    sb.call("transitions", [{ id: "cap-x", status: "" }, { id: "cap-x", status }, {}], SLACK);

  // allowed: the two terminal verdicts, an empty status (create / re-open),
  // and case-insensitively.
  for (const ok of ["merged", "rejected", "", "MERGED", "Rejected"]) {
    assert.equal(gate(ok).allow, true, `status '${ok}' should be allowed`);
  }
  // denied: the historical drift, each with a reason naming the valid set.
  for (const bad of ["dismissed", "resolved", "closed", "done"]) {
    const r = gate(bad);
    assert.equal(r.allow, false, `status '${bad}' should be denied`);
    assert.match(r.reason, /merged.*rejected|rejected.*merged/s);
    assert.match(r.reason, new RegExp(bad));
  }

  // the create path (no current node) is always allowed.
  assert.equal(sb.call("transitions", [undefined, { id: "cap-x" }, {}], SLACK).allow, true);
});

// dec-cc-status-enforcement-via-transitions: the core queueable/lifecycle
// types carry status-vocabulary gates. Each allows its valid set plus an empty
// status (status-less = live), denies anything else with a reason, and never
// blocks the create path.
test("seed pack: core type schemas gate status to their vocabulary", () => {
  const reg = graph.seedRegistry();
  const SLACK = { timeoutMs: 5000 };
  // A view that satisfies the completion-resolver gate (task done / issue
  // resolved), so this case isolates the VOCABULARY gate from the resolver one.
  const RESOLVED_VIEW = { resolvers: [{ id: "dec-x", type: "decision", status: "active" }] };
  const cases = {
    task: { ok: ["open", "active", "done", "abandoned", ""], bad: ["dismissed", "resolved", "merged", "wip"] },
    issue: { ok: ["open", "active", "resolved", ""], bad: ["dismissed", "done", "closed"] },
    decision: { ok: ["active", "superseded", "rejected", ""], bad: ["dismissed", "done", "resolved"] },
    question: { ok: ["open", "answered", ""], bad: ["dismissed", "resolved", "closed"] },
  };
  for (const [type, { ok, bad }] of Object.entries(cases)) {
    const sb = sandboxFor(reg.nodeSchemas.get(type));
    // Every gated type exports transitions(); task/issue/question additionally
    // carry the read-time get() enrichment hook (task-spor-schema-get-hook-readtime-
    // enrichment) — decision does not. Order-independent so a future verb add stays
    // a one-line change.
    const expectedExports = type === "decision" ? ["transitions"] : ["transitions", "get"];
    assert.deepEqual(sb.names.slice().sort(), expectedExports.slice().sort(), `${type} schema exports ${expectedExports.join("+")}`);
    const gate = (status, view = RESOLVED_VIEW) =>
      sb.call("transitions", [{ id: `${type}-x`, status: "" }, { id: `${type}-x`, status }, view], SLACK);
    for (const s of ok) assert.equal(gate(s).allow, true, `${type}: '${s}' should be allowed`);
    for (const s of bad) {
      const r = gate(s);
      assert.equal(r.allow, false, `${type}: '${s}' should be denied`);
      assert.match(r.reason, new RegExp(s), `${type}: reason should name the rejected value`);
    }
    // create path always allowed.
    assert.equal(sb.call("transitions", [undefined, { id: `${type}-x` }, RESOLVED_VIEW], SLACK).allow, true);
  }
});

test("seed pack: task done / issue resolved require a decision or artifact resolver", () => {
  const reg = graph.seedRegistry();
  const SLACK = { timeoutMs: 5000 };
  const gateFor = (type, terminal) => {
    const sb = sandboxFor(reg.nodeSchemas.get(type));
    return (view) => sb.call("transitions", [{ id: `${type}-x`, status: "active" }, { id: `${type}-x`, status: terminal }, view], SLACK);
  };
  for (const [type, terminal] of [["task", "done"], ["issue", "resolved"]]) {
    const gate = gateFor(type, terminal);
    const none = gate({ resolvers: [] });
    assert.equal(none.allow, false, `${type} ${terminal} denied without a resolver`);
    assert.match(none.reason, /decision or artifact/, `${type}: actionable reason`);
    assert.equal(gate({ resolvers: [{ id: "task-y", type: "task" }] }).allow, false, `${type}: a non-decision/artifact resolver does not satisfy the gate`);
    assert.equal(gate({ resolvers: [{ id: "dec-y", type: "decision" }] }).allow, true, `${type}: a decision resolver allows ${terminal}`);
    assert.equal(gate({ resolvers: [{ id: "art-y", type: "artifact" }] }).allow, true, `${type}: an artifact resolver allows ${terminal}`);
    assert.equal(gate(undefined).allow, false, `${type}: a missing view is treated as no resolver`);
  }
  // `abandoned` (task) is exempt — won't-do work produces nothing to record.
  const taskGate = gateFor("task", "abandoned");
  assert.equal(taskGate({ resolvers: [] }).allow, true, "abandoned needs no resolver");

  // dec-spor-definition-of-done-org-policy: the task done-gate reads the
  // registry's resolving partition off view.non_resolving_statuses. An in-review
  // change keeps the task live; a landed (merged) one allows done; an omitted
  // partition counts every resolver as before (backward-readable).
  const doneGate = gateFor("task", "done");
  const partition = [...reg.nonResolvingStatuses()];
  const inReview = doneGate({ resolvers: [{ id: "art-pr", type: "artifact", status: "in-review" }], non_resolving_statuses: partition });
  assert.equal(inReview.allow, false, "an in-review resolver does not allow done");
  assert.match(inReview.reason, /RESOLVING/);
  assert.equal(doneGate({ resolvers: [{ id: "art-pr", type: "artifact", status: "merged" }], non_resolving_statuses: partition }).allow, true,
    "a merged resolver allows done");
  assert.equal(doneGate({ resolvers: [{ id: "dec-y", type: "decision", status: "active" }], non_resolving_statuses: partition }).allow, true,
    "an active decision resolver allows done (active is resolving)");
  assert.equal(doneGate({ resolvers: [{ id: "dec-y", type: "decision" }] }).allow, true,
    "no partition on the view counts every resolver (backward-readable)");
});

// issue-spor-schema-authoring-docs-gap: GRAPH.md ships a complete, copy-pasteable
// worked example of a custom node schema (the `escalation` type) exercising BOTH
// attached hooks. This test extracts that example straight out of the doc and
// runs it through the same registry parser + sandbox the server uses, so the
// shipped example cannot rot and the documented validate()/transitions() return
// conventions are verified, not merely asserted in prose.
function workedExampleFromGraphMd() {
  const doc = fs.readFileSync(path.join(__dirname, "..", "GRAPH.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Authoring a custom schema"));
  // the worked example is the one ````markdown … ```` block in that section
  // (4-backtick fence wrapping a node whose body has 3-backtick json/js fences).
  const m = section.match(/````markdown\n([\s\S]*?)\n````/);
  assert.ok(m, "GRAPH.md must carry the ````markdown worked-example block");
  return m[1];
}

test("GRAPH.md worked schema example parses and its hooks run as documented", () => {
  const md = workedExampleFromGraphMd();
  const node = graph.parseFrontmatter(md, "schema-escalation.md");
  const r = registry.parseSchemaNode(node);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.schema.kind, "node-schema");
  assert.equal(r.schema.key, "escalation");
  assert.deepEqual(r.schema.payload.prefix, ["esc-"]);
  assert.equal(typeof r.schema.code.validate, "string");
  assert.equal(typeof r.schema.code.transitions, "string");

  const sb = sandboxFor(r.schema);
  const SLACK = { timeoutMs: 5000 };

  // validate(node) -> string[] ([] == ok), runs on every write.
  assert.deepEqual(sb.call("validate", [{ id: "esc-1", severity: "sev1" }], SLACK), [],
    "a valid severity passes validate()");
  assert.match(sb.call("validate", [{ id: "esc-1" }], SLACK)[0], /requires a severity/,
    "a missing severity is rejected");
  assert.match(sb.call("validate", [{ id: "esc-1", severity: "sev9" }], SLACK)[0], /invalid severity/,
    "an out-of-vocab severity is rejected");

  // transitions(current, proposed, view) -> { allow, reason? }, update-only.
  const gate = (status, view = {}) =>
    sb.call("transitions", [{ id: "esc-1", status: "open" }, { id: "esc-1", status }, view], SLACK);
  assert.equal(gate("").allow, true, "status-less (live) is allowed");
  assert.equal(gate("mitigated").allow, true, "a valid status is allowed");
  assert.equal(gate("bogus").allow, false, "an out-of-vocab status is denied");
  assert.match(gate("bogus").reason, /bogus/, "the denial names the bad value");
  assert.equal(gate("closed", { resolvers: [] }).allow, false, "closed needs a resolver");
  assert.match(gate("closed", { resolvers: [] }).reason, /decision or artifact/);
  assert.equal(gate("closed", { resolvers: [{ id: "dec-x", type: "decision" }] }).allow, true,
    "closed allowed once a decision resolver exists");
  // a status-less write is always allowed by the function; the server further
  // never even calls transitions() on create (it is update-only — store.js).
  assert.equal(sb.call("transitions", [undefined, { id: "esc-1" }, {}], SLACK).allow, true,
    "a status-less create is allowed");
});
