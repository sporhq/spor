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

// Env with no SPOR_*/SUBSTRATE_* leakage from the runner. Also isolate the
// config-cascade homes to an empty temp dir so the developer's real
// ~/.spor/config.json (which may carry server+token after `spor join`) can't
// leak in and flip a local-mode test to remote. Tests that need a specific home
// pass it via `extra`, which wins (applied last).
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-iso-'));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SPOR_') || k.startsWith('SUBSTRATE_') || k === 'XDG_CONFIG_HOME') continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME; // user config: ISO_HOME/config.json (absent) -> local mode
  env.XDG_CONFIG_HOME = ISO_HOME; // global config: ISO_HOME/spor/config.json (absent)
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

// --- table-driven help + parsing (task-cc-spor-cli-flag-parsing-help) -------
// One COMMANDS table drives dispatch, util.parseArgs flag parsing, and help —
// top-level AND per-command. These pin the new surfaces.

test('top-level help is generated from the table (grouped, with the footer)', () => {
  const r = run(['help']);
  assert.strictEqual(r.status, 0);
  // groups present
  assert.match(r.stdout, /Getting started/);
  assert.match(r.stdout, /Repo scoping/);
  // a command line and the "--help for detail" footer
  assert.match(r.stdout, /install \[host\.\.\.\]/);
  assert.match(r.stdout, /Run 'spor <command> --help'/);
});

test("'spor <command> --help' prints that command's detailed page", () => {
  const r = run(['add', '--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^spor add /m);     // usage line
  assert.match(r.stdout, /Aliases: capture/); // alias surfaced
  assert.match(r.stdout, /Options:/);
  assert.match(r.stdout, /--type <T>/);       // a flag with its value placeholder
  // -h is the same as --help, and dispatch (a strict verb) documents its flags
  const h = run(['dispatch', '-h']);
  assert.strictEqual(h.status, 0);
  assert.match(h.stdout, /--from-queue/);
  assert.match(h.stdout, /--no-brief/);
});

test("'spor help <command>' is the same as '<command> --help'", () => {
  const a = run(['help', 'install']);
  const b = run(['install', '--help']);
  assert.strictEqual(a.status, 0);
  assert.strictEqual(a.stdout, b.stdout);
  // an alias resolves to its canonical page
  assert.match(run(['help', 'queue']).stdout, /^spor next /m);
});

test('an unknown flag on a strict command exits 1 with a suggestion, no stack', () => {
  const r = run(['install', 'codex', '--scpoe', 'user']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown flag '--scpoe'/);
  assert.match(r.stderr, /did you mean --scope\?/);
  assert.doesNotMatch(r.stderr, /at Object|\bError:/); // friendly, not a throw
});

test('a flag missing its value is a friendly error, not a crash', () => {
  const r = run(['add', 'some text', '--type']); // --type needs a value
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /spor add:/);
  assert.doesNotMatch(r.stderr, /at Object|\bError:/);
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
  // The Node prerequisite line is always surfaced (issue-spor-onboarding-no-
  // node-silent-fail-open) so a box where the hooks silently no-op is greppable.
  assert.match(r.stdout, /node:\s+\d+\.\d+\.\d+/);
});

// --- Node prerequisite check (issue-spor-onboarding-no-node-silent-fail-open).
// The version-check logic is a pure helper (no I/O), so it is unit-tested
// directly via the bin/spor.js export seam — main() is guarded by require.main.
const cli = require(CLI);

test('nodeFloor reads the engines.node floor from package.json (not hardcoded)', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const declared = parseInt(String(pkg.engines.node).match(/\d+/)[0], 10);
  assert.strictEqual(cli.nodeFloor(), declared);
});

test('nodeRuntimeCheck: floor satisfied => ok, OK line', () => {
  const floor = cli.nodeFloor();
  const c = cli.nodeRuntimeCheck(`${floor}.0.0`);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.floor, floor);
  assert.match(c.line, /OK/);
  // a far-newer interpreter is also fine
  assert.strictEqual(cli.nodeRuntimeCheck(`${floor + 50}.1.2`).ok, true);
});

