// lib/auth.js (the multi-tenant credential store), the lib/config.js tenant
// SELECTOR, lib/remote.js per-tenant refresh-on-401, and the `spor auth` CLI
// verbs (task-cc-spor-client-multitenant-credential-store, task-cc-spor-auth-cli-
// verbs-device-code, dec-spor-client-cli-mode-tenant-resolution,
// dec-spor-cli-auth-device-grant-front-door). Everything runs against a throwaway
// home — never the live graph.
require('./helpers/tmp-cleanup'); // scratch-home leak guard
const { hermeticEnv } = require("./helpers/env.js");
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
const { loadConfig, describeTenantRefusal } = require('../lib/config.js');

const CLI = path.join(__dirname, '..', 'bin', 'spor.js');

function tmp(p = 'spor-auth-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
// An env with no SPOR_*/SUBSTRATE_* leakage from the test runner.
function bareEnv(extra = {}) {
  // Library-level cascade tests resolve mode from the configs they write, so
  // opt out of the helper's local-mode pin.
  return hermeticEnv({ SPOR_MODE: "auto", ...extra });
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

// Every WRITE path re-reads the store strictly: only ENOENT means "no store";
// a corrupt or unreadable file is refused, never read as empty and written back
// over every stored credential (issue-spor-credential-store-fail-open-overwrite-
// and-legacy-token-mode).
const STORE_WRITERS = {
  upsertTenant: (home) => auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' }),
  removeTenant: (home) => auth.removeTenant(home, 'acme'),
  setDefault: (home) => auth.setDefault(home, 'acme'),
};
for (const [name, write] of Object.entries(STORE_WRITERS)) {
  for (const [label, body] of [['invalid JSON', '{"tenants": {"https://a/acme": {'], ['a non-object root', '[1,2]'], ['a non-object tenants', '{"tenants": [1]}']]) {
    test(`${name}: refuses a store holding ${label}, leaving it untouched`, () => {
      const home = tmp();
      fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
      fs.writeFileSync(auth.credentialsPath(home), body);
      assert.throws(() => write(home), /refusing to overwrite it/);
      assert.strictEqual(fs.readFileSync(auth.credentialsPath(home), 'utf8'), body);
    });
  }
  test(`${name}: refuses an unreadable (non-ENOENT) store`, { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const home = tmp();
    auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
    const before = fs.readFileSync(auth.credentialsPath(home), 'utf8');
    fs.chmodSync(auth.credentialsPath(home), 0o000);
    try {
      assert.throws(() => write(home), (e) => e.code === 'EACCES' && /cannot read credential store/.test(e.message));
    } finally {
      fs.chmodSync(auth.credentialsPath(home), 0o600);
    }
    assert.strictEqual(fs.readFileSync(auth.credentialsPath(home), 'utf8'), before);
  });
}

test('clearAll: discards a corrupt store (that is the ask) but refuses an unreadable one', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
  fs.writeFileSync(auth.credentialsPath(home), 'not json');
  assert.strictEqual(auth.clearAll(home), 0);
  assert.deepStrictEqual(auth.readStoreStrict(home).tenants, {});
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  fs.chmodSync(auth.credentialsPath(home), 0o000);
  try {
    assert.throws(() => auth.clearAll(home), /cannot read credential store/);
  } finally {
    fs.chmodSync(auth.credentialsPath(home), 0o600);
  }
  assert.ok(auth.readStore(home).tenants['https://a/acme']);
});

test('readStoreStrict: absent store is empty; a well-formed one reads like readStore', () => {
  const home = tmp();
  assert.deepStrictEqual(auth.readStoreStrict(home), { version: 1, tenants: {}, default: null });
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  assert.deepStrictEqual(auth.readStoreStrict(home), auth.readStore(home));
});

test('writeStore: a DANGLING symlinked store is written through, the link kept', { skip: process.platform === 'win32' }, () => {
  const home = tmp();
  const real = path.join(tmp(), 'creds.json'); // never created
  fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
  fs.symlinkSync(real, auth.credentialsPath(home));
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  assert.ok(fs.lstatSync(auth.credentialsPath(home)).isSymbolicLink(), 'link not replaced');
  assert.strictEqual(JSON.parse(fs.readFileSync(real, 'utf8')).tenants['https://a/acme'].access_token, 'AT');
  assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
});

test('writeStore: a dangling link whose target DIRECTORY is missing is created, not refused', { skip: process.platform === 'win32' }, () => {
  const home = tmp();
  const real = path.join(tmp(), 'not', 'yet', 'creds.json');
  fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
  fs.symlinkSync(real, auth.credentialsPath(home));
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  assert.ok(fs.lstatSync(auth.credentialsPath(home)).isSymbolicLink());
  assert.strictEqual(auth.readStore(home).tenants['https://a/acme'].access_token, 'AT');
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
  if (process.platform !== "win32") assert.strictEqual(mode, 0o600);
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

// --- unknown --org REFUSES (issue-spor-cli-unrecognized-org-fallback) ------
// The flag is a per-invocation assertion of WHICH tenant a command is for, so
// resolving it to a different one reads the wrong graph and writes into it.

test('selector: --org naming no stored credential refuses (no fallthrough to the store default)', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  auth.upsertTenant(home, { server: 'https://b', org: 'beta', access_token: 'BT' });
  const c = loadAt(home, { cli: { org: 'nope' } });
  assert.strictEqual(c.tenant(), null, 'no tenant resolved');
  assert.strictEqual(c.server(), '', 'no wrong-tenant server leaks out');
  assert.strictEqual(c.token(), '', 'no wrong-tenant token leaks out');
  assert.strictEqual(c.mode(), 'local');
  const te = c.tenantError();
  assert.strictEqual(te.kind, 'unknown-org');
  assert.strictEqual(te.org, 'nope');
  assert.deepStrictEqual(te.orgs, ['acme', 'beta'], 'reports what IS stored, sorted');
});

test('selector: --org refuses past the legacy flat config.json too, and past an env SPOR_ORG', () => {
  const home = tmp();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'https://f.example', token: 'ftok' }));
  const c = loadAt(home, { env: { SPOR_ORG: 'acme' }, cli: { org: 'nope' } });
  assert.strictEqual(c.server(), '');
  assert.strictEqual(c.tenantError().kind, 'unknown-org');
  assert.deepStrictEqual(c.tenantError().orgs, [], 'empty store reported as empty');
});

