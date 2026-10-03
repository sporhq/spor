// THE GATE LEDGER'S ONE WRITER (lib/shell/agent-dispatch-runner.js
// appendGateProgress, reached through lib/shell/stage-projection.js
// writeGateProgress and makeGateDeps' save closures;
// task-spor-run-surfaces-read-stage-journal): the per-attempt finding ledger,
// rescue state, pools and carried flake obligations are an APPEND-ONLY LOG
// beside the run's stage journals (`gate-progress.jsonl`), never a field of
// the run record. The writer takes the RECORD lock so the three refusals the
// record writer enforced still hold — a settled pipeline, an owner that
// changed, an attempt that rolled over — and a refusal appends nothing; the
// record itself is never written. The projection (`latestProgress`) reads the
// last line back, and a record that predates the log is read (once, as the
// prior) and never rewritten.
require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runs = require('../lib/shell/agent-dispatch-runner');
const projection = require('../lib/shell/stage-projection');
const cli = require('../bin/spor.js');
const { loadConfig } = require('../lib/config');

function fixture(t, seed = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-progress-writer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runId = '11111111-2222-3333-4444-555555555555';
  const file = runs.runPaths(home, runId).record;
  runs.atomicJson(file, { run_id: runId, state: 'done', gate_state: 'running', gate_settle_id: 'owner-a', gate_regate_count: 0, ...seed });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const deps = () => cli.makeGateDeps(cfg, { entry: { node_id: 'task-demo', run_id: runId }, factory: { id: 'factory-test' }, log: () => {}, home });
  const ledger = () => projection.latestProgress(home, runs.readJson(file));
  const log = () => projection.readProgressLog(home, runId);
  return { home, runId, file, deps, read: () => runs.readJson(file), ledger, log };
}

test('every save is one appended line, the record is never written, and the projection reads the last line back', async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const deps = f.deps();
  await deps.saveGateProgress({ gate: { id: 'review' }, progress: { ledger: [{ id: 'F1' }], fixes: 1 } });
  await deps.saveRescueState({ rescues: [{ n: 1, gate: 'review' }] });
  await deps.saveGatePools({ pools: { retry: { spent: 1 } } });
  await deps.saveCarriedProgress({ carryKey: `${f.runId}|old`, progress: { evidence: { complete: true } } });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'the run record is byte-identical: the ledger is not a record field');
  assert.equal(f.log().length, 4, 'one line per save');
  const { stamp, source } = f.ledger();
  assert.equal(source, 'log');
  assert.deepEqual(stamp.gates, { review: { ledger: [{ id: 'F1' }], fixes: 1 } });
  assert.deepEqual(stamp.rescue, [{ n: 1, gate: 'review' }]);
  assert.deepEqual(stamp.pools, { retry: { spent: 1 } });
  assert.deepEqual(stamp.carried, { [`${f.runId}|old`]: { evidence: { complete: true } } });
  assert.equal(stamp.key, f.runId);
  assert.equal(stamp.seq, 4, 'the sequence counts every save');
  // The deps read exactly what they saved.
  assert.deepEqual(await deps.loadGateProgress({ gate: { id: 'review' } }), { ledger: [{ id: 'F1' }], fixes: 1, lastFix: null });
  assert.deepEqual(await deps.loadRescueState(), [{ n: 1, gate: 'review' }]);
  assert.deepEqual(await deps.loadGatePools(), { retry: { spent: 1 } });
});

