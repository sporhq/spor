// Every durable write the gate pipeline makes passes ONE owner guard
// (issue-spor-pipeline-completion-writers-unfenced). The settle and the launch
// stamps were already fenced on the pipeline lease (test/gate-stamp-lease-
// owner.test.js); this file covers the rest of what a displaced driver could
// still write: the parent workflow's split-verdict stamps and completion
// writes (stampCompletionState / stampImplState's `own`, makeCompletionDeps'
// `own`), the gate and integration deps' graph writers (recordFact,
// parkForReview, escalate, … — guardPipelineWriters), and, end to end, a
// driver whose lease is taken over mid-gate: A writes nothing more — no fact,
// no completion, no journal entry — and B, driving the same attempt, lands
// all of it. The static half is R10 of test/record-write-lint.test.js.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gateDeps = require("../lib/shell/gate-deps.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const sp = require("../lib/shell/stage-projection.js");
const gates = require("../lib/kernel/gates.js");
const { loadConfig } = require("../lib/config.js");
const { gitEnv } = require("./helpers/git.js");

const RUN = "88888888-aaaa-bbbb-cccc-dddddddddddd";

function scratchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-writer-owner-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function cfgFor(home) {
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
}

function fakeHost(overrides = {}) {
  const host = { GATE_DIFF_CAP_BYTES: 48 * 1024 };
  for (const name of gateDeps.HOST_FUNCTIONS) {
    host[name] = () => {
      throw new Error(`unexpected host call: ${name}`);
    };
  }
  return { ...host, ...overrides };
}

// Worker A claimed the pipeline, its lease EXPIRED (a stalled pass), and
// worker B then claimed it. Returns both tokens and the record path.
function takenOver(home, extra = {}) {
  const file = dispatchRuns.runPaths(home, RUN).record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ run_id: RUN, node_id: "task-x", state: "done", terminal_state: "resolved", cwd: "/tmp/the-run-checkout", ...extra }));
  const t0 = Date.now() - 2 * sp.PIPELINE_LEASE_TTL_MS;
  const a = dispatchRuns.claimPipeline(home, RUN, { workerId: "worker-a", factory: "factory-test", ownerLive: () => true, nowMs: () => t0 });
  assert.strictEqual(a.ok, true, a.refused);
  const b = dispatchRuns.claimPipeline(home, RUN, { workerId: "worker-b", factory: "factory-test", ownerLive: () => true });
  assert.strictEqual(b.ok, true, b.refused);
  assert.strictEqual(sp.pipelineLease(home, { run_id: RUN }).token, b.token);
  return { file, a: a.token, b: b.token };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const lost = (e) => e && e.code === "PIPELINE_OWNER_LOST";

test("assertPipelineOwner: A's displaced token and an owner-less driver throw PipelineOwnerLost; B passes; a run with no record has nothing to protect", (t) => {
  const home = scratchHome(t);
  const { a, b } = takenOver(home);
  assert.throws(() => dispatchRuns.assertPipelineOwner(home, RUN, a), (e) => lost(e) && /worker worker-b/.test(e.message));
  assert.throws(() => dispatchRuns.assertPipelineOwner(home, RUN, null), lost, "no token never writes over a claimed pipeline");
  assert.strictEqual(dispatchRuns.assertPipelineOwner(home, RUN, b), true);
  assert.strictEqual(dispatchRuns.assertPipelineOwner(home, "no-such-run", a), true);
  // A record that EXISTS but cannot be read owns nobody — not even its holder.
  fs.writeFileSync(dispatchRuns.runPaths(home, RUN).record, "{ torn");
  assert.throws(() => dispatchRuns.assertPipelineOwner(home, RUN, b), (e) => lost(e) && /could not be read/.test(e.message));
});

