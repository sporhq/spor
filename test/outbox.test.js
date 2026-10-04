// drain-outbox dead-letter policy + u.curl Retry-After/backoff
// (issue-cc-401-429-contract-gap). Drives the real engines against a scratch
// graph home with a stubbed global fetch — no server, no live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u = require('../scripts/engines/util');
const { drainOutbox } = require('../scripts/engines/drain-outbox');

// A Response shaped like the bits u.curl reads: .status, .text(),
// .headers.get()/.forEach() (real Headers, mimicked for the response-headers
// pass-through added by task-spor-distill-conditional-status-fetch).
function fakeResponse(status, { body = '', headers = {} } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]);
  return {
    status,
    text: async () => body,
    headers: {
      get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null),
      forEach: (fn) => {
        for (const [k, v] of Object.entries(lower)) fn(v, k);
      },
    },
  };
}

function scratchGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-outbox-'));
  const graph = path.join(root, 'graph');
  fs.mkdirSync(path.join(graph, 'outbox'), { recursive: true });
  return graph;
}

function spool(graph, name) {
  fs.writeFileSync(path.join(graph, 'outbox', name), JSON.stringify({ id: 'n-x', type: 'note' }));
}

// Run `fn` with SPOR_SERVER set and global fetch stubbed to `responder`
// (called with the same args as fetch). Restores both afterward.
async function withServer(responder, fn) {
  const realFetch = globalThis.fetch;
  const realServer = process.env.SPOR_SERVER;
  const realToken = process.env.SPOR_TOKEN;
  process.env.SPOR_SERVER = 'http://127.0.0.1:9';
  process.env.SPOR_TOKEN = 'spor_pat_test';
  globalThis.fetch = responder;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (realServer === undefined) delete process.env.SPOR_SERVER;
    else process.env.SPOR_SERVER = realServer;
    if (realToken === undefined) delete process.env.SPOR_TOKEN;
    else process.env.SPOR_TOKEN = realToken;
  }
}

const dead = (graph, name) => fs.existsSync(path.join(graph, 'outbox', 'dead', name));
const live = (graph, name) => fs.existsSync(path.join(graph, 'outbox', name));

test('drain dead-letters a 401 (revoked token) to outbox/dead/', async () => {
  const graph = scratchGraph();
  spool(graph, 'a.json');
  await withServer(async () => fakeResponse(401), () => drainOutbox(graph, 'test', 2, 0));
  assert.ok(dead(graph, 'a.json'), '401 file should move to outbox/dead/');
  assert.ok(!live(graph, 'a.json'), '401 file should not stay spooled');
  const log = fs.readFileSync(path.join(graph, 'journal', 'remote.log'), 'utf8');
  assert.match(log, /http=401/);
  assert.match(log, /re-mint SPOR_TOKEN/, 'must emit a loud, actionable line');
});

test('drain still dead-letters 400/413/422 (existing permanent set preserved)', async () => {
  for (const code of [400, 413, 422]) {
    const graph = scratchGraph();
    spool(graph, 'a.json');
    await withServer(async () => fakeResponse(code), () => drainOutbox(graph, 'test', 2, 0));
    assert.ok(dead(graph, 'a.json'), `${code} should dead-letter`);
  }
});

test('drain leaves transient failures (500, transport 000) spooled', async () => {
  for (const responder of [async () => fakeResponse(500), async () => { throw new Error('refused'); }]) {
    const graph = scratchGraph();
    spool(graph, 'a.json');
    // maxTimeSec=2 => retry=0, so no backoff sleeps and the call is immediate.
    await withServer(responder, () => drainOutbox(graph, 'test', 2, 0));
    assert.ok(live(graph, 'a.json'), 'transient failure must stay spooled for a later drain');
    assert.ok(!dead(graph, 'a.json'), 'transient failure must not be dead-lettered');
  }
});

test('drain unlinks a successfully drained file (200/207)', async () => {
  for (const code of [200, 207]) {
    const graph = scratchGraph();
    spool(graph, 'a.json');
    await withServer(async () => fakeResponse(code), () => drainOutbox(graph, 'test', 2, 0));
    assert.ok(!live(graph, 'a.json') && !dead(graph, 'a.json'), `${code} should be unlinked`);
  }
});