test('progress callbacks merge debt that lands between the caller and the record lock, and preserve unknown top-level keys', async (t) => {
  for (const kind of ['gate', 'rescue', 'pool']) {
    const f = fixture(t);
    const deps = f.deps();
    const open = fs.openSync;
    let intercepted = false;
    fs.openSync = (file, flags, ...rest) => {
      if (!intercepted && file === `${f.file}.lock` && flags === 'wx') {
        intercepted = true;
        // A concurrent save (same owner) lands first: its debt must survive ours.
        runs.appendGateProgress(f.home, f.runId, { gates: { other: { evidence: { complete: false, receipt: 'owed' }, filingIntent: { id: 'intent' } } }, rescue: [{ n: 1 }], pools: { retry: { spent: 1, charge_receipt: 'paid' }, implementation: { spent: 2 } }, future_receipt: 'preserved' }, { key: f.runId, attempt: 1, own: 'owner-a' });
      }
      return open(file, flags, ...rest);
    };
    try {
      if (kind === 'gate') await deps.saveGateProgress({ gate: { id: 'review' }, progress: { ledger: [] } });
      if (kind === 'rescue') await deps.saveRescueState({ rescues: [{ n: 2 }] });
      if (kind === 'pool') await deps.saveGatePools({ pools: { retry: { spent: 2 } } });
    } finally { fs.openSync = open; }
    assert.equal(intercepted, true);
    const { stamp } = f.ledger();
    assert.equal(stamp.gates.other.evidence.receipt, 'owed', kind);
    assert.equal(stamp.gates.other.filingIntent.id, 'intent', kind);
    assert.equal(stamp.future_receipt, 'preserved', kind);
    assert.equal(stamp.seq, 2, kind);
    assert.equal(stamp.pools.retry.charge_receipt, 'paid');
    assert.equal(stamp.pools.implementation.spent, 2);
    if (kind !== 'rescue') assert.deepEqual(stamp.rescue, [{ n: 1 }]);
    if (kind !== 'pool') assert.equal(stamp.pools.retry.spent, 1);
    assert.equal(f.read().gate_progress, undefined, 'still no record field');
  }
});

test('fresh update callback performs one locked decision and refuses stale owner, attempt and terminal state — a refusal appends nothing', (t) => {
  const f = fixture(t);
  const opts = { key: f.runId, attempt: 1, own: 'owner-a' };
  let calls = 0;
  const reserve = (prior) => {
    calls++;
    const spent = prior.pools?.retry?.spent || 0;
    return spent < 1 ? { pools: { retry: { spent: spent + 1, receipt: 'one' } } } : null;
  };
  assert.equal(projection.writeGateProgress(f.home, f.runId, reserve, opts).ok, true);
  const paid = f.log();
  const refused = projection.writeGateProgress(f.home, f.runId, reserve, opts);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /refused/);
  assert.deepEqual(f.log(), paid, 'capacity refusal writes nothing');
  assert.equal(calls, 2);
  for (const [invalid, why] of [[{ own: 'owner-old' }, /owner changed/], [{ attempt: 2 }, /attempt changed/]]) {
    const r = projection.writeGateProgress(f.home, f.runId, reserve, { ...opts, ...invalid });
    assert.equal(r.ok, false);
    assert.match(r.reason, why);
  }
  assert.equal(calls, 2, 'rejected fences do not invoke the mutation');
  const locked = projection.writeGateProgress(f.home, f.runId, reserve, { ...opts, lock: () => ({ ok: false, reason: 'busy' }) });
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /locked \(busy\)/);
  assert.deepEqual(f.log(), paid, 'lock refusal writes nothing');
  runs.stampGateState(f.home, f.runId, { gate_state: 'passed' }, { own: 'owner-a' });
  const settled = projection.writeGateProgress(f.home, f.runId, reserve, opts);
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /already settled/);
  assert.equal(calls, 2);
  assert.deepEqual(f.log(), paid, 'even the current owner cannot reopen terminal progress');
});

