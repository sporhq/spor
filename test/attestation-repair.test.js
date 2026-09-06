"use strict";
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = require("../bin/spor.js");
const runner = require("../lib/shell/agent-dispatch-runner.js");
const att = require("../lib/shell/attestation.js");
const { loadConfig } = require("../lib/config.js");

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attestation-repair-"));
  fs.mkdirSync(path.join(home, "nodes"));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const item = { node_id: "task-repair", run_id: "11111111-2222-3333-4444-000000000078", attempt: 0 };
  const file = runner.runPaths(home, item.run_id).record;
  runner.atomicJson(file, { ...item, state: "done", gate_state: "running", gate_settle_id: "winner", gate_worker: "w" });
  const factory = { id: "factory-test", trustedRef: "main", gates: [], protectedPaths: [], riskClasses: {}, integration: null };
  const gateResult = { state: "passed", gates: [], facts: [], head: "a".repeat(40), base: "b".repeat(40), trusted_ref: "main" };
  const pending = cli.prepareRunAttestation(cfg, { item, factory, gateResult, intResult: null });
  assert.ok(pending.built, pending.error);
  return { home, cfg, item, file, factory, gateResult, pending };
}

test("settlement crash leaves exact attestation bytes as durable debt; replay writes once and clears debt", async () => {
  const f = fixture();
  const input = path.join(f.home, "settlement.json");
  fs.writeFileSync(input, JSON.stringify({ home: f.home, item: f.item, gateResult: f.gateResult, factory: f.factory, pending: f.pending }));
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const cli = require(${JSON.stringify(require.resolve("../bin/spor.js"))});
    const f = JSON.parse(fs.readFileSync(process.argv[1]));
    const settled = cli.settleRunRecord(f.home, f.item.run_id, f.gateResult, 'w', { gateResult: f.gateResult, factory: f.factory, token: 'winner', pending: f.pending });
    if (!settled.landed) process.exit(72);
    process.exit(71); // die at the actual settlement/publication boundary
  `, input], { encoding: "utf8" });
  assert.equal(child.status, 71, child.stderr);
  const before = runner.readJson(f.file);
  assert.equal(before.gate_state, "passed");
  assert.equal(before.gate_attestation_missing, true);
  assert.deepEqual(before.gate_attestation_pending.built, f.pending.built);
  assert.equal(fs.existsSync(path.join(f.home, "nodes", `${f.pending.built.id}.md`)), false);
  await cli.replayAttestationDebts(f.cfg, { home: f.home });
  assert.equal(fs.readFileSync(path.join(f.home, "nodes", `${f.pending.built.id}.md`), "utf8"), f.pending.built.markdown);
  const after = runner.readJson(f.file);
  assert.equal(after.gate_attestation, f.pending.built.id);
  assert.equal(after.gate_attestation_missing, false);
  assert.equal(after.gate_attestation_pending, null);
  let writes = 0;
  await cli.replayAttestationDebts(f.cfg, { home: f.home, write: async () => { writes++; } });
  assert.equal(writes, 0, "completed debt never republishes or reruns judgement");
});

test("publication failure retains settlement debt and later replay preserves signed bytes without signing keys", async () => {
  const f = fixture();
  f.pending.built = att.buildAttestationNode({ item: f.item, factory: f.factory, gate: f.gateResult, signing: { key: "test-signing-secret", keyId: "test" } });
  cli.settleRunRecord(f.home, f.item.run_id, f.gateResult, "w", { token: "winner", pending: f.pending });
  const original = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    if (String(file).includes(f.pending.built.id)) throw new Error("injected graph disk full");
    return original.call(this, file, ...args);
  };
  try { await cli.replayAttestationDebts(f.cfg, { home: f.home }); }
  finally { fs.writeFileSync = original; }
  assert.ok(runner.readJson(f.file).gate_attestation_pending);
  assert.equal(runner.readJson(f.file).gate_attestation_missing, true);
  assert.equal(fs.readFileSync(f.file, "utf8").includes("test-signing-secret"), false);
  await cli.replayAttestationDebts(f.cfg, { home: f.home });
  assert.equal(fs.readFileSync(path.join(f.home, "nodes", `${f.pending.built.id}.md`), "utf8"), f.pending.built.markdown);
});

test("losing observer cannot rewrite live owner before claiming or install its own settlement debt", () => {
  const f = fixture();
  const bytes = fs.readFileSync(f.file, "utf8");
  runner.stampGateState(f.home, f.item.run_id, { gate_state: "running", gate_worker: "loser" });
  const claim = runner.claimGateRecord(f.home, f.item.run_id, { workerId: "loser", ownerLive: () => true });
  assert.equal(claim.ok, false);
  assert.equal(fs.readFileSync(f.file, "utf8"), bytes);
  const settle = cli.settleRunRecord(f.home, f.item.run_id, { state: "failed" }, "loser", { token: "losing-token", pending: f.pending });
  assert.equal(settle.landed, false);
  assert.equal(fs.readFileSync(f.file, "utf8"), bytes);
});

test("stale breaker observation cannot unlink a successor; the waiter fails closed", () => {
  const f = fixture();
  const lock = runner.recordLockPath(f.file);
  const breaker = runner.breakerLockPath(lock);
  fs.writeFileSync(lock, "old-record-lock");
  fs.writeFileSync(breaker, "old-breaker");
  const old = new Date(Date.now() - 100000);
  fs.utimesSync(lock, old, old);
  fs.utimesSync(breaker, old, old);
  const original = fs.statSync;
  let swapped = false;
  fs.statSync = function (file, ...args) {
    const stat = original.call(this, file, ...args);
    if (String(file) === breaker && !swapped) {
      swapped = true;
      fs.unlinkSync(breaker);
      fs.writeFileSync(breaker, "live-successor");
    }
    return stat;
  };
  let entered = false;
  try { assert.equal(runner.withRecordLock(f.file, () => { entered = true; }, { attempts: 2, waitMs: 1, staleMs: 1 }).ok, false); }
  finally { fs.statSync = original; }
  assert.equal(entered, false);
  assert.ok(fs.existsSync(breaker));
  assert.equal(fs.readFileSync(breaker, "utf8"), swapped ? "live-successor" : "old-breaker");
  // Exercise the acquirer path's stat/cleanup window as well.
  fs.unlinkSync(lock);
  fs.statSync = function (file, ...args) {
    const stat = original.call(this, file, ...args);
    if (String(file) === breaker && !swapped) { swapped = true; fs.unlinkSync(breaker); fs.writeFileSync(breaker, "live-successor"); }
    return stat;
  };
  try { assert.equal(runner.withRecordLock(f.file, () => { entered = true; }, { attempts: 2, waitMs: 1, staleMs: 1 }).ok, false); }
  finally { fs.statSync = original; }
  assert.equal(swapped, true, "the forced successor replacement really happened");
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(breaker, "utf8"), "live-successor");
});

test("PR refresh preserves human and unrelated automation bytes around the owned block", () => {
  const f = fixture();
  const generated = att.renderPrBody({ attestation: f.pending.built.attestation, branch: "feature", base: "main" });
  const old = generated.replace(/"commit": "a+/g, '"commit": "old');
  const prefix = "Human acceptance checklist\n\n- [x] manually verified\n\n";
  const suffix = "\n<!-- external-bot -->\nDo not remove this evidence.\n";
  const current = prefix + old.slice(old.indexOf("<!-- spor-proposal:begin -->")) + suffix;
  const calls = [];
  const result = cli.editProposalBody({ repo: "test/repo", number: 4, body: generated, gh: (args) => {
    calls.push(args);
    if (args[1] === "view") return { status: 0, stdout: JSON.stringify({ body: current }) };
    return { status: 0, stdout: "" };
  } });
  assert.equal(result.ok, true, result.reason);
  const edited = calls[1].at(-1);
  assert.ok(edited.startsWith(prefix));
  assert.ok(edited.endsWith(suffix));
  assert.equal(att.extractPrAttestation(edited).subject.commit, "a".repeat(40));
  assert.equal(att.mergePrBody(edited, generated), edited, "refresh is idempotent");
  assert.throws(() => att.mergePrBody(`${att.PR_BEGIN}\nunclosed`, generated), /ambiguous/);
});

test("implementation and completion writers respect the settlement lock; pending evidence survives retention", () => {
  const f = fixture();
  cli.settleRunRecord(f.home, f.item.run_id, f.gateResult, "w", { token: "winner", pending: f.pending });
  const bytes = fs.readFileSync(f.file, "utf8");
  const lockPath = runner.recordLockPath(f.file);
  fs.writeFileSync(lockPath, "settler-is-writing");
  const lock = (file, fn) => runner.withRecordLock(file, fn, { attempts: 2, waitMs: 1 });
  assert.equal(runner.stampImplState(f.home, f.item.run_id, { impl_state: "candidate" }, { lock }), null);
  assert.equal(runner.stampCompletionState(f.home, f.item.run_id, { completion_debt: "pending" }, { lock }), null);
  assert.equal(fs.readFileSync(f.file, "utf8"), bytes);
  fs.unlinkSync(lockPath);
  runner.stampImplState(f.home, f.item.run_id, { impl_state: "candidate" });
  runner.stampCompletionState(f.home, f.item.run_id, { completion_debt: "pending" });
  assert.deepEqual(runner.readJson(f.file).gate_attestation_pending, f.pending);
  runner.atomicJson(f.file, { ...runner.readJson(f.file), state: "done", created_at: "2000-01-01T00:00:00Z" });
  runner.pruneRuns(f.home, { maxAgeMs: 1 });
  assert.ok(fs.existsSync(f.file), "settled process retention cannot erase publication debt");
});
