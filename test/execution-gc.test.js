// THE EXECUTION JOURNAL SWEEP and the person-facing outbox door
// (task-spor-execution-journal-gc-takeovers-and-locks, derived from
// issue-spor-execution-outbox-unlocked-rmw-and-adoption-cutoff and
// issue-spor-execution-event-lost-on-outbox-lock-contention).
//   1. gcExecutions: an ENDED execution's takeover ledger, empty outbox files
//      and gone holders' lock files are collected; a live execution's are
//      not; an execution whose outbox holds ANY line (a stranded one
//      included) is spared whole.
//   2. resolveOutbox / `spor executions --discard|--adopt`: a stranded file
//      is resolved by a person, confirmed, journaled with every line.
//   3. the summary counts only replayable lines.
//   4. local-mode item-lock contention is retryable: the reporter holds the
//      event and redelivers it.
//   5. a store answer with no fence never strands the reporter's held queue.
// No live graph, no model call; the only network is loopback to the fake.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const store = require("../lib/shell/execution-store.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { loadConfig } = require("../lib/config.js");
const spor = require("../bin/spor.js");
const { startFakeExecutionServer } = require("./helpers/fake-execution-server.js");
const { hermeticEnv } = require("./helpers/env.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const tag = (instance) => sha256(instance).slice(0, 16);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `spor-execgc-${p}-`));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const deadPidNow = () => Number(require("node:child_process").spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const outboxLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const T0 = "2026-09-06T12:00:00.000Z";
const CAND = { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40), provenance: { attempt: 1 }, reference: { kind: "git", commit: "b".repeat(40), verified_at: T0 } };