test('selector: an org-less (opaque-token) tenant is listed by its store key', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: '', access_token: 'AT' });
  assert.deepStrictEqual(loadAt(home, { cli: { org: 'nope' } }).tenantError().orgs, ['https://a/']);
});

test('selector: a RESOLVABLE --org records no tenantError, and an explicit --server still wins', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  assert.strictEqual(loadAt(home, { cli: { org: 'acme' } }).tenantError(), null);
  // --server is checked first, so it is the tenant even beside an unknown --org.
  const c = loadAt(home, { cli: { server: 'https://x', token: 'XT', org: 'nope' } });
  assert.strictEqual(c.server(), 'https://x');
  assert.strictEqual(c.tenantError(), null);
});

test('serverForNewTenant: re-resolves the cascade with an unresolvable --org ignored', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://self.hosted', org: 'acme', access_token: 'AT' });
  const c = loadAt(home, { cli: { org: 'brandnew' } });
  assert.strictEqual(c.server(), '', 'the refusal still holds for ordinary reads');
  assert.strictEqual(c.serverForNewTenant(), 'https://self.hosted', 'login defaults to the box the rest of the cascade names');
  // With no refusal it is just server().
  const c2 = loadAt(home);
  assert.strictEqual(c2.serverForNewTenant(), 'https://self.hosted');
  // With nothing configured at all it is empty (the caller falls to DEFAULT_SERVER).
  assert.strictEqual(loadAt(tmp(), { cli: { org: 'brandnew' } }).serverForNewTenant(), '');
});

test('CLI: an unknown --org refuses the verb (exit 1) instead of running it', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  const r = await runAsync(['get', 'dec-anything', '--org', 'nope'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no credential stored for org 'nope'/);
  assert.match(r.stderr, /stored orgs: acme/);
  assert.match(r.stderr, /spor auth login --org nope/);
  assert.strictEqual(r.stdout, '', 'the verb never ran');
});

