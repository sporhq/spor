require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/shell/execution-store');
const T0 = '2026-09-06T12:00:00.000Z';
const args = { node_id: 'task-recovery', factory: 'factory-test', gates: [{ id: 'review' }], boundary: 'gates' };
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-exec-recovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let at = T0;
  const engine = (extra = {}) => store.localExecutionEngine({ home, worker: 'worker-a', machine: 'machine-a', now: () => at, ...extra });
  return { home, engine, advance: () => { at = '2026-09-06T12:01:00.000Z'; } };
}
function files(home, id) {
  return { log: store.eventsPath(home, 'local', id), view: store.recordPath(home, 'local', id), pointer: store.itemPath(home, 'local', args.node_id) };
}
function bytes(f) { return Object.fromEntries(Object.entries(f).map(([k, p]) => [k, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null])); }

test('local recovery uses log-first ownership after stale, missing, or malformed materialization', async t => {
  const { home, engine, advance } = setup(t);
  const e = engine();
  const opened = await e.open(args);
  const id = opened.execution.execution_id, f = files(home, id);
  const stale = fs.readFileSync(f.view, 'utf8');
  advance();
  assert.equal((await e.release(id, { fence: opened.fence })).ok, true);
  const expected = store.readRecord(home, 'local', id);
  for (const view of [stale, '{bad view', null]) {
    if (view === null) fs.rmSync(f.view); else fs.writeFileSync(f.view, view);
    const before = bytes(f);
    const got = await engine().get(id);
    assert.equal(got.ok, true);
    assert.equal(got.execution.owner, null);
    assert.equal(got.execution.released_at, expected.released_at);
    assert.deepEqual(bytes(f), before, 'reads do not repair or mutate durable files');
    assert.equal((await e.renew(id, { fence: opened.fence })).ok, false);
  }
  assert.equal((await e.list()).count, 1, 'log-only execution remains visible');
});

for (const fault of ['missing-log', 'empty-log', 'malformed-genesis', 'wrong-genesis-identity', 'duplicate-genesis', 'missing-genesis', 'corrupt-middle', 'corrupt-framed-tail', 'invalid-transition', 'wrong-sequence']) {
  test(`local recovery fails closed on ${fault}`, async t => {
    const { home, engine } = setup(t), e = engine();
    const opened = await e.open(args), id = opened.execution.execution_id, f = files(home, id);
    const rows = store.readEvents(home, 'local', id);
    if (fault === 'missing-log') fs.rmSync(f.log);
    else if (fault === 'empty-log') fs.writeFileSync(f.log, '');
    else if (fault === 'malformed-genesis') { rows[0].spec = {}; fs.writeFileSync(f.log, rows.map(JSON.stringify).join('\n') + '\n'); }
    else if (fault === 'wrong-genesis-identity') { rows[0].spec.tenant = 'other'; fs.writeFileSync(f.log, rows.map(JSON.stringify).join('\n') + '\n'); }
    else if (fault === 'duplicate-genesis') fs.appendFileSync(f.log, JSON.stringify(rows[0]) + '\n');
    else if (fault === 'missing-genesis') fs.writeFileSync(f.log, JSON.stringify(rows[1]) + '\n');
    else if (fault === 'corrupt-middle') fs.writeFileSync(f.log, JSON.stringify(rows[0]) + '\n{broken\n' + JSON.stringify(rows[1]) + '\n');
    else if (fault === 'corrupt-framed-tail') fs.appendFileSync(f.log, '{broken\n');
    else fs.appendFileSync(f.log, JSON.stringify({ execution_id: id, type: fault === 'invalid-transition' ? 'unrecognized.event' : 'stage.started', attempt: 1, run_id: 'run-1', fence: opened.fence, at: T0, seq: 55 }) + '\n');
    const before = bytes(f);
    assert.equal((await e.get(id)).code, 'conflict');
    assert.equal((await e.events(id)).code, 'conflict');
    assert.equal((await e.renew(id, { fence: opened.fence })).code, 'conflict');
    assert.equal((await e.open(args)).code, 'conflict');
    assert.deepEqual(bytes(f), before);
  });
}

