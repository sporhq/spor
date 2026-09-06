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

test("every terminal bookkeeping writer locks before reading and preserves a concurrently settled outbox", () => {
  for (const writer of ["settleNativeOutcome", "settleContractOutcome", "stampRun"]) {
    const f = fixture();
    runner.atomicJson(f.file, { ...runner.readJson(f.file), contract_pending: true });
    let entered = false;
    const lock = (file, body) => {
      entered = true;
      const settled = cli.settleRunRecord(f.home, f.item.run_id, f.gateResult, "w", { token: "winner", pending: f.pending });
      assert.equal(settled.landed, true);
      return runner.withRecordLock(file, body);
    };
    const record = runner.readJson(f.file);
    const patch = { terminal_state: "resolved", terminal_enforced: true, lease_released: true };
    runner[writer](f.home, writer === "stampRun" ? f.item.run_id : record, patch, { lock });
    assert.equal(entered, true, writer);
    const final = runner.readJson(f.file);
    assert.equal(final.gate_settle_id, "winner", writer);
    assert.deepEqual(final.gate_attestation_pending, f.pending, writer);
    assert.equal(final.terminal_state, "resolved", writer);
    const bytes = fs.readFileSync(f.file, "utf8");
    runner[writer](f.home, writer === "stampRun" ? f.item.run_id : final, { terminal_state: "reported" }, { lock: () => ({ ok: false, reason: "busy" }) });
    assert.equal(fs.readFileSync(f.file, "utf8"), bytes, "lock refusal makes no write");
  }
});

test("outbox replay refuses other servers, organizations, local graphs, and legacy unbound evidence", async () => {
  const f = fixture();
  cli.settleRunRecord(f.home, f.item.run_id, f.gateResult, "w", { token: "winner", pending: f.pending });
  const saved = runner.readJson(f.file);
  const otherLocal = { mode: () => "local", nodesDir: () => path.join(f.home, "other-nodes") };
  const remote = (server, org) => ({ mode: () => "remote", server: () => server, tenant: () => ({ org }) });
  let writes = 0;
  const write = async () => { writes++; return { attestation: null }; };
  for (const [origin, cfg] of [
    [f.pending.origin, otherLocal], [f.pending.origin, remote("https://a.example", "a")],
    [{ mode: "remote", server: "https://a.example", org: "a" }, remote("https://b.example", "a")],
    [{ mode: "remote", server: "https://a.example", org: "a" }, remote("https://a.example", "b")],
    [null, f.cfg],
  ]) {
    runner.atomicJson(f.file, { ...saved, gate_attestation_pending: { ...f.pending, origin } });
    const bytes = fs.readFileSync(f.file, "utf8");
    await cli.replayAttestationDebts(cfg, { home: f.home, write });
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(f.file, "utf8"), bytes, "wrong graph cannot clear original debt");
  }
  const cfg = remote("https://a.example/", "a");
  runner.atomicJson(f.file, { ...saved, gate_attestation_pending: { ...f.pending, origin: { mode: "remote", server: "https://a.example", org: "a" } } });
  await cli.replayAttestationDebts(cfg, { home: f.home, write });
  assert.equal(writes, 1, "matching origin alone may pay the debt");
});

test("re-gate publishes liveness before claiming and cannot overwrite a successor at final settlement", async () => {
  const gates = require("../lib/shell/gate-runner.js");
  const loop = require("../lib/shell/work-loop.js");
  for (const steal of [false, true]) {
    const f = fixture();
    runner.atomicJson(f.file, { ...runner.readJson(f.file), terminal_state: "resolved", terminal_enforced: true, gate_state: "failed", gate_worker: "old" });
    const original = gates.runGatePipeline;
    let workerId;
    gates.runGatePipeline = async () => {
      const rec = runner.readJson(f.file);
      workerId = rec.gate_worker;
      assert.ok(loop.readWorkerStatuses(f.home, { alive: cli.workerAlive }).some((w) => w.worker_id === workerId && w.live));
      const rival = runner.claimGateRecord(f.home, f.item.run_id, { workerId: "rival", ownerLive: (id) => loop.readWorkerStatuses(f.home, { alive: cli.workerAlive }).some((w) => w.live && w.worker_id === id) });
      assert.equal(rival.ok, false, "orphan scan cannot adopt live re-gate");
      if (steal) runner.stampGateState(f.home, f.item.run_id, { gate_state: "passed", gate_settle_id: "successor", gate_worker: "successor", gate_reason: "successor verdict" }, { force: true });
      return f.gateResult;
    };
    try {
      const code = await cli.cmdWorkRegate(f.cfg, { regate: f.item.run_id }, { factory: f.factory, factoryId: f.factory.id, slug: null, passthrough: {}, warn: () => {}, runMaxMs: 1000, home: f.home });
      assert.equal(code, steal ? 1 : 0);
    } finally { gates.runGatePipeline = original; }
    const final = runner.readJson(f.file);
    assert.equal(final.gate_worker, steal ? "successor" : workerId);
    if (steal) {
      assert.equal(final.gate_settle_id, "successor");
      assert.equal(final.gate_reason, "successor verdict");
      assert.equal(fs.existsSync(path.join(f.home, "nodes", `${f.pending.built.id}.md`)), false);
    }
    assert.equal(loop.readWorkerStatuses(f.home, { alive: cli.workerAlive }).find((w) => w.worker_id === workerId).live, false);
  }
});

