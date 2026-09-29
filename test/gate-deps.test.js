// The gate pipeline's and the integration stage's REAL deps, driven directly
// (task-spor-extract-make-gate-deps-to-lib-shell).
//
// lib/shell/gate-deps.js builds the `deps` objects gate-runner.js and
// integration-runner.js consume, over an injected host of CLI helpers. These
// tests build them against a FAKE host — every helper a stub that fails loudly
// if a path the test did not expect reaches it — so a closure's own behaviour
// (what it dispatches, what it pins, what it stamps) is the oracle, not the
// whole CLI. The run record and the git repo stay REAL: the claims here are
// about what lands on the record and which tree is pinned, which only real
// ones settle.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gateDeps = require("../lib/shell/gate-deps.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { loadConfig } = require("../lib/config.js");
const { gitEnv } = require("./helpers/git.js");

function fakeHost(overrides = {}) {
  const host = { GATE_DIFF_CAP_BYTES: 48 * 1024 };
  for (const name of gateDeps.HOST_FUNCTIONS) {
    host[name] = () => {
      throw new Error(`unexpected host call: ${name}`);
    };
  }
  return { ...host, ...overrides };
}

function scratchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gatedeps-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function cfgFor(home) {
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
}

function writeRecord(home, runId, extra = {}) {
  const p = dispatchRuns.runPaths(home, runId);
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: runId, node_id: "task-x", state: "done", ...extra }));
  return p.record;
}
const readRecord = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function realRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gatedeps-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv();
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore", env });
  g("config", "user.email", "t@t");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "trusted");
  g("checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  return { dir, g };
}

test("createGateDeps refuses a host missing a helper, naming it, before any dep is built", () => {
  const host = fakeHost();
  delete host.resolveNode;
  delete host.git;
  assert.throws(() => gateDeps.createGateDeps(host), /host is missing .*git.*resolveNode|host is missing .*resolveNode.*git/);
  assert.throws(() => gateDeps.createGateDeps({ ...fakeHost(), GATE_DIFF_CAP_BYTES: undefined }), /GATE_DIFF_CAP_BYTES/);
  const built = gateDeps.createGateDeps(fakeHost());
  assert.strictEqual(typeof built.makeGateDeps, "function");
  assert.strictEqual(typeof built.makeIntegrationDeps, "function");
});

// issue-spor-auto-route-reaches-fix-cycle-and-rescue-dispatches: a
// pipeline-internal dispatch never re-routes — this worker holds the lease and
// the gate on the item, so a standing dispatch.autoRoute must not hand a fix
// cycle to another box.
test("the gate fix cycle dispatches with the no-auto-route marker, forced, into the run's own checkout", async (t) => {
  const home = scratchHome(t);
  const runId = "33333333-3333-3333-3333-333333333333";
  const file = writeRecord(home, runId);
  const calls = [];
  const { makeGateDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id.replace(/^[a-z]+-/, ""),
      launchedFixRun: () => null,
      awaitGateRun: async (_cfg, id) => ({ ok: true, record: { run_id: id, state: "done", terminal_state: "reported" } }),
    })
  );
  const record = { cwd: "/tmp/the-run-checkout", run_id: runId, harness: "claude-code" };
  const entry = { run_id: runId, node_id: "task-x", project: "demo" };
  const deps = makeGateDeps(cfgFor(home), {
    record, entry, factory: { id: "factory-test", trustedRef: "main" }, slug: "demo",
    passthrough: { "permission-mode": "bypassPermissions" },
    warn: () => {}, sleep: async () => {}, log: () => {}, home,
    dispatch: async (_cfg, values, prompt) => {
      calls.push({ values, prompt });
      return { ok: true, run: { run_id: "fix-run-1" } };
    },
  });

  const out = await deps.fix({ gate: { id: "review", cycles: 2 }, cycle: 0, findings: [], detail: "the suite failed" });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.runId, "fix-run-1");
  assert.strictEqual(calls.length, 1);
  const { values } = calls[0];
  assert.strictEqual(values["no-auto-route"], true);
  assert.strictEqual(values.force, true);
  assert.strictEqual(values["no-worktree"], true);
  assert.strictEqual(values.node, "task-x");
  assert.strictEqual(values.dir, "/tmp/the-run-checkout", "no change set was read, so the fix lands in the record's own checkout");
  assert.strictEqual(values["permission-mode"], "bypassPermissions", "the worker's posture rides along");
  assert.match(values.name, /^fix-review-.+-0$/);
  assert.match(calls[0].prompt[0], /refused your resolution of task-x/);
  // The launch is stamped on the pipeline's own record BEFORE the long wait,
  // so an interrupted worker's record names the orphan fix run.
  const rec = readRecord(file);
  assert.strictEqual(rec.gate_fix_run_id, "fix-run-1");
  assert.strictEqual(rec.gate_fix_gate, "review");
  assert.strictEqual(rec.gate_fix_cycle, 0);
});