for (const tail of ['{torn', 'complete-unframed']) {
  test(`local append recovers ${tail} without losing the next event`, async t => {
    const { home, engine } = setup(t), e = engine();
    const opened = await e.open(args), id = opened.execution.execution_id, f = files(home, id);
    if (tail === '{torn') fs.appendFileSync(f.log, tail);
    else fs.writeFileSync(f.log, fs.readFileSync(f.log, 'utf8').trimEnd());
    assert.equal((await e.get(id)).ok, true);
    assert.equal((await e.event(id, { fence: opened.fence, event: { type: 'stage.started', attempt: 1, run_id: 'run-1' } })).ok, true);
    assert.equal(store.readEvents(home, 'local', id).length, 3);
    assert.equal((await engine().get(id)).execution.seq, 1);
    assert.equal(fs.readFileSync(f.log, 'utf8').endsWith('\n'), true);
  });
}

for (const keepOwnership of [false, true]) {
  test(`initial-open crash recovers original pin before graph access (ownership=${keepOwnership})`, async t => {
    const { home, engine } = setup(t), e = engine({ pinRead: () => ({ revision: 'original' }) });
    const opened = await e.open(args), id = opened.execution.execution_id, f = files(home, id);
    const rows = store.readEvents(home, 'local', id);
    fs.writeFileSync(f.log, rows.slice(0, keepOwnership ? 2 : 1).map(JSON.stringify).join('\n') + '\n');
    fs.rmSync(f.view); fs.rmSync(f.pointer);
    let reads = 0;
    const recovered = await engine({ pinRead: () => { reads++; return { revision: 'changed' }; } }).open(args);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.execution.execution_id, id);
    assert.equal(recovered.execution.item.revision, 'original');
    assert.equal(recovered.execution.owner.machine, 'machine-a');
    assert.equal(reads, 0);
    assert.equal(store.readEvents(home, 'local', id).filter(r => r.type === 'execution.opened').length, 1);
    assert.equal(store.readItem(home, 'local', args.node_id).open, id);
    assert.equal((await engine().get(id)).ok, true);
  });
}

test('released replay is read-only and stale terminal pointer permits the next execution', async t => {
  const { home, engine } = setup(t), e = engine();
  const opened = await e.open(args), id = opened.execution.execution_id, f = files(home, id);
  const oldPointer = fs.readFileSync(f.pointer, 'utf8');
  await e.release(id, { fence: opened.fence });
  fs.writeFileSync(f.pointer, oldPointer); // crash after release journal, before pointer cleanup
  const next = await e.open(args);
  assert.equal(next.ok, true); assert.notEqual(next.execution.execution_id, id);
  const before = bytes(f);
  const replay = await engine({ worker: 'different' }).release(id, { fence: 999 });
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.deepEqual(bytes(f), before);
  assert.equal(store.readItem(home, 'local', args.node_id).open, next.execution.execution_id);
});

test('first release cannot clear a pointer naming a newer execution', async t => {
  const { home, engine } = setup(t), e = engine();
  const opened = await e.open(args), id = opened.execution.execution_id;
  store.writeItemPointer(home, 'local', args.node_id, { open: 'exec-newer', add: 'exec-newer' });
  const pointer = fs.readFileSync(store.itemPath(home, 'local', args.node_id), 'utf8');
  assert.equal((await e.release(id, { fence: opened.fence })).ok, true);
  assert.equal(fs.readFileSync(store.itemPath(home, 'local', args.node_id), 'utf8'), pointer);
});

test('local open and claim use the fixed machine identity despite supplied holder machine', async t => {
  const { engine, advance } = setup(t), e = engine();
  const opened = await e.open({ ...args, machine: 'spoofed' });
  assert.equal(opened.execution.owner.machine, 'machine-a');
  const other = engine({ machine: 'machine-b' });
  assert.equal((await other.open({ ...args, machine: 'machine-a' })).fence, undefined);
  assert.equal((await other.claim(opened.execution.execution_id, { machine: 'machine-a' })).ok, false);
  advance();
  const claimed = await e.claim(opened.execution.execution_id, { machine: 'spoofed' });
  assert.equal(claimed.ok, true); assert.equal(claimed.execution.owner.machine, 'machine-a');
});

test('remote materialized cache remains readable without a local authoritative journal', async t => {
  const { home, engine } = setup(t);
  const opened = await engine().open(args), id = opened.execution.execution_id;
  fs.rmSync(path.join(home, 'journal'), { recursive: true });
  let online = true;
  const remote = { post: async () => ({ ok: true, json: opened }), get: async () => online ? { ok: true, json: opened } : { transport: true, error: 'offline' } };
  const e = store.remoteExecutionAdapter({}, remote, { home, tenant: 'remote' });
  assert.equal((await e.open(args)).ok, true); online = false;
  assert.equal((await e.get(id)).cached, true);
  const list = await e.list(); assert.equal(list.cached, true); assert.equal(list.count, 1);
  assert.equal(fs.existsSync(store.eventsPath(home, 'local', id)), false);
});