test('nodeRuntimeCheck: below the floor => not ok, loud prereq line', () => {
  const floor = cli.nodeFloor();
  const c = cli.nodeRuntimeCheck(`${floor - 1}.9.9`);
  assert.strictEqual(c.ok, false);
  assert.match(c.line, /TOO OLD/);
  assert.match(c.line, new RegExp(`Node ${floor}\\+`));
  assert.match(c.line, /no-op/);
});

test('bare "spor install" states the Node requirement', () => {
  const r = run(['install']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, new RegExp(`Requires:\\s+Node ${cli.nodeFloor()}\\+`));
});

test('spor-hook shim drops a one-time breadcrumb when node is absent', () => {
  // Drive bin/spor-hook with a PATH that has no `node`, pointed at a scratch
  // home — never the live graph. Must stay fail-open (exit 0) AND leave a
  // greppable journal/no-node.warn marker, written at most once.
  if (process.platform === 'win32') return; // POSIX shim only
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-nonode-'));
  const shim = path.join(__dirname, '..', 'bin', 'spor-hook');
  // Build a PATH dir holding ONLY the externals the shim needs (mkdir, date) —
  // explicitly NOT node — by symlinking the real ones. `printf`/`command` are sh
  // builtins, so the shim runs end-to-end while `node` is genuinely unreachable.
  const noNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-nopath-'));
  for (const tool of ['mkdir', 'date']) {
    const real = (spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout || '').trim();
    if (real) { try { fs.symlinkSync(real, path.join(noNodeDir, tool)); } catch { /* ignore */ } }
  }
  const env = { HOME: home, SPOR_HOME: home, PATH: noNodeDir };
  // sanity: confirm node really is unreachable on this PATH
  assert.notStrictEqual(spawnSync('/bin/sh', ['-c', 'command -v node'], { env }).status, 0,
    'test PATH must not contain node');
  const r1 = spawnSync('/bin/sh', [shim, 'session-start'], { env, input: '{"cwd":"/tmp"}', encoding: 'utf8' });
  assert.strictEqual(r1.status, 0, 'shim must fail open (exit 0) with no node');
  assert.strictEqual(r1.stdout, '', 'no stdout on the no-node path');
  const warn = path.join(home, 'journal', 'no-node.warn');
  assert.ok(fs.existsSync(warn), 'breadcrumb written to journal/no-node.warn');
  const body = fs.readFileSync(warn, 'utf8');
  assert.match(body, /node not found/);
  // second invocation is still fail-open and does NOT rewrite the marker (one-time)
  const mtime1 = fs.statSync(warn).mtimeMs;
  const r2 = spawnSync('/bin/sh', [shim, 'prompt-context'], { env, input: '{"cwd":"/tmp"}', encoding: 'utf8' });
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(fs.statSync(warn).mtimeMs, mtime1, 'breadcrumb is one-time (not rewritten)');
});