function itemNode(id) {
  return `---
id: ${id}
type: task
project: spor
title: Title of ${id}
summary: Standalone summary for ${id} used by the execution gc tests.
date: 2026-09-01
status: open
---
Body of ${id}.
`;
}
function remoteCfg(dir, base) {
  return loadConfig({ cwd: dir, env: { SPOR_HOME: dir, XDG_CONFIG_HOME: dir, SPOR_SERVER: base, SPOR_TOKEN: "tok-a", SPOR_DISPATCH_AGENT: "agent-a" } });
}
async function box(tagName) {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  const home = tmp(tagName);
  const cfg = remoteCfg(home, fake.base);
  // Instances are suffixed per box: the store's fence/loss maps are
  // process-global, keyed by (instance, execution id), and every box mints
  // the same execution id.
  return { fake, home, cfg, open: (instance, extra = {}) => store.openExecutionStore(cfg, { home, machine: "box", instance: `${instance}-${tagName}`, ...extra }), inst: (instance) => `${instance}-${tagName}` };
}
const execDir = (home, tn = "remote") => path.join(home, "journal", "executions", tn, "exec");
// Every file of `id` across the tenant partitions (the record copy is filed
// under the server's partition, `acme`; the outbox under the label `remote`).
const filesOf = (home, id) => {
  const out = [];
  for (const tn of store.tenants(home)) {
    try {
      out.push(...fs.readdirSync(execDir(home, tn)).filter((n) => n.startsWith(`${id}.`)).map((n) => `${tn}/${n}`));
    } catch {
      /* no exec dir */
    }
  }
  return out.sort();
};
// A lock artifact left by a process that is gone, aged past the stale bound.
function plantDeadLock(file, { ageMs = 60 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), pid: deadPidNow(), ticks: null, token: crypto.randomUUID() }));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}
function plantLiveLock(file, { ageMs = 60 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), pid: process.pid, ticks: null, token: crypto.randomUUID() }));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}
// Fence 3 was granted ELSEWHERE (never in this box's ledger) and fence 4
// here: a gone holder's line under fence 2 then has a loss this box cannot
// date — the stranded case.
function ledgerGap(b, id) {
  store.appendJsonlLine(store.takeoverPath(b.home, "remote", id), { fence: 4, at: new Date().toISOString(), instance: "elsewhere-then-here", machine: "box" });
}
// An execution held by A then taken over by B (so the ledger has two
// grants), with the given gone holder's outbox line, if any, planted.
async function twoGrants(b) {
  const A = b.open("pA-gc");
  const o = await A.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
  const id = o.execution.execution_id;
  assert.equal((await A.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
  await pause(5);
  const B = b.open("pB-gc");
  assert.equal((await B.claim(id, { takeover: true })).fence, 2);
  return { id, A, B };
}

// ---------- 1. the sweep ----------

test("gc: an execution run to TERMINAL leaves no takeover ledger, empty outbox or lock file behind; its record and event history stay", async () => {
  const b = await box("terminal");
  try {
    const { id, B } = await twoGrants(b);
    assert.ok(fs.existsSync(store.takeoverPath(b.home, "remote", id)), "the takeover ledger was written");
    assert.equal((await B.release(id, { fence: 2 })).ok, true, "released: terminal on the server and in the cached copy");
    // What a crash can leave: a gone holder's lock and a breaker's moved
    // copy, plus a zero-byte outbox file.
    const lock = path.join(execDir(b.home), `${id}.outbox.lock`);
    plantDeadLock(lock);
    plantDeadLock(`${lock}.dead-${crypto.randomUUID()}`);
    fs.writeFileSync(store.outboxPath(b.home, "remote", id, tag(b.inst("pA-gc"))), "");
    const stat = await store.gcExecutions(b.home);
    assert.deepEqual(stat.collected, [id], JSON.stringify(stat));
    assert.deepEqual(filesOf(b.home, id), [`acme/${id}.json`], "only the record copy remains — no ledger, outbox or lock file");
    // Idempotent: a second sweep finds nothing to do.
    const again = await store.gcExecutions(b.home);
    assert.deepEqual(again.collected, []);
    assert.equal(again.removed, 0);
  } finally {
    await b.fake.close();
  }
});

test("gc: a LIVE execution's ledger and a live holder's lock are untouched; only a gone holder's stale lock is broken", async () => {
  const b = await box("live");
  try {
    const { id } = await twoGrants(b);
    const ledger = store.takeoverPath(b.home, "remote", id);
    const before = fs.readFileSync(ledger, "utf8");
    const lock = path.join(execDir(b.home), `${id}.outbox.lock`);
    plantLiveLock(lock);
    const stat = await store.gcExecutions(b.home);
    assert.deepEqual(stat.collected, []);
    assert.equal(fs.readFileSync(ledger, "utf8"), before, "the live execution's ledger is untouched");
    assert.ok(fs.existsSync(lock), "a live holder's lock is never removed, however old");
    fs.rmSync(lock);
    // A gone holder's lock younger than the stale bound is left for the next
    // acquirer; past it, the sweep breaks it through the lock's own protocol.
    plantDeadLock(lock, { ageMs: 1000 });
    await store.gcExecutions(b.home);
    assert.ok(fs.existsSync(lock), "not yet stale");
    plantDeadLock(lock);
    await store.gcExecutions(b.home);
    assert.equal(fs.existsSync(lock), false, "a stale dead holder's lock is broken");
    assert.equal(fs.readFileSync(ledger, "utf8"), before);
  } finally {
    await b.fake.close();
  }
});

test("gc: an abandoned breaker (its process gone) is removed once stale, which unwedges the lock; a live breaker is not", async () => {
  const home = tmp("breaker");
  const dir = path.join(home, "journal", "executions", "local", "item");
  const base = path.join(dir, "task-x.json");
  plantLiveLock(`${base}.lock.break`);
  await store.gcExecutions(home);
  assert.ok(fs.existsSync(`${base}.lock.break`), "a live breaker is in flight — left alone");
  fs.rmSync(`${base}.lock.break`);
  plantDeadLock(`${base}.lock.break`);
  plantDeadLock(`${base}.lock.dead-${crypto.randomUUID()}`);
  plantDeadLock(`${base}.lock`);
  const stat = await store.gcExecutions(home);
  assert.deepEqual(fs.readdirSync(dir), [], JSON.stringify(stat));
});

test("gc: a terminal execution whose outbox holds ANY line — a stranded one — is spared whole: ledger and file kept byte-for-byte", async () => {
  const b = await box("stranded");
  try {
    const { id, B } = await twoGrants(b);
    assert.equal((await B.release(id, { fence: 2 })).ok, true);
    // A gone process's line written under fence 2, whose loss (fence 3) this
    // box never recorded: undatable, so stranded.
    const xFile = store.outboxPath(b.home, "remote", id, tag("pX-gone"));
    fs.writeFileSync(xFile, `${JSON.stringify({ event: { type: "gate.settled", gate_id: "acceptance", attempt: 9, state: "failed" }, queued_at: new Date(Date.now() - 60000).toISOString(), fence: 2, by: { instance: "pX-gone", machine: "box", pid: deadPidNow(), ticks: null } })}\n`);
    ledgerGap(b, id);
    const before = fs.readFileSync(xFile, "utf8");
    const ledgerBefore = fs.readFileSync(store.takeoverPath(b.home, "remote", id), "utf8");
    const stat = await store.gcExecutions(b.home);
    assert.deepEqual(stat.collected, []);
    assert.deepEqual(stat.spared, [{ id, reason: "outbox holds lines" }]);
    assert.equal(fs.readFileSync(xFile, "utf8"), before);
    assert.equal(fs.readFileSync(store.takeoverPath(b.home, "remote", id), "utf8"), ledgerBefore);
    // The report a reader (no grant of its own) sees names it stranded.
    const R = b.open("pR-reader");
    assert.deepEqual(R.outboxReport(id).map((f) => [f.state, f.lines, f.replayable]), [["stranded", 1, 0]]);

    // ---------- 2. the person-facing door ----------
    // Dry run first: nothing changes.
    const dry = await R.resolveOutbox(id, { action: "discard", file: tag("pX-gone"), dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.equal(dry.dry_run, true);
    assert.equal(fs.readFileSync(xFile, "utf8"), before);
    assert.equal(fs.existsSync(store.resolutionsPath(b.home, "remote", id)), false);
    const done = await R.resolveOutbox(id, { action: "discard", file: "pX-gone", by: "tester@box" });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(fs.existsSync(xFile), false);
    const journal = outboxLines(store.resolutionsPath(b.home, "remote", id));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].action, "discard");
    assert.equal(journal[0].by, "tester@box");
    assert.deepEqual(journal[0].lines.map((l) => l.event.attempt), [9], "the discarded lines are journaled, so the discard is recoverable");
    // Now terminal and empty: collected; the audit journal is history and stays.
    const after = await store.gcExecutions(b.home);
    assert.deepEqual(after.collected, [id]);
    assert.deepEqual(filesOf(b.home, id), [`acme/${id}.json`, `remote/${id}.outbox-resolutions.jsonl`]);
  } finally {
    await b.fake.close();
  }
});

test("resolveOutbox: an adoptable or live file is refused (the adapter owns it); an unknown name and a non-stranded state say so", async () => {
  const b = await box("refuse");
  try {
    const { id, A, B } = await twoGrants(b);
    b.fake.state.down = true;
    await A.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 3, state: "failed" } });
    b.fake.state.down = false;
    const r = await B.resolveOutbox(id, { action: "discard", file: tag(b.inst("pA-gc")) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "not_stranded", JSON.stringify(r));
    assert.equal(r.state, "live");
    assert.equal((await B.resolveOutbox(id, { action: "adopt", file: "nope-nope-nope" })).code, "not_found");
    assert.equal((await B.resolveOutbox(id, { action: "explode", file: tag(b.inst("pA-gc")) })).code, "invalid_action");
  } finally {
    await b.fake.close();
  }
});