test('unknown_candidate publication refusal is dropped once and later outbox events drain', async t => {
  const { home } = setup(t);
  const sent = [], logs = []; let online = false;
  const remote = { post: async (_cfg, _path, body) => {
    if (!online) return { transport: true, error: 'offline' };
    sent.push(body.event.type);
    return body.event.type === 'candidate.published'
      ? { ok: false, status: 409, json: { error: { code: 'unknown_candidate', message: 'candidate is not current' } } }
      : { ok: true, json: { ok: true } };
  } };
  const e = store.remoteExecutionAdapter({}, remote, { home, log: s => logs.push(s) });
  await e.event('exec-test', { fence: 1, event: { type: 'candidate.published', candidate_id: 'cand-old' } });
  await e.event('exec-test', { fence: 1, event: { type: 'stage.started', attempt: 2, run_id: 'run-next' } });
  assert.equal(e.outbox('exec-test').length, 2); online = true;
  const result = await e.reconcile('exec-test', { fence: 1 });
  assert.equal(result.ok, true); assert.equal(result.replayed, 1); assert.equal(result.pending, 0);
  assert.deepEqual(sent, ['candidate.published', 'stage.started']);
  assert.equal(logs.length, 1); assert.match(logs[0], /unknown_candidate.*dropped/);
  await e.reconcile('exec-test', { fence: 1 }); assert.equal(sent.length, 2);
});

test('empty log-only genesis and missing pointed execution refuse open without overwriting evidence', async t => {
  const { home, engine } = setup(t), e = engine();
  const opened = await e.open(args), id = opened.execution.execution_id, f = files(home, id);
  fs.rmSync(f.view); fs.writeFileSync(f.log, ''); fs.rmSync(f.pointer);
  const before = bytes(f);
  assert.equal((await e.open(args)).code, 'conflict');
  assert.deepEqual(bytes(f), before);
  fs.rmSync(f.log);
  store.writeItemPointer(home, 'local', args.node_id, { open: id, add: id });
  const dangling = bytes(f);
  assert.equal((await e.open(args)).code, 'conflict');
  assert.deepEqual(bytes(f), dangling);
});

test('historical replay does not re-adjudicate the already accepted event timestamp against the lease', async t => {
  const { home, engine } = setup(t), e = engine();
  const opened = await e.open(args), id = opened.execution.execution_id;
  const accepted = await e.event(id, { fence: opened.fence, event: { type: 'stage.started', attempt: 1, run_id: 'run-time', at: '2027-01-01T00:00:00.000Z' } });
  assert.equal(accepted.ok, true, 'live acceptance is checked against the engine clock');
  fs.rmSync(store.recordPath(home, 'local', id));
  const replayed = await engine().get(id);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.execution.seq, 1);
});

test('new local publication logs normalized clocks and replays the exact returned record', async t => {
  for (const alreadyPublished of [false, true]) {
    const { home, engine } = setup(t), e = engine();
    const opened = await e.open(args), id = opened.execution.execution_id;
    const reference = { kind: 'branch', commit: 'a'.repeat(40), ref: 'refs/spor/candidates/one', locator: 'https://example.com/repo.git', verified_at: T0 };
    const candidate = { candidate_id: 'cand-one', commit: 'a'.repeat(40), tree: 'b'.repeat(40), ...(alreadyPublished ? { reference } : {}) };
    assert.equal((await e.event(id, { fence: opened.fence, event: { type: 'candidate.submitted', candidate } })).ok, true);
    const accepted = await e.event(id, { fence: opened.fence, event: { type: 'candidate.published', candidate_id: candidate.candidate_id, reference, verified_at: 'invalid-discordant-top-level' } });
    assert.equal(accepted.ok, true, accepted.message);
    const logged = store.readEvents(home, 'local', id).at(-1);
    assert.equal(logged.reference.verified_at, T0);
    assert.equal(logged.verified_at, T0, 'new journal rows have one unambiguous normalized publication clock');
    fs.rmSync(store.recordPath(home, 'local', id));
    assert.deepEqual((await engine().get(id)).execution, accepted.execution, 'same-reference publication metadata is replay-identical');
  }
});