test('whoami in local mode explains there is no server identity', () => {
  const { dir } = fixtureGraph();
  const r = run(['whoami'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /local mode/);
});

// --- Split-brain detection (issue-spor-local-mode-claude-ai-mcp-split-brain,
// dec-spor-local-mode-split-brain-mitigation). LOCAL mode + a bound claude.ai
// Spor MCP connector = two write surfaces; `spor status` warns. Detection reads
// the LIVE connector set from `claude mcp list` (NOT the sticky
// `claudeAiMcpEverConnected` array, which warned forever after the connector was
// disabled — issue-spor-status-split-brain-warning-false-positive), stubbed here
// via SPOR_FAKE_MCP_LIST. Fail-open: an absent claude / failed probe never warns.
function fakeMcpList(connectors) {
  const body = connectors.map((n) => `${n}: https://example.test/mcp - ✔ Connected`).join('\n');
  return `Checking MCP server health…\n\n${body}\n`;
}
const SPLIT = /SPLIT-BRAIN/;
// A command name that cannot resolve, so spawnSync errors -> fail-open false.
const NO_CLAUDE = path.join(os.tmpdir(), 'spor-no-claude-' + Math.random());

test('sporConnectorBound: detects a Spor connector, ignores others, fail-open', () => {
  process.env.SPOR_FAKE_MCP_LIST = fakeMcpList(['claude.ai Spotify', 'claude.ai Spor']);
  assert.strictEqual(cli.sporConnectorBound(), true);
  // pre-rename "Substrate" connector name also matches
  process.env.SPOR_FAKE_MCP_LIST = fakeMcpList(['claude.ai Substrate']);
  assert.strictEqual(cli.sporConnectorBound(), true);
  // only other connectors (Spotify shares a prefix but \b stops it) => false
  process.env.SPOR_FAKE_MCP_LIST = fakeMcpList(['claude.ai Spotify', 'claude.ai Linear']);
  assert.strictEqual(cli.sporConnectorBound(), false);
  // connector DISABLED => empty live list => false (the regression this fixes)
  process.env.SPOR_FAKE_MCP_LIST = fakeMcpList([]);
  assert.strictEqual(cli.sporConnectorBound(), false);
  delete process.env.SPOR_FAKE_MCP_LIST;
  // claude absent / probe fails => fail-open false (no crash)
  process.env.SPOR_CLAUDE_CMD = NO_CLAUDE;
  assert.strictEqual(cli.sporConnectorBound(), false);
  delete process.env.SPOR_CLAUDE_CMD;
});

test('status (local) WARNS of split-brain when a Spor connector is bound', () => {
  const { dir } = fixtureGraph();
  const r = run(['status'], { SPOR_HOME: dir, SPOR_FAKE_MCP_LIST: fakeMcpList(['claude.ai Spor']) });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+local/);
  assert.match(r.stdout, SPLIT);
  assert.match(r.stdout, /two live write surfaces|TWO live write surfaces/);
});

test('status (local) does NOT warn when no Spor connector is bound', () => {
  const { dir } = fixtureGraph();
  const r = run(['status'], { SPOR_HOME: dir, SPOR_FAKE_MCP_LIST: fakeMcpList(['claude.ai Spotify']) });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, SPLIT);
});

test('status (local) does NOT warn after the connector is disabled (empty live list)', () => {
  // The reported false positive: a previously-connected Spor connector, now
  // unbound, must not warn (issue-spor-status-split-brain-warning-false-positive).
  const { dir } = fixtureGraph();
  const r = run(['status'], { SPOR_HOME: dir, SPOR_FAKE_MCP_LIST: fakeMcpList([]) });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, SPLIT);
});

test('status (local) does NOT warn / crash when the connector probe fails', () => {
  const { dir } = fixtureGraph();
  // No SPOR_FAKE_MCP_LIST; an unresolvable claude cmd => spawn error => fail-open.
  const r = run(['status'], { SPOR_HOME: dir, SPOR_CLAUDE_CMD: NO_CLAUDE });
  assert.strictEqual(r.status, 0); // fail-open
  assert.doesNotMatch(r.stdout, SPLIT);
});

test('status (remote) does NOT warn of split-brain even with a Spor connector', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote-status-'));
  // dead server => remote-mode status probes, fails open (exit 0), and the
  // split-brain block lives only in the local branch, so it must not appear.
  const r = run(['status'], {
    SPOR_HOME: home,
    SPOR_SERVER: 'http://127.0.0.1:9',
    SPOR_TOKEN: 'tok',
    SPOR_FAKE_MCP_LIST: fakeMcpList(['claude.ai Spor']),
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+remote/);
  assert.doesNotMatch(r.stdout, SPLIT);
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

// --- install / setup (task-cc-spor-cli-install) --------------------------
// Every install test points HOME at a scratch dir, so the real ~/.codex,
// ~/.gemini, ~/.config/opencode etc. are never touched.
function scratchHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-install-'));
}

test('install with no host lists hosts and writes nothing', () => {
  const home = scratchHome();
  const r = run(['install'], { HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Hosts:.*codex/);
  assert.match(r.stdout, /spor install/);
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'discovery touches nothing');
});

test('install codex resolves the placeholder into ~/.codex/hooks.json', () => {
  const home = scratchHome();
  const r = run(['install', 'codex', '--scope', 'user'], { HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const txt = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
  assert.doesNotMatch(txt, /__SPOR_ROOT__/, 'placeholder resolved');
  const j = JSON.parse(txt); // valid JSON
  const cmd = j.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /bin\/spor-hook session-start --host codex$/);
  assert.ok(path.isAbsolute(cmd.split(' ')[0]), 'command points at an absolute checkout path');
});

test('install is idempotent and preserves foreign hooks + top-level keys', () => {
  const home = scratchHome();
  const f = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    version: 9,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/my-own-hook' }] }] },
  }));
  run(['install', 'codex'], { HOME: home });
  run(['install', 'codex'], { HOME: home }); // second run must not duplicate
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ss = j.hooks.SessionStart;
  assert.strictEqual(ss.filter((e) => JSON.stringify(e).includes('spor-hook')).length, 1, 'one spor entry after two installs');
  assert.ok(ss.some((e) => JSON.stringify(e).includes('my-own-hook')), 'foreign hook preserved');
  assert.strictEqual(j.version, 9, 'foreign top-level key preserved');
});

