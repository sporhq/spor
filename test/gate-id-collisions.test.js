"use strict";

// Audit of the gate-minted id truncation (task-spor-audit-gate-truncation-
// collisions): `shortRunAttempt` cuts the run id to 8 chars and the stem/gate
// segments are capped, so the READABLE part of two ids can be identical. The
// identity is the trailing tuple hash over the full run key — these tests pin
// that every re-dispatch scenario (re-gate attempt, rescue pass, judged head,
// run ids sharing an 8-char prefix, over-long gate ids / stems) still mints a
// distinct id, since a collision is silently absorbed by `if_exists: skip`.

const test = require("node:test");
const assert = require("node:assert/strict");
const gr = require("../lib/shell/gate-runner.js");
const ir = require("../lib/shell/integration-runner.js");
const att = require("../lib/shell/attestation.js");

const RUNS = ["run-0001", "run0001", "run-0001-b", "run-00019999", "RUN-0001"];
const NODES = ["task-" + "a".repeat(40) + "-one", "task-" + "a".repeat(40) + "-two"];
const GATES = ["g".repeat(30) + "1", "g".repeat(30) + "2", "suite"];
const HEADS = [null, "a".repeat(40), "b".repeat(40)];

function assertDistinct(label, ids) {
  const seen = new Map();
  for (const [key, id] of ids) {
    assert.ok(!seen.has(id), `${label}: ${key} collides with ${seen.get(id)} on ${id}`);
    seen.set(id, key);
  }
}

test("gate fact ids stay distinct across attempts, rescue passes, heads, gates, nodes and runs", () => {
  const ids = [];
  for (const run of RUNS) for (const node of NODES) for (const gate of GATES) for (const head of HEADS)
    for (const attempt of [0, 2, 3]) for (const rescue of [0, 1, 2]) {
      ids.push([`${run}/${node}/${gate}/${head}/r${attempt}/x${rescue}`, gr.gateFactId(gate, node, run, attempt, rescue, head).toLowerCase()]);
    }
  // RUN-0001 and run-0001 differ only by case: the readable short folds case,
  // so they are the one deliberate equivalence — drop the uppercase spelling.
  assertDistinct("gate fact", ids.filter(([k]) => !k.startsWith("RUN-")));
});

test("rescue, integration and attestation ids stay distinct across attempts and run-id prefixes", () => {
  const runs = RUNS.filter((r) => r !== "RUN-0001");
  const rescue = [], merge = [], attest = [];
  for (const run of runs) for (const node of NODES) for (const attempt of [0, 2, 3]) {
    for (const n of [1, 2, 3]) rescue.push([`${run}/${node}/r${attempt}/x${n}`, gr.rescueFactId(node, run, attempt, n)]);
    for (const phase of [null, "proposed", "landed"]) merge.push([`${run}/${node}/r${attempt}/${phase}`, ir.integrationFactId(node, run, phase, attempt)]);
    attest.push([`${run}/${node}/r${attempt}`, att.attestationId(node, run, attempt)]);
  }
  assertDistinct("rescue", rescue);
  assertDistinct("merge", merge);
  assertDistinct("attest", attest);
});

test("the readable stem of two re-gate attempts may match, the full id never does", () => {
  const a = gr.gateFactId("suite", "task-x", "run-0001", 2);
  const b = gr.gateFactId("suite", "task-x", "run-0001", 3);
  assert.notEqual(a, b);
  assert.notEqual(gr.shortRunAttempt("run-0001", 2), gr.shortRunAttempt("run-0001", 3));
  // attempt 0 and 1 are the same first judgement by design (byte-identical)
  assert.equal(gr.gateFactId("suite", "task-x", "run-0001", 0), gr.gateFactId("suite", "task-x", "run-0001", 1));
});

test("a rescue pass of one attempt never reuses another attempt's key", () => {
  const keys = new Set();
  for (const attempt of [0, 2, 3]) for (const rescue of [0, 1, 2]) keys.add(gr.gateRunKey("run-0001", attempt, rescue));
  assert.equal(keys.size, 9);
});
