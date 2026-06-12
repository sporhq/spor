// Zero-dependency test suite for the attached-code sandbox (lib/sandbox.js,
// QUEUE.md §2.4 v1). Run: node --test
//
// The sandbox secures EXECUTION (escape, runaway, nondeterminism, leakage);
// the proposal-flow review gate secures semantics.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { createSandbox, sandboxFor } = require(path.join(__dirname, "..", "lib", "sandbox.js"));

test("sandbox: pure function runs, JSON in / JSON out", () => {
  const sb = createSandbox(`
export function validate(node) {
  const errors = [];
  if (!node.effort) errors.push("task needs an effort field");
  return errors;
}
export const helper = 42;
`);
  assert.deepEqual(sb.names.sort(), ["helper", "validate"]);
  assert.deepEqual(sb.call("validate", [{ id: "task-x" }]), ["task needs an effort field"]);
  assert.deepEqual(sb.call("validate", [{ id: "task-x", effort: "small" }]), []);
});

test("sandbox: host objects never enter, guest objects never leak (JSON boundary)", () => {
  const sb = createSandbox(`
export function probe(arg) {
  return { argIsPlain: Object.getPrototypeOf(arg) === Object.prototype, out: { nested: true } };
}
`);
  class Marker { constructor() { this.x = 1; } }
  const r = sb.call("probe", [new Marker()]);
  assert.equal(r.argIsPlain, true, "argument arrives as guest-realm plain data");
  assert.equal(Object.getPrototypeOf(r), Object.prototype, "result is a host-realm JSON clone");
});

test("sandbox: no require, no process, no Function-constructor escape", () => {
  const sb = createSandbox(`
export function tryRequire() { return typeof require; }
export function tryProcess() { return typeof process; }
export function tryEscape() { return ({}).constructor.constructor("return 1")(); }
`);
  assert.equal(sb.call("tryRequire", []), "undefined");
  assert.equal(sb.call("tryProcess", []), "undefined");
  assert.throws(() => sb.call("tryEscape", []), /Code generation from strings disallowed/);
});

test("sandbox: runaway code hits the timeout", () => {
  const sb = createSandbox(`export function spin() { while (true) {} }`);
  assert.throws(() => sb.call("spin", [], { timeoutMs: 50 }), /timed out/);
});

test("sandbox: no clock, no randomness", () => {
  const sb = createSandbox(`
export function clock() { return Date.now(); }
export function dice() { return Math.random(); }
`);
  assert.throws(() => sb.call("clock", []));
  assert.throws(() => sb.call("dice", []), /randomness/);
});

test("sandbox: guest prototype pollution cannot reach the host", () => {
  const sb = createSandbox(`
export function pollute() {
  try { Object.prototype.polluted = "yes"; } catch (e) { return "frozen: " + e.message; }
  return ({}).polluted || "frozen-silently";
}
`);
  const r = sb.call("pollute", []);
  assert.notEqual(r, "yes", "guest intrinsics are frozen");
  assert.equal({}.polluted, undefined, "host Object.prototype untouched");
});

test("sandbox: unknown export name is an error, not an eval", () => {
  const sb = createSandbox(`export function ok() { return 1; }`);
  assert.throws(() => sb.call("nope", []), /no attached export/);
  assert.throws(() => sb.call("ok; process.exit()", []), /no attached export/);
});

test("sandboxFor: memoizes per schema id+version", () => {
  const schema = {
    id: "schema-x", version: "2026.06.10.1",
    codeBlocks: [`export function f() { return 7; }`],
  };
  const a = sandboxFor(schema);
  const b = sandboxFor(schema);
  assert.equal(a, b, "same schema -> same compiled sandbox");
  assert.equal(a.call("f", []), 7);
  assert.equal(sandboxFor({ id: "schema-x", version: "2026.06.10.1", codeBlocks: [] }), null, "no code -> null");
});