test("the completion and impl stamps decide ownership under the record lock: A's split verdict, debt and candidate are refused, B's land, and the unowned door is unchanged", (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const refused = dispatchRuns.stampCompletionState(home, RUN, { gates_state: "passed", integration_state: "landed", completion_debt: "write" }, { own: a });
  assert.match(refused.owner_refused, /worker-b/);
  for (const k of ["gates_state", "integration_state", "completion_debt"]) assert.strictEqual(read(file)[k], undefined, `A's ${k} did not land`);
  const impl = dispatchRuns.stampImplState(home, RUN, { impl_candidate: { tree: "a-tree" } }, { own: a });
  assert.match(impl.owner_refused, /worker-b/);
  assert.strictEqual(read(file).impl_candidate, undefined);
  assert.ok(dispatchRuns.stampCompletionState(home, RUN, { gates_state: "failed" }, { own: null }).owner_refused, "an owner-less driver is refused on a claimed pipeline");
  dispatchRuns.stampCompletionState(home, RUN, { gates_state: "passed", integration_state: "landed" }, { own: b });
  dispatchRuns.stampImplState(home, RUN, { impl_candidate: { tree: "b-tree" } }, { own: b });
  assert.strictEqual(read(file).gates_state, "passed");
  assert.strictEqual(read(file).integration_state, "landed");
  assert.deepStrictEqual(read(file).impl_candidate, { tree: "b-tree" });
  // No `own` key at all: the per-pass reconcile's door, as before.
  dispatchRuns.stampCompletionState(home, RUN, { completion_note: "reconciled" });
  assert.strictEqual(read(file).completion_note, "reconciled");
});

test("the pipeline's completion deps (makeCompletionDeps `own`): A's resolver, edge, item CAS and debt stamp all throw before they write — writeCompletion itself is refused — while B's land", async (t) => {
  const home = scratchHome(t);
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const { file, a, b } = takenOver(home, { impl_claim: { execution_id: "exec-a", completion: { after: "gates" } } });
  const sporCli = require("../bin/spor.js");
  const cfg = cfgFor(home);
  const resolver = (id) => `---\nid: ${id}\ntype: artifact\nproject: demo\ntitle: Resolver\nsummary: A completion resolver.\ndate: 2026-10-04\n---\n\nBody.\n`;
  const depsA = sporCli.makeCompletionDeps(cfg, { home, runId: RUN, own: a });
  await assert.rejects(async () => depsA.writeNode("art-completion-a", resolver("art-completion-a")), lost);
  await assert.rejects(async () => depsA.addEdge("art-completion-a", "resolves", "task-x"), lost);
  await assert.rejects(async () => depsA.removeEdge("art-completion-a", "resolves", "task-x"), lost);
  await assert.rejects(async () => depsA.casWrite({ nodeId: "task-x", revision: "r", raw: "---\nid: task-x\n---\n" }), lost);
  assert.throws(() => depsA.stamp({ completion_debt: "write" }), lost);
  assert.throws(() => depsA.stampImpl({ impl_candidate: { tree: "a" } }), lost);
  assert.ok(!fs.existsSync(path.join(home, "nodes", "art-completion-a.md")), "A wrote no resolver");
  const completionShell = require("../lib/shell/completion.js");
  await assert.rejects(completionShell.writeCompletion({ record: read(file), deps: depsA, facts: [], boundary: "gates" }), lost);
  assert.strictEqual(read(file).completion_debt, undefined, "A owed nothing onto B's record");
  // B, the holder: the same doors write.
  const depsB = sporCli.makeCompletionDeps(cfg, { home, runId: RUN, own: b });
  const wrote = await depsB.writeNode("art-completion-b", resolver("art-completion-b"));
  assert.strictEqual(wrote.ok, true, wrote.reason);
  assert.ok(fs.existsSync(path.join(home, "nodes", "art-completion-b.md")));
  depsB.stamp({ completion_debt: "write" });
  assert.strictEqual(read(file).completion_debt, "write");
});

