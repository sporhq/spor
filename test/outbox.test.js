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