test('saved closures cannot write for a new owner or re-gate; a launch stamp is a record stamp that preserves the ledger', async (t) => {
  const f = fixture(t);
  const old = f.deps();
  await old.saveGateProgress({ gate: { id: 'review' }, progress: { filingIntent: { id: 'old' } } });
  const prior = f.ledger().stamp;
  // The fix/rescue launch stamps stay on the RECORD (a child run's identity)
  // and leave the log untouched.
  const stamped = runs.stampGateState(f.home, f.runId, { gate_fix_run_id: 'fix-one' }, { own: 'owner-a' });
  assert.equal(stamped.gate_fix_run_id, 'fix-one');
  assert.deepEqual(f.ledger().stamp, prior);
  assert.equal(f.read().gate_state, 'running');
  assert.equal(f.read().state, 'done');
  runs.stampGateState(f.home, f.runId, { gate_settle_id: 'owner-b', gate_regate_count: 1 }, { own: 'owner-a' });
  const lines = f.log().length;
  for (const write of [() => old.saveGateProgress({ gate: { id: 'review' }, progress: {} }), () => old.saveRescueState({ rescues: [] }), () => old.saveGatePools({ pools: {} }), () => old.saveCarriedProgress({ carryKey: 'x', progress: {} })]) {
    await assert.rejects(async () => write(), /could not be updated/);
  }
  assert.equal(f.log().length, lines, 'a stale owner appends nothing');
  const fresh = projection.writeGateProgress(f.home, f.runId, { gates: { review: { ledger: [] } } }, { key: `${f.runId}#r2`, attempt: 2, own: 'owner-b' });
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.progress.gates.review, { ledger: [] }, 'new attempt does not inherit old state');
  assert.deepEqual(Object.keys(fresh.progress.carried), [f.runId + '|review'], 'but it CARRIES what the old attempt still owes');
});

