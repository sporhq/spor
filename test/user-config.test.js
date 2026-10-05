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
