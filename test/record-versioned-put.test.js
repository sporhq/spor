"use strict";
// The versioned put over run records (task-spor-gate-progress-versioned-put-
// and-write-lint): every locked writer bumps ONE `rev` on the record, the
// namespace stampers refuse a patch whose `expectedRev` is not the disk's, a
// record is created exactly once, and the bin/spor.js callers that used to
// hand-carry a premise through an unconditional stamp now compare-and-swap
// on it (the flake-sweep reservation, the escalation retry). The two
// non-record halves of the same item ride here too: a human approval is bound
// to the judged commit on the READ side, and a candidate locator is
// percent-decoded over the whole escape alphabet before the `.git` refusal.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("../lib/shell/agent-dispatch-runner.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const gates = require("../lib/kernel/gates.js");
const candidate = require("../lib/kernel/candidate.js");
const candidatePublish = require("../lib/shell/candidate-publish.js");
const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");
const remoteLib = require("../lib/remote.js");

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-vput-"));
}

function seed(home, runId, extra = {}) {
  const p = runner.runPaths(home, runId);
  runner.createRecord(p.record, { run_id: runId, harness: "codex", launch_mode: "supervised-jsonl", state: "done", created_at: "2026-09-27T10:00:00.000Z", ...extra });
  return p.record;
}

// ------------------------------------------------------------- the rev --

test("createRecord mints rev 1 and refuses to rename over a record that already exists — the loser reads the winner back", () => {
  const home = scratch();
  const file = seed(home, "r-create", { name: "first" });
  const first = runner.readJson(file);
  assert.strictEqual(first.rev, 1);
  assert.ok(first.rev_at);
  const again = runner.createRecord(file, { run_id: "r-create", name: "second" });
  assert.strictEqual(again.name, "first", "a second creation under the same id hands back what is on disk");
  assert.strictEqual(runner.readJson(file).name, "first");
});

test("every locked writer bumps the record's ONE rev — a gate stamp, an impl stamp, a completion stamp, a whole-record carry and a plain stampRun share the counter", () => {
  const home = scratch();
  const file = seed(home, "r-bump");
  const revs = [runner.readJson(file).rev];
  runner.stampGateState(home, "r-bump", { gate_state: "running", gate_worker: "w1" });
  revs.push(runner.readJson(file).rev);
  runner.stampImplState(home, "r-bump", { impl_state: "running" });
  revs.push(runner.readJson(file).rev);
  runner.stampCompletionState(home, "r-bump", { completion_debt: { owed: true } });
  revs.push(runner.readJson(file).rev);
  runner.writeRecordCarryingGate(file, { ...runner.readJson(file), terminal_note: "carried" });
  revs.push(runner.readJson(file).rev);
  runner.stampRun(home, "r-bump", { lease_released: true });
  revs.push(runner.readJson(file).rev);
  assert.deepStrictEqual(revs, [1, 2, 3, 4, 5, 6]);
  const final = runner.readJson(file);
  assert.strictEqual(final.gate_state, "running", "the carry kept the out-of-band gate namespace");
  assert.strictEqual(final.impl_state, "running");
  assert.strictEqual(final.lease_released, true);
});

test("a stale in-memory copy cannot roll the rev back: the whole-record carry takes the rev from disk, never from the copy it was handed", () => {
  const home = scratch();
  const file = seed(home, "r-stale-copy");
  const early = runner.readJson(file); // rev 1
  runner.stampGateState(home, "r-stale-copy", { gate_state: "running" }); // rev 2
  runner.writeRecordCarryingGate(file, { ...early, note: "from an old copy" });
  const after = runner.readJson(file);
  assert.strictEqual(after.rev, 3);
  assert.strictEqual(after.gate_state, "running");
  assert.strictEqual(after.note, "from an old copy");
});

test("readRecord is the read half: it hands back the record with the rev a caller can pass as expectedRev, and null for no record", () => {
  const home = scratch();
  seed(home, "r-read");
  assert.strictEqual(runner.readRecord(home, "r-read").rev, 1);
  assert.strictEqual(runner.readRecord(home, "r-none"), null);
  assert.strictEqual(runner.readRecord(home, null), null);
});

