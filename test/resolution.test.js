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