function integrationDepsFor(home, gateOwner, calls) {
  const { makeIntegrationDeps } = gateDeps.createGateDeps(
    fakeHost({
      gateStem: (id) => id,
      gateIdSuffix: () => "abc123",
      proposalTrackingId: (nodeId, runId) => `task-proposal-${nodeId}-${String(runId).slice(0, 8)}`,
      buildProposalTrackingNode: ({ id }) => `---\nid: ${id}\n---\n`,
      buildGateWorkNode: ({ id }) => `---\nid: ${id}\n---\n`,
      writeGateNode: async (_cfg, id) => (calls.push(`write:${id}`), { ok: true }),
      gateDemoteItem: async (_cfg, id) => (calls.push(`demote:${id}`), { ok: true, demoted: true }),
      mainCheckoutOf: (dir) => dir,
    })
  );
  return makeIntegrationDeps(cfgFor(home), {
    record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
    factory: { id: "factory-test", trustedRef: "main", integration: { targetRef: "origin/main", mode: "propose", strategy: "merge", command: "npm test", cycles: 2 } },
    slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
  });
}

test("the integration deps' graph writers (recordFact, parkForReview, escalate, demote, land): A's each throw before the write, B's land", async (t) => {
  const home = scratchHome(t);
  const { file, a, b } = takenOver(home);
  const callsA = [];
  const depsA = integrationDepsFor(home, a, callsA);
  const proposal = { number: 7, repo: "o/r", url: "https://example.invalid/pr/7", branch: "impl", targetSha: "abc" };
  await assert.rejects(async () => depsA.recordFact({ id: "art-merge-x", markdown: "---\nid: art-merge-x\n---\n" }), lost);
  await assert.rejects(async () => depsA.parkForReview({ proposal }), lost);
  await assert.rejects(async () => depsA.escalate({ attempts: [{ verdict: "failed", detail: "suite failed" }], detail: "suite failed", evidence: "" }), lost);
  await assert.rejects(async () => depsA.demote({ blockerId: "task-integration-x" }), lost);
  assert.throws(() => depsA.land({ top: "/nowhere", targetRef: "main", sha: "x", expected: "y" }), lost, "a land is refused before it touches the ref");
  await assert.rejects(async () => depsA.dispatchFix({ cycle: 0, kind: "conflict", detail: "CONFLICT in a.txt" }), lost, "no fixer is launched into the holder's checkout");
  assert.deepStrictEqual(callsA, [], "A reached no graph write");
  assert.strictEqual(read(file).gate_proposal_number, undefined);
  const callsB = [];
  const depsB = integrationDepsFor(home, b, callsB);
  assert.strictEqual((await depsB.recordFact({ id: "art-merge-x", markdown: "---\nid: art-merge-x\n---\n" })).ok, true);
  assert.strictEqual((await depsB.parkForReview({ proposal })).ok, true);
  assert.strictEqual((await depsB.escalate({ attempts: [{ verdict: "failed", detail: "suite failed" }], detail: "suite failed", evidence: "" })).ok, true);
  assert.strictEqual((await depsB.demote({ blockerId: "task-integration-x" })).ok, true);
  assert.deepStrictEqual(callsB.map((c) => c.split(":")[0]), ["write", "write", "write", "demote"]);
  assert.strictEqual(read(file).gate_proposal_number, 7);
});

test("the gate deps' graph writers (recordFact, escalate, fileHumanItem, demote): A's each throw before the write, B's land", async (t) => {
  const home = scratchHome(t);
  const { a, b } = takenOver(home);
  const make = (gateOwner, calls) =>
    gateDeps
      .createGateDeps(
        fakeHost({
          gateStem: (id) => id,
          gateIdSuffix: () => "abc123",
          buildGateWorkNode: ({ id }) => `---\nid: ${id}\n---\n`,
          writeGateNode: async (_cfg, id) => (calls.push(`write:${id}`), { ok: true }),
          gateDemoteItem: async (_cfg, id) => (calls.push(`demote:${id}`), { ok: true, demoted: true }),
          withoutFlakeEdges: (markdown) => markdown,
        })
      )
      .makeGateDeps(cfgFor(home), {
        record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
        factory: { id: "factory-test", trustedRef: "main", gates: [] },
        slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
      });
  const gate = { id: "review", kind: "agent-review", cycles: 1 };
  const callsA = [];
  const depsA = make(a, callsA);
  await assert.rejects(async () => depsA.recordFact({ id: "art-gate-x", markdown: "---\nid: art-gate-x\n---\n" }), lost);
  await assert.rejects(async () => depsA.escalate({ gate, attempts: [{ verdict: "changes_requested" }], detail: "spent", evidence: "", findings: [], ledger: [] }), lost);
  await assert.rejects(async () => depsA.fileHumanItem({ gate: { id: "approve", kind: "human" }, classes: ["touches:auth"], head: "abc" }), lost);
  await assert.rejects(async () => depsA.demote({ blockerId: "task-gate-x" }), lost);
  for (const lane of ["review", "dispatchFix", "dispatchRescue", "dispatchImplement"]) {
    await assert.rejects(async () => depsA[lane]({ gate, cycle: 0, attempt: 1 }), lost, `A launches no ${lane} agent`);
  }
  assert.deepStrictEqual(callsA, []);
  const callsB = [];
  const depsB = make(b, callsB);
  assert.strictEqual((await depsB.recordFact({ id: "art-gate-x", markdown: "---\nid: art-gate-x\n---\n" })).ok, true);
  assert.strictEqual((await depsB.escalate({ gate, attempts: [{ verdict: "changes_requested" }], detail: "spent", evidence: "", findings: [], ledger: [] })).ok, true);
  assert.strictEqual((await depsB.demote({ blockerId: "task-gate-x" })).ok, true);
  assert.deepStrictEqual(callsB.map((c) => c.split(":")[0]), ["write", "write", "demote"]);
});