// ------------------------------------------------- the expectedRev door --

test("stampGateState with expectedRev lands only on the rev it was decided from, and reports the moved record as stale without writing", () => {
  const home = scratch();
  const file = seed(home, "r-cas-gate");
  const read = runner.readRecord(home, "r-cas-gate");
  const landed = runner.stampGateState(home, "r-cas-gate", { gate_state: "running", gate_note: "mine" }, { expectedRev: read.rev });
  assert.strictEqual(landed.gate_note, "mine");
  assert.strictEqual(landed.rev, 2);
  // Decided from rev 1 again — the record has moved on.
  const stale = runner.stampGateState(home, "r-cas-gate", { gate_note: "theirs" }, { expectedRev: read.rev });
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.gate_note, "mine", "the stale caller is handed what is on disk");
  const disk = runner.readJson(file);
  assert.strictEqual(disk.gate_note, "mine");
  assert.strictEqual(disk.rev, 2, "a refused put writes nothing, not even a rev bump");
  assert.strictEqual(disk.stale, undefined, "the stale marker is the caller's, never written");
});

test("stampImplState, stampCompletionState and stampRun refuse a stale expectedRev the same way", () => {
  const home = scratch();
  const file = seed(home, "r-cas-all");
  const rev = runner.readRecord(home, "r-cas-all").rev;
  runner.stampGateState(home, "r-cas-all", { gate_state: "running" }); // moves the record to rev 2
  assert.strictEqual(runner.stampImplState(home, "r-cas-all", { impl_state: "running" }, { expectedRev: rev }).stale, true);
  assert.strictEqual(runner.stampCompletionState(home, "r-cas-all", { completion_debt: { x: 1 } }, { expectedRev: rev }).stale, true);
  assert.strictEqual(runner.stampRun(home, "r-cas-all", { lease_released: true }, { expectedRev: rev }).stale, true);
  const disk = runner.readJson(file);
  assert.strictEqual(disk.impl_state, undefined);
  assert.strictEqual(disk.completion_debt, undefined);
  assert.strictEqual(disk.lease_released, undefined);
  assert.strictEqual(disk.rev, 2);
  // And with the CURRENT rev, each lands.
  assert.strictEqual(runner.stampImplState(home, "r-cas-all", { impl_state: "running" }, { expectedRev: 2 }).impl_state, "running");
  assert.strictEqual(runner.stampCompletionState(home, "r-cas-all", { completion_debt: { x: 1 } }, { expectedRev: 3 }).completion_debt.x, 1);
  assert.strictEqual(runner.stampRun(home, "r-cas-all", { lease_released: true }, { expectedRev: 4 }).lease_released, true);
  assert.strictEqual(runner.readJson(file).rev, 5);
});

// The gate ledger is no longer a record field (task-spor-run-surfaces-read-
// stage-journal): its writer is agent-dispatch-runner.js appendGateProgress
// over the gate-progress log, pinned in test/gate-progress-writer.test.js.

// ------------------------------------- the bin/spor.js callers made CAS --

test("casFlakeRegateReservation is the ONE door for a reservation's take, hand-back and settle — each lands only over the exact state it was planned from", () => {
  const home = scratch();
  const file = seed(home, "r-flake", { gate_state: "failed", gate_settle_id: "s1" });
  const reservation = { issues: ["issue-flake-a"], tests: ["t.js"], at: "2026-09-27T10:00:00.000Z", state: "running" };
  // Take: prior is null.
  let r = sporCli.casFlakeRegateReservation(home, "r-flake", null, reservation);
  assert.strictEqual(r.gate_flake_regate.at, reservation.at);
  // A second sweep that planned from the same null prior loses.
  const rival = { ...reservation, at: "2026-09-27T10:00:01.000Z" };
  r = sporCli.casFlakeRegateReservation(home, "r-flake", null, rival);
  assert.strictEqual(r, null, "a CAS that found other state writes nothing");
  assert.strictEqual(runner.readJson(file).gate_flake_regate.at, reservation.at, "the rival's reservation did not land");
  // The rival's hand-back (keyed on ITS reservation) cannot hand back ours.
  r = sporCli.casFlakeRegateReservation(home, "r-flake", rival, null);
  assert.strictEqual(runner.readJson(file).gate_flake_regate.at, reservation.at);
  // Our settle, keyed on our reservation, lands.
  r = sporCli.casFlakeRegateReservation(home, "r-flake", reservation, { ...reservation, state: "passed" });
  assert.strictEqual(runner.readJson(file).gate_flake_regate.state, "passed");
  // The settled record was never reopened by any of it.
  assert.strictEqual(runner.readJson(file).gate_state, "failed");
});

