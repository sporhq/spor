// ADOPT-BY-NAME AT THE DISPATCH DOOR (bin/spor.js `dispatchThrough`,
// dec-spor-adopt-by-name-returns-existing, task-spor-gate-pipeline-as-
// workflow-kernel). The work loop's one dispatch door — every review, fix,
// rescue, implementer and integration-fix launch goes through it — returns
// the run already launched under a name and launches nothing, so a dispatch
// re-executed in the durable-workflow kernel's at-least-once window (the
// crash between a launch and its journal append) is idempotent at the door
// rather than by each caller remembering to look first. The oracle is the
// `cmdDispatch` seam: adopted means it was never called.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const spor = require("../bin/spor.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { loadConfig } = require("../lib/config.js");

function scratchHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-adopt-door-"));
}
function cfgFor(home) {
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
}
function writeRun(home, runId, extra = {}) {
  const p = dispatchRuns.runPaths(home, runId);
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: runId, node_id: "task-x", state: "running", harness: "codex", created_at: "2026-10-01T00:00:00.000Z", ...extra }));
}
function fakeDispatch(calls) {
  return async (_cfg, { values }, ctx) => {
    calls.push(values);
    ctx.onLaunch({ run_id: "fresh-run", harness: "codex" });
    return 0;
  };
}

test("a named dispatch whose run this box already launched is ADOPTED: the run is returned, cmdDispatch is never called", async () => {
  const home = scratchHome();
  writeRun(home, "11111111-1111-1111-1111-111111111111", { name: "fix-review-abcd1234-1" });
  const calls = [];
  const out = await spor.dispatchThrough(cfgFor(home), { name: "fix-review-abcd1234-1", node: "task-x", force: true }, ["fix it"], { cmdDispatch: fakeDispatch(calls) });
  assert.deepEqual(out, { ok: true, run: { run_id: "11111111-1111-1111-1111-111111111111", harness: "codex", adopted: true }, adopted: true });
  assert.deepEqual(calls, []);
});

test("a review dispatch names no node: it is adopted on the name alone, and a run of the same name bound to a node is still that name's run", async () => {
  const home = scratchHome();
  writeRun(home, "22222222-2222-2222-2222-222222222222", { name: "gate-review-abcd1234-0", node_id: null });
  const calls = [];
  const out = await spor.dispatchThrough(cfgFor(home), { name: "gate-review-abcd1234-0", "read-only": true }, ["review it"], { cmdDispatch: fakeDispatch(calls) });
  assert.equal(out.adopted, true);
  assert.equal(out.run.run_id, "22222222-2222-2222-2222-222222222222");
  assert.deepEqual(calls, []);
});

test("a name bound to a DIFFERENT node is not this dispatch's run: the launch proceeds", async () => {
  const home = scratchHome();
  writeRun(home, "33333333-3333-3333-3333-333333333333", { name: "fix-review-abcd1234-1", node_id: "task-other" });
  const calls = [];
  const out = await spor.dispatchThrough(cfgFor(home), { name: "fix-review-abcd1234-1", node: "task-x" }, ["fix it"], { cmdDispatch: fakeDispatch(calls) });
  assert.deepEqual(out, { ok: true, run: { run_id: "fresh-run", harness: "codex" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "fix-review-abcd1234-1");
});

test("a nameless dispatch, or one whose name nothing here was launched under, takes no part in adoption", async () => {
  const home = scratchHome();
  writeRun(home, "44444444-4444-4444-4444-444444444444", { name: "fix-review-abcd1234-1" });
  for (const values of [{ node: "task-x" }, { name: "", node: "task-x" }, { name: "fix-review-abcd1234-2", node: "task-x" }]) {
    const calls = [];
    const out = await spor.dispatchThrough(cfgFor(home), values, ["go"], { cmdDispatch: fakeDispatch(calls) });
    assert.equal(out.ok, true);
    assert.equal(out.adopted, undefined, JSON.stringify(values));
    assert.equal(out.run.run_id, "fresh-run");
    assert.equal(calls.length, 1);
  }
});

test("launchedRunNamed is fail-open on an unreadable run journal: no adoption, never a throw", () => {
  const home = scratchHome();
  const runs = path.join(home, "journal", "dispatch");
  fs.mkdirSync(path.dirname(runs), { recursive: true });
  fs.writeFileSync(runs, "not a directory");
  assert.equal(spor.launchedRunNamed(home, { node: "task-x", name: "fix-x" }), null);
});
