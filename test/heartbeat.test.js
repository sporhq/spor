// task-spor-fleet-scheduler-client-heartbeat-tick — the post-tool mid-session
// FLEET liveness tick. A throttled, fail-open POST /v1/agents/{id}/heartbeat that
// keeps this box's agent last_seen fresh between session-starts WITHOUT re-probing
// or re-publishing capabilities. Driven through the real dispatcher (bin/spor-hook
// post-tool) against an in-process stub server on an ephemeral port; the cwd is a
// real git repo and everything writes to a throwaway SPOR_HOME. The claim branch
// is disabled (SPOR_CLAIM_NUDGE=0) so the ONLY POST under test is the heartbeat,
// and edits target a `.js` file so the LLM capture nudge never fires.
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');
const AGENT = 'agent-test-shark';

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_')) delete env[k];
    if (k.startsWith('SPOR_') && k !== 'SPOR_HOME') delete env[k];
  }
  // Opt the scratch repo in (task-spor-plugin-opt-in-default) so the post-tool
  // engine runs; disable the claim branch so the heartbeat is the only POST.
  env.SPOR_ENABLED = '1';
  env.SPOR_CLAIM_NUDGE = '0';
  return { ...env, ...extra };
}

// A git-repo cwd named `projx` so the engine runs against a real repo slug, with
// SPOR_HOME pointing at a separate scratch graph home.
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-heartbeat-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'projx');
  fs.mkdirSync(cwd);
  const g = (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  g(['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'f.txt'), 'x');
  g(['add', 'f.txt']);
  g(['commit', '-q', '-m', 'init']);
  return { root, home, cwd };
}

// Stub server: records hits; answers POST /v1/agents/{id}/heartbeat from
// `status` (default 200 with a refreshed record). Everything else 404.
function stubServer(status = 200) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/heartbeat$/.test(req.url)) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200
          ? { agent: AGENT, last_seen: '2026-06-19T00:00:00Z', published_at: '2026-06-19T00:00:00Z' }
          : {}));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// async spawn — spawnSync would block the event loop and starve the stub server
// while the hook's curl waits on it. Resolves with stdout.
function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    let out = '';
    const c = spawn('bash', [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    c.stdin.end(input);
  });
}

function editPayload(cwd, session = 's1', file = 'code.js') {
  return JSON.stringify({
    cwd, session_id: session, hook_event_name: 'PostToolUse',
    tool_name: 'Edit', tool_input: { file_path: path.join(cwd, file), new_string: 'x' },
  });
}

function journal(home, session = 's1') {
  const p = path.join(home, 'journal', `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function heartbeatHits(hits) {
  return hits.filter((h) => h.method === 'POST' && /\/heartbeat$/.test(h.url));
}

test('configured dispatch.agent + remote -> a write fires one heartbeat POST, journaled + cooldown stamped', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '', 'the liveness tick never emits an output envelope');
    const hb = heartbeatHits(hits);
    assert.strictEqual(hb.length, 1, `expected one heartbeat POST; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.strictEqual(hb[0].url, `/v1/agents/${AGENT}/heartbeat`);
    assert.strictEqual(hb[0].auth, 'Bearer spor_pat_test', 'bearer rode the heartbeat');
    assert.strictEqual(hb[0].body, '', 'heartbeat carries no body (no caps re-upload)');
    // journaled + cooldown stamped (with the last-tick epoch)
    const j = journal(home).filter((e) => e.tool === 'agent-heartbeat');
    assert.strictEqual(j.length, 1);
    assert.strictEqual(j[0].agent, AGENT);
    assert.strictEqual(j[0].http, '200');
    const state = path.join(home, 'journal', 's1.heartbeat');
    assert.ok(fs.existsSync(state));
    assert.ok(Number(fs.readFileSync(state, 'utf8').trim()) > 0, 'cooldown holds an epoch ms');
  } finally {
    srv.close();
  }
});

test('throttle: a second write within the interval does NOT fire a second heartbeat', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT });
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    // default 5min interval -> only the first write ticked
    assert.strictEqual(heartbeatHits(hits).length, 1);
    assert.strictEqual(journal(home).filter((e) => e.tool === 'agent-heartbeat').length, 1);
  } finally {
    srv.close();
  }
});

test('interval elapsed (SPOR_HEARTBEAT_INTERVAL=0) -> every write ticks again', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home, {
      SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT,
      SPOR_HEARTBEAT_INTERVAL: '0',
    });
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    assert.strictEqual(heartbeatHits(hits).length, 2, 'a zero interval ticks on every write');
  } finally {
    srv.close();
  }
});

test('no dispatch.agent configured -> no heartbeat (no fleet identity to keep alive)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' }); // no SPOR_DISPATCH_AGENT
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(heartbeatHits(hits).length, 0);
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.heartbeat')));
  } finally {
    srv.close();
  }
});

test('SPOR_HEARTBEAT=0 disables the tick (no POST, no cooldown)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home, {
      SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT, SPOR_HEARTBEAT: '0',
    });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(heartbeatHits(hits).length, 0);
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.heartbeat')));
  } finally {
    srv.close();
  }
});

test('local mode (no SPOR_SERVER) is a no-op — no POST, file touch still journaled', async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home, { SPOR_DISPATCH_AGENT: AGENT }); // no SPOR_SERVER
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  const j = journal(home);
  assert.ok(j.some((e) => e.file), 'file touch still journaled in local mode');
  assert.strictEqual(j.filter((e) => e.tool === 'agent-heartbeat').length, 0);
  assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.heartbeat')));
});

test('fail-open: a dead server yields no output, no crash (exit 0), cooldown still throttles', async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home, {
    SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT,
    SPOR_HEARTBEAT_TIMEOUT: '400',
  });
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  // the cooldown is stamped BEFORE the curl, so an outage can't make every write
  // pay the (bounded) timeout — at most one attempt per interval.
  assert.ok(fs.existsSync(path.join(home, 'journal', 's1.heartbeat')));
  const j = journal(home).filter((e) => e.tool === 'agent-heartbeat');
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].http, '000', 'a dead server journals http 000, fail-open');
});

test('404 (caps never published) -> journaled, fail-open, exit 0', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer(404);
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_DISPATCH_AGENT: AGENT });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(heartbeatHits(hits).length, 1);
    const j = journal(home).filter((e) => e.tool === 'agent-heartbeat');
    assert.strictEqual(j.length, 1);
    assert.strictEqual(j[0].http, '404');
  } finally {
    srv.close();
  }
});