test('a failed callback cannot publish its partial reservation', (t) => {
  const f = fixture(t);
  const before = f.log();
  const result = projection.writeGateProgress(f.home, f.runId, (p) => { p.pools = { retry: { spent: 1 } }; throw new Error('write failed'); }, { key: f.runId, own: 'owner-a' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /threw: write failed/);
  assert.deepEqual(f.log(), before);
});

test('a record that predates the log (a legacy `gate_progress` stamp) is the read-only prior: read by the loaders, carried by the first write, never rewritten', async (t) => {
  const runId = '11111111-2222-3333-4444-555555555555';
  const legacy = { key: runId, seq: 3, gates: { review: { fixes: 1, ledger: [{ id: 'F1' }], evidence: { complete: false, gate: { id: 'review' } } } }, rescue: [{ n: 1, gate: 'review' }], pools: { retry: { spent: 1 } } };
  const f = fixture(t, { gate_progress: legacy });
  const deps = f.deps();
  assert.equal(f.ledger().source, 'record');
  assert.equal((await deps.loadGateProgress({ gate: { id: 'review' } })).fixes, 1, 'the loaders read the legacy stamp');
  assert.deepEqual(await deps.loadGatePools(), { retry: { spent: 1 } });
  assert.equal(projection.owesEvidence(f.home, f.read()), true, 'its owed evidence counts');
  // The first write under the SAME attempt key continues from it in the log…
  await deps.saveGateProgress({ gate: { id: 'acceptance' }, progress: { fixes: 0 } });
  const after = f.ledger();
  assert.equal(after.source, 'log');
  assert.equal(after.stamp.seq, 4, 'the sequence continues from the legacy stamp');
  assert.deepEqual(Object.keys(after.stamp.gates).sort(), ['acceptance', 'review']);
  assert.deepEqual(f.read().gate_progress, legacy, 'the record is never rewritten');
  // …and a new attempt carries only the debt.
  runs.stampGateState(f.home, f.runId, { gate_settle_id: 'owner-b', gate_regate_count: 1 }, { own: 'owner-a' });
  const rolled = projection.writeGateProgress(f.home, f.runId, { gates: {} }, { key: `${runId}#r2`, attempt: 2, own: 'owner-b' });
  assert.equal(rolled.ok, true, rolled.reason);
  assert.deepEqual(Object.keys(rolled.progress.carried), [`${runId}|review`]);
  assert.deepEqual(rolled.progress.gates, {});
});

test('a torn final line is dropped on read; a corrupt interior line fails the read closed', (t) => {
  const f = fixture(t);
  assert.equal(projection.writeGateProgress(f.home, f.runId, { gates: { g: { fixes: 1 } } }, { key: f.runId, own: 'owner-a' }).ok, true);
  const abs = projection.progressLogPath(f.home, f.runId);
  fs.appendFileSync(abs, '{"kind":"progress","stamp":{"key":"x","gates":{"g":{"fixes":9');
  assert.equal(f.ledger().stamp.gates.g.fixes, 1, 'the torn tail is not a stamp');
  const next = projection.writeGateProgress(f.home, f.runId, { gates: { g: { fixes: 2 } } }, { key: f.runId, own: 'owner-a' });
  assert.equal(next.ok, true, 'the append repairs the framing first');
  assert.equal(f.ledger().stamp.gates.g.fixes, 2);
  assert.equal(f.log().length, 2);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines[0] = '{not json';
  fs.writeFileSync(abs, lines.join('\n'));
  assert.throws(() => projection.readProgressLog(f.home, f.runId), /corrupt at line 1/);
  assert.throws(() => f.ledger(), /corrupt/);
});

test('a builder cannot mutate fields outside the gate namespace through its input record', (t) => {
  const f = fixture(t);
  const result = runs.stampGateState(f.home, f.runId, (fresh) => {
    fresh.state = 'vanished';
    fresh.gate_settle_id = 'forged';
    return { gate_fix_run_id: 'fixed', state: 'failed' };
  }, { own: 'owner-a' });
  assert.equal(result.gate_fix_run_id, 'fixed');
  assert.equal(f.read().state, 'done');
  assert.equal(f.read().gate_settle_id, 'owner-a');
});

test('a fix launch stamp from UNOWNED deps lands only on a record nobody has claimed since — the same arm the ledger writer refuses on, so a worker never adopts a fix a standalone caller launched', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-progress-writer-unowned-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runId = '22222222-2222-3333-4444-555555555555';
  const file = runs.runPaths(home, runId).record;
  // Unclaimed when the deps are made: no nonce, no gate_at.
  runs.atomicJson(file, { run_id: runId, node_id: 'task-demo', state: 'done', terminal_state: 'resolved', terminal_enforced: true, created_at: new Date().toISOString() });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const mk = () => cli.makeGateDeps(cfg, {
    record: { node_id: 'task-demo', cwd: home }, entry: { run_id: runId, node_id: 'task-demo', project: null }, factory: { id: 'factory-test' },
    slug: null, passthrough: {}, warn: () => {}, log: () => {}, stopping: () => false, home,
    dispatch: async () => {
      runs.atomicJson(runs.runPaths(home, 'fix-run-standalone').record, { run_id: 'fix-run-standalone', node_id: 'task-demo', state: 'running', created_at: new Date().toISOString() });
      return { ok: true, run: { run_id: 'fix-run-standalone', harness: 'fake' } };
    },
  });
  const unowned = mk();
  // Still unclaimed: the standalone caller's launch stamp lands.
  const first = await unowned.dispatchFix({ gate: { id: 'acceptance' }, cycle: 0, findings: [], detail: 'the suite fails', evidence: '' });
  assert.equal(first.ok, true, first.reason);
  assert.equal(runs.readJson(file).gate_fix_run_id, 'fix-run-standalone');
  // A worker claims the record; the standalone's next launch stamp is refused
  // (and the fix cycle with it), exactly as its ledger write is.
  const claim = runs.claimPipeline(home, runId, { workerId: 'worker-1' });
  assert.equal(claim.ok, true, claim.refused);
  runs.stampGateState(home, runId, { gate_fix_run_id: null, gate_fix_gate: null, gate_fix_cycle: null }, { own: claim.token });
  await assert.rejects(() => unowned.dispatchFix({ gate: { id: 'acceptance' }, cycle: 1, findings: [], detail: 'still failing', evidence: '' }), /could not be updated: the gate pipeline is settled or its owner changed/);
  await assert.rejects(() => unowned.saveGateProgress({ gate: { id: 'acceptance' }, progress: { fixes: 1 } }), /owner changed/);
  const after = runs.readJson(file);
  assert.equal(after.gate_fix_run_id, null, "the worker's record gained no fix id it did not launch");
  assert.equal(after.gate_settle_id, undefined, 'the claim is a lease entry, never a record stamp');
  assert.equal(projection.pipelineLease(home, after).token, claim.token);
});
