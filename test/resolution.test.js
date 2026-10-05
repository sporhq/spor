// Zero-dependency tests for lib/kernel/resolution.js — the resolution-map
// derivation (issue-cc-status-lags-resolution-edges). Run: node --test
//
// Covers task-spor-getnode-surface-resolution-on-terminal: the map entry now
// carries the RESOLVER's summary/title so a read surface can show WHAT
// resolved/answered a node, not just that something did.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolutionMap, resolutionOf, isTerminalStatus } = require("../lib/kernel/resolution.js");

function fixture() {
  return {
    supersededBy: {},
    nodes: {
      "question-x": { id: "question-x", type: "question", status: "answered", edges: [] },
      "task-y": { id: "task-y", type: "task", status: "open", edges: [] },
      "dec-ans": {
        id: "dec-ans", type: "decision", status: "active", date: "2026-06-18",
        title: "The answer", summary: "Ship ClickStack on Fly.",
        edges: [{ type: "answers", to: "question-x" }],
      },
      "dec-fix": {
        id: "dec-fix", type: "decision", status: "active", date: "2026-06-17",
        title: "The fix", summary: "Patched the exporter.",
        edges: [{ type: "resolves", to: "task-y" }],
      },
    },
  };
}

test("resolutionMap entries carry the resolver's summary and title", () => {
  const m = resolutionMap(fixture());
  assert.deepEqual(m["question-x"], {
    by: "dec-ans", edge: "answers", date: "2026-06-18",
    summary: "Ship ClickStack on Fly.", title: "The answer",
  });
  assert.deepEqual(m["task-y"], {
    by: "dec-fix", edge: "resolves", date: "2026-06-17",
    summary: "Patched the exporter.", title: "The fix",
  });
});

test("resolutionOf mirrors the map entry", () => {
  const g = fixture();
  assert.deepEqual(resolutionOf(g, "question-x"), resolutionMap(g)["question-x"]);
  assert.equal(resolutionOf(g, "no-such-node"), null);
});

// ---------- FALLBACK_NON_RESOLVING (issue-spor-fallback-non-resolving-
// missing-in-review) ----------
//
// A graph with NO registry (a hand-built fixture, or a graph-less caller)
// falls back to FALLBACK_NON_RESOLVING, which must match the seed registry's
// non-resolving partition: an in-review or approved artifact is a resolver
// still in flight and must not retire its target, exactly as a registry-
// backed reader (rankQueue against a real graph) already treats it.

test("resolutionMap: a registry-less in-review artifact resolver does not retire its target", () => {
  const g = fixture();
  g.nodes["art-pr"] = {
    id: "art-pr", type: "artifact", status: "in-review", date: "2026-09-27",
    title: "Draft fix", summary: "Still in review.",
    edges: [{ type: "resolves", to: "task-y" }],
  };
  // task-y already has a live resolver (dec-fix) in fixture(); drop it so the
  // in-review artifact is the ONLY inbound resolver and the assertion is
  // unambiguous.
  g.nodes["dec-fix"].status = "superseded";
  g.supersededBy["dec-fix"] = "art-pr"; // any truthy value marks it superseded
  const m = resolutionMap(g);
  assert.equal(m["task-y"], undefined, "an in-review resolver must not retire its target");
});

test("resolutionMap: a registry-less approved artifact resolver does not retire its target", () => {
  const g = fixture();
  g.nodes["art-pr"] = {
    id: "art-pr", type: "artifact", status: "approved", date: "2026-09-27",
    title: "Approved fix", summary: "Approved, not yet merged.",
    edges: [{ type: "resolves", to: "task-y" }],
  };
  g.nodes["dec-fix"].status = "superseded";
  g.supersededBy["dec-fix"] = "art-pr";
  const m = resolutionMap(g);
  assert.equal(m["task-y"], undefined, "an approved resolver must not retire its target");
});

