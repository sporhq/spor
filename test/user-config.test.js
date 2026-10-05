// lib/shell/user-config.js — the one atomic, mode-preserving user config.json writer.
require("./helpers/tmp-cleanup");
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { editUserConfig } = require('../lib/shell/user-config.js');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spor-ucfg-'));
const posix = process.platform !== 'win32';

test('creates a missing home and file, 0600', () => {
  const home = path.join(scratch(), 'nested');
  const r = editUserConfig(home, (d) => { d.a = 1; });
  assert.strictEqual(r.wrote, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { a: 1 });
  if (posix) assert.strictEqual(fs.statSync(r.file).mode & 0o777, 0o600);
});

test('preserves other keys and the existing file mode', () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ x: { y: 1 } }));
  fs.chmodSync(f, 0o644);
  editUserConfig(home, (d) => { d.z = 2; });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { x: { y: 1 }, z: 2 });
  if (posix) assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644);
});

test('mutate returning false skips the write; no temp files are left behind', () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, '{"a":1}');
  const before = fs.statSync(f).mtimeMs;
  assert.strictEqual(editUserConfig(home, () => false).wrote, false);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
  assert.strictEqual(fs.statSync(f).mtimeMs, before);
  editUserConfig(home, (d) => { d.b = 2; });
  assert.deepStrictEqual(fs.readdirSync(home), ['config.json']);
});

test('refuses to clobber a malformed config', () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, '{ not json');
  const r = editUserConfig(home, (d) => { d.a = 1; });
  assert.deepStrictEqual({ wrote: r.wrote, malformed: r.malformed }, { wrote: false, malformed: true });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ not json');
});

test('writes through a symlinked config.json, leaving the link in place', { skip: !posix }, () => {
  const home = scratch();
  const real = path.join(scratch(), 'dotfiles-config.json');
  fs.writeFileSync(real, '{"a":1}');
  fs.symlinkSync(real, path.join(home, 'config.json'));
  editUserConfig(home, (d) => { d.b = 2; });
  assert.ok(fs.lstatSync(path.join(home, 'config.json')).isSymbolicLink());
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { a: 1, b: 2 });
});

test('an unreadable (non-ENOENT) config is not treated as absent', { skip: !posix || process.getuid?.() === 0 }, () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, '{"a":1}');
  fs.chmodSync(f, 0o000);
  assert.throws(() => editUserConfig(home, (d) => { d.b = 2; }));
  fs.chmodSync(f, 0o600);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
});

test('a config holding a secret (legacy flat token) is tightened to owner-only', { skip: !posix }, () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ server: 'https://s', token: 'T' }));
  fs.chmodSync(f, 0o644);
  editUserConfig(home, (d) => { d.dispatch = { agent: 'a' }; });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  // a nested secret key counts too
  const g = path.join(home, 'config.json');
  fs.writeFileSync(g, JSON.stringify({ attestation: { signingKey: 'K' } }));
  fs.chmodSync(g, 0o640);
  editUserConfig(home, (d) => { d.x = 1; });
  assert.strictEqual(fs.statSync(g).mode & 0o777, 0o600);
});

test('a token REMOVED by the edit does not force the tighten; owner bits are kept', { skip: !posix }, () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ token: 'T' }));
  fs.chmodSync(f, 0o644);
  editUserConfig(home, (d) => { delete d.token; });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644);
});

test('writes through a DANGLING symlinked config.json, leaving the link in place', { skip: !posix }, () => {
  const home = scratch();
  const real = path.join(scratch(), 'missing-dir', 'config.json');
  fs.symlinkSync(real, path.join(home, 'config.json'));
  const r = editUserConfig(home, (d) => { d.a = 1; });
  assert.strictEqual(r.file, real);
  assert.ok(fs.lstatSync(path.join(home, 'config.json')).isSymbolicLink());
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { a: 1 });
  assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
});

test('a no-op edit still tightens a secret-bearing config left world-readable', { skip: !posix }, () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ server: 'https://s', token: 'T' }));
  fs.chmodSync(f, 0o644);
  assert.strictEqual(editUserConfig(home, () => false).wrote, false);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('a dangling RELATIVE link with `..`, inside a symlinked home, resolves as the kernel does', { skip: !posix }, () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, 'dotfiles', 'spor'), { recursive: true });
  const home = path.join(root, 'home');
  fs.symlinkSync(path.join(root, 'dotfiles', 'spor'), home);
  fs.symlinkSync('../private/c.json', path.join(home, 'config.json'));
  const r = editUserConfig(home, (d) => { d.a = 1; });
  const expected = path.join(fs.realpathSync(root), 'dotfiles', 'private', 'c.json');
  assert.strictEqual(r.file, expected);
  assert.strictEqual(fs.realpathSync(path.join(home, 'config.json')), expected, 'the link now resolves to what was written');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), { a: 1 });
});

test('a symlink loop is refused, never replaced', { skip: !posix }, () => {
  const home = scratch();
  const f = path.join(home, 'config.json');
  fs.symlinkSync('loop2', f);
  fs.symlinkSync('config.json', path.join(home, 'loop2'));
  assert.throws(() => editUserConfig(home, (d) => { d.a = 1; }), (e) => e.code === 'ELOOP');
  assert.ok(fs.lstatSync(f).isSymbolicLink());
});