test('drainOutbox returns an {attempted,drained,deadLettered,failed} tally', async () => {
  // two ship (200), one dead-letters (422), one stays spooled (500).
  const graph = scratchGraph();
  spool(graph, 'a.json');
  spool(graph, 'b.json');
  spool(graph, 'c.json');
  spool(graph, 'd.json');
  const codes = { 'a.json': 200, 'b.json': 200, 'c.json': 422, 'd.json': 500 };
  // route by the file the body came from — every spool() body is identical, so
  // key off call order against the lexical sort the drain uses (a,b,c,d).
  const order = ['a.json', 'b.json', 'c.json', 'd.json'];
  let i = 0;
  const s = await withServer(async () => fakeResponse(codes[order[i++]]), () => drainOutbox(graph, 'test', 2, 0));
  assert.deepStrictEqual(s, { attempted: 4, drained: 2, deadLettered: 1, failed: 1 });
  assert.ok(live(graph, 'd.json'), 'the 500 stays spooled');
  assert.ok(dead(graph, 'c.json'), 'the 422 dead-letters');
});

test('drainOutbox returns a zero tally when there is no server / no outbox', async () => {
  const graph = scratchGraph();
  // no SPOR_SERVER set -> early return
  const realServer = process.env.SPOR_SERVER;
  delete process.env.SPOR_SERVER;
  try {
    assert.deepStrictEqual(await drainOutbox(graph, 'test', 2, 0), { attempted: 0, drained: 0, deadLettered: 0, failed: 0 });
  } finally {
    if (realServer === undefined) delete process.env.SPOR_SERVER;
    else process.env.SPOR_SERVER = realServer;
  }
});

test('drainOutbox honors the maxFiles cap and reports only what it attempted', async () => {
  const graph = scratchGraph();
  spool(graph, 'a.json');
  spool(graph, 'b.json');
  spool(graph, 'c.json');
  const s = await withServer(async () => fakeResponse(200), () => drainOutbox(graph, 'test', 2, 2));
  assert.strictEqual(s.attempted, 2, 'the cap stops after 2 files');
  assert.strictEqual(s.drained, 2);
  assert.ok(live(graph, 'c.json'), 'the capped-out file stays spooled');
});

test('parseRetryAfter: numeric seconds, dates, and junk', () => {
  assert.strictEqual(u.parseRetryAfter('2'), 2000);
  assert.strictEqual(u.parseRetryAfter('0'), 0);
  assert.strictEqual(u.parseRetryAfter(''), null);
  assert.strictEqual(u.parseRetryAfter(null), null);
  assert.strictEqual(u.parseRetryAfter('not-a-number'), null);
  // HTTP-date form resolves to a non-negative delay.
  const ms = u.parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(ms >= 0 && ms <= 6000, `date form within bounds, got ${ms}`);
});

test('backoffMs: exponential, capped, Retry-After takes precedence', () => {
  assert.strictEqual(u.backoffMs(0, null, 8000), 250);
  assert.strictEqual(u.backoffMs(1, null, 8000), 500);
  assert.strictEqual(u.backoffMs(2, null, 8000), 1000);
  assert.strictEqual(u.backoffMs(10, null, 8000), 8000, 'exponential is capped');
  assert.strictEqual(u.backoffMs(0, 5000, 8000), 5000, 'Retry-After wins over exponential');
  assert.strictEqual(u.backoffMs(0, 999999, 8000), 8000, 'huge Retry-After is capped');
});

test('u.curl retries a 429 up to `retry` times, then returns the final status', async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls < 2 ? fakeResponse(429, { headers: { 'retry-after': '0' } }) : fakeResponse(200, { body: 'ok' });
    };
    const r = await u.curl('http://x/', { retry: 1, backoffCapMs: 1 });
    assert.strictEqual(r.http, '200');
    assert.strictEqual(calls, 2, 'one retry after the 429');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('u.curl with retry=0 does not retry a 429 (session-start fast path)', async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return fakeResponse(429); };
    const r = await u.curl('http://x/', { retry: 0 });
    assert.strictEqual(r.http, '429');
    assert.strictEqual(calls, 1, 'retry=0 means a single attempt, no backoff');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// issue-spor-outbox-drain-file-cap-hol-block: one failing file must not block
