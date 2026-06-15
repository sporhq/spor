// `spor-hook doctor` engine + helpers
// (task-cc-client-hook-operability-diagnostics piece 3). Pure-helper unit tests
// and an engine test that drives doctor() against a scratch graph with a stubbed
// global fetch — no server, no live graph. Black-box CLI coverage (dispatcher
// wiring, both modes, the session-start nudge) lives in hookcli.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u = require('../scripts/engines/util');
const { doctor, fmtAge, tailErrors, cacheReport } = require('../scripts/engines/doctor');

function fakeResponse(status, { body = '', headers = {} } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]);
  return {
    status,
    text: async () => body,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
  };
}

function scratchGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-doctor-'));
  const graph = path.join(root, 'graph');
  fs.mkdirSync(path.join(graph, 'nodes'), { recursive: true });
  return graph;
}

const spool = (graph, name) => {
  fs.mkdirSync(path.join(graph, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(graph, 'outbox', name), '{}');
};
const deadLetter = (graph, name) => {
  fs.mkdirSync(path.join(graph, 'outbox', 'dead'), { recursive: true });
  fs.writeFileSync(path.join(graph, 'outbox', 'dead', name), '{}');
};
const journal = (graph, file, body) => {
  fs.mkdirSync(path.join(graph, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(graph, 'journal', file), body);
};

// Run doctor() against `graph` with SPOR_HOME pointed at it; remote when
// `server` is given (fetch stubbed to `responder`), local otherwise. Restores
// env + fetch + the active config afterward.
async function runDoctor(graph, { server, responder } = {}) {
  const realFetch = globalThis.fetch;
  const saved = {};
  for (const k of ['SPOR_HOME', 'SUBSTRATE_HOME', 'SPOR_SERVER', 'SUBSTRATE_SERVER', 'SPOR_TOKEN', 'SUBSTRATE_TOKEN']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SPOR_HOME = graph;
  if (server) {
    process.env.SPOR_SERVER = server;
    process.env.SPOR_TOKEN = 'spor_pat_test';
    globalThis.fetch = responder;
  }
  u.clearConfig(); // engine reads fall back to the env we just set
  try {
    return await doctor();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    u.clearConfig();
  }
}

// --- pure helpers ---------------------------------------------------------

test('fmtAge: scales seconds/minutes/hours/days, guards null and future', () => {
  const now = Date.now();
  assert.match(fmtAge(now - 5_000), /^\ds ago$/);
  assert.match(fmtAge(now - 5 * 60_000), /^5m ago$/);
  assert.match(fmtAge(now - 3 * 3600_000), /^3h \d+m ago$/);
  assert.match(fmtAge(now - 2 * 86400_000), /^2d \d+h ago$/);
  assert.strictEqual(fmtAge(null), 'unknown');
  assert.strictEqual(fmtAge(NaN), 'unknown');
  assert.strictEqual(fmtAge(now + 10_000), 'just now');
});

test('tailErrors: null for absent log, [] when only success lines, filters to failures', () => {
  const graph = scratchGraph();
  const f = path.join(graph, 'journal', 'remote.log');
  assert.strictEqual(tailErrors(f), null, 'absent log => null');

  journal(graph, 'remote.log',
    '[t] briefing ok (v2, 800 nodes)\n[t] captured 3/3 facts (0 spooled, 0 rejected)\n[t] drained a.json (http=200)\n');
  assert.deepStrictEqual(tailErrors(f), [], 'success-only log => no error lines');

  journal(graph, 'remote.log',
    '[t] briefing ok (v2, 800 nodes)\n' +
    '[t] captured 3/3 facts (0 spooled, 0 rejected)\n' +   // must NOT match
    '[t] dead-lettered d1 (http=401, revoked/invalid token)\n' +
    '[t] crashed (fail-open, exit 0): boom\n');
  const errs = tailErrors(f);
  assert.strictEqual(errs.length, 2, 'two genuine failures, success lines excluded');
  assert.match(errs[0], /dead-lettered/);
  assert.match(errs[1], /crashed/);
});

test('tailErrors: returns at most the last n error lines', () => {
  const graph = scratchGraph();
  journal(graph, 'remote.log', Array.from({ length: 6 }, (_, i) => `[t] drain failed for f${i} (http=500)`).join('\n') + '\n');
  const errs = tailErrors(path.join(graph, 'journal', 'remote.log'), 3);
  assert.strictEqual(errs.length, 3);
  assert.match(errs[2], /f5/, 'keeps the most recent');
});

test('cacheReport: parses the fetched= marker and dual-reads the legacy spelling', () => {
  const graph = scratchGraph();
  const dir = path.join(graph, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief-a.md'),
    '<!-- spor cache: brief-a version=2 fetched=2026-06-14T10:00:00+00:00 host=h -->\nbody\n');
  fs.writeFileSync(path.join(dir, 'brief-b.md'),
    '<!-- substrate cache: brief-b version=1 fetched=2026-06-13T09:00:00+00:00 host=h -->\nbody\n');
  const r = cacheReport(dir);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].file, 'brief-a.md');
  assert.strictEqual(r[0].fetched, '2026-06-14T10:00:00+00:00');
  assert.ok(Number.isFinite(r[0].ageMs), 'marker timestamp parsed to a number');
});

test('cacheReport: absent cache dir => []', () => {
  assert.deepStrictEqual(cacheReport(path.join(scratchGraph(), 'cache')), []);
});

// --- engine, local mode ---------------------------------------------------

test('doctor (local): reports local mode, node count, and journal errors', async () => {
  const graph = scratchGraph();
  fs.writeFileSync(path.join(graph, 'nodes', 'a.md'), 'title: x\n');
  fs.writeFileSync(path.join(graph, 'nodes', 'b.md'), 'title: y\n');
  journal(graph, 'distill.log', '[t] distill complete (2 candidate nodes)\n[t] claude -p failed\n');
  const out = await runDoctor(graph);
  assert.match(out, /mode:\s+local/);
  assert.match(out, /graph:\s+.*\(2 nodes\)/);
  assert.match(out, /distill\.log:\s+last 1 error line/);
  assert.match(out, /claude -p failed/);
  assert.doesNotMatch(out, /server:/, 'local mode names no server');
});

// --- engine, remote mode --------------------------------------------------

test('doctor (remote, 200): reachable + token valid + node count', async () => {
  const graph = scratchGraph();
  const out = await runDoctor(graph, {
    server: 'http://127.0.0.1:9',
    responder: async () => fakeResponse(200, { body: JSON.stringify({ node_count: 878 }) }),
  });
  assert.match(out, /mode:\s+remote/);
  assert.match(out, /reachable:\s+yes/);
  assert.match(out, /token:\s+valid — graph has 878 nodes/);
});

test('doctor (remote, 401): reachable but token REJECTED', async () => {
  const graph = scratchGraph();
  const out = await runDoctor(graph, {
    server: 'http://127.0.0.1:9',
    responder: async () => fakeResponse(401),
  });
  assert.match(out, /reachable:\s+yes/);
  assert.match(out, /token:\s+REJECTED \(http 401\)/);
  assert.match(out, /re-mint/);
});

test('doctor (remote, transport down): UNREACHABLE, token validity indeterminate', async () => {
  const graph = scratchGraph();
  const out = await runDoctor(graph, {
    server: 'http://127.0.0.1:9',
    responder: async () => { throw new Error('refused'); },
  });
  assert.match(out, /reachable:\s+NO/);
  assert.match(out, /cannot validate while the server is unreachable/);
});

test('doctor (remote): reports outbox spool + dead-letter depth with oldest age', async () => {
  const graph = scratchGraph();
  spool(graph, 's1.capture.json');
  spool(graph, 's2.capture.json');
  deadLetter(graph, 'd1.capture.json');
  const out = await runDoctor(graph, {
    server: 'http://127.0.0.1:9',
    responder: async () => fakeResponse(200, { body: '{}' }),
  });
  assert.match(out, /outbox:\s+2 spooled \(oldest .*ago\)/);
  assert.match(out, /dead-letter:\s+1 in outbox\/dead\/ \(oldest .*ago\)/);
  assert.match(out, /PERMANENT rejects/);
});

test('doctor (remote): a clear outbox reads "clear", not a scary count', async () => {
  const graph = scratchGraph();
  const out = await runDoctor(graph, {
    server: 'http://127.0.0.1:9',
    responder: async () => fakeResponse(200, { body: '{}' }),
  });
  assert.match(out, /outbox:\s+0 spooled — clear/);
  assert.match(out, /dead-letter:\s+0 — clear/);
});

test('doctor never throws (fail-soft) even with an unreadable graph home', async () => {
  // A graph home that doesn't exist: every read fails open, doctor still returns.
  const out = await runDoctor(path.join(os.tmpdir(), 'spor-doctor-nonexistent-xyz'));
  assert.match(out, /spor doctor/);
});
