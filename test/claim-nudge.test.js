// task-cc-claim-nudge-hook — the post-tool claim heartbeat ∪ claim-nudge
// branch (dec-cc-task-claim-lease). A no-LLM boolean lease lookup over
// GET /v1/queue?assignee=me: a live claim renews (heartbeat), no claim nudges
// once. Driven through the real dispatcher (bin/spor-hook post-tool) against an
// in-process stub server on an ephemeral port. The cwd is a real git repo so
// the in-repo gate passes; everything writes to a throwaway SPOR_HOME.
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_')) delete env[k];
    if (k.startsWith('SPOR_') && k !== 'SPOR_HOME') delete env[k];
  }
  // Opt the scratch repo in (task-spor-plugin-opt-in-default) so the claim
  // heartbeat/nudge path runs; the cwd is a git repo but carries no .spor marker.
  env.SPOR_ENABLED = '1';
  return { ...env, ...extra };
}

// A git-repo cwd named `projx`, so projectSlug resolves to a real repo slug and
// the in-repo gate passes. SPOR_HOME points at a separate scratch graph home.
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-claimnudge-'));
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

// Stub server: records hits, and answers GET /v1/queue from `queueFor(url)` and
// POST /v1/nodes/{id}/renew with 200 {status:"renewed"}. `queueFor` returns the
// {items:[...]} object for a given request url (assignee=me vs the pool query).
function stubServer(queueFor) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'GET' && req.url.startsWith('/v1/queue')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(queueFor(req.url)));
        return;
      }
      if (req.method === 'POST' && /^\/v1\/nodes\/[^/]+\/renew$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'renewed' }));
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

function isAssigneeMe(url) {
  return url.includes('assignee=me');
}

test('no live claim -> claim-nudge fires once, naming the top eligible pool items', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [] } // person holds no claim
      : { items: [
          { id: 'task-alpha', title: 'Do alpha', why: 'blocks two' },
          { id: 'task-beta', title: 'Do beta' },
        ] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    const json = JSON.parse(out);
    assert.strictEqual(json.hookSpecificOutput.hookEventName, 'PostToolUse');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /claim nudge/);
    assert.match(ctx, /no task claimed/);
    assert.match(ctx, /task-alpha — Do alpha \(blocks two\)/);
    assert.match(ctx, /task-beta — Do beta/);
    assert.match(ctx, /spor:defer/);
    // bearer rode the lookup
    assert.strictEqual(hits[0].auth, 'Bearer spor_pat_test');
    // no renew was attempted (no claim held)
    assert.ok(!hits.some((h) => h.method === 'POST'));
    // cooldown file written + journaled
    assert.ok(fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 1);
  } finally {
    srv.close();
  }
});

test('cooldown: a second write in the same session does not nudge again', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url) ? { items: [] } : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const first = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /claim nudge/);
    const second = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    assert.strictEqual(second.trim(), '');
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 1);
  } finally {
    srv.close();
  }
});

test('live claim held by this person -> renew (heartbeat) fires, no nudge', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [
          { id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' },
        ] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '', 'a held-claim write must not nudge');
    // the heartbeat renewed exactly the live item, carrying the session id
    const renew = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-mine/renew');
    assert.ok(renew, `expected a renew POST; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.deepStrictEqual(JSON.parse(renew.body), { session: 's1' });
    // no claim-nudge journaled; a claim-heartbeat line was
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 0);
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    // no cooldown file (the nudge branch was never reached)
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('Tier-2 reservation held -> suppresses the nudge but does NOT renew (no heartbeat)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [{ id: 'task-resv', title: 'Reserved', lease_state: 'reserved', lease_by: 'person-t' }] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!hits.some((h) => h.method === 'POST'), 'a Tier-2 reservation is not heartbeated');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('SPOR_CLAIM_NUDGE=0 disables the branch entirely (no lookup, no nudge)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url) ? { items: [] } : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_CLAIM_NUDGE: '0' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    // no queue lookup was made (the disable gate is checked before any curl)
    assert.ok(!hits.some((h) => h.url.startsWith('/v1/queue')));
  } finally {
    srv.close();
  }
});

test('local mode (no SPOR_SERVER) is a no-op — no claim lookup, no nudge', async () => {
  const { home, cwd } = scratch();
  // a local graph dir exists, so the post-tool engine runs (and journals), but
  // the claim branch returns before any network or nudge.
  const env = freshEnv(home); // no SPOR_SERVER / SPOR_TOKEN
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  // the file touch was still journaled (local-mode behavior unchanged), but no
  // claim-nudge / claim-heartbeat lines exist.
  const j = journal(home);
  assert.ok(j.some((e) => e.file), 'file touch still journaled in local mode');
  assert.strictEqual(j.filter((e) => e.tool === 'claim-nudge' || e.tool === 'claim-heartbeat').length, 0);
  assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
});

test('fail-open: a dead server yields no output and no crash (exit 0)', async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home, { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 'spor_pat_test', SPOR_CLAIM_NUDGE_TIMEOUT: '400' });
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
});

test('non-200 lookup -> never nudge (cannot verify lease state)', async () => {
  const { home, cwd } = scratch();
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const base = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('empty eligible pool -> no nudge (nothing worth offering)', async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await stubServer(() => ({ items: [] })); // both queries empty
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('not a git repo -> in-repo gate skips the claim branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-claimnudge-nogit-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'loose');
  fs.mkdirSync(cwd);
  let touched = false;
  const { srv, base } = await stubServer((url) => { touched = isAssigneeMe(url) || touched; return { items: [{ id: 'task-alpha', title: 'Alpha' }] }; });
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(touched, false, 'no assignee=me lookup outside a git repo');
  } finally {
    srv.close();
  }
});