test("resolveOutbox adopt: a stranded file's lines move to the shared outbox (authorship stripped, provenance kept) and the next holder replays them", async () => {
  const b = await box("adopt");
  try {
    const { id } = await twoGrants(b);
    const xFile = store.outboxPath(b.home, "remote", id, tag("pX-gone"));
    fs.writeFileSync(xFile, `${JSON.stringify({ event: { type: "gate.settled", gate_id: "acceptance", attempt: 4, state: "passed" }, queued_at: new Date(Date.now() - 60000).toISOString(), fence: 2, by: { instance: "pX-gone", machine: "box", pid: deadPidNow(), ticks: null } })}\n`);
    ledgerGap(b, id);
    const R = b.open("pR-adopt");
    const done = await R.resolveOutbox(id, { action: "adopt", file: tag("pX-gone") });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(fs.existsSync(xFile), false);
    const shared = outboxLines(store.outboxPath(b.home, "remote", id));
    assert.equal(shared.length, 1);
    assert.equal(shared[0].by, undefined, "authorship stripped: a forfeit hands it back to the shared file, not the stranded one");
    assert.equal(shared[0].adopted_from, `${id}.outbox.${tag("pX-gone")}.jsonl`);
    assert.deepEqual(R.outboxReport(id).map((f) => [f.state, f.replayable]), [["shared", 1]]);
    // The holder (B, fence 2) — a fresh instance after a restart — adopts the
    // shared file wholesale and replays it.
    await pause(5);
    const N = b.open("pN-adopt");
    const claimed = await N.claim(id, { takeover: true });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const rec = await N.reconcile(id, { fence: claimed.fence });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.replayed, 1);
    assert.deepEqual(b.fake.events(id).filter((e) => e.type === "gate.settled").map((e) => e.attempt), [4]);
  } finally {
    await b.fake.close();
  }
});

