'use strict';

// scripts/release-ci-gate.js — the release gate that refuses to publish over a red
// `test` matrix (task-spor-release-gate-refuses-red-main-ci). gh is injected,
// so nothing here touches the network.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const gate = require(path.join(__dirname, '..', 'scripts', 'release-ci-gate.js'));

const SHA = 'a'.repeat(40);

function run(over) {
  return { id: 1, head_sha: SHA, status: 'completed', conclusion: 'success',
    created_at: '2026-10-13T07:00:00Z', html_url: 'https://example/run/1', ...over };
}

// A fake gh: answers the runs query with `runs` (or a sequence of them) and
// the jobs query with `jobs`; records every call.
function fakeGh({ runs = [], seq, jobs = [], fail = false } = {}) {
  const calls = [];
  let i = 0;
  const gh = (args) => {
    calls.push(args);
    if (fail) return { ok: false, stdout: '', stderr: 'gh: not logged in' };
    const url = args[1];
    if (url.includes('/jobs?')) return { ok: true, stdout: JSON.stringify({ jobs }) };
    const r = seq ? seq[Math.min(i++, seq.length - 1)] : runs;
    return { ok: true, stdout: JSON.stringify({ workflow_runs: r }) };
  };
  gh.calls = calls;
  return gh;
}

test('judgeRuns: no run for the sha is none, never success', () => {
  assert.strictEqual(gate.judgeRuns([], SHA).state, 'none');
  assert.strictEqual(gate.judgeRuns([run({ head_sha: 'b'.repeat(40) })], SHA).state, 'none');
});

test('judgeRuns: the newest run decides', () => {
  const older = run({ id: 1, conclusion: 'failure', created_at: '2026-10-13T06:00:00Z' });
  const newer = run({ id: 2, conclusion: 'success', created_at: '2026-10-13T07:00:00Z' });
  assert.strictEqual(gate.judgeRuns([older, newer], SHA).state, 'success');
  assert.strictEqual(gate.judgeRuns([newer, { ...older, created_at: '2026-10-13T08:00:00Z' }], SHA).state, 'red');
});

test('judgeRuns: in progress is pending; cancelled/failure/timed_out are red', () => {
  assert.strictEqual(gate.judgeRuns([run({ status: 'in_progress', conclusion: null })], SHA).state, 'pending');
  for (const c of ['failure', 'cancelled', 'timed_out', null]) {
    assert.strictEqual(gate.judgeRuns([run({ conclusion: c })], SHA).state, 'red', String(c));
  }
});

test('readGate asks only for push runs on the release branch of the exact sha', () => {
  const gh = fakeGh({ runs: [run()] });
  const v = gate.readGate({ sha: SHA, repo: 'o/r', gh });
  assert.strictEqual(v.state, 'success');
  const url = gh.calls[0][1];
  assert.match(url, /^repos\/o\/r\/actions\/workflows\/test\.yaml\/runs\?/);
  assert.match(url, new RegExp(`head_sha=${SHA}`));
  assert.match(url, /branch=main/);
  assert.match(url, /event=push/);
});

test('readGate on red lists the failing jobs (Windows shards included)', () => {
  const gh = fakeGh({
    runs: [run({ conclusion: 'failure' })],
    jobs: [
      { name: 'Node 24 on ubuntu-latest (shard 1/4)', conclusion: 'success' },
      { name: 'Node 24 on windows-latest (shard 2/4)', conclusion: 'failure' },
      { name: 'skipped thing', conclusion: 'skipped' },
      { name: 'CI', conclusion: 'failure' },
    ],
  });
  const v = gate.readGate({ sha: SHA, repo: 'o/r', gh });
  assert.strictEqual(v.state, 'red');
  assert.deepStrictEqual(v.failedJobs, ['Node 24 on windows-latest (shard 2/4) (failure)', 'CI (failure)']);
  const msg = gate.describe(v, { sha: SHA });
  assert.match(msg, /concluded failure/);
  assert.match(msg, /windows-latest \(shard 2\/4\)/);
});

test('readGate: a gh failure or garbage is an error, never success', () => {
  assert.strictEqual(gate.readGate({ sha: SHA, gh: fakeGh({ fail: true }) }).state, 'error');
  const garbage = () => ({ ok: true, stdout: 'not json' });
  assert.strictEqual(gate.readGate({ sha: SHA, gh: garbage }).state, 'error');
});

test('readGate without --repo lets gh resolve {owner}/{repo}', () => {
  const gh = fakeGh({ runs: [run()] });
  gate.readGate({ sha: SHA, gh });
  assert.match(gh.calls[0][1], /^repos\/\{owner\}\/\{repo\}\//);
});

test('waitGate polls through none/pending until the run settles', async () => {
  const gh = fakeGh({ seq: [[], [run({ status: 'queued', conclusion: null })], [run()]] });
  let t = 0;
  const v = await gate.waitGate({ sha: SHA, gh }, {
    timeoutMs: 10000, intervalMs: 1000, now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.strictEqual(v.state, 'success');
  assert.strictEqual(gh.calls.length, 3);
});

test('waitGate gives up at the deadline and reports it timed out', async () => {
  const gh = fakeGh({ runs: [run({ status: 'in_progress', conclusion: null })] });
  let t = 0;
  const v = await gate.waitGate({ sha: SHA, gh }, {
    timeoutMs: 3000, intervalMs: 1000, now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.strictEqual(v.state, 'pending');
  assert.strictEqual(v.timedOut, true);
});

test('main exits 0 only on success, 1 on red, 2 on bad args', async () => {
  const quiet = { out: () => {}, err: () => {} };
  assert.strictEqual(await gate.main(['--sha', SHA], { ...quiet, gh: fakeGh({ runs: [run()] }) }), 0);
  const errs = [];
  assert.strictEqual(await gate.main(['--sha', SHA],
    { out: () => {}, err: (l) => errs.push(l), gh: fakeGh({ runs: [run({ conclusion: 'failure' })] }) }), 1);
  assert.match(errs.join('\n'), /refusing to release/);
  assert.strictEqual(await gate.main(['--sha', SHA], { ...quiet, gh: fakeGh({ runs: [] }) }), 1);
  assert.strictEqual(await gate.main(['--sha', 'abc123'], quiet), 2);
  assert.strictEqual(await gate.main([], quiet), 2);
  assert.strictEqual(await gate.main(['--sha', SHA, '--timeout-min', '0'], quiet), 2);
  assert.strictEqual(await gate.main(['--sha', SHA, '--bogus'], quiet), 2);
});

test('main --wait sleeps through a pending run to its verdict', async () => {
  const gh = fakeGh({ seq: [[run({ status: 'in_progress', conclusion: null })], [run({ conclusion: 'failure' })]] });
  const code = await gate.main(['--sha', SHA, '--wait', '--interval-sec', '1'],
    { gh, out: () => {}, err: () => {}, sleep: async () => {} });
  assert.strictEqual(code, 1);
});
