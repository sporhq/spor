// bin/spor — the unified client CLI (task-cc-spor-cli-bin-build).
// Local verbs must be byte-identical passthrough to the lib scripts; onboarding
// verbs (init/status) and fail-open behavior are the new contract. Everything
// runs against a throwaway graph home — never the live graph.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'spor.js');
const LIB = path.join(__dirname, '..', 'lib');

// Env with no SPOR_*/SUBSTRATE_* leakage from the runner.
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SPOR_') || k.startsWith('SUBSTRATE_') || k === 'XDG_CONFIG_HOME') continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: bare(env) });
}
function runLib(script, args, env) {
  return spawnSync(process.execPath, [path.join(LIB, script), ...args], { encoding: 'utf8', env: bare(env) });
}

// A tiny scratch graph for local-mode verbs.
function fixtureGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-'));
  const nodes = path.join(dir, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, 'dec-x.md'), `---
id: dec-x
type: decision
project: demo
title: A demo decision about auth token rotation
summary: A demo decision describing auth token rotation and credential handling for the pipeline.
date: 2026-06-01
---
Body about auth token rotation.
`);
  return { dir, nodes };
}

test('help and version exit 0', () => {
  assert.strictEqual(run(['help']).status, 0);
  assert.strictEqual(run([]).status, 0); // no verb => help
  const v = run(['version']);
  assert.strictEqual(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown verb exits 1 with a hint', () => {
  const r = run(['frobnicate']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown verb/);
});

test('init creates the local graph home, idempotently', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-home-'));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const r1 = run(['init'], { SPOR_HOME: home });
  assert.strictEqual(r1.status, 0);
  assert.match(r1.stdout, /Created/);
  assert.ok(fs.existsSync(path.join(home, 'nodes')), 'nodes dir created');
  assert.strictEqual(fs.readFileSync(path.join(home, '.gitignore'), 'utf8'), 'journal/\n');
  // second run is safe and reports already-present
  const r2 = run(['init'], { SPOR_HOME: home });
  assert.strictEqual(r2.status, 0);
  assert.match(r2.stdout, /already present/);
});

test('status (local) reports local mode and node count', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['status'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+local/);
  assert.match(r.stdout, new RegExp(`${nodes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(1 nodes\\)`));
});