test("the reviewer cooldown writers (stampReviewerCooldown, noteReviewerSuccess): A's displaced driver writes nothing, B's land (issue-spor-reviewer-cooldown-stamp-unguarded)", async (t) => {
  const home = scratchHome(t);
  const { a, b } = takenOver(home);
  const make = (gateOwner, calls) =>
    gateDeps
      .createGateDeps(
        fakeHost({
          gateStem: (id) => id,
          gateIdSuffix: () => "abc123",
          stampReviewerCooldown: (_home, stamp) => calls.push(`stamp:${stamp.profile}`),
          noteReviewerSuccess: (_home, profile) => calls.push(`success:${profile}`),
        })
      )
      .makeGateDeps(cfgFor(home), {
        record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
        factory: { id: "factory-test", trustedRef: "main", gates: [] },
        slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
      });
  const callsA = [];
  const depsA = make(a, callsA);
  await assert.rejects(async () => depsA.stampReviewerCooldown({ profile: "p", until: Date.now() + 1000, at: Date.now() }), lost);
  await assert.rejects(async () => depsA.noteReviewerSuccess({ profile: "p", at: Date.now() }), lost);
  assert.deepStrictEqual(callsA, []);
  const callsB = [];
  const depsB = make(b, callsB);
  await depsB.stampReviewerCooldown({ profile: "p", until: Date.now() + 1000, at: Date.now() });
  await depsB.noteReviewerSuccess({ profile: "p", at: Date.now() });
  assert.deepStrictEqual(callsB, ["stamp:p", "success:p"]);
});

test("the gate deps' T1 withdraw (withdrawHold): A's displaced driver withdraws nothing, B's lands; a record with no claim skips (issue-spor-gate-withdraw-hold-outside-durable-writer-lint)", async (t) => {
  const home = scratchHome(t);
  const { a, b } = takenOver(home);
  const make = (gateOwner, calls, record = { cwd: "/tmp/the-run-checkout", run_id: RUN, impl_claim: { execution_id: "exec-a" } }) =>
    gateDeps
      .createGateDeps(fakeHost({ gateStem: (id) => id, gateIdSuffix: () => "abc123" }))
      .makeGateDeps(cfgFor(home), {
        record, entry: { run_id: RUN, node_id: "task-x" },
        factory: { id: "factory-test", trustedRef: "main", gates: [] },
        slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner,
        withdrawHold: async ({ reason }) => (calls.push(`withdraw:${reason}`), { ok: true }),
      });
  const callsA = [];
  await assert.rejects(async () => make(a, callsA).withdrawHold({ reason: "refused" }), lost);
  assert.deepStrictEqual(callsA, []);
  const callsB = [];
  assert.strictEqual((await make(b, callsB).withdrawHold({ reason: "refused" })).ok, true);
  assert.deepStrictEqual(callsB, ["withdraw:refused"]);
  const unclaimed = [];
  assert.deepStrictEqual(await make(b, unclaimed, { cwd: "/tmp/the-run-checkout", run_id: RUN }).withdrawHold({ reason: "refused" }), { ok: true, skipped: true });
  assert.deepStrictEqual(unclaimed, []);
  // Unwired (a standalone caller, the integration stage's re-gate): no dep, so
  // the gate workflow's `has.withdrawHold` is false and the hold is kept.
  const bare = gateDeps.createGateDeps(fakeHost({ gateStem: (id) => id, gateIdSuffix: () => "abc123" })).makeGateDeps(cfgFor(home), {
    record: { cwd: "/tmp/the-run-checkout", run_id: RUN }, entry: { run_id: RUN, node_id: "task-x" },
    factory: { id: "factory-test", trustedRef: "main", gates: [] },
    slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, gateOwner: b,
  });
  assert.strictEqual(typeof bare.withdrawHold, "undefined");
});