test("retryOneEscalation's bookkeeping stamps are CAS on the retry count they were planned from — a rival pass that already advanced it is not overwritten, and a cleared payload is never re-stamped pending", async () => {
  const home = scratch();
  const file = seed(home, "r-retry", { gate_state: "failed", node_id: "task-x", gate_escalation_pending: { gateId: "g", detail: "d" }, gate_escalation_retry_count: 0 });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const record = runner.readJson(file);
  // A rival pass landed attempt 1 between this pass's read and its stamp.
  runner.stampGateState(home, "r-retry", { gate_escalation_retry_count: 1, gate_escalation_retry_at: "2026-09-27T10:05:00.000Z" }, { allowSettledPatch: true });
  const logs = [];
  await sporCli.retryOneEscalation(cfg, { record, attempts: 0 }, {
    factory: { id: "factory-x", gates: [] },
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    home,
    maxAttempts: 5,
    backoffMs: 1000,
    maxBackoffMs: 1000,
  });
  const after = runner.readJson(file);
  assert.strictEqual(after.gate_escalation_retry_count, 1, "the stale pass's stamp (planned from count 0) did not land over the rival's");
  assert.strictEqual(after.gate_escalation_retry_at, "2026-09-27T10:05:00.000Z");
  assert.strictEqual(after.gate_escalation_pending.gateId, "g");
  assert.strictEqual(after.gate_escalation_retry_exhausted, undefined);
  // The same pass, planned from the count the record actually carries, lands
  // its give-up (the gate named by the payload is not in this factory).
  await sporCli.retryOneEscalation(cfg, { record: after, attempts: 1 }, { factory: { id: "factory-x", gates: [] }, log: (m) => logs.push(m), warn: (m) => logs.push(m), home, maxAttempts: 5, backoffMs: 1000, maxBackoffMs: 1000 });
  const settled = runner.readJson(file);
  assert.strictEqual(settled.gate_escalation_retry_exhausted, true);
  assert.strictEqual(settled.gate_escalation_retry_count, 2);
  assert.strictEqual(settled.gate_state, "failed", "the settled verdict was never reopened by the bookkeeping");
});

// ------------------------------------ human approval bound to the commit --

function remoteCfg() {
  const home = scratch();
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: "http://127.0.0.1:1", SPOR_TOKEN: "t" } });
}

async function withNodeBodies(bodies, fn) {
  const original = remoteLib.get;
  remoteLib.get = async (cfg, p) => {
    const m = /^\/v1\/nodes\/([^/]+)$/.exec(p);
    const id = m && decodeURIComponent(m[1]);
    const spec = id && Object.prototype.hasOwnProperty.call(bodies, id) ? bodies[id] : undefined;
    if (spec === undefined) return { ok: false, status: 404, json: { error: { code: "not_found" } }, jsonError: null };
    return { ok: true, status: 200, json: spec, jsonError: null };
  };
  try {
    return await fn();
  } finally {
    remoteLib.get = original;
  }
}

test("the approval item carries the judged commit as gate_head frontmatter, and buildGateWorkNode keeps a field to one safe token", () => {
  const md = sporCli.buildGateWorkNode({ id: "task-approve-x", title: "t", summary: "s", body: "b", project: "spor", date: "2026-09-27", requiresHuman: true, fields: { gate_head: COMMIT, bad: "two\nlines", "Not-Key": "x" } });
  assert.match(md, new RegExp(`^gate_head: ${COMMIT}$`, "m"));
  assert.doesNotMatch(md, /^bad:/m, "a value that would open a second key is dropped, not escaped");
  assert.doesNotMatch(md, /Not-Key/);
});

