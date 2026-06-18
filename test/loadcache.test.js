// loadGraphCached + load-latency telemetry (issue-cc-local-mode-hook-load-latency).
// Pure scratch-dir tests over the real util helper — no server, no live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u = require('../scripts/engines/util');

const NODE = (id) => `---
id: ${id}
type: note
project: projx
title: ${id} title
summary: A note.
---

Body of ${id}.
`;

function scratchNodes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-loadcache-'));
  const nodes = path.join(root, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, 'note-a.md'), NODE('note-a'));
  fs.writeFileSync(path.join(nodes, 'note-b.md'), NODE('note-b'));
  return { root, nodes };
}

test('loadGraphCached: second load of an unchanged dir is a cache hit', () => {
  const { nodes } = scratchNodes();
  const first = u.loadGraphCached(nodes);
  assert.strictEqual(first.cached, false, 'first load is a miss');
  assert.ok(first.graph.nodes['note-a'], 'graph actually loaded');
  const second = u.loadGraphCached(nodes);
  assert.strictEqual(second.cached, true, 'unchanged dir is a hit');
  assert.strictEqual(second.loadMs, 0, 'a hit does no scan');
  assert.strictEqual(second.graph, first.graph, 'returns the same graph object');
});

test('loadGraphCached: adding a node busts the cache', () => {
  const { nodes } = scratchNodes();
  u.loadGraphCached(nodes);
  fs.writeFileSync(path.join(nodes, 'note-c.md'), NODE('note-c'));
  const after = u.loadGraphCached(nodes);
  assert.strictEqual(after.cached, false, 'new file count busts the fingerprint');
  assert.ok(after.graph.nodes['note-c'], 'reload picks up the new node');
});

test('loadGraphCached: touching a node (mtime bump) busts the cache', () => {
  const { nodes } = scratchNodes();
  u.loadGraphCached(nodes);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(nodes, 'note-a.md'), later, later);
  const after = u.loadGraphCached(nodes);
  assert.strictEqual(after.cached, false, 'a newer mtime busts the fingerprint');
});

test('loadGraphCached: an unreadable dir propagates (fail-open is the caller’s job)', () => {
  assert.throws(() => u.loadGraphCached(path.join(os.tmpdir(), 'nope-' + Date.now())));
});

test('journalLoadMs: stamps one JSON line to journal/load-latency.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-loadms-'));
  u.journalLoadMs(root, 'sess-x', 'session-start', 123, { nodes: 2, cached: false });
  const line = fs.readFileSync(path.join(root, 'journal', 'load-latency.jsonl'), 'utf8').trim();
  const rec = JSON.parse(line);
  assert.strictEqual(rec.engine, 'session-start');
  assert.strictEqual(rec.session, 'sess-x');
  assert.strictEqual(rec.load_ms, 123);
  assert.strictEqual(rec.nodes, 2);
  assert.strictEqual(rec.cached, false);
});
