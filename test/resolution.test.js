// Zero-dependency tests for lib/kernel/resolution.js — the resolution-map
// derivation (issue-cc-status-lags-resolution-edges). Run: node --test
//
// Covers task-spor-getnode-surface-resolution-on-terminal: the map entry now
// carries the RESOLVER's summary/title so a read surface can show WHAT
// resolved/answered a node, not just that something did.

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolutionMap, resolutionOf } = require("../lib/kernel/resolution.js");

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
