require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('../lib/shell/execution-store');
const { personForceRelease, reconcilePersonReleaseCleanups } = require('../lib/shell/person-force-release');
const { forceReleaseFromCli } = require('../bin/spor.js');
const { loadConfig } = require('../lib/config');
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-person-release-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const args = { node_id: 'task-release', factory: 'factory-test', gates: [{ id: 'review' }] };
  const engine = extra => store.localExecutionEngine({ home, worker: 'foreign', machine: 'other-box', ...extra });
  return { home, args, engine, origin: { mode: 'local', nodes: path.join(home, 'nodes') } };
}
const debts = home => fs.readdirSync(path.join(home, 'journal', 'person-force-release'));

test('local force release requires bound capability, exact CAS and immutable audit; replay never clears a successor', async t => {
  const { home, args, engine } = setup(t), ordinary = engine(), person = engine({ worker: 'operator', person: 'person-operator' });
  const opened = await ordinary.open(args), id = opened.execution.execution_id;
  const request = { node_id: args.node_id, reason: 'Cancel stuck delivery', request_id: 'operator-1', expected_revision: opened.execution.release_revision };
  assert.equal((await ordinary.forceRelease(id, { ...request, person: 'person-operator' })).code, 'forbidden');
  assert.equal((await person.forceRelease(id, { ...request, node_id: 'other-task' })).code, 'conflict');
  assert.equal((await ordinary.event(id, { fence: opened.fence, event: { type: 'stage.started', attempt: 1, run_id: 'race' } })).ok, true);
  assert.equal((await person.forceRelease(id, request)).code, 'conflict');
  request.expected_revision = (await person.get(id)).execution.release_revision;
  const released = await person.forceRelease(id, request);
  assert.equal(released.ok, true); assert.equal(released.execution.owner, null);
  assert.equal(released.execution.completion.written_at, null);
  assert.equal(released.execution.force_release.person, 'person-operator');
  assert.equal(released.execution.force_release.previous_owner.worker, 'foreign');
  assert.deepEqual((await person.get(id)).execution, released.execution);
  assert.equal((await ordinary.renew(id, { fence: opened.fence })).ok, false);
  const next = await ordinary.open(args), file = store.eventsPath(home, 'local', id), before = fs.readFileSync(file, 'utf8');
  assert.equal((await person.forceRelease(id, request)).replayed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(store.readItem(home, 'local', args.node_id).open, next.execution.execution_id);
});

test('lost acknowledgement and failed graph CAS retain exact cleanup debt, recovery never replays person authority', async t => {
  const { home, args, engine, origin } = setup(t), person = engine({ person: 'person-operator' });
  const opened = await engine().open(args), id = opened.execution.execution_id;
  let attempts = 0, held = id;
  const remote = { get: person.get, forceRelease: async (...a) => { attempts++; await person.forceRelease(...a); return { ok: false, transport: true }; } };
  const clearHold = async ({ executionId }) => ({ ok: held === executionId, reason: 'CAS failed' });
  const input = { home, store: remote, origin, nodeId: args.node_id, executionId: id, reason: 'Operator cancellation', requestId: 'Request_Z', clearHold: async () => ({ ok: false, reason: 'graph offline' }) };
  const first = await personForceRelease(input);
  assert.equal(first.pending, true); assert.equal(attempts, 1); assert.equal(debts(home).length, 1);
  const before = fs.readFileSync(path.join(home, 'journal', 'person-force-release', debts(home)[0]), 'utf8');
  held = 'newer-execution';
  const recovery = { ...input, clearHold, store: { get: person.get, forceRelease: () => { throw new Error('must not replay person authority'); } } };
  assert.equal((await reconcilePersonReleaseCleanups(recovery))[0].pending, true);
  assert.equal(fs.readFileSync(path.join(home, 'journal', 'person-force-release', debts(home)[0]), 'utf8'), before);
  assert.deepEqual(await reconcilePersonReleaseCleanups({ ...recovery, origin: { ...origin, nodes: '/different' } }), []);
  held = id;
  assert.equal((await reconcilePersonReleaseCleanups(recovery))[0].ok, true);
  assert.equal(debts(home).length, 0); assert.equal(attempts, 1);
});

test('explicit retry after unapplied transport loss reuses its original intent', async t => {
  const { home, args, engine, origin } = setup(t), person = engine({ person: 'person-operator' });
  const id = (await person.open(args)).execution.execution_id;
  const requests = [];
  const remote = { get: person.get, forceRelease: async (id, body) => { requests.push(body); return requests.length === 1 ? { ok: false, transport: true } : person.forceRelease(id, body); } };
  const input = { home, store: remote, origin, nodeId: args.node_id, executionId: id, reason: 'Cancel', clearHold: async () => ({ ok: true }) };
  assert.equal((await personForceRelease(input)).pending, true);
  assert.equal((await personForceRelease(input)).ok, true);
  assert.deepEqual(requests[1], requests[0]); assert.equal(debts(home).length, 0);
});

test('local CLI needs person binding and no dispatch agent, but no local dispatch record', async t => {
  const { home, args, engine } = setup(t);
  fs.mkdirSync(path.join(home, 'nodes'));
  execFileSync('git', ['init', '-q', home]);
  execFileSync('git', ['-C', home, 'config', 'user.email', 'operator@example.com']);
  fs.writeFileSync(path.join(home, 'nodes', 'person-operator.md'), '---\nid: person-operator\ntype: person\ntitle: Operator\nsummary: Bound local person.\nemail: operator@example.com\n---\n');
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const id = (await engine().open(args)).execution.execution_id;
  const input = { home, nodeId: args.node_id, executionId: id, reason: 'Cancel foreign delivery', clearHold: async () => ({ ok: true }) };
  const agentCfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_DISPATCH_AGENT: 'agent-test' } });
  await assert.rejects(forceReleaseFromCli(agentCfg, input), /dispatch.agent/);
  assert.equal((await forceReleaseFromCli(cfg, input)).ok, true);
  assert.equal(fs.existsSync(path.join(home, 'journal', 'dispatch')), false);
  execFileSync('git', ['-C', home, 'config', 'user.email', 'unknown@example.com']);
  await assert.rejects(forceReleaseFromCli(cfg, input), /bound to a person/);
});

