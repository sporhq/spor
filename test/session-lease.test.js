// task-cc-client-sessionend-reserve-hook (dec-cc-task-resumption-reservation):
// the SessionEnd lease-conversion branch. For every task THIS SESSION's own
// claim-heartbeat journal shows a live Tier-1 lease on, it converts the lease
// into a Tier-2 resumption reservation (still open -> `reserve`) or drops it
// (terminal / resolved-by-edge -> `release`); a session that never renewed any
// lease does nothing at all. Driven through the real dispatcher (bin/spor-hook
// distill) against an in-process stub server on an ephemeral port. The cwd is
// a real git repo so the in-repo gate passes; everything writes to a throwaway
// SPOR_HOME.
require('./helpers/tmp-cleanup'); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHook, runHook } = require('./helpers/portable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_')) delete env[k];
    if (k.startsWith('SPOR_') && k !== 'SPOR_HOME') delete env[k];
  }
  // Opt the scratch repo in (task-spor-plugin-opt-in-default); disable the LLM
  // distill call entirely so only the lease branch's requests hit the stub.
  env.SPOR_ENABLED = '1';
  env.SPOR_DISTILL = '0';
  return { ...env, ...extra };
}

// A git-repo cwd named `projx`, so projectSlug resolves to a real repo slug and
// the in-repo gate passes. SPOR_HOME points at a separate scratch graph home.
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-sessionlease-'));
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

// Seed this session's journal with a claim-heartbeat line, exactly what the
// post-tool claim-nudge branch writes on every renew (task-cc-claim-nudge-hook)
// -- the evidence sessionEndLease reads to find what THIS session held.
function seedHeartbeat(home, session, renewed) {
  const dir = path.join(home, 'journal');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `${session}.jsonl`),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', project: 'projx', tool: 'claim-heartbeat', renewed }) + '\n'
  );
}

// Stub server: records hits. `nodesFor(id)` returns the GET /v1/nodes/{id}
// response body object (or null for 404); reserve/release both 200.
function stubServer(nodesFor) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const getM = req.method === 'GET' && req.url.match(/^\/v1\/nodes\/([^/]+)$/);
      if (getM) {
        const found = nodesFor(decodeURIComponent(getM[1]));
        if (!found) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(found));
        return;
      }
      if (req.method === 'POST' && /^\/v1\/nodes\/[^/]+\/(reserve|release)$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: req.url.endsWith('reserve') ? 'reserved' : 'released' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// async spawn — spawnSync would block the event loop and starve the stub
// server while the hook's curl waits on it. Resolves with stdout.
function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    let out = '';
    const c = spawnHook(args, input, env, { stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

function sessionEndPayload(cwd, session = 's1') {
  return JSON.stringify({ cwd, session_id: session, hook_event_name: 'SessionEnd' });
}

function journal(home, session = 's1') {
  const p = path.join(home, 'journal', `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('no claim held this session -> no lookup, no action', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer(() => null);
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(hits.length, 0, 'no claim-heartbeat evidence -> no network call at all');
  } finally {
    srv.close();
  }
});

test('still-open held task -> converts to a Tier-2 reservation via /reserve', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-mine']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'task-mine' ? { raw: 'id: task-mine\nstatus: open\n---\nbody' } : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    const reserve = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-mine/reserve');
    assert.ok(reserve, `expected a reserve POST; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.deepStrictEqual(JSON.parse(reserve.body), { session: 's1' });
    const rec = journal(home).find((e) => e.tool === 'session-lease');
    assert.deepStrictEqual(rec && { id: rec.id, action: rec.action }, { id: 'task-mine', action: 'reserve' });
  } finally {
    srv.close();
  }
});

test('terminal-status held task -> cleaned up via /release', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-done']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'task-done' ? { raw: 'id: task-done\nstatus: done\n---\nbody' } : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    const release = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-done/release');
    assert.ok(release, `expected a release POST; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.strictEqual(release.body, '{}');
    const rec = journal(home).find((e) => e.tool === 'session-lease');
    assert.deepStrictEqual(rec && { id: rec.id, action: rec.action }, { id: 'task-done', action: 'release' });
  } finally {
    srv.close();
  }
});

test('status still open but retired by a live resolves edge -> /release (status lags resolution)', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-edge-resolved']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'task-edge-resolved'
      ? { raw: 'id: task-edge-resolved\nstatus: open\n---\nbody', resolution: { by: 'dec-x', summary: 'done via decision' } }
      : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    const release = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-edge-resolved/release');
    assert.ok(release, 'a resolution-enriched node releases even with a non-terminal status field');
  } finally {
    srv.close();
  }
});

// issue-spor-type-blind-terminal-status-fallbacks: `released` is terminal for
// an ARTIFACT only (schema-artifact's own status.terminal/inert partition,
// not the type-blind TERMINAL_FALLBACK) — a graph-less caller that ignored
// type used to miss this and leave the lease held. sessionEndLease reads
// `parsed.frontmatter.type` off the server response, so the offline
// seed-registry fallback sees it without ever loading a graph.
test('offline path: artifact status "released" is detected terminal via the seed-registry fallback', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['art-shipped']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'art-shipped'
      ? { raw: 'id: art-shipped\ntype: artifact\nstatus: released\n---\nbody', frontmatter: { type: 'artifact' } }
      : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    const release = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/art-shipped/release');
    assert.ok(release, `released artifact must release via the offline fallback; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
  } finally {
    srv.close();
  }
});

