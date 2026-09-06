require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runs = require('../lib/shell/agent-dispatch-runner');
const cli = require('../bin/spor.js');
const { loadConfig } = require('../lib/config');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-progress-writer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runId = '11111111-2222-3333-4444-555555555555';
  const file = runs.runPaths(home, runId).record;
  runs.atomicJson(file, { run_id: runId, state: 'done', gate_state: 'running', gate_settle_id: 'owner-a', gate_regate_count: 0 });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const deps = () => cli.makeGateDeps(cfg, { entry: { node_id: 'task-demo', run_id: runId }, factory: { id: 'factory-test' }, log: () => {}, home });
  return { home, runId, file, deps, read: () => runs.readJson(file) };
}

test('progress callbacks merge debt that lands between the caller and record lock', async (t) => {
  for (const kind of ['gate', 'rescue', 'pool']) {
    const f = fixture(t);
    const deps = f.deps();
    const open = fs.openSync;
    let intercepted = false;
    fs.openSync = (file, flags, ...rest) => {
      if (!intercepted && file === `${f.file}.lock` && flags === 'wx') {
        intercepted = true;
        runs.stampGateState(f.home, f.runId, {
          gate_progress: { key: f.runId, seq: 7, gates: { other: { evidence: { complete: false, receipt: 'owed' }, filingIntent: { id: 'intent' } } }, rescue: [{ n: 1 }], pools: { retry: { spent: 1, charge_receipt: 'paid' }, implementation: { spent: 2 } }, future_receipt: 'preserved' },
          gate_fix_run_id: 'fix-other', gate_rescue_run_id: 'rescue-other',
        });
      }
      return open(file, flags, ...rest);
    };
    try {
      if (kind === 'gate') await deps.saveGateProgress({ gate: { id: 'review' }, progress: { ledger: [] } });
      if (kind === 'rescue') await deps.saveRescueState({ rescues: [{ n: 2 }] });
      if (kind === 'pool') await deps.saveGatePools({ pools: { retry: { spent: 2 } } });
    } finally { fs.openSync = open; }
    assert.equal(intercepted, true);
    const record = f.read();
    assert.equal(record.gate_progress.gates.other.evidence.receipt, 'owed', kind);
    assert.equal(record.gate_progress.gates.other.filingIntent.id, 'intent', kind);
    assert.equal(record.gate_progress.future_receipt, 'preserved', kind);
    assert.equal(record.gate_progress.seq, 8, kind);
    assert.equal(record.gate_progress.pools.retry.charge_receipt, 'paid');
    assert.equal(record.gate_progress.pools.implementation.spent, 2);
    assert.equal(record.gate_fix_run_id, 'fix-other');
    assert.equal(record.gate_rescue_run_id, 'rescue-other');
    if (kind !== 'rescue') assert.deepEqual(record.gate_progress.rescue, [{ n: 1 }]);
    if (kind !== 'pool') assert.equal(record.gate_progress.pools.retry.spent, 1);
  }
});

test('fresh update callback performs one locked decision and refuses stale owner, attempt and terminal state', (t) => {
  const f = fixture(t);
  const opts = { key: f.runId, attempt: 1, own: 'owner-a' };
  let calls = 0;
  const reserve = (prior) => {
    calls++;
    const spent = prior.pools?.retry?.spent || 0;
    return spent < 1 ? { pools: { retry: { spent: spent + 1, receipt: 'one' } } } : null;
  };
  assert.equal(runs.updateGateProgress(f.home, f.runId, reserve, opts).ok, true);
  const paid = f.read();
  assert.equal(runs.updateGateProgress(f.home, f.runId, reserve, opts).ok, false);
  assert.deepEqual(f.read(), paid, 'capacity refusal writes nothing');
  assert.equal(calls, 2);
  for (const invalid of [{ own: 'owner-old' }, { attempt: 2 }]) {
    assert.equal(runs.updateGateProgress(f.home, f.runId, reserve, { ...opts, ...invalid }).ok, false);
  }
  assert.equal(calls, 2, 'rejected fences do not invoke the mutation');
  assert.equal(runs.updateGateProgress(f.home, f.runId, reserve, { ...opts, lock: () => ({ ok: false, reason: 'busy' }) }).ok, false);
  assert.deepEqual(f.read(), paid, 'lock refusal writes nothing');
  runs.stampGateState(f.home, f.runId, { gate_state: 'passed' }, { own: 'owner-a' });
  const settled = f.read();
  assert.equal(runs.updateGateProgress(f.home, f.runId, reserve, opts).ok, false);
  assert.equal(calls, 2);
  assert.deepEqual(f.read(), settled, 'even current owner cannot reopen terminal progress');
});

test('saved closures cannot overwrite a new owner or regate and owned side stamps preserve progress', async (t) => {
  const f = fixture(t);
  const old = f.deps();
  await old.saveGateProgress({ gate: { id: 'review' }, progress: { filingIntent: { id: 'old' } } });
  const prior = f.read().gate_progress;
  assert.equal(runs.updateGateProgress(f.home, f.runId, null, { key: f.runId, own: 'owner-a', sidePatch: { gate_fix_run_id: 'fix-one', gate_state: 'failed', state: 'vanished' } }).ok, true);
  assert.deepEqual(f.read().gate_progress, prior);
  assert.equal(f.read().gate_state, 'running');
  assert.equal(f.read().state, 'done');
  runs.stampGateState(f.home, f.runId, { gate_settle_id: 'owner-b', gate_regate_count: 1 }, { own: 'owner-a' });
  const newer = f.read();
  for (const write of [() => old.saveGateProgress({ gate: { id: 'review' }, progress: {} }), () => old.saveRescueState({ rescues: [] }), () => old.saveGatePools({ pools: {} }), () => old.updateGateProgress(null, { gate_rescue_run_id: 'stale' })]) {
    await assert.rejects(async () => write(), /could not be updated/);
  }
  assert.deepEqual(f.read(), newer);
  const fresh = runs.updateGateProgress(f.home, f.runId, { gates: { review: { ledger: [] } } }, { key: `${f.runId}#r2`, attempt: 2, own: 'owner-b' });
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.progress.gates.review, { ledger: [] }, 'new attempt does not inherit old debt');
});

test('a failed callback cannot publish its partial reservation or mutate stored evidence', (t) => {
  const f = fixture(t);
  const before = f.read();
  const result = runs.updateGateProgress(f.home, f.runId, (p) => { p.pools = { retry: { spent: 1 } }; throw new Error('write failed'); }, { key: f.runId, own: 'owner-a' });
  assert.equal(result.ok, false);
  assert.deepEqual(f.read(), before);
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
