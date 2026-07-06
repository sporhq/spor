// Periodic journal garbage collection (task-spor-client-journal-gc): the
// age-bounded sweep of per-session artifacts (<session>.jsonl logs, the
// .nudged/.claim-nudged/.coupling-nudged/.heartbeat cooldown markers,
// prompt-context caches, and pending-nudges/<session>/ dirs) that otherwise
// accumulate unbounded in journal/. Pure scratch-dir tests over u.gcJournal —
// no server, no live graph — plus a driven session-start smoke.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const u = require('../scripts/engines/util');

const DAY = 86400000;

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-journal-gc-'));
  const graph = path.join(root, 'graph');
  const journal = path.join(graph, 'journal');
  fs.mkdirSync(journal, { recursive: true });
  return { root, graph, journal };
}

// Write a file and backdate its mtime by `ageDays`.
function aged(dir, name, ageDays) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(full, t, t);
  return full;
}

// A per-session subdirectory under pending-nudges/, backdated by `ageDays`.
function agedDir(base, session, ageDays) {
  const full = path.join(base, session);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'result.json'), '{}');
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(full, t, t);
  return full;
}

test('prunes stale per-session artifacts, keeps fresh and durable ones', () => {
  const { graph, journal } = scratch();
  // Stale (30d) per-session artifacts of a DIFFERENT, ended session — prunable.
  const old = 'sess-old';
  aged(journal, `${old}.jsonl`, 30);
  aged(journal, `${old}.nudged`, 30);
  aged(journal, `${old}.claim-nudged`, 30);
  aged(journal, `${old}.coupling-nudged`, 30);
  aged(journal, `${old}.heartbeat`, 30);
  aged(journal, 'prompt-context-abc123.json', 30);
  const pending = path.join(journal, 'pending-nudges');
  agedDir(pending, old, 30);

  // Fresh (1d) artifacts — must survive the 14d cutoff.
  aged(journal, 'sess-fresh.jsonl', 1);
  aged(journal, 'prompt-context-fresh.json', 1);
  agedDir(pending, 'sess-fresh', 1);

  // Durable state — never pruned regardless of age.
  aged(journal, 'load-latency.jsonl', 30);
  aged(journal, 'distill.log', 30);
  aged(journal, 'remote.log', 30);
  aged(journal, 'pending-distill', 30);
  aged(journal, 'enable-hint-projx', 30);
  aged(path.join(journal, 'llm-calls'), '2026-01-01.jsonl', 30);

  const stat = u.gcJournal(graph, { force: true });
  assert.equal(stat.ran, true);
  assert.equal(stat.removed, 7, 'six stale files + one stale pending dir');

  // Stale, ended-session artifacts gone.
  for (const n of [`${old}.jsonl`, `${old}.nudged`, `${old}.claim-nudged`, `${old}.coupling-nudged`, `${old}.heartbeat`, 'prompt-context-abc123.json']) {
    assert.equal(fs.existsSync(path.join(journal, n)), false, `${n} should be pruned`);
  }
  assert.equal(fs.existsSync(path.join(pending, old)), false, 'stale pending dir pruned');

  // Fresh artifacts survive.
  assert.ok(fs.existsSync(path.join(journal, 'sess-fresh.jsonl')));
  assert.ok(fs.existsSync(path.join(journal, 'prompt-context-fresh.json')));
  assert.ok(fs.existsSync(path.join(pending, 'sess-fresh')));

  // Durable state survives.
  for (const n of ['load-latency.jsonl', 'distill.log', 'remote.log', 'pending-distill', 'enable-hint-projx']) {
    assert.ok(fs.existsSync(path.join(journal, n)), `${n} must be kept`);
  }
  assert.ok(fs.existsSync(path.join(journal, 'llm-calls', '2026-01-01.jsonl')), 'llm-calls telemetry kept');
});

test('never sweeps the live session even when its files are stale', () => {
  const { graph, journal } = scratch();
  const live = 'sess-live';
  // A stale-mtime file for the CURRENTLY-running session (clock skew / long idle).
  aged(journal, `${live}.jsonl`, 30);
  aged(journal, `${live}.heartbeat`, 30);
  agedDir(path.join(journal, 'pending-nudges'), live, 30);

  const stat = u.gcJournal(graph, { force: true, session: live });
  assert.equal(stat.removed, 0);
  assert.ok(fs.existsSync(path.join(journal, `${live}.jsonl`)));
  assert.ok(fs.existsSync(path.join(journal, `${live}.heartbeat`)));
  assert.ok(fs.existsSync(path.join(journal, 'pending-nudges', live)));
});

test('throttles to once per interval via the .gc-stamp cooldown', () => {
  const { graph, journal } = scratch();
  aged(journal, 'sess-a.jsonl', 30);

  // First run (no stamp yet) is due; it stamps and sweeps.
  const first = u.gcJournal(graph, {});
  assert.equal(first.ran, true);
  assert.equal(first.removed, 1);
  assert.ok(fs.existsSync(path.join(journal, '.gc-stamp')));

  // A second stale file, then an immediate re-run — throttled, no sweep.
  aged(journal, 'sess-b.jsonl', 30);
  const second = u.gcJournal(graph, {});
  assert.equal(second.ran, false);
  assert.ok(fs.existsSync(path.join(journal, 'sess-b.jsonl')), 'not swept while throttled');

  // force bypasses the throttle.
  const forced = u.gcJournal(graph, { force: true });
  assert.equal(forced.ran, true);
  assert.equal(forced.removed, 1);
});

test('respects the age threshold (nothing older than maxAgeMs)', () => {
  const { graph, journal } = scratch();
  aged(journal, 'sess-5d.jsonl', 5);
  aged(journal, 'sess-20d.jsonl', 20);
  // Custom 10-day cutoff: only the 20d file is stale.
  const stat = u.gcJournal(graph, { force: true, maxAgeMs: 10 * DAY });
  assert.equal(stat.removed, 1);
  assert.ok(fs.existsSync(path.join(journal, 'sess-5d.jsonl')));
  assert.equal(fs.existsSync(path.join(journal, 'sess-20d.jsonl')), false);
});

test('SPOR_GC=0 disables the sweep entirely', () => {
  const { graph, journal } = scratch();
  aged(journal, 'sess-a.jsonl', 30);
  const prev = process.env.SPOR_GC;
  process.env.SPOR_GC = '0';
  try {
    const stat = u.gcJournal(graph, { force: true });
    assert.equal(stat.ran, false);
    assert.ok(fs.existsSync(path.join(journal, 'sess-a.jsonl')), 'kept while disabled');
  } finally {
    if (prev === undefined) delete process.env.SPOR_GC;
    else process.env.SPOR_GC = prev;
  }
});

test('absent journal dir is a no-op', () => {
  const { graph, journal } = scratch();
  fs.rmSync(journal, { recursive: true, force: true });
  const stat = u.gcJournal(graph, { force: true });
  assert.equal(stat.ran, false);
  assert.equal(stat.removed, 0);
});