test("a fix cycle already launched under its name is adopted, never dispatched twice", async (t) => {
  const home = scratchHome(t);
  const runId = "44444444-4444-4444-4444-444444444444";
  writeRecord(home, runId);
  const logs = [];
  const { makeGateDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id,
      launchedFixRun: (_home, nodeId, name) => (nodeId === "task-x" && /^fix-review-/.test(name) ? { run_id: "already-running" } : null),
      awaitGateRun: async (_cfg, id) => ({ ok: true, record: { run_id: id, state: "done" } }),
    })
  );
  const deps = makeGateDeps(cfgFor(home), {
    record: { cwd: "/tmp/x", run_id: runId }, entry: { run_id: runId, node_id: "task-x" }, factory: { id: "f", trustedRef: "main" },
    passthrough: {}, warn: () => {}, sleep: async () => {}, log: (l) => logs.push(l), home,
    dispatch: async () => assert.fail("an adopted fix must not be dispatched"),
  });
  const out = await deps.fix({ gate: { id: "review", cycles: 2 }, cycle: 1, findings: [], detail: "" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.runId, "already-running");
  assert.ok(logs.some((l) => /adopting it, not dispatching again/.test(l)));
});

test("the integration stage's fix cycle carries the same no-auto-route marker", async (t) => {
  const home = scratchHome(t);
  const runId = "55555555-5555-5555-5555-555555555555";
  writeRecord(home, runId);
  const calls = [];
  const { makeIntegrationDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id,
      launchedFixRun: () => null,
      awaitGateRun: async (_cfg, id) => ({ ok: true, record: { run_id: id, state: "done" } }),
    })
  );
  const deps = makeIntegrationDeps(cfgFor(home), {
    record: { cwd: "/tmp/x", run_id: runId }, entry: { run_id: runId, node_id: "task-x" },
    factory: { id: "f", trustedRef: "main", integration: { targetRef: "main", mode: "local", strategy: "merge", command: "npm test", cycles: 2 } },
    passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
    dispatch: async (_cfg, values) => {
      calls.push(values);
      return { ok: true, run: { run_id: "int-fix-1" } };
    },
  });
  const out = await deps.fix({ cycle: 0, kind: "conflict", detail: "CONFLICT in a.txt" });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]["no-auto-route"], true);
  assert.strictEqual(calls[0].force, true);
  assert.match(calls[0].name, /^integration-fix-.+-0$/);
});

// pinCandidate against a real repo and a real run record, with the host's
// graph-facing helpers faked: the provenance names what the HOST reports (the
// agent, the producer's resolved profile), and a re-pin after a fix cycle
// moves the tip without re-minting the stage's own submission dimensions.
function pinDeps(t, { home, dir, runId, host = {}, warn = () => {} }) {
  const { makeGateDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id,
      gateChangeSet: (rec, ref) => gateRunner.gateChangeSet(rec, ref),
      refuseDirtyCandidate: () => null,
      dispatchAgentId: () => "agent-fake",
      candidateResolverFromReport: async (_cfg, _producer, _id, seen) => seen,
      ...host,
    })
  );
  return makeGateDeps(cfgFor(home), {
    record: { cwd: dir, run_id: runId, harness: "claude-code" },
    entry: { run_id: runId, node_id: "task-x", project: "demo" },
    factory: { id: "factory-test", trustedRef: "main" },
    slug: "demo", passthrough: {}, warn, sleep: async () => {}, log: () => {}, workerId: "worker-1", home,
  });
}