test("a pre-upgrade approval item (no gate_head line) is equivalent to the re-filed one that carries it — resume does not refuse the gate — but a DIFFERENT head still refuses", async () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const mk = (fields) => sporCli.buildGateWorkNode({ id: "task-approve-eq", title: "t", summary: "s", body: "b", project: "spor", date: "2026-09-27", requiresHuman: true, edges: [{ type: "blocks", to: "task-x" }], fields });
  const old = mk({});
  const first = await sporCli.writeGateNode(cfg, "task-approve-eq", old);
  assert.ok(first.ok, JSON.stringify(first));
  const again = await sporCli.writeGateNode(cfg, "task-approve-eq", mk({ gate_head: COMMIT }));
  assert.ok(again.ok, `an occupant that predates gate_head is the same item: ${JSON.stringify(again)}`);
  assert.ok(again.existing);
  const withHead = await sporCli.writeGateNode(cfg, "task-approve-head", mk({ gate_head: COMMIT }).replace("task-approve-eq", "task-approve-head"));
  assert.ok(withHead.ok);
  const other = await sporCli.writeGateNode(cfg, "task-approve-head", mk({ gate_head: OTHER }).replace("task-approve-eq", "task-approve-head"));
  assert.strictEqual(other.ok, false, "a different judged commit under the same id is a different node");
  const dropped = await sporCli.writeGateNode(cfg, "task-approve-head", old.replace("task-approve-eq", "task-approve-head"));
  assert.strictEqual(dropped.ok, false, "the tolerance is one way: a candidate WITHOUT the head is not the item that has one");
});

test("createRecord never exposes a torn record: the bytes land by link (or rename over a reservation), and a concurrent loser reads the winner", () => {
  const home = scratch();
  const file = runner.runPaths(home, "r-atomic").record;
  const origLink = fs.linkSync;
  // Force the no-link() fallback too.
  fs.linkSync = () => { const e = new Error("EPERM"); e.code = "EPERM"; throw e; };
  try {
    const made = runner.createRecord(file, { run_id: "r-atomic", name: "first" });
    assert.strictEqual(made.rev, 1);
    assert.strictEqual(runner.readJson(file).name, "first");
    assert.strictEqual(runner.createRecord(file, { run_id: "r-atomic", name: "second" }).name, "first");
  } finally {
    fs.linkSync = origLink;
  }
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), [], "no temp file is left behind");
  // The fallback's rename failing takes its empty reservation with it.
  const file2 = runner.runPaths(home, "r-atomic-2").record;
  const origRename = fs.renameSync;
  fs.linkSync = () => { const e = new Error("ENOTSUP"); e.code = "ENOTSUP"; throw e; };
  fs.renameSync = () => { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; };
  try {
    assert.throws(() => runner.createRecord(file2, { run_id: "r-atomic-2" }), /EBUSY/);
  } finally {
    fs.linkSync = origLink;
    fs.renameSync = origRename;
  }
  assert.strictEqual(fs.existsSync(file2), false, "no zero-byte record is left where a rename failed");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file2)).filter((f) => f.endsWith(".tmp")), []);
});

test("gateApprovalState binds the answer to the judged commit: an approval whose gate_head names another commit reads 'mismatch', not approved and not pending", async () => {
  const cfg = remoteCfg();
  const approved = { id: "task-approve-x", raw: `---\nid: task-approve-x\ntype: task\nstatus: done\ngate_head: ${OTHER}\n---\n\nb\n`, resolution: { by: "dec-ok" } };
  await withNodeBodies({ "task-approve-x": approved }, async () => {
    assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-x", { head: COMMIT }), { state: "mismatch", head: OTHER });
    assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-x", { head: OTHER }), { state: "approved", by: "dec-ok" });
    // No head asked for, or no gate_head on the item: read as before.
    assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-x"), { state: "approved", by: "dec-ok" });
  });
  const unbound = { id: "task-approve-y", raw: "---\nid: task-approve-y\ntype: task\nstatus: done\n---\n\nb\n", resolution: { by: "dec-ok" } };
  await withNodeBodies({ "task-approve-y": unbound }, async () => {
    assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-y", { head: COMMIT }), { state: "approved", by: "dec-ok" });
  });
});

