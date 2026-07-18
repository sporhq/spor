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

test("isTerminalStatus: graph-less and type-less callers read the fallback vocabulary", () => {
  // coupling.js (hook tool loop, no loaded graph) and single-node REST readers
  // pass no graph: they get TERMINAL_FALLBACK — the seed register's classes —
  // which excludes per-type statuses like released by construction.
  assert.equal(isTerminalStatus("done", null), true);
  assert.equal(isTerminalStatus("merged", "capture-pending"), true);
  assert.equal(isTerminalStatus("settled", "decision"), false);
  assert.equal(isTerminalStatus("released", "artifact"), false,
    "a graph-less caller cannot see per-type declarations (documented limitation)");
  assert.equal(isTerminalStatus("", null), false);
  assert.equal(isTerminalStatus(undefined, undefined), false);
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