test('install gemini merges into existing settings without clobbering', () => {
  const home = scratchHome();
  const f = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theme: 'dark', mcpServers: { x: { httpUrl: 'http://y' } } }));
  const r = run(['install', 'gemini'], { HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(j.theme, 'dark');
  assert.ok(j.mcpServers && j.mcpServers.x, 'foreign settings preserved');
  assert.match(j.hooks.BeforeAgent[0].hooks[0].command, /spor-hook prompt-context --host gemini/);
});

test('install opencode places the plugin file (symlink or copy)', () => {
  const home = scratchHome();
  const r = run(['install', 'opencode'], { HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const f = path.join(home, '.config', 'opencode', 'plugins', 'spor.js');
  assert.ok(fs.existsSync(f), 'plugin file present');
  const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'opencode', 'spor.js'), 'utf8');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), src, 'matches the adapter source (linked or copied)');
});

test('install --scope repo writes under the cwd, not home', () => {
  const home = scratchHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-repo-'));
  const r = spawnSync(process.execPath, [CLI, 'install', 'cursor', '--scope', 'repo'], { cwd: repo, encoding: 'utf8', env: bare({ HOME: home }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(repo, '.cursor', 'hooks.json')), 'repo-scope file under cwd');
  assert.ok(!fs.existsSync(path.join(home, '.cursor')), 'nothing written to home');
});

test('install claude --print shows the plugin CLI commands and runs nothing', () => {
  const r = run(['install', 'claude', '--print'], { HOME: scratchHome() });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would run: claude plugin marketplace add /);
  assert.match(r.stdout, /would run: claude plugin install spor@spor --scope user/);
});

test('install --print is a dry run (writes nothing)', () => {
  const home = scratchHome();
  const r = run(['install', 'codex', '--print'], { HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would write .*\.codex.*hooks\.json/);
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'dry run wrote nothing');
});

test('install rejects an unknown host and a bad scope', () => {
  const home = scratchHome();
  const h = run(['install', 'bogus'], { HOME: home });
  assert.strictEqual(h.status, 1);
  assert.match(h.stderr, /unknown host/);
  const s = run(['install', 'codex', '--scope', 'nope'], { HOME: home });
  assert.strictEqual(s.status, 1);
  assert.match(s.stderr, /invalid --scope/);
});