test('CLI: --help and an unknown verb are answerable without a tenant', async () => {
  const home = tmp();
  const h = await runAsync(['get', '--help', '--org', 'nope'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(h.code, 0);
  assert.match(h.stdout, /spor get/);
  const u = await runAsync(['nosuchverb', '--org', 'nope'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(u.code, 1);
  assert.match(u.stderr, /unknown verb/, 'the unknown VERB is the useful error, not the org');
});

test('CLI: the credential verbs are exempt — naming an org you lack is what they are FOR', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  const r = await runAsync(['join', '--org', 'brandnew'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.code, 0, r.stderr);
  const store = auth.readStore(home);
  assert.ok(Object.keys(store.tenants).some((k) => store.tenants[k].org === 'brandnew'), 'the new tenant was added');
  assert.ok(store.tenants['https://a/acme'], 'the sibling was not clobbered');
});

// The exemption is per-INVOCATION, not per-verb: `auth` is a sub-dispatcher, and
// exempting the whole namespace left every non-acquiring subcommand with the
// exact wrong-tenant behavior the refusal exists to stop.

test('CLI: only the ACQUIRING auth subcommand is exempt — auth logout --org <unknown> refuses', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  const r = await runAsync(['auth', 'logout', '--org', 'nope'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no credential stored for org 'nope'/);
  assert.ok(auth.readStore(home).tenants['https://a/acme'], 'the ACTIVE tenant was not destroyed');
  assert.strictEqual(r.stdout, '', 'the subcommand never ran');
});

test('CLI: auth whoami/list/switch under an unknown --org refuse too (they answer about the active tenant)', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  for (const args of [['auth', 'whoami'], ['auth', 'list'], ['auth'], ['auth', 'switch', 'acme']]) {
    const r = await runAsync([...args, '--org', 'nope'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no credential stored for org 'nope'/, args.join(' '));
    assert.strictEqual(r.stdout, '', `${args.join(' ')} never ran`);
  }
});

test('CLI: `auth login --org <new>` stays exempt (it is the door out of the refusal)', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  // The paste path of `auth login` is `login <url> <token>` — acquisition, so it runs.
  const r = await runAsync(['auth', 'login', 'https://b', 'BT', '--org', 'brandnew'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.code, 0, r.stderr);
  const store = auth.readStore(home);
  assert.ok(Object.keys(store.tenants).some((k) => store.tenants[k].org === 'brandnew'), 'the new tenant was added');
  assert.ok(store.tenants['https://a/acme'], 'the sibling was not clobbered');
});

// --- an EMPTY --org is malformed input, not "no selector" -------------------
// The classic shape is an unset shell variable: quoted it arrives as `--org ""`,
// unquoted the word vanishes and `--org` dangles.

test('extractOrgFlag: absent -> null; empty, `--org=`, and a dangling `--org` -> "" (asserted but unusable)', () => {
  const { extractOrgFlag } = require('../bin/spor.js');
  assert.deepStrictEqual(extractOrgFlag(['get', 'x']), { org: null, rest: ['get', 'x'] });
  assert.deepStrictEqual(extractOrgFlag(['get', 'x', '--org', 'acme']), { org: 'acme', rest: ['get', 'x'] });
  assert.deepStrictEqual(extractOrgFlag(['get', 'x', '--org', '']), { org: '', rest: ['get', 'x'] });
  assert.deepStrictEqual(extractOrgFlag(['get', 'x', '--org=']), { org: '', rest: ['get', 'x'] });
  assert.deepStrictEqual(extractOrgFlag(['get', 'x', '--org']), { org: '', rest: ['get', 'x'] });
  // dangling before another flag: the next flag is preserved, the org is empty
  assert.deepStrictEqual(extractOrgFlag(['get', 'x', '--org', '--json']), { org: '', rest: ['get', 'x', '--json'] });
});

test('selector: an empty --org refuses (it must not read as "use the active tenant")', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  for (const org of ['', '   ']) {
    const c = loadAt(home, { cli: { org } });
    assert.strictEqual(c.tenant(), null, JSON.stringify(org));
    assert.strictEqual(c.server(), '');
    assert.strictEqual(c.token(), '');
    assert.strictEqual(c.tenantError().kind, 'empty-org');
    assert.deepStrictEqual(c.tenantError().orgs, ['acme']);
  }
  // A whitespace-PADDED org is still an unknown org, not an empty one: the
  // emptiness test trims, the lookup does not.
  assert.strictEqual(loadAt(home, { cli: { org: ' acme' } }).tenantError().kind, 'unknown-org');
});

test('CLI: an empty --org refuses every verb, acquisition included', async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'AT' });
  for (const args of [['get', 'dec-anything', '--org', ''], ['get', 'dec-anything', '--org='], ['join', '--org', ''], ['auth', 'login', 'https://b', 'BT', '--org', ''], ['auth', 'logout', '--org', '']]) {
    const r = await runAsync(args, { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--org was given an empty value/, args.join(' '));
    assert.strictEqual(r.stdout, '', `${args.join(' ')} never ran`);
  }
  const store = auth.readStore(home);
  assert.deepStrictEqual(Object.keys(store.tenants), ['https://a/acme'], 'nothing was acquired, nothing was cleared');
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

test('refreshTenant: a store gone corrupt mid-refresh is left untouched; the fresh token still serves the call', async () => {
  const { srv, base } = await refreshServer();
  try {
    const home = tmp();
    const key = auth.tenantKey(base, 'acme');
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'STALE', refresh_token: 'RT' } }, default: key });
    // corrupt the store between the lookup and the strict re-read
    const orig = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (f, ...rest) {
      if (f === auth.credentialsPath(home) && ++reads === 2) fs.writeFileSync(f, 'torn {');
      return orig.call(this, f, ...rest);
    };
    let fresh;
    try {
      fresh = await auth.refreshTenant(home, key);
    } finally {
      fs.readFileSync = orig;
    }
    assert.strictEqual(fresh, 'FRESH');
    assert.strictEqual(fs.readFileSync(auth.credentialsPath(home), 'utf8'), 'torn {');
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
// Agent-scoped tokens never escalate to the person
// (issue-spor-agent-token-scope-escalation-via-refresh-and-store-default). A
// dispatched agent runs with the PERSON's HOME (and so their credentials.json)
// but an agent-scoped SPOR_TOKEN; the person's refresh credential must not ride
// beside it, or a 401/403 — or a near-expiry proactive refresh — swaps the
// bearer for the person's.
// ===========================================================================

test('selector: env SPOR_TOKEN that is NOT the stored access_token carries no refresh credential or identity', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://a', org: 'acme', access_token: 'PERSON', refresh_token: 'RT', person: 'person-x', email: 'x@y', exp: 1 });
  const c = loadAt(home, { env: { SPOR_SERVER: 'https://a', SPOR_TOKEN: 'AGENT' } });
  const t = c.tenant();
  assert.strictEqual(t.token, 'AGENT');
  assert.strictEqual(t.org, 'acme', 'an opaque foreign bearer still falls back to the server\'s known org');
  assert.strictEqual(t.key, null, 'a foreign bearer is no store entry\'s own');
  assert.strictEqual(t.refresh_token, null, 'the person\'s refresh credential does not ride beside a foreign bearer');
  assert.strictEqual(t.exp, null);
  assert.strictEqual(t.person, null);
  assert.strictEqual(t.email, null);
  // byte-identical when the env token IS the store's own
  const same = loadAt(home, { env: { SPOR_SERVER: 'https://a', SPOR_TOKEN: 'PERSON' } }).tenant();
  assert.strictEqual(same.refresh_token, 'RT');
  assert.strictEqual(same.person, 'person-x');
  assert.strictEqual(same.exp, 1);
});

test('selector: on a multi-org server a bearer is matched to ITS tenant by token, and a foreign JWT keeps its own org claim', () => {
  const home = tmp();
  auth.upsertTenant(home, { server: 'https://s', org: 'acme', access_token: 'ACME', refresh_token: 'RT-acme' });
  auth.upsertTenant(home, { server: 'https://s', org: 'beta', access_token: 'BETA', refresh_token: 'RT-beta' }, { makeDefault: true });
  // the person's own beta token: matched by token, not by first-same-server (acme)
  const beta = loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: 'BETA' } }).tenant();
  assert.strictEqual(beta.key, 'https://s/beta');
  assert.strictEqual(beta.org, 'beta');
  assert.strictEqual(beta.refresh_token, 'RT-beta');
  // an agent JWT minted for beta: never stamped with acme, never refreshable
  const agent = loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: fakeJwt({ org: 'beta', sub: 'agent-1' }) } }).tenant();
  assert.strictEqual(agent.org, 'beta');
  assert.strictEqual(agent.key, null);
  assert.strictEqual(agent.refresh_token, null);
  // no token supplied: the store default when it is on this server (the one
  // same-server pick rule, task-spor-client-config-tenant-unification-and-refresh)
  const none = loadAt(home, { env: { SPOR_SERVER: 'https://s' } }).tenant();
  assert.strictEqual(none.key, 'https://s/beta');
  assert.strictEqual(none.token, 'BETA');
  assert.strictEqual(none.refresh_token, 'RT-beta');
});