// the ones behind it.
test('drain: a transiently failing head does not block the files behind it', async () => {
  const graph = scratchGraph();
  for (const n of ['a.json', 'b.json', 'c.json', 'd.json', 'e.json']) spool(graph, n);
  // Oldest first by mtime: make a.json the unambiguous head.
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(graph, 'outbox', 'a.json'), old, old);
  let calls = 0;
  const s = await withServer(async () => (calls++ === 0 ? fakeResponse(503) : fakeResponse(200)), () =>
    drainOutbox(graph, 'test', 2, 10, 20)
  );
  assert.deepStrictEqual({ drained: s.drained, failed: s.failed }, { drained: 4, failed: 1 });
  assert.ok(live(graph, 'a.json'), 'the failing file stays spooled');
  // The rotation stamp is a sidecar: the file's own mtime stays its SPOOL time,
  // which is what `spor-hook doctor` reports as how long captures are stuck.
  assert.strictEqual(Math.round(fs.statSync(path.join(graph, 'outbox', 'a.json')).mtimeMs / 1000), Math.round(old.getTime() / 1000));
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox', '.attempts')), ['a.json']);
  for (const n of ['b.json', 'c.json', 'd.json', 'e.json']) assert.ok(!live(graph, n), `${n} drained`);
});

test('drain: a failed file rotates behind the untried ones under a file cap of 1', async () => {
  const graph = scratchGraph();
  const old = new Date(Date.now() - 60000);
  const seen = [];
  const responder = async (url, init) => {
    seen.push(String(init.body));
    return fakeResponse(seen.length === 1 ? 503 : 200);
  };
  fs.writeFileSync(path.join(graph, 'outbox', 'a.json'), JSON.stringify({ id: 'n-a' }));
  fs.utimesSync(path.join(graph, 'outbox', 'a.json'), old, old);
  fs.writeFileSync(path.join(graph, 'outbox', 'b.json'), JSON.stringify({ id: 'n-b' }));
  // b is older than "now" so a's re-stamp after its failure lands strictly later
  // than b's mtime — written back to back they can tie on a coarse-mtime fs and
  // the name tiebreak would hand a the head again.
  const mid = new Date(Date.now() - 30000);
  fs.utimesSync(path.join(graph, 'outbox', 'b.json'), mid, mid);
  await withServer(responder, () => drainOutbox(graph, 'test', 2, 1));
  await withServer(responder, () => drainOutbox(graph, 'test', 2, 1));
  assert.match(seen[0], /n-a/);
  assert.match(seen[1], /n-b/, 'the second pass takes the untried file, not the failed head again');
  assert.ok(!live(graph, 'b.json'));
  assert.ok(live(graph, 'a.json'));
  // A later success clears the stamp.
  await withServer(async () => fakeResponse(200), () => drainOutbox(graph, 'test', 2, 0));
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox', '.attempts')), []);
});

test('drain: the wall-clock budget stops a pass and leaves the rest spooled', async () => {
  const graph = scratchGraph();
  spool(graph, 'a.json');
  spool(graph, 'b.json');
  const s = await withServer(
    async () => {
      await new Promise((r) => setTimeout(r, 1100));
      return fakeResponse(200);
    },
    () => drainOutbox(graph, 'test', 2, 0, 1)
  );
  assert.strictEqual(s.attempted, 1);
});