// --- end to end: a takeover in the middle of a real gate ---------------------

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
}

function benignRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-writer-owner-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore", env: gitEnv() });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".spor"), "project: demo\n");
  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "test", "acceptance.js"), 'const add = require("../lib/add.js");\nif (add(2, 3) !== 5) process.exit(1);\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "lib", "sub.js"), "module.exports = (a, b) => a - b;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "implementer work");
  return dir;
}

test("end to end: worker A's lease is taken over while its command gate runs — A files no gate fact, writes no completion and appends nothing to the shared journal; B drives the same attempt and its fact, split verdict and settle land", async (t) => {
  const sporCli = require("../bin/spor.js");
  const home = scratchHome(t);
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = cfgFor(home);
  fs.writeFileSync(path.join(nodes, "task-demo.md"), "---\nid: task-demo\ntype: task\nproject: demo\ntitle: Benign work\nsummary: Benign work whose gate passes.\nstatus: open\ndate: 2026-10-04\n---\n\nBody.\n");
  const repo = benignRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // The gate's suite TAKES THE LEASE OVER the first time it runs — the stall
  // of A's pass, compressed: another claim lands while A is inside the gate.
  const runId = "run-writer-owner-1";
  const marker = path.join(home, "taken-over.token");
  const takeover = path.join(home, "takeover.js");
  fs.writeFileSync(
    takeover,
    [
      `const fs = require("fs");`,
      `if (!fs.existsSync(${JSON.stringify(marker)})) {`,
      `  const r = require(${JSON.stringify(path.resolve(__dirname, "../lib/shell/agent-dispatch-runner.js"))});`,
      `  const c = r.claimPipeline(${JSON.stringify(home)}, ${JSON.stringify(runId)}, { workerId: "w-1", factory: "factory-test", ownerLive: () => false, nowMs: () => Date.now() + 2 * 30 * 60 * 1000 });`,
      `  if (!c.ok) { console.error("takeover refused: " + c.refused); process.exit(3); }`,
      `  fs.writeFileSync(${JSON.stringify(marker)}, c.token);`,
      `}`,
    ].join("\n")
  );
  const body = ["```json", JSON.stringify({ factory: "test", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer", gates: [{ id: "acceptance", kind: "command", command: `node ${JSON.stringify(takeover)} && node test/acceptance.js` }], completion: { by: "controller" } }), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes: new Map() });
  assert.deepStrictEqual(errors, []);
  sporCli.LIVE_EXECUTIONS.clear();
  t.after(() => sporCli.LIVE_EXECUTIONS.clear());
  const held = await sporCli.claimExecutionHold(cfg, { id: "task-demo", project: "demo" }, factory, { home });
  assert.strictEqual(held.ok, true, held.reason);
  const record = { run_id: runId, node_id: "task-demo", name: "task-demo", harness: "fake", cwd: repo, state: "exited", termination_class: "completed", terminal_state: "reported", terminal_enforced: true, started_at: "2026-10-04T00:00:00.000Z", finished_at: "2026-10-04T00:10:00.000Z", ...held.recordFields };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, record);
  const entry = { run_id: runId, node_id: "task-demo", project: "demo" };
  const ctx = { factory, slug: "demo", passthrough: {}, warn: () => {}, runMaxMs: 1000, home, stopping: () => false, sleep: async () => {}, workerId: "w-1" };

  // --- A: displaced mid-gate.
  const linesA = [];
  const resA = await sporCli.runGateAndIntegration(cfg, entry, record, { ...ctx, log: (l) => linesA.push(l) });
  assert.strictEqual(resA.owner_lost, true, `A stops as superseded: ${JSON.stringify(resA)}\n${linesA.join("\n")}`);
  assert.strictEqual(resA.superseded, true);
  assert.ok(fs.existsSync(marker), "the takeover happened inside A's gate");
  const tokenB = fs.readFileSync(marker, "utf8");
  assert.strictEqual(sp.pipelineLease(home, record).token, tokenB, "A left B's lease in place");
  assert.deepStrictEqual(fs.readdirSync(nodes).filter((f) => /^art-(gate|completion)-/.test(f)), [], "A filed no gate fact and no completion resolver");
  assert.match(fs.readFileSync(path.join(nodes, "task-demo.md"), "utf8"), /status: open/, "A completed nothing");
  // ...and appended nothing to the journals B is about to replay: the
  // refused step's failure entry never reached disk.
  const journals = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith(".workflow.jsonl")) journals.push(p); } };
  walk(home);
  assert.ok(journals.length >= 2, "the pipeline and gate journals exist");
  for (const j of journals) assert.doesNotMatch(fs.readFileSync(j, "utf8"), /PIPELINE_OWNER_LOST|no longer owns/, `${path.basename(j)} carries none of A's refusal`);
  const parent = journals.find((j) => /pipeline-a\d+\.workflow\.jsonl$/.test(j));
  assert.doesNotMatch(fs.readFileSync(parent, "utf8"), /\/gates"/, "A's parent journal recorded no gates result");
  const afterA = read(dispatchRuns.runPaths(home, runId).record);
  assert.strictEqual(afterA.gate_state, undefined, "A settled nothing");
  assert.strictEqual(afterA.gates_state, undefined, "A stamped no split verdict");
  assert.strictEqual(afterA.completion_debt, undefined, "A owed no completion");

  // --- B: the holder drives the same attempt over the same journals.
  const linesB = [];
  const fresh = read(dispatchRuns.runPaths(home, runId).record);
  const resB = await sporCli.runGateAndIntegration(cfg, entry, fresh, { ...ctx, gateClaim: { ok: true, token: tokenB, refused: null }, log: (l) => linesB.push(l) });
  assert.ok(!resB.superseded && !resB.owner_lost, `B owns the pipeline and drives it to a verdict: ${JSON.stringify(resB)}\n${linesB.join("\n")}`);
  assert.ok(["passed", "failed"].includes(resB.state), `${JSON.stringify(resB)}\n${linesB.join("\n")}`);
  assert.ok(!linesB.some((l) => /REPLAY FAULT|cannot be continued/.test(l)), `B's journals replay cleanly — none of A's refused steps is in them:\n${linesB.join("\n")}`);
  // B's writes LAND — the fact, the split verdict, the settle.
  assert.strictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-")).length, 1, "B's gate fact landed");
  const afterB = read(dispatchRuns.runPaths(home, runId).record);
  assert.strictEqual(afterB.gate_state, resB.state, "B's settle landed");
  assert.strictEqual(afterB.gates_state, resB.state, "B's split verdict landed");
  // What a takeover ends in: B — resumed past A's journaled `changedPaths`,
  // so the change set is restored from the journal, never re-read live
  // (issue-spor-gate-resume-loses-change-under-judgement) — passes the gate A
  // was inside, and its completion lands.
  assert.strictEqual(resB.state, "passed", `${JSON.stringify(resB)}\n${linesB.join("\n")}`);
  assert.ok(!linesB.some((l) => /could not be read/.test(l)), `B judged the change A read:\n${linesB.join("\n")}`);
  assert.match(fs.readFileSync(path.join(nodes, "task-demo.md"), "utf8"), /status: done/);
  assert.ok(afterB.completion_written_at);
});