test('remote.request: an agent 401 never refreshes into the person credential', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } }, default: key });
    const c = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 'AGENT' } });
    const r = await remote.get(c, '/v1/thing');
    assert.strictEqual(r.status, 401, JSON.stringify(r));
    assert.deepStrictEqual(hits.map((h) => [h.url, h.bearer]), [['/v1/thing', 'AGENT']], 'one attempt as the agent, no /oauth/token, no retry as FRESH');
    // the CLI's own refresh door refuses the same tenant
    assert.strictEqual(await remote.refreshAfterAuthFailure(c), null);
    assert.strictEqual(auth.readStore(home).tenants[key].access_token, 'PERSON', 'the store was not touched');
  } finally {
    srv.close();
  }
});

test('remote.request: a near-expiry store credential is not proactively refreshed under an agent bearer', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, {
      tenants: { [key]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT', exp: Math.floor(Date.now() / 1000) - 1 } },
      default: key,
    });
    const c = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 'AGENT' } });
    await remote.get(c, '/v1/thing');
    assert.ok(!hits.some((h) => h.url === '/oauth/token'), 'no proactive refresh of the person credential');
    assert.deepStrictEqual(hits.map((h) => h.bearer), ['AGENT']);
  } finally {
    srv.close();
  }
});

test('selector: an agent child env on a store-only box (person default, SPOR_SERVER+SPOR_TOKEN exported by dispatch) sends the agent token', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    // The person logged in with `spor auth login`: no SPOR_SERVER anywhere in
    // their env, the store default is the whole remote configuration.
    auth.writeStore(home, { tenants: { [key]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } }, default: key });
    const person = loadAt(home);
    assert.strictEqual(person.tenant().source, 'store-default');
    // The dispatch runner exports the server beside the child token (see
    // agent-dispatch-runner.test.js); with both set the flat env path wins the
    // cascade and the attribution the server sees is the agent's.
    const agent = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 'AGENT' } });
    assert.strictEqual(agent.tenant().source, 'env');
    assert.strictEqual(agent.token(), 'AGENT');
    await remote.get(agent, '/v1/thing');
    assert.deepStrictEqual(hits.map((h) => h.bearer), ['AGENT'], 'the stub server saw the agent, never the person');
  } finally {
    srv.close();
  }
});

// A dispatched agent run (SPOR_AGENT_RUN, set by the supervisor beside the
// agent token) is bound to that token: `--org` must never resolve the person's
// store tenant for the org (issue-spor-agent-org-flag-resolves-person-store-tenant).
test('selector: an agent run --org naming another org refuses instead of resolving the person store tenant', () => {
  const home = tmp();
  auth.writeStore(home, {
    tenants: {
      'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'ACME', refresh_token: 'RT-acme' },
      'https://s/beta': { server: 'https://s', org: 'beta', access_token: 'BETA', refresh_token: 'RT-beta' },
    },
    default: 'https://s/acme',
  });
  const agentEnv = { SPOR_SERVER: 'https://s', SPOR_TOKEN: fakeJwt({ org: 'acme', sub: 'agent-1' }), SPOR_AGENT_RUN: '1' };
  // Without the marker, --org beta picks the stored beta credential (unchanged).
  const person = loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: agentEnv.SPOR_TOKEN }, cli: { org: 'beta' } });
  assert.strictEqual(person.token(), 'BETA');
  // With it, the same --org refuses: no tenant, no token, a reported refusal.
  const c = loadAt(home, { env: agentEnv, cli: { org: 'beta' } });
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.token(), '');
  const te = c.tenantError();
  assert.strictEqual(te.kind, 'agent-org');
  assert.strictEqual(te.org, 'beta');
  assert.strictEqual(te.agent_org, 'acme');
  assert.strictEqual(te.source, 'cli-org');
  // --org naming the agent's own org is not the person's acme tenant either:
  // it stays on the agent bearer, as the non-store `env` source, unrefreshable.
  const own = loadAt(home, { env: agentEnv, cli: { org: 'acme' } });
  assert.strictEqual(own.tenantError(), null);
  const t = own.tenant();
  assert.strictEqual(t.token, agentEnv.SPOR_TOKEN);
  assert.strictEqual(t.source, 'env');
  assert.strictEqual(t.key, null);
  assert.strictEqual(t.refresh_token, null);
  // An agent run with no env bearer to bind to refuses rather than use the store.
  const bare = loadAt(home, { env: { SPOR_AGENT_RUN: '1' }, cli: { org: 'acme' } });
  assert.strictEqual(bare.tenant(), null);
  assert.strictEqual(bare.tenantError().kind, 'agent-org');
  // An empty --org stays the malformed-input refusal.
  assert.strictEqual(loadAt(home, { env: agentEnv, cli: { org: '' } }).tenantError().kind, 'empty-org');
  // No --org: the flat env path, unchanged.
  assert.strictEqual(loadAt(home, { env: agentEnv }).token(), agentEnv.SPOR_TOKEN);
});