test("resolutionMap: a registry-less merged artifact resolver still retires its target", () => {
  const g = fixture();
  g.nodes["art-pr"] = {
    id: "art-pr", type: "artifact", status: "merged", date: "2026-09-27",
    title: "Merged fix", summary: "Shipped.",
    edges: [{ type: "resolves", to: "task-y" }],
  };
  g.nodes["dec-fix"].status = "superseded";
  g.supersededBy["dec-fix"] = "art-pr";
  const m = resolutionMap(g);
  assert.equal(m["task-y"].by, "art-pr", "a merged resolver still retires its target (unaffected by the fix)");
});

test("a resolver missing summary/title yields null, not undefined", () => {
  const g = fixture();
  delete g.nodes["dec-ans"].summary;
  delete g.nodes["dec-ans"].title;
  const e = resolutionMap(g)["question-x"];
  assert.equal(e.summary, null);
  assert.equal(e.title, null);
});

// ---------- type-aware isTerminalStatus (task-spor-terminal-status-type-aware-
// migration, dec-spor-status-inert-third-partition) ----------
//
// isTerminalStatus(status, type, graph) reads the registry's per-type INERT
// overlay (declared status.inert, or — the inheritance default — the schema's
// status.terminal) UNIONED with the type-blind terminal-status register. The
// union is one-way additive: a per-type declaration scopes a status to its own
// type without removing a universal completion word.

// A minimal graph carrying the SEED registry — isTerminalStatus only reads
// graph.registry (and caches its vocabularies on the graph object).
function seedGraph() {
  const graphLib = require("../lib/graph.js");
  return { registry: graphLib.seedRegistry(), supersededBy: {}, nodes: {} };
}

test("isTerminalStatus: an org-scoped status is inert only for its own type (released)", () => {
  // The cross-type contamination pin the migration exists for: `released` is an
  // artifact delivery stage (schema-artifact status.terminal, inherited by its
  // inert overlay), NOT a universal completion word — a task or decision marked
  // `released` stays live instead of silently dying from the queue.
  const g = seedGraph();
  assert.equal(isTerminalStatus("released", "artifact", g), true, "released artifact retires");
  assert.equal(isTerminalStatus("released", "task", g), false, "released task stays live");
  assert.equal(isTerminalStatus("released", "decision", g), false, "released decision stays live");
  assert.equal(isTerminalStatus("released", "feature", g), false, "an undeclared org type stays live too");
});

test("isTerminalStatus: decision settled is terminal but NOT inert (the pinned exception)", () => {
  // dec-spor-decision-lifecycle-surfacing: a settled decision keeps surfacing
  // as live guidance — the decision schema declares inert explicitly to block
  // the inert-inherits-terminal default from swallowing `settled`.
  const g = seedGraph();
  assert.equal(isTerminalStatus("settled", "decision", g), false, "settled stays live");
  assert.equal(isTerminalStatus("superseded", "decision", g), true);
  assert.equal(isTerminalStatus("rejected", "decision", g), true);
  // The union with the type-blind register is additive — universal completion
  // words still retire a decision.
  assert.equal(isTerminalStatus("done", "decision", g), true);
});

test("isTerminalStatus: the inert-inherits-terminal default (correction applied)", () => {
  // schema-correction declares status.terminal [applied] and no inert set, so
  // its inert overlay inherits it: an applied correction is queue-liveness-dead
  // for its own type only.
  const g = seedGraph();
  assert.equal(isTerminalStatus("applied", "correction", g), true, "inherited from status.terminal");
  assert.equal(isTerminalStatus("applied", "task", g), false, "applied does not leak cross-type");
});

test("isTerminalStatus: legacy off-vocab closed is covered by the type-blind register", () => {
  // The orphan `closed` status (carried by 3 legacy capture-pending nodes in
  // the live graph) belongs to no schema's declared vocabulary — it is handled
  // by the type-blind terminal-status register, so those nodes stay retired
  // for ANY type. This is the documented legacy-fallback handling.
  const g = seedGraph();
  assert.equal(isTerminalStatus("closed", "capture-pending", g), true);
  assert.equal(isTerminalStatus("closed", "task", g), true);
  assert.equal(isTerminalStatus("closed", null, g), true, "even with no type at all");
});