// ---------- 3. the CLI ----------

function runCli(home, base, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, "..", "bin", "spor.js"), "executions", ...args], { cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "tok-a", SPOR_DISPATCH_AGENT: "agent-a" }), encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test("cli: the summary counts only REPLAYABLE lines; --discard needs --yes, then journals and removes the stranded file", async () => {
  const b = await box("cli");
  try {
    const { id } = await twoGrants(b);
    const xFile = store.outboxPath(b.home, "remote", id, tag("pX-cli"));
    fs.writeFileSync(xFile, `${JSON.stringify({ event: { type: "gate.settled", gate_id: "acceptance", attempt: 9, state: "failed" }, queued_at: new Date(Date.now() - 60000).toISOString(), fence: 2, by: { instance: "pX-cli", machine: os.hostname(), pid: deadPidNow(), ticks: null } })}\n`);
    ledgerGap(b, id);
    const shown = await runCli(b.home, b.fake.base, [id]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.doesNotMatch(shown.stdout, /owed to the server — replayed/, "a stranded line is not counted as replayed");
    assert.match(shown.stdout, /1 line\(s\) NOT replayed/);
    assert.match(shown.stdout, /STRANDED/);
    const unconfirmed = await runCli(b.home, b.fake.base, ["--discard", id, "--file", tag("pX-cli")]);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.stderr, /confirmation required/);
    assert.ok(fs.existsSync(xFile), "nothing happens without --yes");
    const confirmed = await runCli(b.home, b.fake.base, ["--discard", id, "--file", tag("pX-cli"), "--yes"]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /discarded 1 line/);
    assert.equal(fs.existsSync(xFile), false);
    assert.equal(outboxLines(store.resolutionsPath(b.home, "remote", id)).length, 1);
  } finally {
    await b.fake.close();
  }
});

// ---------- 4. local-mode lock contention is retryable ----------

function holdLockInChild(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const held = path.join(tmp("lockchild"), "held");
  const release = `${held}.release`;
  const script = `
    const fs = require("node:fs");
    const { withLocalExecutionLock } = require(${JSON.stringify(path.join(__dirname, "..", "lib", "shell", "local-execution-lock.js"))});
    withLocalExecutionLock(${JSON.stringify(file)}, async () => {
      fs.writeFileSync(${JSON.stringify(held)}, "1");
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 10));
    }).then(() => process.exit(0));`;
  const child = require("node:child_process").spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  const exited = new Promise((r) => child.on("exit", r));
  return {
    ready: async () => {
      for (let i = 0; i < 500 && !fs.existsSync(held); i++) await pause(10);
      assert.ok(fs.existsSync(held), "the child took the lock");
    },
    release: async () => {
      fs.writeFileSync(release, "1");
      await exited;
    },
  };
}

