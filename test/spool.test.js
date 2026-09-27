// lib/shell/spool.js — the one spool module (task-spor-client-spool-single-module):
// atomic writes, claim-by-rename, and the single TTL table.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spool = require('../lib/shell/spool');
const u = require('../scripts/engines/util');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-spool-'));
}

test('the TTL table is ordered: claim < orphan re-drive < sweep < foreign collection < GC', () => {
  const t = spool.SPOOL_TTL;
  assert.ok(t.claimHold < t.orphanInput);
  assert.ok(t.orphanInput < t.collectForeign);
  assert.ok(t.sweepInterval < t.collectForeign);
  assert.ok(t.collectForeign < t.gcMaxAge);
  assert.ok(Object.isFrozen(t));
});

test('the engines read their horizons from the one table', () => {
  // util re-exports the same object, so a horizon changed in spool.js is the
  // horizon every engine uses.
  assert.strictEqual(u.SPOOL_TTL, spool.SPOOL_TTL);
  const engines = path.join(__dirname, '..', 'scripts', 'engines');
  for (const [file, re] of [
    ['prompt-context.js', /PENDING_ORPHAN_MS = u\.SPOOL_TTL\.orphanInput/],
    ['distill.js', /SPOOL_COLLECT_AFTER_MS = u\.SPOOL_TTL\.collectForeign/],
    ['spool-sweeper.js', /SWEEP_INTERVAL_MS = u\.SPOOL_TTL\.sweepInterval/],
  ]) {
    assert.match(fs.readFileSync(path.join(engines, file), 'utf8'), re, file);
  }
});

test('writeSpoolFile publishes whole files and leaves no temp behind', () => {
  const dir = scratch();
  const f = path.join(dir, 'x.in.json');
  spool.writeSpoolFile(f, '{"a":1}');
  spool.writeSpoolFile(f, '{"a":2}');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":2}');
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.in.json']);
  assert.throws(() => spool.writeSpoolFile(path.join(dir, 'missing', 'y.json'), '{}'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.in.json']);
  spool.writeSpoolFile(path.join(dir, 'made', 'z.json'), '{}', { mkdir: true });
  assert.ok(fs.existsSync(path.join(dir, 'made', 'z.json')));
});

test('createExclusive: first writer wins and the loser never clobbers', () => {
  const dir = scratch();
  const f = path.join(dir, 'origin.json');
  assert.strictEqual(spool.createExclusive(f, 'first'), true);
  assert.strictEqual(spool.createExclusive(f, 'second'), false);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'first');
  assert.deepStrictEqual(fs.readdirSync(dir), ['origin.json']);
});

test('claimAndReadJson: exactly one taker, and the result is consumed', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, '1-1.out.json'), JSON.stringify({ digest: 'd' }));
  assert.deepStrictEqual(spool.claimAndReadJson(dir, '1-1.out.json'), { digest: 'd' });
  assert.strictEqual(spool.claimAndReadJson(dir, '1-1.out.json'), null);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('claimAndReadJson leaves a live owner\'s held claim alone', () => {
  const dir = scratch();
  // pid 1 is always alive; a fresh stamp makes it a live hold.
  const held = `1-1.claim-1-${Date.now()}.out.json`;
  fs.writeFileSync(path.join(dir, held), JSON.stringify({ digest: 'd' }));
  assert.strictEqual(spool.claimAndReadJson(dir, held), null);
  assert.deepStrictEqual(fs.readdirSync(dir), [held]);
});

test('isNothingVerdict: an exact NOTHING line with no parsed block, and nothing else', () => {
  assert.strictEqual(u.isNothingVerdict('NOTHING', 0), true);
  assert.strictEqual(u.isNothingVerdict('  NOTHING  \n', 0), true);
  assert.strictEqual(u.isNothingVerdict('preamble\nNOTHING\n', 0), true);
  assert.strictEqual(u.isNothingVerdict('NOTHING', 1), false, 'a parsed block always wins');
  assert.strictEqual(u.isNothingVerdict('the tool returns NOTHING here', 0), false);
  assert.strictEqual(u.isNothingVerdict('NOTHING.', 0), false);
  assert.strictEqual(u.isNothingVerdict('', 0), false);
});

test('describeBackendFailure names how and why, keeping the label as the prefix', () => {
  assert.strictEqual(u.describeBackendFailure('nudge cmd failed', {}), 'nudge cmd failed');
  assert.strictEqual(
    u.describeBackendFailure('nudge cmd failed', { exit_code: 127, stderr: '\nsh: 1: gemini: not found\nmore' }),
    'nudge cmd failed (exit 127: sh: 1: gemini: not found)'
  );
  assert.strictEqual(
    u.describeBackendFailure('claude -p failed', { signal: 'SIGKILL', exit_code: null }),
    'claude -p failed (signal SIGKILL)'
  );
  assert.strictEqual(u.describeBackendFailure('x failed', { spawn_error: 'ENOENT' }), 'x failed (spawn ENOENT)');
});