test("pinCandidate pins the checkout's tree with the host's provenance, then a fix cycle's re-pin moves the tip", async (t) => {
  const { dir, g } = realRepo(t);
  const home = scratchHome(t);
  const runId = "66666666-6666-6666-6666-666666666666";
  const file = writeRecord(home, runId, { resolved_profile: "profile-impl", harness: "claude-code" });
  const deps = pinDeps(t, { home, dir, runId });

  const change = await deps.changedPaths({ trustedRef: "main" });
  assert.strictEqual(change.ok, true, change.reason);
  const first = await deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(first.ok, true, first.reason);
  assert.strictEqual(first.change, "created");
  assert.strictEqual(first.candidate.tree, g("rev-parse", "HEAD^{tree}"));
  assert.strictEqual(first.candidate.provenance.agent, "agent-fake", "the agent is the host's answer");
  assert.strictEqual(first.candidate.provenance.profile, "profile-impl", "the producer's own resolved profile, not the worker's passthrough");
  assert.strictEqual(first.candidate.provenance.worker, "worker-1");
  assert.strictEqual(first.candidate.provenance.pool, "implementation");
  const afterFirst = readRecord(file);
  assert.strictEqual(afterFirst.impl_candidate.candidate_id, first.candidate.candidate_id);
  assert.strictEqual(afterFirst.impl_run_id, runId);
  assert.strictEqual(afterFirst.impl_pool, "implementation");

  // A fix cycle commits on top; its re-pin comes from a different producer run.
  fs.writeFileSync(path.join(dir, "c.txt"), "three\n");
  g("add", "-A");
  g("commit", "-q", "-m", "a fix cycle");
  writeRecord(home, "fix-run-9", { resolved_profile: "profile-fixer", harness: "codex" });
  await deps.changedPaths({ trustedRef: "main" });
  const second = await deps.pinCandidate({ submittedBy: { stage: "fix", cycle: 1, rescue: 0 }, runId: "fix-run-9" });
  assert.strictEqual(second.ok, true, second.reason);
  assert.notStrictEqual(second.change, "created");
  assert.strictEqual(second.candidate.tree, g("rev-parse", "HEAD^{tree}"), "the tip follows the fix's tree");
  assert.notStrictEqual(second.candidate.candidate_id, first.candidate.candidate_id);
  assert.strictEqual(second.candidate.provenance.run_id, "fix-run-9");
  assert.strictEqual(second.candidate.provenance.harness, "codex", "per-run provenance reads the producer's own record");
  assert.strictEqual(second.candidate.provenance.pool, null, "a fix cycle charges neither pool");
  const afterSecond = readRecord(file);
  assert.strictEqual(afterSecond.impl_candidate.candidate_id, second.candidate.candidate_id);
  assert.strictEqual(afterSecond.impl_run_id, runId, "the submission's own dimensions are untouched by the fixer's re-pin");
  assert.strictEqual(afterSecond.impl_pool, "implementation");
});

test("pinCandidate returns the host's require_clean refusal before reading anything", async (t) => {
  const home = scratchHome(t);
  const runId = "77777777-7777-7777-7777-777777777777";
  const file = writeRecord(home, runId);
  const seen = [];
  const deps = pinDeps(t, {
    home, dir: "/nonexistent-checkout", runId,
    host: {
      refuseDirtyCandidate: (factory, cwd) => {
        seen.push({ factory: factory.id, cwd });
        return { ok: false, reason: "candidate.require_clean refused the pin" };
      },
    },
  });
  const out = await deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.deepStrictEqual(out, { ok: false, reason: "candidate.require_clean refused the pin" });
  assert.deepStrictEqual(seen, [{ factory: "factory-test", cwd: "/nonexistent-checkout" }]);
  assert.strictEqual(readRecord(file).impl_candidate, undefined, "nothing was stamped");
});