test('actual local CLI enforces explicit flags and releases a foreign hold without a dispatch record', async t => {
  const { home, args } = setup(t);
  fs.mkdirSync(path.join(home, 'nodes'));
  execFileSync('git', ['init', '-q', home]);
  execFileSync('git', ['-C', home, 'config', 'user.email', 'operator@example.com']);
  execFileSync('git', ['-C', home, 'config', 'user.name', 'Operator']);
  fs.writeFileSync(path.join(home, 'nodes', 'person-operator.md'), '---\nid: person-operator\ntype: person\ntitle: Operator\nsummary: Bound local person.\nemail: operator@example.com\n---\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SPOR_') && !key.startsWith('SUBSTRATE_')));
  Object.assign(env, { SPOR_HOME: home, XDG_CONFIG_HOME: home, HOME: home });
  const cfg = loadConfig({ cwd: home, env });
  const engine = store.localExecutionEngine({ home: cfg.userConfigHome(), worker: 'foreign', machine: 'other-box' });
  const id = (await engine.open(args)).execution.execution_id;
  const taskFile = path.join(home, 'nodes', `${args.node_id}.md`);
  fs.writeFileSync(taskFile, `---\nid: ${args.node_id}\ntype: task\ntitle: Release fixture\nsummary: Exercise the CLI.\nstatus: open\nexecution: ${id}\nexecution_at: 2026-09-06T12:00:00Z\n---\n`);
  const run = options => require('node:child_process').spawnSync(process.execPath, [path.resolve(__dirname, '../bin/spor.js'), 'release', args.node_id, '--execution', id, ...options], { cwd: home, env, encoding: 'utf8', timeout: 10000 });
  for (const flags of [['--force'], ['--reason', 'Cancel']]) { const refused = run(flags); assert.equal(refused.status, 1); assert.match(refused.stderr, /--force --reason/); assert.equal((await engine.get(id)).execution.released_at, undefined); }
  const accepted = run(['--force', '--reason', 'Operator cancellation']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /graph hold cleanup complete/);
  assert.equal((await engine.get(id)).execution.force_release.person, 'person-operator');
  assert.doesNotMatch(fs.readFileSync(taskFile, 'utf8'), /^execution:/m);
  assert.match(fs.readFileSync(taskFile, 'utf8'), /execution_released_by:.*person-operator/);
  assert.equal(fs.existsSync(path.join(cfg.userConfigHome(), 'journal', 'dispatch')), false);
});