test('cli: an agent run `spor --org <other>` exits 1 and sends nothing', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    auth.writeStore(home, {
      tenants: {
        [`${base}/acme`]: { server: base, org: 'acme', access_token: 'PERSON-ACME', refresh_token: 'RT' },
        [`${base}/beta`]: { server: base, org: 'beta', access_token: 'PERSON-BETA', refresh_token: 'RT' },
      },
      default: `${base}/acme`,
    });
    const r = await runAsync(['--org', 'beta', 'get', 'task-x'], {
      SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: fakeJwt({ org: 'acme' }), SPOR_AGENT_RUN: '1',
    });
    assert.strictEqual(r.code, 1, r.stderr);
    assert.match(r.stderr, /--org 'beta' refused — this is a dispatched agent run/);
    assert.ok(!hits.some((h) => /PERSON/.test(h.bearer || '')), JSON.stringify(hits));
  } finally {
    srv.close();
  }
});

// The widened guard (task-spor-agent-run-guard-all-org-selectors): the AMBIENT
// selectors — an inherited SPOR_ORG, a repo `.spor` org: marker — bind to the
// agent's own bearer or refuse exactly like --org, and an agent run never
// acquires a credential. The hazard they close is the LOCAL-MODE job: no
// SPOR_SERVER in the child env, so the flat path never runs and the selector
// used to answer from the person's store.
test('selector: an inherited SPOR_ORG in an agent run on a store-only box refuses instead of resolving the person tenant', () => {
  const home = tmp();
  auth.writeStore(home, {
    tenants: { 'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } },
    default: 'https://s/acme',
  });
  // Non-agent: SPOR_ORG picks the stored tenant, unchanged.
  const person = loadAt(home, { env: { SPOR_ORG: 'acme' } });
  assert.strictEqual(person.token(), 'PERSON');
  assert.strictEqual(person.tenant().source, 'env-org');
  // Agent run, no env bearer (a local-mode job): refused, store never consulted.
  const c = loadAt(home, { env: { SPOR_ORG: 'acme', SPOR_AGENT_RUN: '1' } });
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.token(), '');
  const te = c.tenantError();
  assert.strictEqual(te.kind, 'agent-org');
  assert.strictEqual(te.org, 'acme');
  assert.strictEqual(te.agent_org, null);
  assert.strictEqual(te.source, 'env-org');
  assert.strictEqual(te.origin, 'SPOR_ORG');
  // The legacy spelling is named as the origin it came from.
  assert.strictEqual(loadAt(home, { env: { SUBSTRATE_ORG: 'acme', SPOR_AGENT_RUN: '1' } }).tenantError().origin, 'SUBSTRATE_ORG');
  // Agent run WITH its bearer exported (the dispatch-exported shape): the flat
  // env path wins before SPOR_ORG is read, as it does for a person — the token
  // sent is the agent's and no refusal is recorded.
  const jwt = fakeJwt({ org: 'acme', sub: 'agent-1' });
  const bound = loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: jwt, SPOR_ORG: 'acme', SPOR_AGENT_RUN: '1' } });
  assert.strictEqual(bound.tenantError(), null);
  assert.strictEqual(bound.token(), jwt);
  assert.strictEqual(bound.tenant().source, 'env');
  assert.strictEqual(bound.tenant().refresh_token, null);
  // Under an explicit local mode the ambient refusal is moot, as for unknown-org.
  assert.strictEqual(loadAt(home, { env: { SPOR_ORG: 'acme', SPOR_AGENT_RUN: '1', SPOR_MODE: 'local' } }).tenantError(), null);
});

test('selector: a repo .spor org: marker in an agent run refuses instead of resolving the person tenant', () => {
  const home = tmp();
  auth.writeStore(home, {
    tenants: { 'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } },
    default: 'https://s/acme',
  });
  const repo = tmp('spor-auth-repo-');
  fs.writeFileSync(path.join(repo, '.spor'), 'repo: x\norg: acme\n');
  // Non-agent: the marker picks the stored tenant, unchanged.
  assert.strictEqual(loadAt(home, { cwd: repo }).token(), 'PERSON');
  // Agent run, no env bearer: refused, naming the marker file.
  const c = loadAt(home, { cwd: repo, env: { SPOR_AGENT_RUN: '1' } });
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.token(), '');
  const te = c.tenantError();
  assert.strictEqual(te.kind, 'agent-org');
  assert.strictEqual(te.org, 'acme');
  assert.strictEqual(te.agent_org, null);
  assert.strictEqual(te.source, 'repo-marker');
  assert.strictEqual(te.origin, path.join(repo, '.spor'));
  // The hook/CLI/explain surfaces share one rendering that names the selector.
  assert.match(describeTenantRefusal(te), /org 'acme' \(from .*\.spor\) in a dispatched agent run/);
  // A marker naming an org that is NOT the agent's, with the agent bearer
  // exported: the flat env path still wins (byte-identical ordering), the
  // agent token is sent and the marker is not consulted.
  const jwt = fakeJwt({ org: 'beta', sub: 'agent-1' });
  const bound = loadAt(home, { cwd: repo, env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: jwt, SPOR_AGENT_RUN: '1' } });
  assert.strictEqual(bound.tenantError(), null);
  assert.strictEqual(bound.token(), jwt);
});