test("isTerminalStatus: graph-less and type-less callers read the SEED registry", () => {
  // coupling.js (hook tool loop, no loaded graph) and single-node REST readers
  // pass no graph: they read the seed registry the kernel's fallback source
  // installs (task-spor-registry-sole-terminal-status-source) — the
  // terminal-status register AND the per-type partitions, with no
  // hand-mirrored table in between.
  assert.equal(isTerminalStatus("done", null), true);
  assert.equal(isTerminalStatus("merged", "capture-pending"), true);
  assert.equal(isTerminalStatus("settled", "decision"), false);
  assert.equal(isTerminalStatus("released", "artifact"), true,
    "a graph-less caller sees artifact's own seed partition");
  assert.equal(isTerminalStatus("released", "task"), false, "released does not leak cross-type");
  assert.equal(isTerminalStatus("released", null), false, "a type-less caller reads the type-blind register only");
  assert.equal(isTerminalStatus("", null), false);
  assert.equal(isTerminalStatus(undefined, undefined), false);
});

test("isTerminalStatus: a graph WITHOUT a registry reads the seed, same as a graph-less caller", () => {
  const bare = { nodes: {}, supersededBy: {} };
  assert.equal(isTerminalStatus("released", "artifact", bare), true);
  assert.equal(isTerminalStatus("dismissed", "finding", bare), true);
  assert.equal(isTerminalStatus("settled", "decision", bare), false);
});

test("the fallback vocabularies are VIEWS of the installed registry, not tables of their own", () => {
  // The drift guard that used to pin a hand-written TERMINAL_FALLBACK /
  // FALLBACK_NON_RESOLVING to the seed is gone because there is nothing left
  // to drift: install a different registry and every export follows it.
  const resolution = require("../lib/kernel/resolution.js");
  const { Registry } = require("../lib/kernel/registry.js");
  const reg = new Registry();
  const parsed = [
    { id: "schema-register-terminal-status", kind: "register", schema_version: "2026.01.01.1",
      body: "```json\n" + JSON.stringify({ register: "terminal-status", classes: [{ id: "finito" }] }) + "\n```" },
    { id: "schema-widget", kind: "node-schema", schema_version: "2026.01.01.1",
      body: "```json\n" + JSON.stringify({ node_type: "widget", prefix: ["w-"], status: { non_resolving: ["draft"], terminal: ["scrapped"] } }) + "\n```" },
  ].map((n) => require("../lib/kernel/registry.js").parseSchemaNode(n));
  for (const r of parsed) { assert.ok(r.ok, JSON.stringify(r.errors)); reg.add(r.schema, "seed"); }
  try {
    resolution.useFallbackRegistry(() => reg);
    assert.deepEqual([...resolution.terminalStatuses], ["finito"]);
    assert.deepEqual([...resolution.nonResolvingStatuses], ["draft"]);
    assert.equal(isTerminalStatus("finito", null), true);
    assert.equal(isTerminalStatus("done", null), false, "no seed word survives outside the registry");
    assert.equal(isTerminalStatus("scrapped", "widget"), true, "per-type partition from the installed registry");
    assert.equal(resolution.isGiveUpStatus("draft", "widget"), false, "non-resolving but not inert");
  } finally {
    require("../lib/shell/seed.js").installSeedFallback();
  }
  assert.equal(isTerminalStatus("done", null), true, "the seed source is restored");
});

test("isTerminalStatus: passing the graph as the second argument throws (stale-caller tripwire)", () => {
  // The pre-migration signature was (status, graph); silently treating a graph
  // object as a type would downgrade a stale caller to the fallback vocabulary.
  const g = seedGraph();
  assert.throws(() => isTerminalStatus("done", g), TypeError);
});