test("local store: an event refused only by item-lock contention is UNSPOOLED and retryable — the reporter holds it and redelivers it once the lock frees", async () => {
  const home = tmp("local-lock");
  const st = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "pL-local", pinRead: (id) => ({ revision: `rev-${id}`, repo: "spor" }) });
  const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
  const id = o.execution.execution_id;
  const record = { run_id: "run-local-lock", node_id: "task-x", impl_claim: { execution_id: id, store: "local", fence: o.fence, gates: ["acceptance"], completion: { by: "controller", after: "gates" } } };
  const rp = dispatchRuns.runPaths(home, record.run_id);
  fs.mkdirSync(path.dirname(rp.record), { recursive: true });
  fs.writeFileSync(rp.record, JSON.stringify(record));
  const logs = [];
  const reporter = spor.executionReporter({ userConfigHome: () => home }, record, { home, store: st, log: (l) => logs.push(l) });
  const child = holdLockInChild(store.itemPath(home, "local", "task-x"));
  await child.ready();
  // The raw door says so.
  const raw = await st.event(id, { fence: o.fence, event: { type: "stage.observed", attempt: 1, state: "running" } });
  assert.equal(raw.ok, false);
  assert.equal(raw.code, "conflict");
  assert.equal(raw.unspooled, true, JSON.stringify(raw));
  assert.equal(raw.transient, true);
  // The reporter holds it rather than logging it "not recorded".
  const sent = await reporter.stageObserved(2, "running");
  assert.equal(sent.held, true, JSON.stringify(sent));
  assert.equal(reporter.held >= 1, true);
  assert.equal(logs.some((l) => /not recorded/.test(l)), false, logs.join("\n"));
  assert.ok(logs.some((l) => /held in memory/.test(l)), logs.join("\n"));
  await child.release();
  assert.equal(await reporter.flushHeld(), true);
  assert.equal(reporter.held, 0);
  assert.equal(spor.HELD_REPORTERS.has(reporter), false);
  assert.deepEqual(store.readEvents(home, "local", id).filter((e) => e.type === "stage.observed").map((e) => e.attempt), [2], "delivered exactly once (the raw refused event was never recorded)");
});

// ---------- 5. a fence-less answer never wedges the held queue ----------

test("reporter: a claim answered WITHOUT a fence keeps the one in force, so events held under it still drain; nothing reads an undelivered queue as flushed", async () => {
  let locked = true;
  const sent = [];
  const st = {
    ttlMs: 1000,
    async event(_id, { fence, event }) {
      if (locked) return { ok: false, code: "outbox_unwritable", unspooled: true, message: "locked" };
      sent.push([fence, event.type]);
      return { ok: true };
    },
    async claim() {
      return { ok: true, execution: { execution_id: "exec-1" } }; // no fence
    },
    async reconcile() {
      return { ok: true, replayed: 0, pending: 0 };
    },
    async renew() {
      return { ok: true };
    },
  };
  const home = tmp("nofence");
  const record = { run_id: "run-nofence", node_id: "task-x", impl_claim: { execution_id: "exec-1", store: "remote", fence: 3, gates: ["acceptance"], completion: { by: "controller", after: "gates" } } };
  const reporter = spor.executionReporter({ userConfigHome: () => home }, record, { home, store: st });
  assert.equal((await reporter.stageObserved(1, "running")).held, true);
  assert.equal((await reporter.resume()).ok, true);
  assert.equal(reporter.fence, 3, "a fence-less answer does not clear the fence in force");
  assert.equal(await reporter.flushHeld(), false, "still contended: reported blocked, not flushed");
  locked = false;
  await reporter.renew();
  assert.equal(reporter.held, 0);
  assert.deepEqual(sent, [[3, "stage.observed"]]);
  spor.HELD_REPORTERS.delete(reporter);
});

// ---------- review findings ----------