test('install --server/--token persists creds to user config', () => {
  const home = scratchHome();
  const r = run(['install', 'codex', '--server', 'http://127.0.0.1:9/', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.server, 'http://127.0.0.1:9'); // trailing slash trimmed
  assert.strictEqual(cfg.token, 'tok9');
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')), 'host still installed');
});

// --- upgrade (issue-spor-upgrade-no-plugin-refresh) -----------------------
// A bumped package leaves Claude Code running its own stale copy until the
// plugin is updated. These exercise the claude CLI shell-outs through a fake
// `claude` (SPOR_CLAUDE_CMD), the same lever dispatch uses. Posix-only (the
// stub is a shell script). PKG is this package's version, so the asserts don't
// hard-code a number that a release bump would break.
const PKG = require('../package.json').version;

// A fake `claude plugin` CLI. `plugin list --json` echoes the currently-loaded
// version (from $STATE, defaulting to $STARTVER); `plugin update spor` writes
// $NEWVER to $STATE (simulating the cache swap). $EMPTY makes list report no
// spor installed. Returns the stub path.
function claudeStub(home) {
  const stub = path.join(home, 'claude-plugin-stub.sh');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'if [ -n "$EMPTY" ]; then',
    '  if [ "$2" = "list" ]; then echo "[]"; fi',
    '  exit 0',
    'fi',
    'ver=$(cat "$STATE" 2>/dev/null || echo "$STARTVER")',
    'if [ "$2" = "list" ]; then',
    '  printf \'[{"id":"spor@spor","version":"%s","scope":"user","enabled":true,"installPath":"/x/%s"}]\\n\' "$ver" "$ver"',
    '  exit 0',
    'fi',
    'if [ "$2" = "update" ] && [ "$3" = "spor" ]; then printf \'%s\' "$NEWVER" > "$STATE"; fi',
    'exit 0',
  ].join('\n') + '\n');
  fs.chmodSync(stub, 0o755);
  return stub;
}

test('upgrade claude --print shows the three plugin commands, runs nothing', () => {
  const r = run(['upgrade', 'claude', '--print'], { HOME: scratchHome() });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would run: claude plugin marketplace add /);
  assert.match(r.stdout, /would run: claude plugin marketplace update spor/);
  assert.match(r.stdout, /would run: claude plugin update spor --scope user/);
});

test('upgrade claude refreshes a stale plugin and reports before → after', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: '0.0.1', NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`spor plugin: 0\\.0\\.1 → ${PKG.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /restart your Claude Code session/i);
  assert.match(r.stdout, /Restart any running sessions/);
});

test('upgrade claude reports already-current when the loaded version matches', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`already current \\(${PKG.replace(/\./g, '\\.')}\\)`));
});

test('upgrade claude errors when spor is not installed in Claude Code', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, EMPTY: '1' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /run 'spor install claude' first/);
});

test('install claude self-heals: an already-installed plugin is refreshed, not no-op', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['install', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: '0.0.1', NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`spor plugin: 0\\.0\\.1 → ${PKG.replace(/\./g, '\\.')}`));
});

test('status flags a stale Claude plugin and stays quiet when current', { skip: process.platform === 'win32' }, () => {
  const { dir } = fixtureGraph();
  const home = scratchHome();
  const stub = claudeStub(home);
  const stale = run(['status'], { SPOR_HOME: dir, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: '0.0.1', NEWVER: PKG });
  assert.strictEqual(stale.status, 0);
  assert.match(stale.stdout, /plugin:\s+spor@spor 0\.0\.1 loaded\s+\(STALE/);
  assert.match(stale.stdout, /run 'spor upgrade'/);
  const current = run(['status'], { SPOR_HOME: dir, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded2'), STARTVER: PKG, NEWVER: PKG });
  assert.strictEqual(current.status, 0);
  assert.match(current.stdout, new RegExp(`plugin:\\s+spor@spor ${PKG.replace(/\./g, '\\.')} loaded`));
  assert.doesNotMatch(current.stdout, /STALE/);
});

// The npm-registry "newer version published" check. SPOR_NPM_LATEST overrides
// the registry answer so this runs offline; the plugin is held current
// (STARTVER=NEWVER=PKG) so only the npm note is under test.
test('upgrade flags a newer @sporhq/spor published to npm', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG, SPOR_NPM_LATEST: '99.0.0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /newer @sporhq\/spor is published — 99\.0\.0/);
  assert.match(r.stdout, /npm install -g @sporhq\/spor@latest/);
});

test('upgrade stays quiet when the installed package is the latest published', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG, SPOR_NPM_LATEST: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /newer @sporhq\/spor/);
});

test('upgrade --no-net skips the registry check entirely', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude', '--no-net'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG, SPOR_NPM_LATEST: '99.0.0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /newer @sporhq\/spor/);
});

// --- lens / render-lens (task-cc-spor-cli-lens-render) ---------------------
// Lens rendering lives server-side (art-cc-lib-boundary), so this is a remote
// verb over GET /v1/lenses (catalog) and GET /v1/lens/<id>/render (view). The
// stub is an in-process http server shaped like the server's two routes; the
// CLI must hit the right endpoint and render its output, and degrade cleanly
// with no server. spawnSync would block the event loop and starve the stub, so
// these use an async spawn (the hookcli.test.js pattern).
function lensStubServer() {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      if (req.method === 'GET' && req.url === '/v1/lenses') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          lenses: [
            { id: 'lens-roadmap', type: 'lens', title: 'Roadmap board', summary: 'Open decisions by status.' },
            { id: 'ws-overview', type: 'workspace', title: 'Overview', summary: 'A composed workspace.' },
          ],
          count: 2,
        }));
        return;
      }
      const m = req.url.match(/^\/v1\/lens\/([^/?]+)\/render(?:\?(.*))?$/);
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]);
        const qs = new URLSearchParams(m[2] || '');
        if (id !== 'lens-roadmap') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_found', message: `no lens or workspace '${id}'` }, available: ['lens-roadmap', 'ws-overview'] }));
          return;
        }
        if (qs.get('format') === 'json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ as: 'list', title: 'Roadmap board', items: [], project: qs.get('project') || null }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Roadmap board\n  (no items)${qs.get('project') ? `\n  project=${qs.get('project')}` : ''}\n`);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