test('cli: an agent run with an inherited SPOR_ORG exits 1 and sends nothing; the same env without the marker is unchanged', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    auth.writeStore(home, {
      tenants: { [`${base}/acme`]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } },
      default: `${base}/acme`,
    });
    const r = await runAsync(['get', 'task-x'], { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: 'acme', SPOR_AGENT_RUN: '1' });
    assert.strictEqual(r.code, 1, r.stderr);
    assert.match(r.stderr, /SPOR_ORG='acme' refused — this is a dispatched agent run/);
    assert.deepStrictEqual(hits, [], 'nothing was sent');
    // auth list is NOT exempt here — the refusal is about who is asking.
    const l = await runAsync(['auth', 'list'], { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: 'acme', SPOR_AGENT_RUN: '1' });
    assert.strictEqual(l.code, 1, l.stderr);
    // Without the marker the person's own SPOR_ORG resolves their tenant (unchanged).
    const p = await runAsync(['get', 'task-x'], { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: 'acme' });
    assert.ok(hits.some((h) => h.bearer === 'PERSON'), JSON.stringify({ hits, stderr: p.stderr }));
  } finally {
    srv.close();
  }
});

test('cli: credential acquisition (auth login / login / join) refuses in an agent run, even with no org selector', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    // A bound agent env with no refusal from the cascade at all.
    const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: fakeJwt({ org: 'acme' }), SPOR_AGENT_RUN: '1' };
    for (const args of [['auth', 'login'], ['auth', 'login', '--org', 'beta'], ['login', `${base}`, 'PASTED'], ['join', 'PASTED']]) {
      const r = await runAsync(args, env);
      assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /refused — this is a dispatched agent run/, args.join(' '));
    }
    assert.deepStrictEqual(hits, [], 'no device-flow or paste-path request left the box');
    assert.deepStrictEqual(auth.readStore(home).tenants, {}, 'nothing was stored');
    // Bare `auth whoami` reports the resolved (agent) tenant and stays open.
    const w = await runAsync(['auth', 'whoami'], env);
    assert.doesNotMatch(w.stderr, /refused — this is a dispatched agent run/);
  } finally {
    srv.close();
  }
});

// The store-mutating and store-listing auth subcommands
// (issue-spor-agent-run-can-mutate-person-credential-store): a dispatched agent
// run may not delete the person's credentials, re-point their default tenant,
// or enumerate the store — with or without an org selector.
test('cli: auth logout / logout --all / switch / list / whoami --all refuse in an agent run and leave the store untouched', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    const store = {
      tenants: {
        [`${base}/acme`]: { server: base, org: 'acme', access_token: 'PERSON-ACME', refresh_token: 'RT' },
        [`${base}/beta`]: { server: base, org: 'beta', access_token: 'PERSON-BETA', refresh_token: 'RT' },
      },
      default: `${base}/acme`,
    };
    auth.writeStore(home, store);
    const before = fs.readFileSync(path.join(home, 'auth', 'credentials.json'), 'utf8');
    const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: fakeJwt({ org: 'acme' }), SPOR_AGENT_RUN: '1' };
    const shapes = [
      ['auth', 'logout'], ['auth', 'logout', '--all'], ['auth', 'logout', 'beta'], ['--org', 'acme', 'auth', 'logout'],
      ['auth', 'switch', 'beta'], ['--org', 'acme', 'auth', 'switch'], ['auth'], ['auth', 'list'], ['auth', 'whoami', '--all'], ['whoami', '--all'],
    ];
    for (const args of shapes) {
      const r = await runAsync(args, env);
      assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /refused — this is a dispatched agent run/, args.join(' '));
      assert.doesNotMatch(r.stdout + r.stderr, /beta/.test(args.join(' ')) ? /PERSON/ : /beta|PERSON/, args.join(' '));
    }
    assert.strictEqual(fs.readFileSync(path.join(home, 'auth', 'credentials.json'), 'utf8'), before, 'the store was not rewritten');
    // The agent-org refusal's explain surface names the agent's org, never the person's stored orgs.
    const x = await runAsync(['--org', 'beta', 'config', 'explain', '--json'], env);
    assert.strictEqual(x.code, 0, x.stderr);
    const j = JSON.parse(x.stdout);
    assert.strictEqual(j.tenant.refused, 'agent-org');
    assert.strictEqual(j.tenant.agent_org, 'acme');
    assert.ok(!('stored_orgs' in j.tenant), JSON.stringify(j.tenant));
    const e = JSON.parse((await runAsync(['--org', '', 'config', 'explain', '--json'], env)).stdout);
    assert.strictEqual(e.tenant.refused, 'empty-org');
    assert.ok(!('stored_orgs' in e.tenant), JSON.stringify(e.tenant));
    const et = await runAsync(['--org', '', 'config', 'explain'], env);
    assert.strictEqual(et.code, 0, et.stderr);
    assert.match(et.stdout, /tenant: +REFUSED/);
    assert.doesNotMatch(et.stdout, /stored:/);
    assert.ok(!hits.some((h) => /PERSON/.test(h.bearer || '')), JSON.stringify(hits));
    // Without the marker the person's own logout still works (unchanged).
    const p = await runAsync(['auth', 'switch', 'beta'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(p.code, 0, p.stderr);
    assert.strictEqual(auth.readStore(home).default, `${base}/beta`);
  } finally {
    srv.close();
  }
});