// ---------- isTerminalStatusOffline (issue-spor-type-blind-terminal-status-
// fallbacks) ----------
//
// The shell-layer (lib/graph.js) fix for the "graph-less and type-less
// callers read the fallback vocabulary" limitation documented above: a
// caller with no loaded graph (distill.js's session-lease cleanup, bin/
// spor.js's remote dispatch pre-flight) still has the SEED registry
// available offline, so it can see a per-type declaration like artifact
// `released` — the exact case the plain type-blind fallback misses.

test("isTerminalStatusOffline: sees a per-type SEED declaration a graph-less caller used to miss (released artifact)", () => {
  const { isTerminalStatusOffline } = require("../lib/graph.js");
  assert.equal(isTerminalStatusOffline("released", "artifact"), true,
    "the seed registry alone is enough to see artifact's own status.terminal/inert partition");
  assert.equal(isTerminalStatusOffline("released", "task"), false, "released does not leak cross-type");
  assert.equal(isTerminalStatusOffline("released", "decision"), false);
});

test("isTerminalStatusOffline: still unions the type-blind register (byte-identical for universal words)", () => {
  const { isTerminalStatusOffline } = require("../lib/graph.js");
  assert.equal(isTerminalStatusOffline("done", "task"), true);
  assert.equal(isTerminalStatusOffline("merged", "capture-pending"), true);
  assert.equal(isTerminalStatusOffline("closed", null), true, "the legacy off-vocab fallback still applies");
  assert.equal(isTerminalStatusOffline("settled", "decision"), false, "the pinned non-inert exception still holds");
  assert.equal(isTerminalStatusOffline("open", "task"), false);
});

test("isTerminalStatusOffline: matches isTerminalStatus(status, type, graph) against the live seed registry", () => {
  // Not a coincidence — isTerminalStatusOffline is exactly isTerminalStatus fed
  // { registry: seedRegistry() }, the same fixture seedGraph() above builds by
  // hand. Pin the equivalence so the two never silently drift apart.
  const graphLib = require("../lib/graph.js");
  const g = seedGraph();
  for (const [status, type] of [["released", "artifact"], ["released", "task"], ["settled", "decision"], ["done", "task"]]) {
    assert.equal(graphLib.isTerminalStatusOffline(status, type), isTerminalStatus(status, type, g), `${status}/${type}`);
  }
});

// ---------- isNodeInertOffline (issue-spor-type-blind-terminal-status-
// fallbacks) ----------
//
// The full tiered decision: a server-computed `inert` boolean (either value)
// wins outright over the offline seed-registry fallback — an explicit
// `false` is just as authoritative as `true`, since the server already
// evaluated the full type-aware partition (including graph-resident
// overrides) that the offline check can't see. Only when the caller has no
// boolean at all (no server response, or an older server) does the offline
// check run.

test("isNodeInertOffline: an explicit server `true` short-circuits, regardless of status/type", () => {
  const { isNodeInertOffline } = require("../lib/graph.js");
  // "archived"/"widget" is not terminal by ANY offline vocabulary — proves the
  // server verdict, not a lucky offline match, is what wins.
  assert.equal(isNodeInertOffline(true, "archived", "widget"), true);
});

test("isNodeInertOffline: an explicit server `false` overrules an offline-terminal status/type", () => {
  const { isNodeInertOffline } = require("../lib/graph.js");
  // released/artifact IS terminal per the offline seed-registry check alone
  // (pinned above) — the server's authoritative false must still win.
  assert.equal(isNodeInertOffline(false, "released", "artifact"), false,
    "an authoritative server false must not be second-guessed by the offline heuristic");
});

test("isNodeInertOffline: no server verdict (null/undefined) falls back to the offline check", () => {
  const { isNodeInertOffline } = require("../lib/graph.js");
  assert.equal(isNodeInertOffline(null, "released", "artifact"), true, "falls back and finds it terminal");
  assert.equal(isNodeInertOffline(undefined, "released", "task"), false, "falls back and finds it live");
});