// task-spor-client-spool-single-module: the drain claims each file by rename
// (u.claimSpoolResult) before reading it, so overlapping drains — session-start's
// detached drain, distill, `spor drain` — never POST one capture twice.
test('drain: two overlapping drains POST one spooled capture exactly once', async () => {
  const graph = scratchGraph();
  spool(graph, 's-1-0.capture.json');
  const posts = [];
  const s = await withServer(
    async (url, init) => {
      posts.push(String(url));
      await new Promise((r) => setTimeout(r, 50));
      return fakeResponse(200);
    },
    () => Promise.all([drainOutbox(graph, 'a', 2), drainOutbox(graph, 'b', 2)])
  );
  assert.strictEqual(posts.length, 1, 'exactly one POST');
  assert.match(posts[0], /\/v1\/capture$/, 'a claimed capture still routes to /v1/capture');
  assert.strictEqual(s[0].drained + s[1].drained, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox')).filter((f) => f.endsWith('.json')), []);
});

test('drain: a file claimed by another live drain is skipped; a stale claim is re-claimed', async () => {
  const graph = scratchGraph();
  // process.ppid is alive (the test runner), so this claim is held.
  const held = `h.claim-${process.ppid}-${Date.now()}.json`;
  spool(graph, held);
  // A claim past SPOOL_TTL.claimHold is stale even if the pid is alive.
  const stale = `t.claim-${process.ppid}-${Date.now() - u.SPOOL_TTL.claimHold - 1000}.capture.json`;
  spool(graph, stale);
  // doctor's outbox depth/age still sees claimed files.
  assert.strictEqual(u.spoolStats(path.join(graph, 'outbox')).count, 2);
  const posts = [];
  const s = await withServer(
    async (url) => {
      posts.push(String(url));
      return fakeResponse(200);
    },
    () => drainOutbox(graph, 'test', 2)
  );
  assert.deepStrictEqual(posts.map((p) => p.replace(/^.*\/v1/, '/v1')), ['/v1/capture']);
  assert.strictEqual(s.attempted, 1);
  assert.ok(live(graph, held), 'the live claim is left to its owner');
  assert.ok(!fs.readdirSync(path.join(graph, 'outbox')).some((f) => f.startsWith('t.')), 'the stale claim was drained');
});

test('drain: a failed POST releases the claim back under the original name', async () => {
  const graph = scratchGraph();
  spool(graph, 'r.capture.json');
  const s = await withServer(async () => fakeResponse(503), () => drainOutbox(graph, 'test', 2));
  assert.strictEqual(s.failed, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox')).filter((f) => f.endsWith('.json')), ['r.capture.json']);
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox', '.attempts')), ['r.capture.json']);
  // and it is retried (and drained) by a later pass
  const s2 = await withServer(async () => fakeResponse(200), () => drainOutbox(graph, 'test', 2));
  assert.strictEqual(s2.drained, 1);
  assert.ok(!live(graph, 'r.capture.json'));
  assert.deepStrictEqual(fs.readdirSync(path.join(graph, 'outbox', '.attempts')), []);
});

// task-spor-session-start-deadline-and-http-failure-classifier: ONE reading of
// a status for session-start, drain-outbox and distill.
test('classifyHttpFailure: ok / auth / rejected / rate-limit / transport / server', () => {
  const cases = {
    200: 'ok', 207: 'ok', 401: 'auth', 403: 'auth', 400: 'rejected', 413: 'rejected',
    422: 'rejected', 429: 'rate-limit', '000': 'transport', 500: 'server', 503: 'server', 404: 'server',
  };
  for (const [http, kind] of Object.entries(cases)) assert.strictEqual(u.classifyHttpFailure(http), kind, http);
  assert.strictEqual(u.classifyHttpFailure(undefined), 'transport');
  assert.strictEqual(u.classifyHttpFailure(401), 'auth', 'numeric status reads the same as the string');
  for (const k of ['auth', 'rejected']) assert.ok(u.isPermanentHttpFailure(k), k);
  for (const k of ['ok', 'rate-limit', 'transport', 'server']) assert.ok(!u.isPermanentHttpFailure(k), k);
});

test('drain dead-letters a 403 exactly as a 401 (auth kind)', async () => {
  const graph = scratchGraph();
  spool(graph, 'a.json');
  await withServer(async () => fakeResponse(403), () => drainOutbox(graph, 't', 1));
  assert.ok(fs.existsSync(path.join(graph, 'outbox', 'dead', 'a.json')));
  const log = fs.readFileSync(path.join(graph, 'journal', 'remote.log'), 'utf8');
  assert.match(log, /http=403, revoked\/invalid token/);
});

test('isSystemSession: either marker spelling', () => {
  assert.strictEqual(u.isSystemSession({}), false);
  assert.strictEqual(u.isSystemSession({ SPOR_DISTILLING: '1' }), true);
  assert.strictEqual(u.isSystemSession({ SUBSTRATE_DISTILLING: '1' }), true);
});

test('u.curl: a caller deadline signal ends the request as transport (000) before its own timeout', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  try {
    const t0 = Date.now();
    const r = await u.curl('http://127.0.0.1:9/x', { timeoutMs: 30000, signal: AbortSignal.timeout(50) });
    assert.strictEqual(r.http, '000');
    assert.ok(Date.now() - t0 < 5000, 'the deadline, not the 30s per-call timeout, ended it');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('u.curl: an expired deadline cuts a Retry-After backoff short and stops retrying', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return fakeResponse(429, { headers: { 'Retry-After': '30' } });
  };
  try {
    const t0 = Date.now();
    const r = await u.curl('http://127.0.0.1:9/x', {
      retry: 3, backoffCapMs: 30000, signal: AbortSignal.timeout(50),
    });
    assert.strictEqual(r.http, '429');
    assert.strictEqual(calls, 1);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('anySignal: aborts when any input aborts', () => {
  const a = new AbortController();
  const b = new AbortController();
  const s = u.anySignal([a.signal, b.signal]);
  assert.strictEqual(s.aborted, false);
  b.abort();
  assert.strictEqual(s.aborted, true);
  assert.strictEqual(u.anySignal([a.signal, undefined]), a.signal);
});

test('drainOutbox: a pinned retry of 0 POSTs a failing file once even with a long per-file window', async () => {
  const graph = scratchGraph();
  spool(graph, 'a.capture.json');
  let calls = 0;
  const s = await withServer(async () => {
    calls++;
    return fakeResponse(503);
  }, () => drainOutbox(graph, 't', 120, 10, 60, 0));
  assert.strictEqual(calls, 1);
  assert.strictEqual(s.failed, 1);
});

// ---------------------------------------------------------------------------
// Refresh-once before dead-lettering an auth failure
// (issue-spor-hook-engines-dead-letter-on-401-without-token-refresh): an expired
// short-lived device-grant token must be refreshed and the POST retried before
// a 401/403 is read as permanent.
// ---------------------------------------------------------------------------
const http = require('node:http');
const auth = require('../lib/auth');
const { loadConfig } = require('../lib/config');
const { hermeticEnv } = require('./helpers/env');

// A fake server: /oauth/token swaps refresh_token RT for FRESH (unless
// `refreshOk` is false); every other POST answers 200 only for FRESH.
function authServer({ refreshOk = true } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const bearerTok = (req.headers.authorization || '').replace('Bearer ', '');
      hits.push({ url: req.url, bearer: bearerTok });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/oauth/token') {
        return refreshOk
          ? send(200, { access_token: 'FRESH', refresh_token: 'RT2', expires_in: 3600 })
          : send(400, { error: 'invalid_grant' });
      }
      return bearerTok === 'FRESH' ? send(200, { ok: true }) : send(401, { error: 'expired' });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// Activate a store-tenant config (refreshable, token STALE) for the engines.
function useStoreTenant(base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-outbox-auth-'));
  const key = `${base}/acme`;
  auth.writeStore(home, {
    tenants: { [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT' } },
    default: key,
  });
  u.setConfig(loadConfig({ cwd: home, env: hermeticEnv({ SPOR_MODE: 'auto', SPOR_HOME: home, XDG_CONFIG_HOME: home }) }));
  return { home, key };
}

test('drain refreshes an expired token once and delivers instead of dead-lettering', async () => {
  const { srv, base, hits } = await authServer();
  try {
    const { home, key } = useStoreTenant(base);
    const graph = scratchGraph();
    spool(graph, 'a.json');
    spool(graph, 'b.json');
    const s = await drainOutbox(graph, 'test', 5, 0);
    assert.strictEqual(s.drained, 2, JSON.stringify(s));
    assert.strictEqual(s.deadLettered, 0);
    assert.ok(!dead(graph, 'a.json') && !dead(graph, 'b.json'));
    assert.strictEqual(hits.filter((h) => h.url === '/oauth/token').length, 1, 'one refresh per run');
    // the second file goes straight out on the refreshed bearer
    assert.strictEqual(hits.filter((h) => h.bearer === 'STALE').length, 1);
    assert.strictEqual(auth.readStore(home).tenants[key].access_token, 'FRESH', 'refreshed token persisted');
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test('drain still dead-letters when the refresh itself fails, and tries it only once', async () => {
  const { srv, base, hits } = await authServer({ refreshOk: false });
  try {
    useStoreTenant(base);
    const graph = scratchGraph();
    spool(graph, 'a.json');
    spool(graph, 'b.json');
    const s = await drainOutbox(graph, 'test', 5, 0);
    assert.strictEqual(s.deadLettered, 2, JSON.stringify(s));
    assert.ok(dead(graph, 'a.json') && dead(graph, 'b.json'));
    assert.strictEqual(hits.filter((h) => h.url === '/oauth/token').length, 1, 'a dead refresh token is not re-tried per file');
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test('curlWithRefresh with a flat env token (no refresh_token) is a single plain call', async () => {
  let calls = 0;
  const r = await withServer(
    async (url, init) => {
      calls++;
      assert.strictEqual(init.headers.Authorization, 'Bearer spor_pat_test');
      return fakeResponse(401);
    },
    () => u.curlWithRefresh('http://127.0.0.1:9/v1/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  );
  assert.strictEqual(r.http, '401');
  assert.strictEqual(calls, 1);
});

test('an env token that is not the store tenant\'s own (a dispatched agent) is never refreshed into the person\'s', async () => {
  const { srv, base, hits } = await authServer();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-outbox-auth-'));
    const key = `${base}/acme`;
    auth.writeStore(home, {
      tenants: { [key]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } },
      default: key,
    });
    u.setConfig(
      loadConfig({
        cwd: home,
        env: hermeticEnv({ SPOR_MODE: 'auto', SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: 'AGENT' }),
      })
    );
    const graph = scratchGraph();
    spool(graph, 'a.json');
    const s = await drainOutbox(graph, 'test', 5, 0);
    assert.strictEqual(s.deadLettered, 1, JSON.stringify(s));
    assert.strictEqual(hits.filter((h) => h.url === '/oauth/token').length, 0, 'no refresh of the person tenant');
    assert.ok(hits.every((h) => h.bearer === 'AGENT'), 'never retried as the person');
    assert.strictEqual(auth.readStore(home).tenants[key].access_token, 'PERSON', 'person credential untouched');
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test('a store tenant whose token another process already rotated still refreshes and delivers', async () => {
  const { srv, base, hits } = await authServer();
  try {
    const { home, key } = useStoreTenant(base);
    u.config().tenant(); // resolve (memoize) with STALE, as a run does at its start
    const s0 = auth.readStore(home);
    s0.tenants[key].access_token = 'OTHER'; // a concurrent CLI refresh rewrote the store
    auth.writeStore(home, s0);
    const graph = scratchGraph();
    spool(graph, 'a.json');
    const s = await drainOutbox(graph, 'test', 5, 0);
    assert.strictEqual(s.drained, 1, JSON.stringify(s));
    assert.strictEqual(hits.filter((h) => h.url === '/oauth/token').length, 1);
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test('a flat env token equal to the stored one refreshes like the store tenant', async () => {
  const { srv, base } = await authServer();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-outbox-auth-'));
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT' } }, default: key });
    u.setConfig(
      loadConfig({ cwd: home, env: hermeticEnv({ SPOR_MODE: 'auto', SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: 'STALE' }) })
    );
    const graph = scratchGraph();
    spool(graph, 'a.json');
    const s = await drainOutbox(graph, 'test', 5, 0);
    assert.strictEqual(s.drained, 1, JSON.stringify(s));
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test('anySignal: the AbortSignal.any fallback detaches its listeners on dispose and on abort', () => {
  const realAny = AbortSignal.any;
  AbortSignal.any = undefined;
  try {
    const counts = () => {
      const long = new AbortController();
      let adds = 0;
      let removes = 0;
      const add = long.signal.addEventListener.bind(long.signal);
      const rem = long.signal.removeEventListener.bind(long.signal);
      long.signal.addEventListener = (...a) => (adds++, add(...a));
      long.signal.removeEventListener = (...a) => (removes++, rem(...a));
      return { long, get live() { return adds - removes; } };
    };
    const c = counts();
    const s = u.anySignal([AbortSignal.timeout(60000), c.long.signal]);
    assert.strictEqual(c.live, 1);
    s.dispose();
    assert.strictEqual(c.live, 0);
    const d = counts();
    const s2 = u.anySignal([new AbortController().signal, d.long.signal]);
    d.long.abort();
    assert.strictEqual(s2.aborted, true);
    assert.strictEqual(d.live, 0);
  } finally {
    AbortSignal.any = realAny;
  }
});