// Access classes (task-spor-cli-command-access-classes-for-agent-runs): the
// guard refuses by what a command does to credentials, so `install
// --server/--token` — which writes the person's flat config credential — refuses
// in an agent run like the auth store writers, while a plain install is not a
// credential write at all.
test('cli: install --server/--token refuses in an agent run and leaves the flat config untouched', async () => {
  const home = tmp();
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: fakeJwt({ org: 'acme' }), SPOR_AGENT_RUN: '1' };
  for (const args of [['install', 'claude', '--token', 'PASTED', '--print'], ['install', '--server=https://evil.example', '--print']]) {
    const r = await runAsync(args, env);
    assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /'install --server\/--token' refused — this is a dispatched agent run/, args.join(' '));
  }
  assert.ok(!fs.existsSync(path.join(home, 'config.json')), 'no flat credential was written');
});

test('cli: config explain renders an empty --org through the shared refusal line', async () => {
  const home = tmp();
  auth.writeStore(home, { tenants: { 'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'T' } }, default: 'https://s/acme' });
  const r = await runAsync(['--org', '', 'config', 'explain'], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /tenant: +REFUSED — --org given an empty value; stored: acme/);
  assert.doesNotMatch(r.stdout, /org '' \(from/);
});

// The last door (task-spor-agent-run-no-store-token-fallback): a server with
// NO bearer. The person's cascade pairs `--server`/SPOR_SERVER with the store's
// credential for that server (tokenForServer) or the flat config `token`, and
// flat() itself borrows the store's access_token when handed an empty one —
// so under SPOR_AGENT_RUN=1 with a server set and no token every one of those
// sent the PERSON's credential. Under an agent run the store is never opened:
// a bare server refuses with `agent-no-token`, and the store default / legacy
// flat token (steps 5-6) are never reached.
test('selector: an agent run with a server and no token refuses instead of pairing the person store or flat config token', () => {
  const home = tmp();
  auth.writeStore(home, {
    tenants: { 'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'PERSON', refresh_token: 'RT', person: 'person-x' } },
    default: 'https://s/acme',
  });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'https://s', token: 'FLAT' }));
  // Person (no marker): every shape pairs the server with a credential of the
  // person's — the flat config token, the store's entry for the server, the
  // store default — unchanged.
  assert.strictEqual(loadAt(home, { env: { SPOR_SERVER: 'https://s' } }).token(), 'FLAT');
  assert.strictEqual(loadAt(home, { cli: { server: 'https://s' } }).token(), 'PERSON');
  assert.strictEqual(loadAt(home, {}).token(), 'PERSON');
  const check = (c, source, origin) => {
    assert.strictEqual(c.tenant(), null);
    assert.strictEqual(c.token(), '');
    assert.strictEqual(c.server(), '');
    const te = c.tenantError();
    assert.strictEqual(te.kind, 'agent-no-token');
    assert.strictEqual(te.server, 'https://s');
    assert.strictEqual(te.source, source);
    assert.strictEqual(te.origin, origin);
    assert.deepStrictEqual(te.orgs, [], 'the person\'s orgs are not listed to the agent');
    assert.match(describeTenantRefusal(te), /in a dispatched agent run with no agent token/);
  };
  // SPOR_SERVER and the legacy spelling.
  check(loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_AGENT_RUN: '1' } }), 'env', 'SPOR_SERVER');
  check(loadAt(home, { env: { SUBSTRATE_SERVER: 'https://s', SPOR_AGENT_RUN: '1' } }), 'env', 'SUBSTRATE_SERVER');
  // --server, with and without an --org that names the stored org.
  check(loadAt(home, { env: { SPOR_AGENT_RUN: '1' }, cli: { server: 'https://s' } }), 'cli-server', '--server');
  check(loadAt(home, { env: { SPOR_AGENT_RUN: '1' }, cli: { server: 'https://s', org: 'acme' } }), 'cli-server', '--server');
  // The config-file server with no bearer: refused too, never paired with FLAT.
  check(loadAt(home, { env: { SPOR_AGENT_RUN: '1' } }), 'flat-config', path.join(home, 'config.json'));
  // No server named anywhere: local, no refusal (the store default is never read).
  const bare = tmp();
  auth.writeStore(bare, { tenants: { 'https://s/acme': { server: 'https://s', org: 'acme', access_token: 'PERSON' } }, default: 'https://s/acme' });
  assert.strictEqual(loadAt(bare, { env: { SPOR_AGENT_RUN: '1' } }).tenant(), null);
  assert.strictEqual(loadAt(bare, { env: { SPOR_AGENT_RUN: '1' } }).tenantError(), null);
  // An ambient refusal is moot under an explicit local mode, as for the others.
  assert.strictEqual(loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_AGENT_RUN: '1', SPOR_MODE: 'local' } }).tenantError(), null);
  // With the agent's bearer the tenant is built WITHOUT the store: no key, no
  // refresh credential, no person identity — even when the store holds an entry
  // for the same server (and the --token spelling, and a config-file server).
  const jwt = fakeJwt({ org: 'acme', sub: 'agent-1' });
  for (const c of [
    loadAt(home, { env: { SPOR_SERVER: 'https://s', SPOR_TOKEN: jwt, SPOR_AGENT_RUN: '1' } }),
    loadAt(home, { env: { SUBSTRATE_SERVER: 'https://s', SUBSTRATE_TOKEN: jwt, SPOR_AGENT_RUN: '1' } }),
    loadAt(home, { env: { SPOR_AGENT_RUN: '1' }, cli: { server: 'https://s', token: jwt } }),
    loadAt(home, { env: { SPOR_TOKEN: jwt, SPOR_AGENT_RUN: '1' } }),
  ]) {
    assert.strictEqual(c.tenantError(), null);
    const t = c.tenant();
    assert.strictEqual(t.token, jwt);
    assert.strictEqual(t.server, 'https://s');
    assert.strictEqual(t.org, 'acme');
    assert.strictEqual(t.key, null);
    assert.strictEqual(t.refresh_token, null);
    assert.strictEqual(t.person, null);
  }
});