test("isNodeInertOffline: a non-boolean explicit value (defensive) is treated as no verdict", () => {
  const { isNodeInertOffline } = require("../lib/graph.js");
  assert.equal(isNodeInertOffline("true", "released", "artifact"), true, "falls back to the offline check, which happens to agree here");
  assert.equal(isNodeInertOffline("true", "released", "task"), false, "falls back to the offline check, not truthy-coerced");
});

// ---------- the per-graph reverse index (task-spor-kernel-inbound-resolvers-reverse-index) ----------
//
// inboundResolvers and resolutionOf read a lazily-built, Symbol-keyed index
// of resolving edges instead of scanning every node per call. The oracle is
// the full scan they replaced: resolutionMap for resolutionOf, and a
// verbatim reference scan for inboundResolvers, over a graph exercising
// every filter (supersession, non-resolving status, answers onto a
// non-question, the hold, duplicate edges, dangling targets).

const resolution = require("../lib/kernel/resolution.js");
const INBOUND_INDEX = Symbol.for("spor.resolution.inbound-index");

function scanInbound(graph, id) {
  const target = graph.nodes[id];
  if (!target) return [];
  const nonResolving = resolution.fallbackRegistry().nonResolvingStatuses();
  const out = [];
  for (const r of Object.values(graph.nodes)) {
    if (graph.supersededBy[r.id]) continue;
    if (nonResolving.has((r.status || "").toLowerCase())) continue;
    for (const e of r.edges ?? []) {
      if (e.type !== "resolves" && e.type !== "answers") continue;
      if (e.to !== id) continue;
      if (e.type === "answers" && target.type !== "question") continue;
      out.push({ by: r.id, edge: e.type, type: r.type ?? null, status: r.status ?? null });
    }
  }
  return out;
}

function busyFixture() {
  const n = (id, type, status, edges = [], extra = {}) => ({ id, type, status, date: "2026-09-01", title: `T ${id}`, summary: `S ${id}`, edges, ...extra });
  return {
    supersededBy: { "dec-old": "dec-new" },
    nodes: {
      "task-a": n("task-a", "task", "open"),
      "task-held": n("task-held", "task", "open", [], { execution: "exec-1" }),
      "question-q": n("question-q", "question", "open"),
      "dec-old": n("dec-old", "decision", "active", [{ type: "resolves", to: "task-a" }]),
      "art-review": n("art-review", "artifact", "in-review", [{ type: "resolves", to: "task-a" }]),
      "dec-ans-task": n("dec-ans-task", "decision", "active", [{ type: "answers", to: "task-a" }]),
      "dec-new": n("dec-new", "decision", "active", [{ type: "supersedes", to: "dec-old" }, { type: "resolves", to: "task-a" }, { type: "resolves", to: "task-a" }]),
      "art-b": n("art-b", "artifact", "done", [{ type: "resolves", to: "task-a" }, { type: "answers", to: "question-q" }, { type: "resolves", to: "task-held" }, { type: "resolves", to: "task-gone" }]),
      "dec-c": n("dec-c", "decision", "active", [{ type: "relates-to", to: "task-a" }, { type: "answers", to: "question-q" }]),
    },
  };
}

test("reverse index: inboundResolvers and resolutionOf match the full scan for every id", () => {
  const g = busyFixture();
  const full = resolutionMap(g);
  for (const id of [...Object.keys(g.nodes), "task-gone", "nope"]) {
    assert.deepEqual(resolution.inboundResolvers(g, id), scanInbound(g, id), `inboundResolvers(${id})`);
    assert.deepEqual(resolutionOf(g, id), full[id] ?? null, `resolutionOf(${id})`);
  }
  // Spot-check the filters actually bit, so the parity above is not vacuous.
  assert.deepEqual(resolution.inboundResolvers(g, "task-a").map((r) => r.by), ["dec-new", "dec-new", "art-b"]);
  assert.equal(resolutionOf(g, "task-held"), null, "a held target has no resolution");
  assert.deepEqual(resolution.inboundResolvers(g, "task-held").map((r) => r.by), ["art-b"], "...but its inert resolver is listed");
  assert.equal(resolutionOf(g, "question-q").by, "art-b");
});