test("report: a dead holder of the CURRENT fence that nobody has taken over from is adoptable, never stranded — a person cannot discard its owed backlog", async () => {
  const b = await box("current");
  try {
    const A = b.open("pA");
    const o = await A.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await A.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    b.fake.state.down = true;
    assert.equal((await A.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } })).deferred, true);
    b.fake.state.down = false;
    // A dies holding fence 1; the ledger has no fence-2 grant yet.
    const aFile = store.outboxPath(b.home, "remote", id, tag(b.inst("pA")));
    const gone = deadPidNow();
    fs.writeFileSync(aFile, outboxLines(aFile).map((l) => JSON.stringify({ ...l, by: { ...l.by, pid: gone, ticks: null }, ...(l.held_by ? { held_by: { ...l.held_by, pid: gone, ticks: null } } : {}) })).join("\n") + "\n");
    const R = b.open("pR");
    assert.deepEqual(R.outboxReport(id).map((f) => [f.state, f.lines, f.replayable]), [["adoptable", 1, 1]]);
    const refused = await R.resolveOutbox(id, { action: "discard", file: tag(b.inst("pA")) });
    assert.equal(refused.code, "not_stranded", JSON.stringify(refused));
    assert.ok(fs.existsSync(aFile));
    // ...and the real next holder does replay it.
    await pause(5);
    const N = b.open("pN");
    const c = await N.claim(id, { takeover: true });
    assert.equal(c.fence, 2);
    assert.equal((await N.reconcile(id, { fence: 2 })).replayed, 1);
  } finally {
    await b.fake.close();
  }
});

test("terminal: a TERMINAL execution's adoptable line is reported unreplayable; adopt is refused, discard is allowed, and the sweep then collects it", async () => {
  const b = await box("ended");
  try {
    const A = b.open("pA");
    const o = await A.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await A.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    b.fake.state.down = true;
    await A.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } });
    b.fake.state.down = false;
    const aFile = store.outboxPath(b.home, "remote", id, tag(b.inst("pA")));
    const gone = deadPidNow();
    fs.writeFileSync(aFile, outboxLines(aFile).map((l) => JSON.stringify({ ...l, by: { ...l.by, pid: gone, ticks: null } })).join("\n") + "\n");
    await pause(5);
    const B = b.open("pB");
    assert.equal((await B.claim(id, { takeover: true })).fence, 2);
    assert.equal((await B.release(id, { fence: 2 })).ok, true, "released before any reconcile adopted A's file");
    const R = b.open("pR");
    assert.deepEqual(R.outboxReport(id).map((f) => [f.state, f.replayable, f.terminal]), [["adoptable", 0, true]]);
    assert.deepEqual((await store.gcExecutions(b.home)).spared, [{ id, reason: "outbox holds lines" }]);
    assert.equal((await R.resolveOutbox(id, { action: "adopt", file: tag(b.inst("pA")) })).code, "execution_terminal");
    const done = await R.resolveOutbox(id, { action: "discard", file: tag(b.inst("pA")) });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.deepEqual((await store.gcExecutions(b.home)).collected, [id]);
    assert.equal(fs.existsSync(store.takeoverPath(b.home, "remote", id)), false);
  } finally {
    await b.fake.close();
  }
});

test("gc: one sweep at a time per home — a sweep that finds another running is skipped, touching nothing", async () => {
  const home = tmp("onesweep");
  const dir = path.join(home, "journal", "executions", "local", "item");
  plantDeadLock(path.join(dir, "task-x.json.lock.dead-x"));
  const gate = path.join(home, "journal", "executions", ".gc");
  const { withLocalExecutionLock } = require("../lib/shell/local-execution-lock.js");
  let inner;
  await withLocalExecutionLock(gate, async () => {
    inner = await store.gcExecutions(home);
  });
  assert.equal(inner.skipped, "another sweep is running");
  assert.ok(fs.existsSync(path.join(dir, "task-x.json.lock.dead-x")));
  const after = await store.gcExecutions(home);
  assert.equal(after.skipped, undefined);
  assert.equal(fs.existsSync(path.join(dir, "task-x.json.lock.dead-x")), false);
});
