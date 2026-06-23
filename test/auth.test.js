// lib/auth.js (the multi-tenant credential store), the lib/config.js tenant
// SELECTOR, lib/remote.js per-tenant refresh-on-401, and the `spor auth` CLI
// verbs (task-cc-spor-client-multitenant-credential-store, task-cc-spor-auth-cli-
// verbs-device-code, dec-spor-client-cli-mode-tenant-resolution,
// dec-spor-cli-auth-device-grant-front-door). Everything runs against a throwaway
// home — never the live graph.
require('./helpers/tmp-cleanup'); // scratch-home leak guard
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const auth = require('../lib/auth.js');
const remote = require('../lib/remote.js');
const { loadConfig } = require('../lib/config.js');

const CLI = path.join(__dirname, '..', 'bin', 'spor.js');

function tmp(p = 'spor-auth-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
// An env with no SPOR_*/SUBSTRATE_* leakage from the test runner.
function bareEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SPOR_') || k.startsWith('SUBSTRATE_') || k === 'XDG_CONFIG_HOME') continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function loadAt(home, { env = {}, cwd, cli } = {}) {
  return loadConfig({ cwd: cwd || home, env: bareEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, ...env }), cli });
}
// A fake (unsigned) JWT carrying claims, so jwtOrg/jwtExp can decode it.
function fakeJwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(claims)}.sig`;
}
// async spawn — spawnSync would block the event loop and starve the fake server.
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = '';
    let er = '';
    const c = spawn(process.execPath, [CLI, ...args], { env: bareEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (er += d));
    c.on('close', (code) => resolve({ code, stdout: out, stderr: er }));
  });
}

// ===========================================================================
// lib/auth.js — the store
// ===========================================================================

test('readStore: absent file -> empty store (no throw)', () => {
  const home = tmp();
  const s = auth.readStore(home);
  assert.deepStrictEqual(s, { version: 1, tenants: {}, default: null });
});

test('readStore: malformed file -> empty store (fail-open)', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
  fs.writeFileSync(auth.credentialsPath(home), 'not json {{{');
  assert.deepStrictEqual(auth.readStore(home), { version: 1, tenants: {}, default: null });
});

test('upsertTenant: first becomes default; second does not steal it', () => {
  const home = tmp();
  const a = auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  assert.strictEqual(a.key, 'https://a/acme');
  assert.strictEqual(a.becameDefault, true);
  const b = auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' });
  assert.strictEqual(b.becameDefault, false);
  const s = auth.readStore(home);
  assert.strictEqual(s.default, 'https://a/acme');
  assert.strictEqual(Object.keys(s.tenants).length, 2);
});

test('upsertTenant: makeDefault:true steals; makeDefault:false never', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' }, { makeDefault: true });
  assert.strictEqual(auth.readStore(home).default, 'https://b/beta');
  auth.upsertTenant(home, { server: 'https://c', org: 'gamma', access_token: 'GT' }, { makeDefault: false });
  assert.strictEqual(auth.readStore(home).default, 'https://b/beta');
});

test('upsertTenant: org defaults to the JWT claim, then ""', () => {
  const home = tmp();
  const jwt = fakeJwt({ org: 'fromjwt' });
  const r = auth.upsertTenant(home, { server: 'https://a', access_token: jwt });
  assert.strictEqual(r.org, 'fromjwt');
  const r2 = auth.upsertTenant(home, { server: 'https://b', access_token: 'opaque' });
  assert.strictEqual(r2.org, '');
  assert.strictEqual(r2.key, 'https://b/');
});

test('upsertTenant: trailing slash on the server is normalized in the key', () => {
  const home = tmp();
  const r = auth.upsertTenant(home, { server: 'https://a///', org: 'acme', access_token: 'AT' });
  assert.strictEqual(r.key, 'https://a/acme');
  assert.strictEqual(auth.readStore(home).tenants['https://a/acme'].server, 'https://a');
});

test('removeTenant: by org slug, repicks default', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' });
  const r = auth.removeTenant(home, 'acme'); // acme was the default
  assert.strictEqual(r.ok, true);
  const s = auth.readStore(home);
  assert.ok(!s.tenants['https://a/acme']);
  assert.strictEqual(s.default, 'https://b/beta', 'default repicked to the remaining tenant');
});

test('removeTenant: unknown selector -> notFound; ambiguous org -> ambiguous', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'dup', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'dup', access_token: 'BT' });
  assert.strictEqual(auth.removeTenant(home, 'nope').notFound, true);
  const amb = auth.removeTenant(home, 'dup');
  assert.ok(amb.ambiguous && amb.ambiguous.length === 2);
});

test('setDefault: by org; clearAll empties', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' });
  assert.strictEqual(auth.setDefault(home, 'beta').ok, true);
  assert.strictEqual(auth.readStore(home).default, 'https://b/beta');
  assert.strictEqual(auth.clearAll(home), 2);
  assert.deepStrictEqual(auth.readStore(home).tenants, {});
});

test('writeStore: file is 0600', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  const mode = fs.statSync(auth.credentialsPath(home)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('jwt decode helpers', () => {
  assert.strictEqual(auth.jwtOrg(fakeJwt({ org: 'x' })), 'x');
  assert.strictEqual(auth.jwtOrg('opaque'), null);
  assert.strictEqual(auth.jwtExp(fakeJwt({ exp: 123 })), 123);
  assert.strictEqual(auth.jwtExp('opaque'), null);
});

// ===========================================================================
// lib/config.js — the tenant SELECTOR (byte-identical guarantees + precedence)
// ===========================================================================

test('selector byte-identical: SPOR_SERVER/SPOR_TOKEN env (flat single-tenant)', () => {
  const home = tmp();
  const c = loadAt(home, { env: { SPOR_SERVER: 'https://s.example/', SPOR_TOKEN: 'tok' } });
  assert.strictEqual(c.server(), 'https://s.example');
  assert.strictEqual(c.token(), 'tok');
  assert.strictEqual(c.mode(), 'remote');
});

test('selector byte-identical: flat config.json server+token, no store', () => {
  const home = tmp();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'https://f.example', token: 'ftok' }));
  const c = loadAt(home);
  assert.strictEqual(c.server(), 'https://f.example');
  assert.strictEqual(c.token(), 'ftok');
  assert.strictEqual(c.tenant().source, 'flat-config'); // migrate-on-read
  assert.strictEqual(c.mode(), 'remote');
});

test('selector: nothing set -> local (null tenant)', () => {
  const home = tmp();
  const c = loadAt(home);
  assert.strictEqual(c.server(), '');
  assert.strictEqual(c.token(), '');
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.mode(), 'local');
});

test('selector: store default selects its tenant', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  const c = loadAt(home);
  assert.strictEqual(c.server(), 'https://a');
  assert.strictEqual(c.token(), 'AT');
  assert.strictEqual(c.tenant().org, 'acme');
  assert.strictEqual(c.mode(), 'remote');
});

test('selector: --org flag, SPOR_ORG env, and .spor org: marker all pick by org', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' }); // acme stays default
  assert.strictEqual(loadAt(home, { cli: { org: 'beta' } }).token(), 'BT');
  assert.strictEqual(loadAt(home, { env: { SPOR_ORG: 'beta' } }).token(), 'BT');
  const repo = tmp('spor-auth-repo-');
  fs.writeFileSync(path.join(repo, '.spor'), 'repo: x\norg: beta\n');
  assert.strictEqual(loadAt(home, { cwd: repo }).token(), 'BT');
});

test('selector precedence: env flat > store default; cli --org > env flat', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' });
  // env flat wins over the store default
  const c1 = loadAt(home, { env: { SPOR_SERVER: 'https://envs', SPOR_TOKEN: 'ET' } });
  assert.strictEqual(c1.server(), 'https://envs');
  assert.strictEqual(c1.token(), 'ET');
  // an explicit --org beats env flat
  const c2 = loadAt(home, { env: { SPOR_SERVER: 'https://envs', SPOR_TOKEN: 'ET' }, cli: { org: 'beta' } });
  assert.strictEqual(c2.token(), 'BT');
});

test('selector: env SPOR_SERVER pointing at a known tenant carries its refresh + org', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT', refresh_token: 'RT' });
  const c = loadAt(home, { env: { SPOR_SERVER: 'https://a' } }); // no SPOR_TOKEN
  const t = c.tenant();
  assert.strictEqual(t.token, 'AT'); // pulled from the store tenant for that server
  assert.strictEqual(t.org, 'acme');
  assert.strictEqual(t.refresh_token, 'RT');
});

// ===========================================================================
// lib/auth.js refreshTenant + lib/remote.js refresh-on-401 (fake server)
// ===========================================================================

function refreshServer() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth0 = (req.headers.authorization || '').replace('Bearer ', '');
      hits.push({ method: req.method, url: req.url, bearer: auth0, body });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/oauth/token') {
        const q = JSON.parse(body || '{}');
        if (q.grant_type === 'refresh_token' && q.refresh_token === 'RT') {
          return send(200, { access_token: 'FRESH', token_type: 'Bearer', refresh_token: 'RT2', expires_in: 3600 });
        }
        return send(400, { error: 'invalid_grant' });
      }
      if (req.url === '/v1/thing') {
        return auth0 === 'FRESH' ? send(200, { ok: true }) : send(401, { error: 'expired' });
      }
      send(404, {});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('refreshTenant: mints a new access token and updates the store in place', async () => {
  const { srv, base } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT' } }, default: key });
    const fresh = await auth.refreshTenant(home, key);
    assert.strictEqual(fresh, 'FRESH');
    const s = auth.readStore(home);
    assert.strictEqual(s.tenants[key].access_token, 'FRESH');
    assert.strictEqual(s.tenants[key].refresh_token, 'RT2', 'rotated refresh token stored');
  } finally {
    srv.close();
  }
});

test('remote.request: 401 on a refreshable tenant refreshes once and retries', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT' } }, default: key });
    const c = loadAt(home);
    const r = await remote.get(c, '/v1/thing');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    // saw: STALE -> 401, refresh, FRESH -> 200
    assert.ok(hits.some((h) => h.url === '/v1/thing' && h.bearer === 'STALE'));
    assert.ok(hits.some((h) => h.url === '/oauth/token'));
    assert.ok(hits.some((h) => h.url === '/v1/thing' && h.bearer === 'FRESH'));
  } finally {
    srv.close();
  }
});

test('remote.request: expired refreshable tenant refreshes before the first API attempt', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, {
      tenants: {
        [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT', exp: Math.floor(Date.now() / 1000) - 1 },
      },
      default: key,
    });
    const c = loadAt(home);
    const r = await remote.get(c, '/v1/thing');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(hits.some((h) => h.url === '/oauth/token'), 'refreshed first');
    assert.ok(!hits.some((h) => h.url === '/v1/thing' && h.bearer === 'STALE'), 'did not spend a request on the expired token');
    assert.ok(hits.some((h) => h.url === '/v1/thing' && h.bearer === 'FRESH'));
  } finally {
    srv.close();
  }
});

test('remote.request: refreshable tenant with no cached access token refreshes before the first API attempt', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, {
      tenants: { [key]: { server: base, org: 'acme', access_token: '', refresh_token: 'RT' } },
      default: key,
    });
    const c = loadAt(home);
    const r = await remote.get(c, '/v1/thing');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(hits.some((h) => h.url === '/oauth/token'), 'refreshed first');
    assert.ok(!hits.some((h) => h.url === '/v1/thing' && h.bearer === ''), 'did not spend a request with an empty bearer');
    assert.ok(hits.some((h) => h.url === '/v1/thing' && h.bearer === 'FRESH'));
  } finally {
    srv.close();
  }
});

// ===========================================================================
// `spor auth` CLI verbs (fake device server)
// ===========================================================================

function deviceServer({ accessToken, refreshToken = 'spor_ort_x', pendingPolls = 0 } = {}) {
  let polls = 0;
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/oauth/device_authorization') {
        return send(200, {
          device_code: 'dc-123',
          user_code: 'WXYZ-1234',
          verification_uri: 'http://example.test/device',
          verification_uri_complete: 'http://example.test/device?user_code=WXYZ-1234',
          expires_in: 30,
          interval: 1,
        });
      }
      if (req.method === 'POST' && req.url === '/oauth/token') {
        const q = JSON.parse(body || '{}');
        if (q.grant_type && q.grant_type.includes('device_code')) {
          polls++;
          if (polls <= pendingPolls) return send(400, { error: 'authorization_pending' });
          return send(200, { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'GET' && req.url === '/v1/me') {
        return send(200, { person: 'person-me', name: 'Me', email: 'me@example.io', bound: true, is_admin: false });
      }
      send(404, {});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('auth login (device-code) polls, confirms /v1/me, and stores the tenant', async () => {
  const accessToken = fakeJwt({ org: 'acme', exp: Math.floor(Date.now() / 1000) + 3600 });
  const { srv, base, hits } = await deviceServer({ accessToken, pendingPolls: 1 });
  try {
    const home = tmp();
    const r = await runAsync(['auth', 'login', '--server', base, '--no-open'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /enter the code:\s+WXYZ-1234/);
    assert.match(r.stdout, /stored credential for acme/);
    const s = auth.readStore(home);
    const key = `${base}/acme`;
    assert.ok(s.tenants[key], 'tenant stored keyed by (server, org)');
    assert.strictEqual(s.tenants[key].access_token, accessToken);
    assert.strictEqual(s.tenants[key].refresh_token, 'spor_ort_x');
    assert.strictEqual(s.tenants[key].person, 'person-me');
    assert.strictEqual(s.default, key, 'a fresh login becomes the active tenant');
    // exercised the pending->approved poll loop
    assert.ok(hits.filter((h) => h.url === '/oauth/token').length >= 2);
    // RFC 8707: the device authorization carries resource=<server> so the issuer can
    // scope the minted token's aud to the api host (task-spor-app-api-strict-audience-restriction).
    const da = hits.find((h) => h.url === '/oauth/device_authorization');
    assert.ok(da, 'a device_authorization request was made');
    assert.strictEqual(JSON.parse(da.body || '{}').resource, base, 'resource indicator = the server origin');
  } finally {
    srv.close();
  }
});

test('flat `login` is an alias for `auth login`; paste path stores a pasted token', async () => {
  const { srv, base } = await deviceServer({ accessToken: 'irrelevant' });
  try {
    const home = tmp();
    // paste path: login <url> <token> never hits the device endpoints
    const r = await runAsync(['login', base, 'pastetok', '--org', 'acme'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    const s = auth.readStore(home);
    assert.strictEqual(s.tenants[`${base}/acme`].access_token, 'pastetok');
  } finally {
    srv.close();
  }
});

test('auth list / switch / whoami --all / logout operate on the store', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT', person: 'person-a', email: 'a@x.io' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT', person: 'person-b' });

  const list = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.match(list.stdout, /\* acme/); // acme is the default
  assert.match(list.stdout, /\s {2}beta|  beta/);

  const sw = await runAsync(['auth', 'switch', 'beta'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(sw.code, 0, sw.stderr);
  assert.strictEqual(auth.readStore(home).default, 'https://b/beta');

  const who = await runAsync(['whoami', '--all'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.match(who.stdout, /person-a/);
  assert.match(who.stdout, /person-b/);

  const out = await runAsync(['auth', 'logout', 'acme'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(out.code, 0, out.stderr);
  const s = auth.readStore(home);
  assert.ok(!s.tenants['https://a/acme']);
  assert.ok(s.tenants['https://b/beta']);
});

// A fake server for GET /v1/me/org-choices (task-spor-cli-auth-list-live-
// membership-requery). `handler(send, req)` shapes the org-choices response;
// every other route 404s.
function orgChoicesServer(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/v1/me/org-choices') return handler(send, req);
    send(404, {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const futureJwt = (org) => fakeJwt({ org, exp: Math.floor(Date.now() / 1000) + 3600 });

test('auth list: live org-choices (source:idp) surfaces membership, login hints, other issuers', async () => {
  const { srv, base, hits } = await orgChoicesServer((send) =>
    send(200, { source: 'idp', org_choices: [{ slug: 'acme', label: 'Acme' }, { slug: 'beta', label: 'Beta' }] }));
  try {
    const home = tmp();
    // a credential for acme (active), a cached credential on a DIFFERENT issuer,
    // and NO credential for beta — which the live membership reports.
    auth.upsertTenant(home, { server: base, org: 'acme', access_token: futureJwt('acme'), person: 'person-a', email: 'a@x.io' });
    auth.upsertTenant(home, { server: 'https://other.example', org: 'gamma', access_token: 'GT', person: 'person-a' });
    const r = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /\* acme/); // credentialed + active
    assert.match(r.stdout, /beta.*no credential — run 'spor auth login --org beta'/); // live, no creds
    assert.match(r.stdout, /gamma/); // other-issuer credential never hidden
    assert.match(r.stdout, /membership refreshed live/);
    assert.ok(hits.some((h) => h.url === '/v1/me/org-choices' && /^Bearer /.test(h.auth || '')), 'queried with the active bearer');
  } finally {
    srv.close();
  }
});

test('auth list: a stored credential the live membership omits is flagged (revoked/stale)', async () => {
  const { srv, base } = await orgChoicesServer((send) =>
    send(200, { source: 'idp', org_choices: [{ slug: 'beta' }] })); // acme dropped
  try {
    const home = tmp();
    auth.upsertTenant(home, { server: base, org: 'acme', access_token: futureJwt('acme'), person: 'person-a' });
    const r = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /acme.*not in current membership/);
    assert.match(r.stdout, /beta.*no credential/);
  } finally {
    srv.close();
  }
});

test('auth list: 502 membership_requery_failed falls back to the cached listing', async () => {
  const { srv, base } = await orgChoicesServer((send) =>
    send(502, { error: { code: 'membership_requery_failed', message: 'idp unreachable' } }));
  try {
    const home = tmp();
    auth.upsertTenant(home, { server: base, org: 'acme', access_token: futureJwt('acme'), person: 'person-a' });
    const r = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /\* acme/);
    assert.doesNotMatch(r.stdout, /membership refreshed live/); // the live-vs-cached signal
    assert.doesNotMatch(r.stdout, /no credential/);
  } finally {
    srv.close();
  }
});

test('auth list: source:bound (single scoped org) falls back to the cached listing', async () => {
  const { srv, base } = await orgChoicesServer((send) =>
    send(200, { source: 'bound', org_choices: [{ slug: 'acme', default: true }] }));
  try {
    const home = tmp();
    auth.upsertTenant(home, { server: base, org: 'acme', access_token: futureJwt('acme'), person: 'person-a' });
    const r = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /\* acme/);
    assert.doesNotMatch(r.stdout, /membership refreshed live/);
  } finally {
    srv.close();
  }
});

test('auth list: an older server with no org-choices endpoint (404) falls back, byte-identical', async () => {
  const { srv, base } = await orgChoicesServer((send) => send(404, {}));
  try {
    const home = tmp();
    auth.upsertTenant(home, { server: base, org: 'acme', access_token: futureJwt('acme'), person: 'person-a', email: 'a@x.io' });
    const r = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    // the exact pre-live cached form: "* acme  <base>  person-a <a@x.io>  [valid, ...]"
    assert.match(r.stdout, new RegExp(`\\* acme {2}${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} {2}person-a <a@x.io> {2}\\[valid`));
    assert.doesNotMatch(r.stdout, /membership refreshed live/);
  } finally {
    srv.close();
  }
});

test('auth login against a server with no device endpoints fails clearly (404)', async () => {
  // a bare 404 server stands in for one without the device grant
  const srv = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = tmp();
    const r = await runAsync(['auth', 'login', '--server', base, '--no-open'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /device endpoints|device authorization failed/);
  } finally {
    srv.close();
  }
});

// ===========================================================================
// `spor auth login --web` — the localhost-loopback flow (auth code + PKCE,
// task-cc-spor-auth-cli-web-loopback). The fake front door implements the same
// DCR -> /oauth/authorize -> /oauth/token contract the real server ships; the
// test plays the BROWSER (GET /oauth/authorize, follow the 302 to the loopback).
// ===========================================================================

// A bare http.get that does NOT auto-follow redirects, so the test can read the
// 302 Location (Node's fetch hides it under redirect:'manual'/opaqueredirect).
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

// The fake front door: RFC 7591 DCR, an auto-approving /oauth/authorize that
// 302s back to the loopback redirect with code+state, PKCE-verifying token
// exchange, RFC 7592 unregister, and /v1/me. Records every hit.
function loopbackServer({ accessToken, refreshToken = 'spor_ort_x' } = {}) {
  const hits = [];
  const codes = new Map(); // code -> code_challenge
  let base = '';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      hits.push({ method: req.method, url: req.url, body });
      const send = (code, obj, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && u.pathname === '/oauth/register') {
        const reg = JSON.parse(body || '{}');
        const clientId = 'sub_client_test';
        return send(201, {
          client_id: clientId,
          redirect_uris: reg.redirect_uris,
          token_endpoint_auth_method: 'none',
          registration_access_token: 'sub_reg_test',
          registration_client_uri: `${base}/oauth/register/${clientId}`,
        });
      }
      if (req.method === 'DELETE' && u.pathname.startsWith('/oauth/register/')) {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && u.pathname === '/oauth/authorize') {
        // auto-approve: mint a code bound to the PKCE challenge, 302 to the loopback
        const redirectUri = u.searchParams.get('redirect_uri');
        const st = u.searchParams.get('state');
        const code = 'sub_code_test';
        codes.set(code, u.searchParams.get('code_challenge'));
        const loc = new URL(redirectUri);
        loc.searchParams.set('code', code);
        if (st) loc.searchParams.set('state', st);
        res.writeHead(302, { location: loc.toString() });
        return res.end();
      }
      if (req.method === 'POST' && u.pathname === '/oauth/token') {
        const q = JSON.parse(body || '{}');
        if (q.grant_type === 'authorization_code') {
          const challenge = codes.get(q.code);
          const digest = crypto.createHash('sha256').update(q.code_verifier || '', 'utf8').digest('base64url');
          if (!challenge || digest !== challenge) {
            return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          }
          return send(200, { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'GET' && u.pathname === '/v1/me') {
        return send(200, { person: 'person-me', name: 'Me', email: 'me@example.io', bound: true });
      }
      send(404, {});
    });
  });
  return new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${srv.address().port}`;
      r({ srv, hits, base });
    }),
  );
}