test("the human gate hands the judged head to checkApproval and treats a 'mismatch' as a final refusal naming the item", async () => {
  const payload = { factory: "test", trusted_ref: "main", risk_classes: { "touches:auth": ["lib/auth.js"] }, gates: [{ id: "security", kind: "human", risk: ["touches:auth"] }] };
  const parsed = gates.parseFactory(["```json", JSON.stringify(payload), "```"].join("\n"), { id: "factory-test" });
  assert.deepStrictEqual(parsed.errors, []);
  const factory = parsed.factory;
  const seen = [];
  const deps = {
    now: () => 0,
    sleep: async () => {},
    changedPaths: async () => ({ ok: true, paths: ["lib/auth.js"], head: COMMIT, base: OTHER, trustedRef: "main", trustedSha: "c".repeat(40), branch: "task-demo" }),
    runSuite: async () => ({ ok: true }),
    review: async () => ({ ok: true, text: "" }),
    fix: async () => ({ ok: true }),
    recordFact: async ({ id }) => ({ ok: true, id }),
    fileTestLaneItem: async () => ({ ok: true, id: "task-test-lane-x" }),
    fileFlakeItem: async () => ({ ok: true, id: "issue-flake-x" }),
    fileHumanItem: async () => ({ ok: true, id: "task-approve-x" }),
    checkApproval: async (args) => { seen.push(args); return { state: "mismatch", head: OTHER }; },
    escalate: async () => ({ ok: true, id: "task-gate-x" }),
    demote: async () => ({ demoted: true }),
  };
  const res = await gateRunner.runGatePipeline({ item: { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" }, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen[0].head, COMMIT, "the poll asks about the judged head");
  assert.match(JSON.stringify(res), /bound to commit bbbbbbbbbbbb, not the judged aaaaaaaaaaaa/);
});

// ----------------------------------- percent-decoding before the .git rule --

test("a candidate locator is percent-decoded over the whole escape alphabet before the .git refusal — `%2e%67it` is `.git`, and a malformed escape is refused as such", () => {
  const ok = { kind: "bundle", locator: "file:///home/x/.spor/candidates/cand-1.bundle", key: "cand-1.bundle", commit: COMMIT };
  const store = { bundleStore: "file:///home/x/.spor/candidates" };
  assert.strictEqual(candidate.referenceRefusal(ok, store), null);
  assert.match(candidate.referenceRefusal({ ...ok, locator: "file:///home/x/.spor/candidates/%2e%67it/objects/c.bundle" }, store), /\.git directory/);
  assert.match(candidate.referenceRefusal({ ...ok, locator: "file:///home/x/.spor/candidates/.%67%69%74/c.bundle" }, store), /\.git directory/);
  assert.match(candidate.referenceRefusal({ ...ok, locator: "file:///home/x/.spor/candidates/%2egit/objects/c.bundle" }, store), /\.git directory/);
  assert.match(candidate.referenceRefusal({ ...ok, locator: "file:///home/x/.spor/candidates/%zz/c.bundle" }, store), /malformed percent-escape/);
  assert.match(candidate.referenceRefusal({ ...ok, locator: "file:///home/x/.spor/candidates/%2" }, store), /malformed percent-escape/);
  // ONE decode: a double-encoded dot reaches the fetcher as the literal `%2e`.
  assert.strictEqual(candidate.percentDecodedPath("file:///s/%252egit/x"), "file:///s/%2egit/x");
  assert.strictEqual(candidate.percentDecodedPath("a%zz"), null);
});

test("the bundle-store startup check applies the same decode: a store spelled into .git by any escape is a configuration error, as is a malformed escape", () => {
  const home = scratch();
  const check = (store) => candidatePublish.resolveBundleStore({ implementation: { candidate: { bundleStore: store } } }, { graphHome: home }).errors.join("\n");
  assert.match(check("file:///home/x/repo/%2e%67it/store"), /\.git directory/);
  assert.match(check("file:///home/x/repo/%2egit/store"), /\.git directory/);
  assert.match(check("file:///home/x/%zz/store"), /malformed percent-escape/);
});
