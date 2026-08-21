// task-spor-heartbeat-journal-protocol-shape-guard: the claim-heartbeat
// journal line is a protocol between post-tool.js's claim-heartbeat branch
// (writer) and distill.js's sessionEndLease (reader, replayed in journal
// order) — not just an operability log. Both ends go through the shared
// scripts/engines/util.js helpers `appendHeartbeatRecord`/`readHeartbeatHeldIds`;
// this test locks the record shape those helpers agree on so a field rename
// on either side fails here instead of silently breaking SessionEnd lease
// handling.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../scripts/engines/util');

function scratchJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-heartbeat-shape-'));
  return path.join(dir, 's1.jsonl');
}

function readEntries(journalPath) {
  return fs
    .readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('appendHeartbeatRecord writes the exact shape sessionEndLease reads', () => {
  const journalPath = scratchJournal();
  u.appendHeartbeatRecord(journalPath, { project: 'projx', renewed: ['task-a', 'task-b'], dropped: [] });
  const [entry] = readEntries(journalPath);
  assert.strictEqual(entry.tool, u.HEARTBEAT_TOOL);
  assert.strictEqual(entry.tool, 'claim-heartbeat');
  assert.strictEqual(entry.project, 'projx');
  assert.deepStrictEqual(entry.renewed, ['task-a', 'task-b']);
  assert.strictEqual('dropped' in entry, false, 'an empty dropped list is omitted, not written as []');
  assert.strictEqual(typeof entry.ts, 'string');
});

test('appendHeartbeatRecord includes dropped only when non-empty', () => {
  const journalPath = scratchJournal();
  u.appendHeartbeatRecord(journalPath, { project: 'projx', renewed: ['task-a'], dropped: ['task-b'] });
  const [entry] = readEntries(journalPath);
  assert.deepStrictEqual(entry.dropped, ['task-b']);
});

test('readHeartbeatHeldIds ignores non-heartbeat entries', () => {
  const ids = u.readHeartbeatHeldIds([
    { tool: 'agent-heartbeat', renewed: ['task-x'] },
    { tool: 'session-lease', id: 'task-y', action: 'release' },
  ]);
  assert.deepStrictEqual([...ids], []);
});

test('readHeartbeatHeldIds replays renewed/dropped in journal order (point-in-time, not cumulative)', () => {
  const ids = u.readHeartbeatHeldIds([
    { tool: 'claim-heartbeat', renewed: ['task-a', 'task-b'] },
    { tool: 'claim-heartbeat', renewed: ['task-a'], dropped: ['task-b'] },
    { tool: 'claim-heartbeat', renewed: ['task-a'] },
  ]);
  assert.deepStrictEqual([...ids].sort(), ['task-a']);
});

test('a node dropped after being renewed does not linger from an earlier beat', () => {
  const ids = u.readHeartbeatHeldIds([
    { tool: 'claim-heartbeat', renewed: ['task-a'] },
    { tool: 'claim-heartbeat', renewed: [], dropped: ['task-a'] },
  ]);
  assert.strictEqual(ids.has('task-a'), false);
});

test('round trip: appendHeartbeatRecord -> parsed journal -> readHeartbeatHeldIds', () => {
  const journalPath = scratchJournal();
  u.appendHeartbeatRecord(journalPath, { project: 'projx', renewed: ['task-a', 'task-b'], dropped: [] });
  u.appendHeartbeatRecord(journalPath, { project: 'projx', renewed: ['task-a'], dropped: ['task-b'] });
  const ids = u.readHeartbeatHeldIds(readEntries(journalPath));
  assert.deepStrictEqual([...ids], ['task-a']);
});

test('renaming the renewed/dropped fields is caught: readHeartbeatHeldIds only understands the agreed keys', () => {
  const ids = u.readHeartbeatHeldIds([{ tool: 'claim-heartbeat', renewedIds: ['task-a'] }]);
  assert.deepStrictEqual([...ids], [], 'a field rename silently drops the record instead of crashing — exactly why both sides must share one helper');
});