test("reverse index: built once per graph, read live for status, invisible to spread views", () => {
  const g = busyFixture();
  resolution.inboundResolvers(g, "task-a");
  const idx = g[INBOUND_INDEX];
  assert.ok(idx, "first call builds the index");
  assert.ok(!Object.keys(g).includes(INBOUND_INDEX) && !Object.getOwnPropertyDescriptor(g, INBOUND_INDEX).enumerable);
  resolutionOf(g, "question-q");
  assert.equal(g[INBOUND_INDEX], idx, "reused, not rebuilt");
  // A status flip is not an edge change: it is read live, no rebuild needed.
  g.nodes["art-b"].status = "rejected";
  assert.deepEqual(resolution.inboundResolvers(g, "task-a"), scanInbound(g, "task-a"));
  assert.equal(resolutionOf(g, "question-q").by, "dec-c");
  // A narrowed `{...graph, nodes}` view must not inherit the full index.
  const view = { ...g, nodes: { "task-a": g.nodes["task-a"], "dec-new": g.nodes["dec-new"] } };
  assert.equal(view[INBOUND_INDEX], undefined);
  assert.deepEqual(resolution.inboundResolvers(view, "task-a").map((r) => r.by), ["dec-new", "dec-new"]);
  // Swapping `nodes` wholesale on the same graph object rebuilds.
  g.nodes = { "task-a": g.nodes["task-a"] };
  assert.deepEqual(resolution.inboundResolvers(g, "task-a"), []);
});

test("reverse index: applyNode invalidates it, so a new resolves edge is seen", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const graph = require("../lib/graph.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-inbound-idx-"));
  const md = (id, type, extra = "") => `---\nid: ${id}\ntype: ${type}\ntitle: T ${id}\nsummary: S ${id}\ndate: 2026-09-01\nstatus: open\n${extra}---\nBody.\n`;
  try {
    fs.writeFileSync(path.join(dir, "task-z.md"), md("task-z", "task"));
    const g = graph.loadGraph(dir);
    assert.equal(resolutionOf(g, "task-z"), null);
    assert.ok(g[INBOUND_INDEX]);
    graph.applyNode(g, md("dec-z", "decision", "edges:\n  - {type: resolves, to: task-z}\n").replace("status: open", "status: active"), "dec-z.md");
    assert.equal(g[INBOUND_INDEX], undefined, "applyNode cleared the index");
    assert.equal(resolutionOf(g, "task-z").by, "dec-z");
    assert.deepEqual(resolution.inboundResolvers(g, "task-z").map((r) => r.by), ["dec-z"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateGraphSteps yields per unit of work and returns exactly validateGraph's result", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const graph = require("../lib/graph.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-validate-steps-"));
  const md = (id, type, extra = "") => `---\nid: ${id}\ntype: ${type}\ntitle: T ${id}\nsummary: S ${id}\n${extra}---\nBody.\n`;
  try {
    fs.writeFileSync(path.join(dir, "task-a.md"), md("task-a", "task", "date: 2026-09-01\nedges:\n  - {type: blocks, to: task-missing}\n"));
    fs.writeFileSync(path.join(dir, "task-b.md"), md("task-b", "task"));
    fs.writeFileSync(path.join(dir, "task-c.md"), md("task-wrong", "task", "date: 2026-09-01\n"));
    const it = graph.validateGraphSteps(dir);
    let r, steps = 0;
    while (!(r = it.next()).done) { assert.equal(r.value, undefined); steps++; }
    assert.ok(steps >= 3 * 2, `yields at least per file read and per file lint (got ${steps})`);
    assert.deepEqual(r.value, graph.validateGraph(dir));
    assert.ok(r.value.errors.length && r.value.warnings.length, "the fixture exercises both severities");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