test('cli: an agent run with SPOR_SERVER / --server --org and no token exits 1 and the server never sees the person token', async () => {
  const { srv, base, hits } = await refreshServer();
  try {
    const home = tmp();
    auth.writeStore(home, {
      tenants: { [`${base}/acme`]: { server: base, org: 'acme', access_token: 'PERSON', refresh_token: 'RT' } },
      default: `${base}/acme`,
    });
    const H = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_AGENT_RUN: '1' };
    const shapes = [
      [['get', 'task-x'], { ...H, SPOR_SERVER: base }, /SPOR_SERVER=.* refused — this is a dispatched agent run with no agent token/],
      [['get', 'task-x'], { ...H, SUBSTRATE_SERVER: base }, /SUBSTRATE_SERVER=.* refused — this is a dispatched agent run with no agent token/],
      // --server is not a global CLI flag (only --org is lifted), so the
      // "--server + --org" shape is the lib-level test above; here --org rides
      // beside the env server under both spellings. --org is read before the
      // env server, and with no bearer to confirm it refuses as `agent-org`.
      [['--org', 'acme', 'get', 'task-x'], { ...H, SPOR_SERVER: base }, /--org 'acme' refused — this is a dispatched agent run/],
      [['--org', 'acme', 'get', 'task-x'], { ...H, SUBSTRATE_SERVER: base }, /--org 'acme' refused — this is a dispatched agent run/],
      // Not exempt: the inspection verbs run as the agent too.
      [['auth', 'list'], { ...H, SPOR_SERVER: base }, /refused — this is a dispatched agent run/],
    ];
    for (const [args, env, re] of shapes) {
      const r = await runAsync(args, env);
      assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, re, args.join(' '));
    }
    assert.deepStrictEqual(hits, [], 'nothing was sent');
    // The explain surface shows the refusal and lists no stored orgs.
    const x = await runAsync(['config', 'explain', '--json'], { ...H, SPOR_SERVER: base });
    assert.strictEqual(x.code, 0, x.stderr);
    const j = JSON.parse(x.stdout);
    assert.strictEqual(j.tenant.refused, 'agent-no-token');
    assert.strictEqual(j.tenant.server, base);
    assert.ok(!('stored_orgs' in j.tenant), 'an agent refusal carries no stored-org inventory');
    // The same env without the marker is the person's own flat path, unchanged.
    await runAsync(['get', 'task-x'], { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base });
    assert.ok(hits.some((h) => h.bearer === 'PERSON'), JSON.stringify(hits));
  } finally {
    srv.close();
  }
});

// ===========================================================================
// lib/remote.js request() — jsonError on an unparseable 2xx body
// (issue-spor-verify-run-resolution-silent-json-parse-failure): mirrors
// dispatch-terminal.js's own httpJson so every caller reading the parsed body
// can tell "failed to parse" apart from "legitimately parsed to null/{}"
// instead of both silently reading as the latter.
// ===========================================================================

function bodyServer(body) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('remote.request: a 2xx with an unparseable body surfaces jsonError, leaving ok/json exactly as before', async () => {
  const { srv, base } = await bodyServer('not valid json{{{');
  try {
    const home = tmp();
    const c = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 't' } });
    const r = await remote.get(c, '/v1/nodes/task-x');
    assert.strictEqual(r.ok, true, 'the HTTP layer alone still reports success');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json, null, 'byte-identical to before this fix: a failed parse still leaves json null');
    assert.match(r.jsonError, /Unexpected|JSON/i);
  } finally {
    srv.close();
  }
});

test('remote.request: a 2xx with a genuinely empty body carries no jsonError — that is not a parse failure', async () => {
  const { srv, base } = await bodyServer('');
  try {
    const home = tmp();
    const c = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 't' } });
    const r = await remote.get(c, '/v1/nodes/task-x');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.json, null);
    assert.strictEqual(r.jsonError, null);
  } finally {
    srv.close();
  }
});

test('remote.request: a 2xx with a valid JSON body parses cleanly and carries no jsonError', async () => {
  const { srv, base } = await bodyServer(JSON.stringify({ id: 'task-x', type: 'task' }));
  try {
    const home = tmp();
    const c = loadAt(home, { env: { SPOR_SERVER: base, SPOR_TOKEN: 't' } });
    const r = await remote.get(c, '/v1/nodes/task-x');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.json, { id: 'task-x', type: 'task' });
    assert.strictEqual(r.jsonError, null);
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