function runAsyncCli(args, env) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

test('lens (remote, no id) lists the catalog from GET /v1/lenses', async () => {
  const { srv, hits, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['lens'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /lens-roadmap/);
    assert.match(r.stdout, /Roadmap board/);
    assert.match(r.stdout, /ws-overview/);
    assert.match(r.stdout, /\[workspace\]/); // non-lens type flagged
    const listHit = hits.find((h) => h.url === '/v1/lenses');
    assert.ok(listHit, 'hit GET /v1/lenses');
    assert.strictEqual(listHit.auth, 'Bearer tok-l', 'bearer token sent');
  } finally {
    srv.close();
  }
});

test('lens <id> renders text via GET /v1/lens/<id>/render?format=text', async () => {
  const { srv, hits, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['lens', 'lens-roadmap'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Roadmap board/);
    const renderHit = hits.find((h) => /\/v1\/lens\/lens-roadmap\/render/.test(h.url));
    assert.ok(renderHit, 'hit the render route');
    assert.match(renderHit.url, /format=text/, 'text format by default');
  } finally {
    srv.close();
  }
});

test('lens <id> --format json emits the raw view tree', async () => {
  const { srv, hits, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['lens', 'lens-roadmap', '--format', 'json'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 0, r.stderr);
    const tree = JSON.parse(r.stdout); // valid JSON on stdout
    assert.strictEqual(tree.as, 'list');
    assert.ok(hits.some((h) => /format=json/.test(h.url)), 'json format requested');
  } finally {
    srv.close();
  }
});

test('lens <id> --PARAM VALUE passes lens params as query string', async () => {
  const { srv, hits, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['lens', 'lens-roadmap', '--project', 'wf'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /project=wf/);
    const renderHit = hits.find((h) => /\/v1\/lens\/lens-roadmap\/render/.test(h.url));
    assert.match(renderHit.url, /project=wf/, 'param forwarded as query string');
  } finally {
    srv.close();
  }
});

test('lens <unknown> exits 1 and surfaces the available catalog from the 404', async () => {
  const { srv, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['lens', 'lens-nope'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no lens or workspace 'lens-nope'/);
    assert.match(r.stderr, /available: .*lens-roadmap/);
  } finally {
    srv.close();
  }
});

