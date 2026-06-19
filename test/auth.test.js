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