test('whoami in local mode explains there is no server identity', () => {
  const { dir } = fixtureGraph();
  const r = run(['whoami'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /local mode/);
});

test('validate is byte-identical passthrough to lib/validate.js', () => {
  const { nodes } = fixtureGraph();
  const viaCli = run(['validate', '--nodes', nodes]);
  const viaLib = runLib('validate.js', ['--nodes', nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
  assert.strictEqual(viaCli.status, viaLib.status);
});

test('compile is byte-identical passthrough to lib/compile.js', () => {
  const { nodes } = fixtureGraph();
  const args = ['--query', 'auth token rotation credential', '--digest', '--nodes', nodes];
  const viaCli = run(['compile', ...args]);
  const viaLib = runLib('compile.js', args);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test('brief <id> is sugar for compile --root <id>', () => {
  const { nodes } = fixtureGraph();
  const viaCli = run(['brief', 'dec-x', '--nodes', nodes]);
  const viaLib = runLib('compile.js', ['--root', 'dec-x', '--nodes', nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test('next (local) is byte-identical passthrough to lib/queue.js', () => {
  const { nodes } = fixtureGraph();
  const viaCli = run(['next', '--nodes', nodes]);
  const viaLib = runLib('queue.js', ['--nodes', nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test('get (local) prints the node file; missing node exits 1', () => {
  const { dir } = fixtureGraph();
  const ok = run(['get', 'dec-x'], { SPOR_NODES: path.join(dir, 'nodes') });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /id: dec-x/);
  const miss = run(['get', 'nope'], { SPOR_NODES: path.join(dir, 'nodes') });
  assert.strictEqual(miss.status, 1);
});

test('add (local) writes a valid typed node that validate accepts', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['add', 'Cache the tf-idf norms across compiles for speed', '--type', 'task'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /added task-/);
  const written = fs.readdirSync(nodes).filter((f) => f.startsWith('task-') && f !== 'dec-x.md');
  assert.strictEqual(written.length, 1);
  // the new graph still validates clean
  const v = runLib('validate.js', ['--nodes', nodes]);
  assert.strictEqual(v.status, 0);
  assert.match(v.stdout, /0 errors/);
});

test('add (local) uniquifies the id on a repeated title', () => {
  const { dir, nodes } = fixtureGraph();
  run(['add', 'same title here', '--type', 'task'], { SPOR_HOME: dir });
  run(['add', 'same title here', '--type', 'task'], { SPOR_HOME: dir });
  const ids = fs.readdirSync(nodes).filter((f) => f.startsWith('task-same-title-here'));
  assert.strictEqual(ids.length, 2, 'second add got a distinct id');
});

test('add with no text exits 1', () => {
  const { dir } = fixtureGraph();
  const r = run(['add'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('join writes server+token to user config (never repo)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-join-'));
  const r = run(['join', 'http://127.0.0.1:9/', 'tok123'], { SPOR_HOME: home });
  // status confirmation runs against a dead server => still exits 0 (fail-open)
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.server, 'http://127.0.0.1:9'); // trailing slash trimmed
  assert.strictEqual(cfg.token, 'tok123');
  assert.match(r.stdout, /OFFLINE/); // confirmation probe ran
});

test('migrate commits the graph and pushes to a user-owned remote', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mig-'));
  const nodes = path.join(home, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, 'dec-x.md'), `---\nid: dec-x\ntype: decision\nproject: demo\ntitle: t\nsummary: s\ndate: 2026-06-01\n---\nbody\n`);
  // a bare repo stands in for the remote the user owns (no network)
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote-'));
  spawnSync('git', ['init', '--bare', '-q', remote]);
  const r = run(['migrate', remote], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /pushed 1 nodes/);
  // the node landed on the remote's pushed branch
  const refs = spawnSync('git', ['-C', remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean);
  assert.ok(refs.length >= 1, 'a branch was pushed to the remote');
  const ls = spawnSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', refs[0]], { encoding: 'utf8' });
  assert.match(ls.stdout, /nodes\/dec-x\.md/);
});

test('migrate remembers origin, so a second run needs no url', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mig2-'));
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'nodes', 'dec-y.md'), `---\nid: dec-y\ntype: decision\nproject: demo\ntitle: t\nsummary: s\ndate: 2026-06-01\n---\nb\n`);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote2-'));
  spawnSync('git', ['init', '--bare', '-q', remote]);
  assert.strictEqual(run(['migrate', remote], { SPOR_HOME: home }).status, 0);
  // second run with no url reuses the stored origin
  const r2 = run(['push'], { SPOR_HOME: home });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /pushed 1 nodes/);
});

test('migrate without a url or origin explains it needs one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mig3-'));
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'nodes', 'dec-z.md'), `---\nid: dec-z\ntype: decision\nproject: demo\ntitle: t\nsummary: s\ndate: 2026-06-01\n---\nb\n`);
  const r = run(['migrate'], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote-url|origin/);
});

test('migrate without a graph points at init', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mig4-'));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const r = run(['migrate', '/tmp/some-remote'], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /spor init/);
});

test('disable/enable merge enabled into .spor.json at the cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-scope-'));
  const r1 = spawnSync(process.execPath, [CLI, 'disable'], { cwd: dir, encoding: 'utf8', env: bare() });
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.spor.json'), 'utf8')).enabled, false);
  const r2 = spawnSync(process.execPath, [CLI, 'enable'], { cwd: dir, encoding: 'utf8', env: bare() });
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.spor.json'), 'utf8')).enabled, true);
});

test('link writes the .spor marker; rejects a non-canonical slug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-link-'));
  const ok = spawnSync(process.execPath, [CLI, 'link', 'my-repo'], { cwd: dir, encoding: 'utf8', env: bare() });
  assert.strictEqual(ok.status, 0);
  assert.match(fs.readFileSync(path.join(dir, '.spor'), 'utf8'), /^repo: my-repo$/m);
  const bad = spawnSync(process.execPath, [CLI, 'link', 'Bad_Slug'], { cwd: dir, encoding: 'utf8', env: bare() });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid slug/);
});

test('invite/token require remote mode (local explains why)', () => {
  const { dir } = fixtureGraph();
  const inv = run(['invite', '--person', 'person-x'], { SPOR_HOME: dir });
  assert.strictEqual(inv.status, 1);
  assert.match(inv.stderr, /team graph/);
  const tok = run(['token', 'list'], { SPOR_HOME: dir });
  assert.strictEqual(tok.status, 1);
  assert.match(tok.stderr, /remote/);
});

test('invite with neither --person nor --name/--email exits 1 with usage', () => {
  const r = run(['invite'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('token revoke without a prefix exits 1', () => {
  const r = run(['token', 'revoke'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('invite fails open against an unreachable server', () => {
  const r = run(['invite', '--person', 'person-x'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test('remote verb fails open against an unreachable server (no stack trace)', () => {
  const r = run(['status'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+remote/);
  assert.match(r.stdout, /OFFLINE/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/); // no crash
});