// The same "released" status on a NON-artifact type must stay OUT of the
// type-blind fallback (dec-spor-status-inert-third-partition) — proves the
// fallback is genuinely type-aware, not just a bigger flat list.
test('offline path: status "released" on a non-artifact type is NOT terminal', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-released']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'task-released'
      ? { raw: 'id: task-released\ntype: task\nstatus: released\n---\nbody', frontmatter: { type: 'task' } }
      : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    const reserve = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-released/reserve');
    assert.ok(reserve, `a released TASK is not terminal, so it must reserve, not release; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
  } finally {
    srv.close();
  }
});

// The forward-compat leg: a server-computed `inert` enrichment key (once
// shipped, issue-spor-type-blind-terminal-status-fallbacks) is trusted
// outright — it can see graph-resident overrides this offline fallback can't,
// so it must win even over a status/type combo the offline check wouldn't
// call terminal on its own.
test('remote-field path: a server-computed `inert: true` releases regardless of the offline vocabulary', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['art-org-terminal']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'art-org-terminal'
      ? { raw: 'id: art-org-terminal\ntype: widget\nstatus: archived\n---\nbody', frontmatter: { type: 'widget' }, inert: true }
      : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    const release = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/art-org-terminal/release');
    assert.ok(release, `inert:true must release even on an unrecognized status/type; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
  } finally {
    srv.close();
  }
});

