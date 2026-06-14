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

test('remote verb fails open against an unreachable server (no stack trace)', () => {
  const r = run(['status'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+remote/);
  assert.match(r.stdout, /OFFLINE/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/); // no crash
});