for (const body of ['', '{malformed']) for (const readbackFails of [false, true]) {
  test(`real adapter preserves force cleanup after ${body ? 'malformed' : 'empty'} success (readback fails=${readbackFails})`, async t => {
    const { home, args } = setup(t);
    const backend = store.localExecutionEngine({ home: path.join(home, 'backend'), worker: 'foreign', person: 'person-operator' });
    const id = (await backend.open(args)).execution.execution_id;
    let committed = false, allowReadback = !readbackFails, posts = 0, cleanups = 0;
    const server = require('node:http').createServer(async (req, res) => {
      if (req.method === 'GET') {
        if (committed && !allowReadback) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'unavailable', message: 'injected readback outage' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await backend.get(id))); return;
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      posts++;
      const released = await backend.forceRelease(id, JSON.parse(raw));
      assert.equal(released.ok, true);
      committed = true;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${server.address().port}`, SPOR_TOKEN: 'person-test-credential' } });
    const cli = require('../bin/spor.js'), origin = cli.attestationGraphOrigin(cfg), bound = cli.attestationPublicationConfig(cfg, origin);
    const adapter = store.openExecutionStore(bound, { home: path.join(home, 'client') });
    const input = { home, store: adapter, origin, nodeId: args.node_id, executionId: id, reason: 'Operator cancellation', clearHold: async () => { cleanups++; assert.ok((await backend.get(id)).execution.force_release); return { ok: true }; } };
    const result = await personForceRelease(input);
    assert.equal(posts, 1);
    assert.equal((await backend.get(id)).execution.owner, null);
    if (readbackFails) {
      assert.equal(result.pending, true);
      assert.equal(cleanups, 0); assert.equal(debts(home).length, 1);
      const file = path.join(home, 'journal', 'person-force-release', debts(home)[0]), debt = fs.readFileSync(file, 'utf8');
      assert.equal((await reconcilePersonReleaseCleanups(input))[0].pending, true);
      assert.equal(fs.readFileSync(file, 'utf8'), debt, 'failed readback preserves original bytes');
      allowReadback = true;
      assert.equal((await reconcilePersonReleaseCleanups(input))[0].ok, true);
    } else assert.equal(result.ok, true);
    assert.equal(cleanups, 1); assert.equal(debts(home).length, 0); assert.equal(posts, 1, 'receipt recovery does not replay person authority');
  });
}


test('actual adapter returns definitive unauthorized force refusal without cleanup debt', async t => {
  const { home, args, engine } = setup(t);
  const backend = engine({ person: 'person-operator' });
  const id = (await backend.open(args)).execution.execution_id;
  let gets = 0, posts = 0;
  const server = require('node:http').createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { gets++; res.end(JSON.stringify(await backend.get(id))); return; }
    posts++; req.resume(); res.writeHead(401);
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'credential revoked' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${server.address().port}`, SPOR_TOKEN: 'revoked-credential' } });
  const cli = require('../bin/spor.js'), origin = cli.attestationGraphOrigin(cfg);
  const adapter = store.openExecutionStore(cli.attestationPublicationConfig(cfg, origin), { home: path.join(home, 'client') });
  const result = await personForceRelease({ home, store: adapter, origin, nodeId: args.node_id, executionId: id, reason: 'Cancel', clearHold: async () => { throw new Error('must not clean a refused release'); } });
  assert.equal(result.ok, false); assert.match(result.reason, /credential revoked|unauthorized/);
  assert.equal(result.pending, undefined); assert.equal(debts(home).length, 0);
  assert.equal(posts, 1); assert.equal(gets, 1);
  assert.equal((await backend.get(id)).execution.released_at, undefined);
});
