// lib/config.js — the client configuration cascade
// (dec-spor-client-config-cascade). Layers, precedence, secret stripping,
// dual-read, and the byte-identical guarantee (env-above-config) are the
// contract.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cfg-'));
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
function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

test('defaults: unset values fall through to caller fallback (byte-identical)', () => {
  const dir = tmp();
  const c = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(c.getNum('search.minSim', 0.08), 0.08);
  assert.strictEqual(c.getNum('distill.debounce', 900), 900);
  assert.strictEqual(c.get('distill.model', 'haiku'), 'haiku');
  assert.strictEqual(c.mode(), 'local'); // no server
  assert.strictEqual(c.enabled(), true);
  assert.deepStrictEqual(c.warnings, []);
});

test('env layer overrides config files (env-above-config)', () => {
  const root = tmp();
  const homeDir = path.join(root, 'home');
  write(path.join(homeDir, 'config.json'), { distill: { model: 'sonnet' } });
  write(path.join(root, 'repo', '.spor.json'), { distill: { model: 'opus' } });
  const c = loadConfig({
    cwd: path.join(root, 'repo'),
    env: bareEnv({ SPOR_HOME: homeDir, SPOR_DISTILL_MODEL: 'haiku-env' }),
  });
  assert.strictEqual(c.get('distill.model'), 'haiku-env');
});

test('dual-read: legacy SUBSTRATE_* honored when SPOR_* absent', () => {
  const dir = tmp();
  const c = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SUBSTRATE_SERVER: 'https://legacy' }) });
  assert.strictEqual(c.get('server'), 'https://legacy');
  assert.strictEqual(c.mode(), 'remote');
});

test('repo layer: nearest-ancestor (deepest) wins; ancestor keys still merge', () => {
  const root = tmp();
  write(path.join(root, '.spor.json'), { server: 'https://root', search: { projects: { exclude: ['a'] } } });
  write(path.join(root, 'sub', '.spor.json'), { search: { minSim: 0.5 } });
  const c = loadConfig({ cwd: path.join(root, 'sub'), env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.getNum('search.minSim', 0.08), 0.5); // from sub
  assert.strictEqual(c.get('server'), 'https://root'); // inherited from root
  assert.deepStrictEqual(c.getList('search.projects.exclude'), ['a']);
});

test('secret rule: repo-level token is stripped and warned', () => {
  const root = tmp();
  write(path.join(root, '.spor.json'), { token: 'LEAK', server: 'https://x' });
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.get('token'), undefined);
  assert.strictEqual(c.get('server'), 'https://x');
  assert.strictEqual(c.warnings.length, 1);
  assert.match(c.warnings[0], /ignored 'token'/);
});

test('token IS honored from user config and env', () => {
  const root = tmp();
  write(path.join(root, 'config.json'), { token: 'user-tok' });
  const c1 = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c1.get('token'), 'user-tok');
  const c2 = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root, SPOR_TOKEN: 'env-tok' }) });
  assert.strictEqual(c2.get('token'), 'env-tok');
});

test('disable mode: enabled:false and mode:off both make enabled() false', () => {
  const root = tmp();
  write(path.join(root, 'a', '.spor.json'), { enabled: false });
  const ca = loadConfig({ cwd: path.join(root, 'a'), env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(ca.enabled(), false);
  write(path.join(root, 'b', '.spor.json'), { mode: 'off' });
  const cb = loadConfig({ cwd: path.join(root, 'b'), env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(cb.enabled(), false);
  assert.strictEqual(cb.mode(), 'off');
});

test('getBool honors the shell "0"/"false" convention', () => {
  const dir = tmp();
  const c0 = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_NUDGE: '0' }) });
  assert.strictEqual(c0.getBool('nudge.enabled', true), false);
  const c1 = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_NUDGE: '1' }) });
  assert.strictEqual(c1.getBool('nudge.enabled', true), true);
  const cd = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(cd.getBool('nudge.enabled', true), true); // fallback
});

test('unknown top-level key earns a warning but is otherwise ignored', () => {
  const root = tmp();
  write(path.join(root, '.spor.json'), { searhc: { minSim: 0.5 }, enabled: true });
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.ok(c.warnings.some((w) => /unknown config key 'searhc'/.test(w)));
  assert.strictEqual(c.getNum('search.minSim', 0.08), 0.08); // typo'd key had no effect
});

test('fail-open: malformed config file is skipped with a warning', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.spor.json'), '{ not json ');
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.warnings.length, 1);
  assert.match(c.warnings[0], /malformed config/);
  assert.strictEqual(c.enabled(), true); // defaults intact
});