test('lens degrades cleanly in local mode (no server, no crash)', () => {
  const { dir } = fixtureGraph();
  const r = run(['lens'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0); // not an error — just no server to render
  assert.match(r.stdout, /needs a team graph/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test('lens fails open against an unreachable server (no stack trace)', () => {
  const r = run(['lens'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test('render-lens is an alias for lens', async () => {
  const { srv, hits, base } = await lensStubServer();
  try {
    const r = await runAsyncCli(['render-lens'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-l' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hits.some((h) => h.url === '/v1/lenses'), 'alias hit the catalog route');
  } finally {
    srv.close();
  }
});

test('lens rejects an invalid --format', () => {
  const r = run(['lens', 'lens-x', '--format', 'pdf'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --format/);
});

// --- compile / brief / validate in REMOTE mode -----------------------------
// (issue-spor-cli-remote-mode-local-verbs) These LOCAL-graph verbs used to run
// lib/compile.js/lib/validate.js even in remote mode, where $SPOR_HOME/nodes is
// absent — exiting with a bare "no Spor graph" that read like a broken install.
// Now brief/compile dispatch to the server (mirroring the /spor:brief skill) and
// validate/--skeleton fail fast naming the remote path; an explicit --nodes
// still names a local checkout. Same async-spawn stub pattern as the lens tests.
function digestStubServer() {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
      const nodeM = req.url.match(/^\/v1\/nodes\/([^/?]+)$/);
      if (req.method === 'GET' && nodeM) {
        const id = decodeURIComponent(nodeM[1]);
        if (id !== 'dec-x') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_found', message: `no node '${id}'` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, title: 'A demo decision', summary: 'A demo decision summary.',
          raw: '---\nid: dec-x\ntype: decision\ntitle: A demo decision\n---\n\nRaw node body.\n',
          revision: 'abc123',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/digest') {
        // A query with the gibberish gate-miss text returns the empty result.
        if (parsed && /zzz-nothing/.test(parsed.query || '')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ found: false }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ found: true, text: `DIGEST for: ${(parsed && parsed.query) || ''}` }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('brief <id> (remote) emits the raw node plus a /v1/digest neighborhood', async () => {
  const { srv, hits, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['brief', 'dec-x'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-b' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Raw node body\./);          // the raw node
    assert.match(r.stdout, /DIGEST for: A demo decision/); // title-seeded neighborhood
    assert.ok(hits.some((h) => h.method === 'GET' && h.url === '/v1/nodes/dec-x'), 'fetched the node');
    const dig = hits.find((h) => h.url === '/v1/digest');
    assert.ok(dig, 'compiled a digest');
    assert.strictEqual(dig.auth, 'Bearer tok-b', 'bearer token sent');
  } finally {
    srv.close();
  }
});

test('compile --query --digest (remote) posts /v1/digest and prints the text', async () => {
  const { srv, hits, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['compile', '--query', 'auth token rotation', '--digest'], { SPOR_SERVER: base, SPOR_TOKEN: 't' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /DIGEST for: auth token rotation/);
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/v1/digest'), 'hit the digest route');
  } finally {
    srv.close();
  }
});

test('compile --query (remote) with a gate-miss prints nothing and exits 0', async () => {
  const { srv, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['compile', '--query', 'zzz-nothing relevant here'], { SPOR_SERVER: base, SPOR_TOKEN: 't' });
    assert.strictEqual(r.status, 0, r.stderr);   // mirrors local "nothing relevant"
    assert.strictEqual(r.stdout, '');
  } finally {
    srv.close();
  }
});

test('brief <unknown> (remote) exits 1 with a clear not-found, no stack', async () => {
  const { srv, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['brief', 'dec-nope'], { SPOR_SERVER: base, SPOR_TOKEN: 't' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: dec-nope/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

test('validate (remote, no --nodes) fails fast naming the remote path, no "no Spor graph"', () => {
  const r = run(['validate'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /validate lints a LOCAL graph/);
  assert.match(r.stderr, /server validates every write/);
  assert.doesNotMatch(r.stderr, /no Spor graph/);     // the confusing message is gone
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test('validate --nodes <dir> (remote) still lints the named local checkout', () => {
  const { nodes } = fixtureGraph();
  const r = run(['validate', '--nodes', nodes], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 0, r.stderr);          // a named checkout works under a server
  assert.match(r.stdout, /0 errors/);
});

test('compile --skeleton (remote) is local-only and fails fast', () => {
  const r = run(['compile', '--root', 'dec-x', '--skeleton'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--skeleton is local-only/);
});

test('compile --query (remote) fails open with a clear OFFLINE line, no stack', () => {
  const r = run(['compile', '--query', 'anything at all here'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});