// An explicit server `inert: false` is just as authoritative as `true` — it
// must win over the offline fallback, not be treated as "unknown" and
// second-guessed by it. A released ARTIFACT is exactly the status/type combo
// the offline check alone treats as terminal, so this pins that the server's
// negative overrules it (the lease stays reserved, not released).
test('remote-field path: a server-computed `inert: false` reserves even though the offline check alone would release', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['art-not-actually-done']);
  const { srv, hits, base } = await stubServer((id) =>
    id === 'art-not-actually-done'
      ? { raw: 'id: art-not-actually-done\ntype: artifact\nstatus: released\n---\nbody', frontmatter: { type: 'artifact' }, inert: false }
      : null
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    const reserve = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/art-not-actually-done/reserve');
    assert.ok(reserve, `inert:false must reserve even though the offline fallback alone would call this terminal; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
  } finally {
    srv.close();
  }
});

test('multiple held tasks -> each gets its own reserve/release call', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-a']);
  seedHeartbeat(home, 's1', ['task-b']);
  const { srv, hits, base } = await stubServer((id) => {
    if (id === 'task-a') return { raw: 'id: task-a\nstatus: open\n---\n' };
    if (id === 'task-b') return { raw: 'id: task-b\nstatus: resolved\n---\n' };
    return null;
  });
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/v1/nodes/task-a/reserve'));
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/v1/nodes/task-b/release'));
  } finally {
    srv.close();
  }
});

test('SPOR_SESSION_LEASE=0 disables the branch entirely (no lookup)', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-mine']);
  const { srv, hits, base } = await stubServer((id) => (id === 'task-mine' ? { raw: 'id: task-mine\nstatus: open\n---\n' } : null));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_SESSION_LEASE: '0' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(hits.length, 0);
  } finally {
    srv.close();
  }
});

test('local mode (no SPOR_SERVER) is a no-op', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-mine']);
  const env = freshEnv(home); // no SPOR_SERVER / SPOR_TOKEN
  const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(journal(home).filter((e) => e.tool === 'session-lease').length, 0);
});

test('not a git repo -> in-repo gate skips the branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-sessionlease-nogit-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'loose');
  fs.mkdirSync(cwd);
  seedHeartbeat(home, 's1', ['task-mine']);
  const { srv, hits, base } = await stubServer((id) => (id === 'task-mine' ? { raw: 'id: task-mine\nstatus: open\n---\n' } : null));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(hits.length, 0);
  } finally {
    srv.close();
  }
});

test('fail-open: a dead server yields no output and no crash (exit 0)', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-mine']);
  const env = freshEnv(home, {
    SPOR_SERVER: 'http://127.0.0.1:1',
    SPOR_TOKEN: 'spor_pat_test',
    SPOR_SESSION_LEASE_TIMEOUT: '400',
  });
  const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(journal(home).filter((e) => e.tool === 'session-lease').length, 0);
});

test('unverifiable node (non-200 GET) -> lease left alone, no reserve/release attempted', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's1', ['task-mine']);
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const base = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(journal(home).filter((e) => e.tool === 'session-lease').length, 0);
  } finally {
    srv.close();
  }
});

test('a sibling session\'s heartbeats are never touched (session-scoped, not person-scoped)', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 's2', ['task-other-session']); // a DIFFERENT session's journal
  const { srv, hits, base } = await stubServer((id) => (id === 'task-other-session' ? { raw: 'id: task-other-session\nstatus: open\n---\n' } : null));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    // SessionEnd fires for session s1, which never renewed anything itself.
    const out = await runAsync(['distill', '--host', 'claude-code'], sessionEndPayload(cwd, 's1'), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(hits.length, 0, "s1's SessionEnd must not act on s2's held claim");
  } finally {
    srv.close();
  }
});

// Codex/Copilot/OpenCode approximate "session end" by debouncing a turn-scoped
// event (Stop/agentStop/session.idle) after N seconds of quiescence — a mid-
// session pause trips it just as easily as a real goodbye. Reserving/releasing
// a still-live claim on that false positive would silently strand active work,
// so the debounced firing (bin/spor-hook.js marks it `spor_debounced`) must
// skip the lease branch entirely, even though it still runs distillation.
test('a debounced (quiescence-approximated) firing skips the lease branch entirely', async () => {
  const { home, cwd } = scratch();
  seedHeartbeat(home, 'sess-deb', ['task-mine']);
  const { srv, hits, base } = await stubServer((id) => (id === 'task-mine' ? { raw: 'id: task-mine\nstatus: open\n---\n' } : null));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    runHook(
      ['distill', '--host', 'codex', '--debounce', '1'],
      JSON.stringify({ cwd, session_id: 'sess-deb', hook_event_name: 'Stop' }),
      env
    );
    const pending = path.join(home, 'journal', 'pending-distill', 'sess-deb.json');
    assert.ok(fs.existsSync(pending), 'payload spooled');
    // wait for the debounce watcher to fire and clean up its spool
    for (let i = 0; i < 40 && fs.existsSync(pending); i++) await sleep(250);
    assert.ok(!fs.existsSync(pending), 'watcher ran (spool cleaned up)');
    assert.strictEqual(hits.length, 0, 'a debounced firing must never call reserve/release');
    assert.strictEqual(journal(home, 'sess-deb').filter((e) => e.tool === 'session-lease').length, 0);
  } finally {
    srv.close();
  }
});