test("proposal push and trusted-ref merge never execute repository hooks with judge credentials", () => {
  const f = fixture();
  const repo = path.join(f.home, "repo");
  const bare = path.join(f.home, "remote.git");
  const bin = path.join(f.home, "bin");
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const git = (cwd, ...args) => { const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "test"); git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "base"), "base"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(f.home, "init", "--bare", "-q", bare);
  git(repo, "remote", "add", "origin", "https://github.com/example/test.git");
  git(repo, "config", "url." + bare + ".insteadOf", "https://github.com/example/test.git");
  git(repo, "checkout", "-qb", "candidate"); fs.writeFileSync(path.join(repo, "candidate"), "candidate"); git(repo, "add", "."); git(repo, "commit", "-qm", "candidate");
  git(repo, "checkout", "-q", "main"); fs.writeFileSync(path.join(repo, "trusted"), "trusted"); git(repo, "add", "."); git(repo, "commit", "-qm", "trusted"); git(repo, "checkout", "-q", "candidate");
  const leaked = path.join(f.home, "hook-ran");
  for (const hook of ["pre-push", "post-merge", "pre-merge-commit"]) fs.writeFileSync(path.join(repo, ".git", "hooks", hook), `#!/bin/sh\nprintf '%s' "$SPOR_ATTESTATION_KEY" > '${leaked}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$2\" = list ]; then echo '[]'; else echo 'https://github.com/example/test/pull/1'; fi\n", { mode: 0o755 });
  // get-url expands insteadOf, so use an explicit pushURL to a local receiver.
  git(repo, "config", "--unset", "url." + bare + ".insteadOf"); git(repo, "remote", "set-url", "--push", "origin", bare);
  const oldPath = process.env.PATH, oldKey = process.env.SPOR_ATTESTATION_KEY;
  process.env.PATH = bin + path.delimiter + oldPath; process.env.SPOR_ATTESTATION_KEY = "never-child-visible";
  try {
    assert.equal(cli.refreshBranchFromTrustedRef(repo, "main").refused, undefined);
    const head = git(repo, "rev-parse", "HEAD");
    assert.equal(cli.proposeIntegrationPR({ top: repo, head, targetRef: "origin/main" }).ok, true);
    assert.equal(fs.existsSync(leaked), false);
    assert.equal(git(bare, "rev-parse", "refs/heads/candidate"), head, "actual local push completed");
  } finally { process.env.PATH = oldPath; if (oldKey === undefined) delete process.env.SPOR_ATTESTATION_KEY; else process.env.SPOR_ATTESTATION_KEY = oldKey; }
});

test("atomic reopen rejects a stale snapshot and a live settler, while mismatch remains re-gateable", () => {
  const f = fixture();
  const before = { ...runner.readJson(f.file), gate_state: "mismatch", gate_regate_count: 0 };
  runner.atomicJson(f.file, before);
  const reopen = { settleId: "winner", regateCount: 0, state: "mismatch" };
  assert.equal(runner.claimGateRecord(f.home, f.item.run_id, { workerId: "new", reopen, ownerLive: () => true }).ok, false);
  assert.deepEqual(runner.readJson(f.file), before);
  assert.equal(runner.claimGateRecord(f.home, f.item.run_id, { workerId: "new", reopen: { ...reopen, settleId: "older" } }).ok, false);
  assert.deepEqual(runner.readJson(f.file), before);
  const winner = runner.claimGateRecord(f.home, f.item.run_id, { workerId: "new", reopen });
  assert.equal(winner.ok, true);
  assert.equal(winner.record.gate_regate_count, 1);
  assert.equal(runner.claimGateRecord(f.home, f.item.run_id, { workerId: "racer", reopen }).ok, false);
  assert.equal(runner.readJson(f.file).gate_settle_id, winner.token);
});

test("re-gating cannot overwrite an unpaid signed outbox; matching-origin replay must finish first", async () => {
  const f = fixture();
  const verdict = { ...f.gateResult, state: "failed", reason: "prior review refused" };
  const pending = cli.prepareRunAttestation(f.cfg, { item: f.item, factory: f.factory, gateResult: verdict, intResult: null });
  pending.built = att.buildAttestationNode({ item: f.item, factory: f.factory, gate: verdict, signing: { key: "original-debt-secret", keyId: "old-judge" } });
  cli.settleRunRecord(f.home, f.item.run_id, verdict, "w", { token: "winner", pending });
  const before = fs.readFileSync(f.file, "utf8");
  const reopen = { settleId: "winner", regateCount: 0, state: "failed" };
  const tryReopen = () => runner.claimGateRecord(f.home, f.item.run_id, { workerId: "new-attempt", reopen });
  assert.match(tryReopen().refused, /publication is still owed.*original graph/);
  assert.equal(fs.readFileSync(f.file, "utf8"), before, "neither nonce nor signed bytes nor attempt changed");
  await cli.replayAttestationDebts({ mode: () => "local", nodesDir: () => path.join(f.home, "foreign") }, { home: f.home });
  assert.equal(fs.readFileSync(f.file, "utf8"), before, "foreign graph cannot discharge debt to permit reopen");
  assert.equal(tryReopen().ok, false);
  await cli.replayAttestationDebts(f.cfg, { home: f.home });
  assert.equal(fs.readFileSync(path.join(f.home, "nodes", `${pending.built.id}.md`), "utf8"), pending.built.markdown);
  assert.equal(tryReopen().ok, true);
  assert.equal(runner.readJson(f.file).gate_regate_count, 1);
});