test('auth login --web: registers a loopback client, captures the code, exchanges it (PKCE)', async () => {
  const accessToken = fakeJwt({ org: 'acme', exp: Math.floor(Date.now() / 1000) + 3600 });
  const { srv, base, hits } = await loopbackServer({ accessToken });
  try {
    const home = tmp();
    const env = bareEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home });
    const c = spawn(process.execPath, [CLI, 'auth', 'login', '--web', '--server', base, '--no-open'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let er = '';
    let drove = false;
    c.stderr.on('data', (d) => (er += d));
    c.stdout.on('data', async (d) => {
      out += d;
      // Once the CLI is waiting, the authorize URL is fully flushed — play browser.
      if (!drove && /Waiting for the browser/.test(out)) {
        drove = true;
        const m = out.match(/(https?:\/\/[^\s]*\/oauth\/authorize[^\s]*)/);
        const authResp = await httpGet(m[1]); // GET /oauth/authorize -> 302 to loopback
        await httpGet(authResp.headers.location); // deliver the code to the CLI listener
      }
    });
    const code = await new Promise((resolve) => c.on('close', resolve));
    assert.strictEqual(code, 0, er);
    assert.ok(drove, 'the authorize URL was printed and the browser leg ran');
    const s = auth.readStore(home);
    const key = `${base}/acme`;
    assert.ok(s.tenants[key], 'tenant stored keyed by (server, org)');
    assert.strictEqual(s.tenants[key].access_token, accessToken);
    assert.strictEqual(s.tenants[key].refresh_token, 'spor_ort_x');
    assert.strictEqual(s.tenants[key].person, 'person-me');
    assert.strictEqual(s.default, key, 'a fresh login becomes the active tenant');
    // exercised DCR register, the authorize redirect, the code exchange, and cleanup
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/oauth/register'));
    assert.ok(hits.some((h) => h.method === 'GET' && h.url.startsWith('/oauth/authorize')));
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/oauth/token'));
    assert.ok(hits.some((h) => h.method === 'DELETE' && h.url.startsWith('/oauth/register/')), 'best-effort unregister');
    // RFC 8707: the resource indicator (=<server>) rides BOTH the authorize URL and the
    // token exchange, so the loopback (--web) token also targets api under strict minting
    // (task-spor-app-api-strict-audience-restriction).
    const authzHit = hits.find((h) => h.method === 'GET' && h.url.startsWith('/oauth/authorize'));
    assert.strictEqual(new URL(authzHit.url, 'http://x').searchParams.get('resource'), base, 'authorize carries resource=<server>');
    const tokenHit = hits.find((h) => h.method === 'POST' && h.url === '/oauth/token');
    assert.strictEqual(JSON.parse(tokenHit.body || '{}').resource, base, 'token exchange echoes resource=<server>');
  } finally {
    srv.close();
  }
});

test('auth login --web falls back to the device grant when the server has no DCR', async () => {
  // deviceServer answers the device endpoints but 404s /oauth/register, so --web
  // registers, sees 404, and falls back to the device-code flow.
  const accessToken = fakeJwt({ org: 'acme', exp: Math.floor(Date.now() / 1000) + 3600 });
  const { srv, base, hits } = await deviceServer({ accessToken, pendingPolls: 0 });
  try {
    const home = tmp();
    const r = await runAsync(['auth', 'login', '--web', '--server', base, '--no-open'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /no loopback\/DCR endpoints/);
    assert.match(r.stdout, /enter the code:\s+WXYZ-1234/);
    assert.ok(auth.readStore(home).tenants[`${base}/acme`], 'device fallback stored the tenant');
    assert.ok(hits.some((h) => h.url === '/oauth/register'), 'it attempted DCR first');
    assert.ok(hits.some((h) => h.url === '/oauth/device_authorization'), 'then ran the device flow');
  } finally {
    srv.close();
  }
});
