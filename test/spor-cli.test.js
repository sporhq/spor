// bin/spor — the unified client CLI (task-cc-spor-cli-bin-build).
// Local verbs must be byte-identical passthrough to the lib scripts; onboarding
// verbs (init/status) and fail-open behavior are the new contract. Everything
// runs against a throwaway graph home — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeSpawnableNodeStub } = require('./helpers/portable');

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

// --- init ensures a committable graph: git identity + initial commit ---------
// (task-spor-onboard-cli-init-git-identity) A fresh ~/.spor must be able to
// commit, or the SessionEnd distiller and gardener auto-commits silently fail
// and the local person node has no email source.

// Neutralize the test box's own git identity: point global+system config at a
// throwaway config so the dev box's ~/.gitconfig can't leak in and mask the
// fallback. `user.useConfigOnly` stops git from synthesizing an identity from
// gecos/hostname, so a commit genuinely fails without a configured identity —
// otherwise the "commit succeeds" assertion is false-green on a box where git
// can auto-detect one (most dev boxes / CI runners).
function noGitIdentityEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-gitcfg-'));
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, '[user]\n\tuseConfigOnly = true\n');
  const empty = path.join(dir, 'empty');
  fs.writeFileSync(empty, '');
  return { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_SYSTEM: empty };
}

// Force commit signing ON but BROKEN: a global commit.gpgsign=true pointed at a
// gpg program that does not exist, so a plain `git commit` tries to sign, fails,
// and ABORTS — exactly what a user with gpgsign=true and no usable key/agent
// hits (issue-spor-local-commit-gpgsign-silent-failure). A valid identity is set
// so the ONLY failure mode under test is the signing, not a missing identity.
function gpgSignFailEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-gpg-'));
  const cfg = path.join(dir, 'gitconfig');
  const fakeGpg = path.join(dir, 'no-such-gpg').replace(/\\/g, '/'); // never created -> sign fails
  fs.writeFileSync(cfg,
    '[user]\n\tname = Real Dev\n\temail = real@dev.example\n' +
    '[commit]\n\tgpgsign = true\n' +
    `[gpg]\n\tprogram = ${fakeGpg}\n`);
  const empty = path.join(dir, 'empty');
  fs.writeFileSync(empty, '');
  return { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_SYSTEM: empty };
}

test('init sets a fallback identity + initial commit when git has none, so the graph can commit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-id-'));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const gitEnv = noGitIdentityEnv();
  const r = run(['init'], { SPOR_HOME: home, ...gitEnv });
  assert.strictEqual(r.status, 0, r.stderr);
  const local = (k) => spawnSync('git', ['-C', home, 'config', '--local', k], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(local('user.name'), 'spor', 'fallback user.name set locally');
  assert.strictEqual(local('user.email'), 'spor@localhost', 'fallback user.email set locally');
  // HEAD is born (an initial commit) so future auto-commits have a parent
  const count = spawnSync('git', ['-C', home, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(count, '1', 'exactly one initial commit');
  // the actual failure mode: a distiller-style plain `git commit` now succeeds
  fs.writeFileSync(path.join(home, 'nodes', 'dec-q.md'), `---\nid: dec-q\ntype: decision\nproject: demo\ntitle: t\nsummary: s\ndate: 2026-06-01\n---\nb\n`);
  spawnSync('git', ['-C', home, 'add', '-A'], { env: bare(gitEnv) });
  const c = spawnSync('git', ['-C', home, 'commit', '-qm', 'distill: session t1'], { encoding: 'utf8', env: bare(gitEnv) });
  assert.strictEqual(c.status, 0, `plain commit must succeed after init: ${c.stderr}`);
  // the committing identity is surfaced, with a hint to override the fallback
  assert.match(r.stdout, /commits:\s+spor <spor@localhost>/);
  assert.match(r.stdout, /git config --global user\.email/);
});

test('init still commits when global commit.gpgsign=true but signing is broken (no usable key)', () => {
  // issue-spor-local-commit-gpgsign-silent-failure: the housekeeping commit must
  // bypass GPG signing so it can't fail silently, leaving HEAD unborn while
  // onboarding reports success.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-gpg-home-'));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const gitEnv = gpgSignFailEnv();
  // sanity: in this env a plain (signed) commit genuinely fails, so a green
  // assertion below proves the bypass, not a no-op env.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-gpg-probe-'));
  spawnSync('git', ['-C', probe, 'init', '-q'], { env: bare(gitEnv) });
  fs.writeFileSync(path.join(probe, 'f'), 'x');
  spawnSync('git', ['-C', probe, 'add', '-A'], { env: bare(gitEnv) });
  const bad = spawnSync('git', ['-C', probe, 'commit', '-qm', 'x'], { encoding: 'utf8', env: bare(gitEnv) });
  assert.notStrictEqual(bad.status, 0, 'sanity: a signed commit must fail in this env');

  const r = run(['init'], { SPOR_HOME: home, ...gitEnv });
  assert.strictEqual(r.status, 0, r.stderr);
  // HEAD is born despite the broken signing config — the commit was not lost
  const count = spawnSync('git', ['-C', home, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(count, '1', 'initial commit lands despite broken gpgsign');
  // and it is genuinely unsigned — signing was bypassed, not somehow satisfied
  const sig = spawnSync('git', ['-C', home, 'log', '-1', '--format=%G?'], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(sig, 'N', 'commit is unsigned (gpgsign bypassed)');
});

test("init prefers the user's own git identity and does not shadow it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-id2-'));
  fs.rmSync(home, { recursive: true, force: true });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-gitcfg2-'));
  const gcfg = path.join(cfgDir, 'gitconfig');
  fs.writeFileSync(gcfg, '[user]\n\tname = Real Dev\n\temail = real@dev.example\n');
  const empty = path.join(cfgDir, 'empty');
  fs.writeFileSync(empty, '');
  const gitEnv = { GIT_CONFIG_GLOBAL: gcfg, GIT_CONFIG_SYSTEM: empty };
  const r = run(['init'], { SPOR_HOME: home, ...gitEnv });
  assert.strictEqual(r.status, 0, r.stderr);
  // no local user.* override was written — the real (global) identity stands
  const localList = spawnSync('git', ['-C', home, 'config', '--local', '--list'], { encoding: 'utf8', env: bare(gitEnv) }).stdout;
  assert.doesNotMatch(localList, /user\.(name|email)=/, 'must not shadow the user identity');
  const author = spawnSync('git', ['-C', home, 'log', '--format=%an <%ae>', '-1'], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(author, 'Real Dev <real@dev.example>');
  assert.match(r.stdout, /commits:\s+Real Dev <real@dev\.example>/);
  assert.doesNotMatch(r.stdout, /git config --global/, 'no fallback hint when git has an identity');
});

test('init is idempotent — a second run adds no second commit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-id3-'));
  fs.rmSync(home, { recursive: true, force: true });
  const gitEnv = noGitIdentityEnv();
  assert.strictEqual(run(['init'], { SPOR_HOME: home, ...gitEnv }).status, 0);
  assert.strictEqual(run(['init'], { SPOR_HOME: home, ...gitEnv }).status, 0);
  const count = spawnSync('git', ['-C', home, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', env: bare(gitEnv) }).stdout.trim();
  assert.strictEqual(count, '1');
});

test('init refuses to rewrite identity or commit into the code repo when the graph home IS that repo (nested sharing)', () => {
  // a fresh code repo that doubles as the graph home (a `graph: .` / SPOR_HOME=.
  // layout, dec-spor-local-mode-sharing-boundary): no commits, no identity.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-nested-'));
  fs.mkdirSync(path.join(repo, 'nodes'), { recursive: true });
  const gitEnv = noGitIdentityEnv(); // no global identity, so the fallback WOULD fire if unguarded
  const G = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: bare(gitEnv) });
  G(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=shhh\n'); // an untracked working-tree file `-A` would have swept in
  // run `spor init` from INSIDE the repo with the graph home pointed at it
  const r = spawnSync(process.execPath, [CLI, 'init'], { encoding: 'utf8', cwd: repo, env: bare({ SPOR_HOME: repo, ...gitEnv }) });
  assert.strictEqual(r.status, 0, r.stderr);
  // the guard fires: no spor identity written onto the code repo, no spor commit
  // injected onto its branch (HEAD stays unborn — the human PR flow owns it)
  assert.strictEqual(G(['config', '--local', 'user.name']).stdout.trim(), '', 'no spor identity on the code repo');
  assert.strictEqual(G(['config', '--local', 'user.email']).stdout.trim(), '');
  assert.notStrictEqual(G(['rev-parse', '--verify', '-q', 'HEAD']).status, 0, 'code branch still unborn — no spor commit');
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

// --- dead queue_mute observability on status (issue-spor-local-mode-queue-mute-noop)
// A graph home that IS a git repo with a pinned user.email, carrying a person
// node with a queue_mute. The note fires when the box identity binds to no
// matching (muted) person; it stays quiet when the identity DOES bind to the muter.
function muteStatusGraph(email) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-mute-'));
  const nodes = path.join(dir, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', email]);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(nodes, 'person-me.md'), `---\nid: person-me\ntype: person\ntitle: Me\nsummary: The muter person node.\nemail: me@test.dev\nqueue_mute: [repo-beta]\ndate: 2026-06-01\n---\nBody.\n`);
  fs.writeFileSync(path.join(nodes, 'task-x.md'), `---\nid: task-x\ntype: task\nproject: repo-alpha\ntitle: A task\nsummary: A task for the mute-status test.\nstatus: open\ndate: 2026-06-01\n---\nBody.\n`);
  return { dir, nodes };
}

test('status (local) NOTES a dead queue_mute when the git identity binds to no muter', () => {
  // The box identity is some-other@test.dev, but the only queue_mute lives on
  // person-me <me@test.dev> — so the mutes silently do nothing. Status says so.
  const { dir } = muteStatusGraph('some-other@test.dev');
  const r = run(['status'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /note: queue_mute is set on a person node/);
  assert.match(r.stdout, /some-other@test\.dev/);          // names the resolved identity
  assert.match(r.stdout, /no matching person node/);
  assert.match(r.stdout, /mutes are inactive/);
});

test('status (local) stays QUIET about mutes when the identity binds to the muter', () => {
  const { dir } = muteStatusGraph('me@test.dev'); // binds to person-me, who holds the mute
  const r = run(['status'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /queue_mute is set on a person node/);
});

test('status (local) does NOT emit the mute note when no person carries a queue_mute', () => {
  const { dir } = fixtureGraph(); // only a decision node — no person, no mute
  const r = run(['status'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /queue_mute is set/);
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

// --- --quiet skips the remote health probe + identity lookup
// (issue-spor-status-health-probe-latency): a caller that only wants a
// locally-resolved field (e.g. the brief skill reading back `project:`)
// shouldn't pay for the up-to-6s health round-trip.
test('status (remote) without --quiet includes health/identity lines', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote-status-full-'));
  const r = run(['status'], {
    SPOR_HOME: home,
    SPOR_SERVER: 'http://127.0.0.1:9',
    SPOR_TOKEN: 'tok',
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+remote/);
  assert.match(r.stdout, /^health:/m);
  assert.match(r.stdout, /^identity:/m);
});

test('status (remote) --quiet skips health probe and identity lookup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote-status-quiet-'));
  const r = run(['status', '--quiet'], {
    SPOR_HOME: home,
    SPOR_SERVER: 'http://127.0.0.1:9',
    SPOR_TOKEN: 'tok',
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mode:\s+remote/);
  assert.match(r.stdout, /^project:/m);
  assert.match(r.stdout, /^token:\s+present/m);
  assert.doesNotMatch(r.stdout, /^health:/m);
  assert.doesNotMatch(r.stdout, /^identity:/m);
});

test('status -q is the short form of --quiet', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-remote-status-q-'));
  const r = run(['status', '-q'], {
    SPOR_HOME: home,
    SPOR_SERVER: 'http://127.0.0.1:9',
    SPOR_TOKEN: 'tok',
  });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /^health:/m);
  assert.doesNotMatch(r.stdout, /^identity:/m);
});

test('status (local) --quiet is a no-op (already no network round-trip)', () => {
  const { dir } = fixtureGraph();
  const withQuiet = run(['status', '--quiet'], { SPOR_HOME: dir });
  const without = run(['status'], { SPOR_HOME: dir });
  assert.strictEqual(withQuiet.status, 0);
  assert.strictEqual(withQuiet.stdout, without.stdout);
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

// A scratch graph with two repo nodes + a task in each, for the --project scope
// and zero-match-warning tests (issue-spor-next-project-token-not-roundtrippable,
// task-spor-queue-default-project-config).
function queueScopeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-q-'));
  const nodes = path.join(dir, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  const w = (id, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), body);
  w('repo-alpha', `---\nid: repo-alpha\ntype: repo\nslugs: [alpha]\ntitle: Alpha\nsummary: Alpha repo node.\ndate: 2026-06-01\n---\nBody.\n`);
  w('repo-beta', `---\nid: repo-beta\ntype: repo\nslugs: [beta]\ntitle: Beta\nsummary: Beta repo node.\ndate: 2026-06-01\n---\nBody.\n`);
  w('task-alpha-1', `---\nid: task-alpha-1\ntype: task\nproject: repo-alpha\ntitle: Alpha task\nsummary: A task stamped to the alpha repo.\nstatus: open\ndate: 2026-06-01\n---\nBody.\n`);
  w('task-beta-1', `---\nid: task-beta-1\ntype: task\nproject: repo-beta\ntitle: Beta task\nsummary: A task stamped to the beta repo.\nstatus: open\ndate: 2026-06-01\n---\nBody.\n`);
  return { dir, nodes };
}

test('next (local) warns on stderr for an unknown --project token, still exits 0', () => {
  // issue-spor-next-project-token-not-roundtrippable: an unmatched token used to
  // silently yield count:0. It now warns on stderr and still fails open (exit 0).
  const { nodes } = queueScopeGraph();
  const r = run(['next', '--nodes', nodes, '--project', 'zzz-nonexistent']);
  assert.strictEqual(r.status, 0, 'fail-open: still exits 0');
  assert.match(r.stderr, /project 'zzz-nonexistent' matched no repo or grouping/);
  assert.match(r.stderr, /repo-<slug> node id/); // names the valid forms
  assert.match(r.stdout, /queue empty/);
});

test('next (local) does NOT warn for a known repo slug / repo id (0.4.x semantics intact)', () => {
  const { nodes } = queueScopeGraph();
  // a bare slug up-resolves (deliberate) and is KNOWN -> no warning, alpha only
  const bySlug = run(['next', '--nodes', nodes, '--project', 'alpha']);
  assert.strictEqual(bySlug.status, 0, bySlug.stderr);
  assert.doesNotMatch(bySlug.stderr, /matched no repo or grouping/);
  assert.match(bySlug.stdout, /task-alpha-1/);
  assert.doesNotMatch(bySlug.stdout, /task-beta-1/);
  // a repo NODE id pins the single repo -> known, no warning
  const byId = run(['next', '--nodes', nodes, '--project', 'repo-beta']);
  assert.doesNotMatch(byId.stderr, /matched no repo or grouping/);
  assert.match(byId.stdout, /task-beta-1/);
  assert.doesNotMatch(byId.stdout, /task-alpha-1/);
});

test('next (local) queue.project pins the default scope; explicit --project wins', () => {
  // task-spor-queue-default-project-config: SPOR_QUEUE_PROJECT fills the default
  // --project when none is given; an explicit flag overrides it.
  const { nodes } = queueScopeGraph();
  // pinned default scopes to alpha (no explicit flag)
  const pinned = run(['next', '--nodes', nodes], { SPOR_QUEUE_PROJECT: 'alpha' });
  assert.strictEqual(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, /task-alpha-1/);
  assert.doesNotMatch(pinned.stdout, /task-beta-1/);
  // explicit --project beta beats the pinned alpha default
  const explicit = run(['next', '--nodes', nodes, '--project', 'beta'], { SPOR_QUEUE_PROJECT: 'alpha' });
  assert.match(explicit.stdout, /task-beta-1/);
  assert.doesNotMatch(explicit.stdout, /task-alpha-1/);
});

test('next (local) with no pin and no --project is byte-identical to a bare passthrough', () => {
  // The unset-default guarantee: a markerless local read injects nothing, so it
  // matches lib/queue.js directly (no safeSlug() injected for local mode).
  const { nodes } = queueScopeGraph();
  const viaCli = run(['next', '--nodes', nodes]);
  const viaLib = runLib('queue.js', ['--nodes', nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
  assert.match(viaCli.stdout, /task-alpha-1/);
  assert.match(viaCli.stdout, /task-beta-1/); // unscoped firehose: both present
});

// node-type filter + cross-project firehose (task-cc-queue-filtering-enhancements)
function queueTypeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-qt-'));
  const nodes = path.join(dir, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  const w = (id, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), body);
  w('task-1', `---\nid: task-1\ntype: task\nproject: demo\ntitle: A task\nsummary: A queueable task for the type-filter CLI test.\nstatus: open\ndate: 2026-06-01\n---\nBody.\n`);
  w('issue-1', `---\nid: issue-1\ntype: issue\nproject: demo\ntitle: An issue\nsummary: A queueable issue for the type-filter CLI test.\nstatus: open\ndate: 2026-06-01\n---\nBody.\n`);
  w('cap-2026-06-10-1', `---\nid: cap-2026-06-10-1\ntype: capture-pending\nproject: demo\ntitle: A pending capture\nsummary: A queueable capture-pending for the type-filter CLI test.\ndate: 2026-06-10\n---\nBody.\n`);
  return { dir, nodes };
}

test('next (local) --type whitelists node types, --exclude-type blacklists them', () => {
  const { nodes } = queueTypeGraph();
  const incl = run(['next', '--nodes', nodes, '--type', 'task,issue']);
  assert.strictEqual(incl.status, 0, incl.stderr);
  assert.match(incl.stdout, /task-1/);
  assert.match(incl.stdout, /issue-1/);
  assert.doesNotMatch(incl.stdout, /cap-2026-06-10-1/);
  const excl = run(['next', '--nodes', nodes, '--exclude-type', 'capture-pending']);
  assert.match(excl.stdout, /task-1/);
  assert.doesNotMatch(excl.stdout, /cap-2026-06-10-1/);
});

test('next (local) --type forwards through to lib/queue.js (byte-identical)', () => {
  const { nodes } = queueTypeGraph();
  const viaCli = run(['next', '--nodes', nodes, '--type', 'task']);
  const viaLib = runLib('queue.js', ['--nodes', nodes, '--type', 'task']);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test('next (local) --all-projects ignores the pinned default scope (firehose)', () => {
  // SPOR_QUEUE_PROJECT would normally scope to alpha; --all-projects overrides it.
  const { nodes } = queueScopeGraph();
  const r = run(['next', '--nodes', nodes, '--all-projects'], { SPOR_QUEUE_PROJECT: 'alpha' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /task-alpha-1/);
  assert.match(r.stdout, /task-beta-1/); // both repos present despite the pin
});

test('query (local) enumerates nodes and edges end-to-end, byte-identical passthrough', () => {
  // A scratch graph with a typed node and a grouped-under edge.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cli-query-'));
  const nodes = path.join(dir, 'nodes');
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, 'repo-a.md'), `---
id: repo-a
type: repo
project: demo
title: Repo A
summary: A repo grouped under a project.
edges:
  - {type: grouped-under, to: proj-rdi}
date: 2026-06-01
---
Body.
`);
  fs.writeFileSync(path.join(nodes, 'proj-rdi.md'), `---
id: proj-rdi
type: project
project: demo
title: Project RDI
summary: A grouping project.
date: 2026-06-01
---
Body.
`);
  // --type --ids selects the repo node.
  const byType = run(['query', '--type', 'repo', '--ids', '--nodes', nodes]);
  assert.strictEqual(byType.status, 0, byType.stderr);
  assert.strictEqual(byType.stdout.trim(), 'repo-a');
  // --edges --edge-type --to answers "what is grouped under proj-rdi".
  const edges = run(['query', '--edges', '--edge-type', 'grouped-under', '--to', 'proj-rdi', '--json', '--nodes', nodes]);
  assert.strictEqual(edges.status, 0, edges.stderr);
  assert.deepEqual(JSON.parse(edges.stdout), [{ from: 'repo-a', type: 'grouped-under', to: 'proj-rdi' }]);
  // byte-identical passthrough to lib/query.js (norm-cc-byte-identical-refactor).
  const viaLib = runLib('query.js', ['--type', 'repo', '--ids', '--nodes', nodes]);
  assert.strictEqual(byType.stdout, viaLib.stdout);
});

test('query (remote, dead server) fails open offline, exit 1, no "no Spor graph" / stack trace', () => {
  // Dual-mode: remote query dispatches to GET /v1/export and queries the fetched
  // graph (query-remote.test.js covers the success/parity path); a dead server
  // surfaces a clean offline line, never a broken-install "no Spor graph" or a
  // raw stack trace (task-spor-cli-query-remote-mode).
  const r = run(['query', '--type', 'task'], { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline — could not reach server/);
  assert.doesNotMatch(r.stderr, /no Spor graph/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
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

// --- add capture-context fields + correct verb -----------------------------
// task-cc-spor-skills-route-through-cli-drop-mode-prose: /spor:defer and
// /spor:correct route through ONE verb each instead of a remote-curl-vs-local-
// file mode branch. The verbs needed the capture-context fields (--during/
// --blocks/--needed-by) and a correct verb; these pin both, local + fail-open.

test('add (local) --during/--blocks write edges and --needed-by writes the field', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(
    ['add', 'Platform must expose a token-rotation hook', '--type', 'task',
      '--during', 'dec-x', '--blocks', 'dec-x', '--needed-by', '2026-07-15'],
    { SPOR_HOME: dir },
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const file = fs.readdirSync(nodes).find((f) => f.startsWith('task-platform-must-expose'));
  assert.ok(file, 'node written');
  const md = fs.readFileSync(path.join(nodes, file), 'utf8');
  assert.match(md, /needed_by: 2026-07-15/);
  assert.match(md, /- \{type: derived-from, to: dec-x\}/);
  assert.match(md, /- \{type: blocks, to: dec-x\}/);
  // the enriched node still validates clean
  const v = runLib('validate.js', ['--nodes', nodes]);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

test('add (local) with no context fields is unchanged (no edges block)', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['add', 'a plain capture with no lineage', '--type', 'task'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = fs.readdirSync(nodes).find((f) => f.startsWith('task-a-plain-capture'));
  const md = fs.readFileSync(path.join(nodes, file), 'utf8');
  assert.doesNotMatch(md, /edges:/);
  assert.doesNotMatch(md, /needed_by:/);
});

// --- add: --project normalization + edge-id validation ----------------------
// issue-spor-local-add-ask-project-normalization-edge-validation: local mode
// stamped --project verbatim (mis-filing the node under a non-canonical slug
// remote mode would reject) and wrote edge target ids without validation (a
// non-[\w-] char makes the whole edge line vanish on the next parse). Normalize
// the explicit --project the same way an inferred slug already is, and reject an
// edge id that won't round-trip instead of silently dropping it.

test('add (local) normalizes a non-canonical --project to the canonical slug', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['add', 'a capture filed under a messy project', '--type', 'task', '--project', 'My_Repo'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = fs.readdirSync(nodes).find((f) => f.startsWith('task-a-capture-filed'));
  const md = fs.readFileSync(path.join(nodes, file), 'utf8');
  assert.match(md, /^repo: my-repo$/m); // not the verbatim My_Repo
});

test('add (local) rejects a --during edge id that would not round-trip', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['add', 'a capture with a broken edge', '--type', 'task', '--during', 'task-foo:bar'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --during id "task-foo:bar"/);
  // and nothing is written — better than a node with a silently dropped edge
  assert.ok(!fs.readdirSync(nodes).some((f) => f.startsWith('task-a-capture-with')), 'no node written on a bad edge id');
});

test('add (local) rejects a --blocks edge id that would not round-trip', () => {
  const { dir } = fixtureGraph();
  const r = run(['add', 'another broken edge', '--type', 'task', '--blocks', 'dec x'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --blocks id "dec x"/);
});

test('add (local) rejects a --project with no slug characters', () => {
  const { dir } = fixtureGraph();
  const r = run(['add', 'a capture under a garbage project', '--type', 'task', '--project', '***'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --project "\*\*\*"/);
});

test('add (local) keeps a clean --during/--blocks id and stays byte-stable', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['add', 'a clean lineage capture', '--type', 'task', '--during', 'dec-x', '--blocks', 'dec-x'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = fs.readdirSync(nodes).find((f) => f.startsWith('task-a-clean-lineage'));
  const md = fs.readFileSync(path.join(nodes, file), 'utf8');
  assert.match(md, /- \{type: derived-from, to: dec-x\}/);
  assert.match(md, /- \{type: blocks, to: dec-x\}/);
});

test('correct (local) writes a valid corr node targeting a node id', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['correct', 'dec-x', 'lead with the rollback plan'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /correction created: corr-dec-x-1/);
  const md = fs.readFileSync(path.join(nodes, 'corr-dec-x-1.md'), 'utf8');
  assert.match(md, /type: correction/);
  assert.match(md, /target: dec-x/);
  assert.match(md, /summary: lead with the rollback plan/); // every node needs a summary
  assert.match(md, /lead with the rollback plan/);
  // it validates clean and FIRES in a compile of the target
  const v = runLib('validate.js', ['--nodes', nodes]);
  assert.strictEqual(v.status, 0, v.stdout);
  const compile = runLib('compile.js', ['--root', 'dec-x', '--nodes', nodes]);
  assert.match(compile.stdout, /CORRECTIONS/);
  assert.match(compile.stdout, /lead with the rollback plan/);
});

test('correct (local) handles project:/global targets, --pin/--exclude, and uniquifies', () => {
  const { dir, nodes } = fixtureGraph();
  const a = run(['correct', 'project:demo', '--pin', 'dec-x', '--title', 'demo-wide guidance'], { SPOR_HOME: dir });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(path.join(nodes, 'corr-project-demo-1.md')), 'project: target id is kebabbed');
  const pmd = fs.readFileSync(path.join(nodes, 'corr-project-demo-1.md'), 'utf8');
  assert.match(pmd, /target: project:demo/);
  assert.match(pmd, /pin: \[dec-x\]/);
  // a second correction on the same node-id target uniquifies (-1, -2)
  run(['correct', 'dec-x', 'first'], { SPOR_HOME: dir });
  run(['correct', 'dec-x', 'second'], { SPOR_HOME: dir });
  assert.ok(fs.existsSync(path.join(nodes, 'corr-dec-x-1.md')));
  assert.ok(fs.existsSync(path.join(nodes, 'corr-dec-x-2.md')));
  // global target
  const g = run(['correct', 'global', 'graph-wide guidance'], { SPOR_HOME: dir });
  assert.strictEqual(g.status, 0, g.stderr);
  assert.ok(fs.existsSync(path.join(nodes, 'corr-global-1.md')));
});

test('correct (local) warns when a pinned node does not exist, still writes', () => {
  const { dir, nodes } = fixtureGraph();
  const r = run(['correct', 'dec-x', '--pin', 'dec-missing', 'guidance'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /pinned\/excluded node 'dec-missing' does not exist/);
  assert.ok(fs.existsSync(path.join(nodes, 'corr-dec-x-1.md')));
});

test('correct with no target, or no guidance/pin/exclude, exits 1 with usage', () => {
  const { dir } = fixtureGraph();
  const noTarget = run(['correct'], { SPOR_HOME: dir });
  assert.strictEqual(noTarget.status, 1);
  assert.match(noTarget.stderr, /usage: spor correct/);
  const empty = run(['correct', 'dec-x'], { SPOR_HOME: dir });
  assert.strictEqual(empty.status, 1);
  assert.match(empty.stderr, /needs at least one of/);
});

test('correct (remote) fails open against an unreachable server (no stack trace)', () => {
  const r = run(['correct', 'dec-x', 'guidance'], { SPOR_SERVER: 'http://127.0.0.1:9', SPOR_TOKEN: 't' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test('join APPENDS an org-scoped credential to the multi-tenant store (never repo)', () => {
  // join now appends to ~/.spor/auth/credentials.json instead of overwriting a
  // flat config.json (dec-spor-client-cli-mode-tenant-resolution). A dead server
  // means /v1/me can't confirm identity — it stores anyway (fail-open) and exits 0.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-join-'));
  const r = run(['join', 'http://127.0.0.1:9/', 'tok123'], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const store = JSON.parse(fs.readFileSync(path.join(home, 'auth', 'credentials.json'), 'utf8'));
  const key = 'http://127.0.0.1:9/'; // <server>/<org>, org empty for an opaque token; trailing slash trimmed off server
  assert.ok(store.tenants[key], 'tenant keyed by (server, org)');
  assert.strictEqual(store.tenants[key].server, 'http://127.0.0.1:9');
  assert.strictEqual(store.tenants[key].access_token, 'tok123');
  assert.strictEqual(store.default, key, 'first tenant becomes the active default');
  assert.match(r.stdout, /stored credential/);
});

test('join APPENDS a second tenant without clobbering the first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-join2-'));
  run(['join', 'http://127.0.0.1:9', 'tokA'], { SPOR_HOME: home });
  const r2 = run(['join', 'http://127.0.0.1:8', 'tokB'], { SPOR_HOME: home });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const store = JSON.parse(fs.readFileSync(path.join(home, 'auth', 'credentials.json'), 'utf8'));
  assert.strictEqual(Object.keys(store.tenants).length, 2, 'both tenants kept');
  assert.strictEqual(store.tenants['http://127.0.0.1:9/'].access_token, 'tokA');
  assert.strictEqual(store.tenants['http://127.0.0.1:8/'].access_token, 'tokB');
  assert.strictEqual(store.default, 'http://127.0.0.1:9/', 'a second join does not steal the active default');
});

test('credential store file is created 0600', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-join-perm-'));
  run(['join', 'http://127.0.0.1:9', 'tok'], { SPOR_HOME: home });
  const mode = fs.statSync(path.join(home, 'auth', 'credentials.json')).mode & 0o777;
  if (process.platform !== "win32") assert.strictEqual(mode, 0o600);
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

// Git resolves its repo from GIT_DIR/GIT_WORK_TREE before it ever discovers one
// from cwd, so an ambient var — a git hook, `git rebase --exec`, a wrapper that
// exported one — used to make repoRoot() misdirect `spor enable`/`disable` at
// the AMBIENT repo instead of the cwd's own (issue-spor-gittime-git-env-
// inheritance). bin/spor.js's git() now spawns through the scrubbed gitSpawn,
// so cwd's own repo wins.
test('enable under an ambient GIT_DIR: .spor.json lands in the cwd repo, not the ambient one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-scope-gitdir-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-scope-decoy-'));
  spawnSync('git', ['init', '-q'], { cwd: decoy });
  const r = spawnSync(process.execPath, [CLI, 'enable'], {
    cwd: dir,
    encoding: 'utf8',
    env: bare({ GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.spor.json'), 'utf8')).enabled, true);
  assert.ok(!fs.existsSync(path.join(decoy, '.spor.json')), 'the ambient repo gets no .spor.json');
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

// --- spor token: self-serve personal access tokens (task-spor-cli-me-tokens-
// verbs) ---------------------------------------------------------------------
// By default every verb is caller-scoped over /v1/me/tokens; --all (and the
// `spor admin token` alias) escalate list/revoke to /v1/admin/tokens. The stub
// is an in-process http server shaped like BOTH surfaces; the CLI must hit the
// right endpoint per verb/flag and degrade cleanly. spawnSync would starve the
// stub, so these use the async runAsyncCli pattern (the lens-test approach).
function tokenStubServer({ unbound = false } = {}) {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url;
      hits.push({ method: req.method, url, auth: req.headers.authorization, body });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const noPerson = { error: { code: 'forbidden', message: 'needs a bound person identity' } };
      // self-serve surface (/v1/me/tokens)
      if (url === '/v1/me/tokens' && req.method === 'GET') {
        if (unbound) return json(403, noPerson);
        return json(200, { tokens: [{ hash_prefix: 'aaaa1111bbbb', person: 'person-me', label: 'ci', expires: '2027-01-01', expired: false }], count: 1 });
      }
      if (url === '/v1/me/tokens' && req.method === 'POST') {
        if (unbound) return json(403, noPerson);
        const b = body ? JSON.parse(body) : {};
        if (b.expires === '400d') return json(422, { error: { code: 'invalid_node', message: 'expires may be at most 1 year out' } });
        return json(201, { token: 'spor_pat_minted123', hash_prefix: 'cccc2222dddd', person: 'person-me', name: 'Me', email: 'me@x.io', label: b.label || null, expires: b.expires ? '2026-09-20' : '2027-06-22' });
      }
      let m = url.match(/^\/v1\/me\/tokens\/([^/?]+)$/);
      if (m && req.method === 'DELETE') {
        if (unbound) return json(403, noPerson);
        if (decodeURIComponent(m[1]) === 'cccc2222dddd') return json(200, { revoked: 1, hash_prefix: 'cccc2222dddd', oauth_grants_revoked: 0 });
        return json(404, { error: { code: 'not_found', message: 'no such token' } });
      }
      // admin surface (--all / spor admin token)
      if (url === '/v1/admin/tokens' && req.method === 'GET') {
        return json(200, { tokens: [{ hash_prefix: 'eeee3333ffff', person: 'person-bob', expires: null, expired: false }], count: 1 });
      }
      m = url.match(/^\/v1\/admin\/tokens\/([^/?]+)$/);
      if (m && req.method === 'DELETE') {
        return json(200, { revoked: 1, hash_prefix: decodeURIComponent(m[1]), oauth_grants_revoked: 2 });
      }
      json(404, { error: { code: 'not_found', message: 'no route' } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('token create mints a caller-scoped PAT over POST /v1/me/tokens', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'create', '--expires', '90d', '--label', 'ci'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-me' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /spor_pat_minted123/); // the plaintext token, shown once
    assert.match(r.stdout, /person-me/);
    const hit = hits.find((h) => h.method === 'POST' && h.url === '/v1/me/tokens');
    assert.ok(hit, 'hit POST /v1/me/tokens');
    assert.strictEqual(hit.auth, 'Bearer tok-me');
    const sent = JSON.parse(hit.body);
    assert.strictEqual(sent.expires, '90d'); // --expires forwarded verbatim
    assert.strictEqual(sent.label, 'ci');    // --label forwarded
  } finally { srv.close(); }
});

test('token create surfaces the server 422 (expiry past the 1-year cap)', async () => {
  const { srv, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'create', '--expires', '400d'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-me' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /1 year/);
  } finally { srv.close(); }
});

test('token list (default) shows the caller OWN PATs from GET /v1/me/tokens', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'list'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-me' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /aaaa1111bbbb/);
    assert.match(r.stdout, /ci/); // the label leads the self listing
    assert.ok(hits.some((h) => h.method === 'GET' && h.url === '/v1/me/tokens'), 'hit the self endpoint');
    assert.ok(!hits.some((h) => h.url === '/v1/admin/tokens'), 'did NOT hit the admin endpoint');
  } finally { srv.close(); }
});

test('token list --all escalates to the team view GET /v1/admin/tokens', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'list', '--all'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-adm' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /eeee3333ffff/);
    assert.match(r.stdout, /person-bob/);
    assert.ok(hits.some((h) => h.method === 'GET' && h.url === '/v1/admin/tokens'), 'hit the admin endpoint');
    assert.ok(!hits.some((h) => h.url === '/v1/me/tokens'), 'did NOT hit the self endpoint');
  } finally { srv.close(); }
});

test('token revoke (default) deletes one of the caller OWN PATs', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'revoke', 'cccc2222dddd'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-me' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /revoked cccc2222dddd/);
    assert.ok(hits.some((h) => h.method === 'DELETE' && h.url === '/v1/me/tokens/cccc2222dddd'), 'hit the self DELETE');
  } finally { srv.close(); }
});

test('token revoke of a prefix that is not yours is a friendly 404', async () => {
  const { srv, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'revoke', 'nottheirs99'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-me' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no personal access token of yours/);
    assert.match(r.stderr, /--all/); // points at the team view
  } finally { srv.close(); }
});

test('token revoke --all escalates to DELETE /v1/admin/tokens', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    const r = await runAsyncCli(['token', 'revoke', 'eeee3333ffff', '--all'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-adm' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /revoked eeee3333ffff \(\+2 oauth grants\)/);
    assert.ok(hits.some((h) => h.method === 'DELETE' && h.url === '/v1/admin/tokens/eeee3333ffff'), 'hit the admin DELETE');
  } finally { srv.close(); }
});

test('admin token list|revoke is the discoverable alias for the team view', async () => {
  const { srv, hits, base } = await tokenStubServer();
  try {
    let r = await runAsyncCli(['admin', 'token', 'list'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-adm' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /eeee3333ffff/);
    r = await runAsyncCli(['admin', 'token', 'revoke', 'eeee3333ffff'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-adm' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /revoked eeee3333ffff/);
    assert.ok(hits.some((h) => h.method === 'GET' && h.url === '/v1/admin/tokens'), 'list hit admin GET');
    assert.ok(hits.some((h) => h.method === 'DELETE' && h.url === '/v1/admin/tokens/eeee3333ffff'), 'revoke hit admin DELETE');
  } finally { srv.close(); }
});

test('token verbs nudge an unbound caller toward spor whoami (403)', async () => {
  const { srv, base } = await tokenStubServer({ unbound: true });
  try {
    const r = await runAsyncCli(['token', 'list'], { SPOR_SERVER: base, SPOR_TOKEN: 'unbound' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bound person identity/);
    assert.match(r.stderr, /whoami/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/); // no stack trace
  } finally { srv.close(); }
});

test('token create needs remote mode (local explains why)', () => {
  const { dir } = fixtureGraph();
  const r = run(['token', 'create'], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote/);
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

function codexStub(home) {
  return writeSpawnableNodeStub(home, 'codex-plugin-stub', `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) process.exit(0);
if (process.env.CODEX_LOG) fs.appendFileSync(process.env.CODEX_LOG, args.join(" ") + "\\n");
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  if (process.env.CODEX_FAIL_MARKETPLACE) {
    process.stderr.write(process.env.CODEX_FAIL_MARKETPLACE + "\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "add" && args[2] === "spor@spor") process.exit(0);
process.stderr.write("unexpected codex args: " + args.join(" ") + "\\n");
process.exit(1);
`);
}

function codexInstallEnv(home) {
  return {
    HOME: home,
    SPOR_CODEX_CMD: codexStub(home),
    CODEX_LOG: path.join(home, 'codex-plugin.log'),
  };
}

function codexLog(home) {
  try {
    return fs.readFileSync(path.join(home, 'codex-plugin.log'), 'utf8');
  } catch {
    return '';
  }
}

test('install with no host lists hosts and writes nothing', () => {
  const home = scratchHome();
  const r = run(['install'], { HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Hosts:.*codex/);
  assert.match(r.stdout, /spor install/);
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'discovery touches nothing');
});

test('install codex resolves the placeholder and installs the backfill custom agent', () => {
  const home = scratchHome();
  const r = run(['install', 'codex', '--scope', 'user'], codexInstallEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(codexLog(home), /^plugin marketplace add \.$/m);
  assert.match(codexLog(home), /^plugin add spor@spor$/m);
  const txt = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
  assert.doesNotMatch(txt, /__SPOR_ROOT__/, 'placeholder resolved');
  const j = JSON.parse(txt); // valid JSON
  const cmd = j.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /^node ".+bin\/spor-hook\.js" session-start --host codex$/);
  const hookPath = cmd.match(/^node "(.+)" session-start/)?.[1];
  assert.ok(hookPath && path.isAbsolute(hookPath), 'command points at an absolute checkout path');
  const agent = fs.readFileSync(path.join(home, '.codex', 'agents', 'spor-backfill.toml'), 'utf8');
  assert.match(agent, /^name = "spor-backfill"$/m);
  assert.match(agent, /^description = "Populate or extend a project's Spor graph/m);
  assert.match(agent, /^developer_instructions = """$/m);
  assert.match(agent, /You are a Spor backfill agent/);
});

test('install is idempotent and preserves foreign hooks + top-level keys', () => {
  const home = scratchHome();
  const f = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    version: 9,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/my-own-hook' }] }] },
  }));
  const env = codexInstallEnv(home);
  run(['install', 'codex'], env);
  run(['install', 'codex'], env); // second run must not duplicate
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ss = j.hooks.SessionStart;
  assert.strictEqual(ss.filter((e) => JSON.stringify(e).includes('spor-hook')).length, 1, 'one spor entry after two installs');
  assert.ok(ss.some((e) => JSON.stringify(e).includes('my-own-hook')), 'foreign hook preserved');
  assert.strictEqual(j.version, 9, 'foreign top-level key preserved');
  assert.strictEqual(codexLog(home).match(/^plugin add spor@spor$/gm).length, 2, 'plugin install is re-run idempotently');
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
  assert.match(j.hooks.BeforeAgent[0].hooks[0].command, /node ".+spor-hook\.js" prompt-context --host gemini/);
});

test('install gemini aborts on a corrupt existing settings.json, writing nothing (no --mcp)', () => {
  // issue-spor-gemini-config-clobbered-on-install: installHookHost used to
  // read the existing target with a lenient readJsonOr(target, {}) fallback,
  // so a pre-existing but unparseable settings.json got silently discarded
  // and replaced with spor's default hooks — even with no --mcp in play.
  const home = scratchHome();
  const f = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not valid json');
  const r = run(['install', 'gemini'], { HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /isn't valid JSON/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{not valid json', 'left untouched');
});

test('install opencode places the plugin file (symlink or copy)', () => {
  const home = scratchHome();
  const r = run(['install', 'opencode'], { HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const f = path.join(home, '.config', 'opencode', 'plugins', 'spor.js');
  assert.ok(fs.existsSync(f), 'plugin file present');
  const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'opencode', 'spor.js'), 'utf8');
  const installed = fs.readFileSync(f, 'utf8');
  assert.ok(installed === src || installed.includes(`const EMBEDDED_ROOT = ${JSON.stringify(path.join(__dirname, '..'))}`),
    'matches the adapter source when linked, or embeds the root when copied');
});

test('install --scope repo writes under the cwd, not home', () => {
  const home = scratchHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-repo-'));
  const r = spawnSync(process.execPath, [CLI, 'install', 'codex', '--scope', 'repo'], { cwd: repo, encoding: 'utf8', env: bare(codexInstallEnv(home)) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(repo, '.codex', 'hooks.json')), 'repo-scope hook file under cwd');
  assert.ok(fs.existsSync(path.join(repo, '.codex', 'agents', 'spor-backfill.toml')), 'repo-scope agent file under cwd');
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'nothing written to home');
  assert.match(codexLog(home), /^plugin add spor@spor$/m);
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
  assert.match(r.stdout, /would run: \(cd .+ && codex plugin marketplace add \.\)/);
  assert.match(r.stdout, /would run: codex plugin add spor@spor/);
  assert.match(r.stdout, /would write .*\.codex.*hooks\.json/);
  assert.match(r.stdout, /would write .*\.codex.*agents.*spor-backfill\.toml/);
  assert.match(r.stdout, /^name = "spor-backfill"$/m);
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
  const r = run(['install', 'codex', '--server', 'http://127.0.0.1:9/', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.server, 'http://127.0.0.1:9'); // trailing slash trimmed
  assert.strictEqual(cfg.token, 'tok9');
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')), 'host still installed');
});

test('install codex stops before hook guidance when marketplace registration fails', () => {
  const home = scratchHome();
  const r = run(['install', 'codex'], { ...codexInstallEnv(home), CODEX_FAIL_MARKETPLACE: 'boom' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /codex plugin marketplace add failed: boom/);
  assert.doesNotMatch(r.stdout, /^next:/m);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'hooks.json')), 'hooks not written after plugin install failure');
});

// --- install --mcp (task-cc-spor-cli-install-mcp-automation) ---------------
// v1 only PRINTED the manual per-host MCP recipe (see each adapter's README);
// --mcp is the opt-in automation of it, plus running agents-md so AGENTS.md is
// populated in the same command. Every test pins its own scratch HOME +
// SPOR_HOME + cwd — --mcp also writes AGENTS.md at the repo root, so an
// unscoped cwd would land in this checkout's real AGENTS.md.
function mcpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mcp-cwd-'));
}
function runIn(cwd, args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: bare(env) });
}

test('install codex --mcp writes ~/.codex/config.toml [mcp_servers.spor]', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const r = runIn(cwd, ['install', 'codex', '--mcp', '--server', 'http://127.0.0.1:9/', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.spor\]$/m);
  assert.match(toml, /^url = "http:\/\/127\.0\.0\.1:9\/mcp"$/m);
  assert.match(toml, /^bearer_token_env_var = "SPOR_TOKEN"$/m);
  assert.match(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'), /<!-- spor:begin -->/);
});

test('install codex --mcp preserves unrelated config.toml content and is idempotent', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '[some_other_table]\nfoo = "bar"\n');
  const env = { ...codexInstallEnv(home), SPOR_HOME: home };
  const args = ['install', 'codex', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'];
  const r1 = runIn(cwd, args, env);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const once = fs.readFileSync(f, 'utf8');
  assert.match(once, /^\[some_other_table\]$/m, 'foreign table preserved');
  assert.match(once, /^foo = "bar"$/m);
  assert.match(once, /^\[mcp_servers\.spor\]$/m);
  const r2 = runIn(cwd, args, env); // second run must be byte-identical
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), once, 'idempotent re-install');
});

test('install gemini --mcp merges mcpServers.spor without clobbering foreign settings', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theme: 'dark', mcpServers: { other: { httpUrl: 'http://y' } } }));
  const r = runIn(cwd, ['install', 'gemini', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(j.theme, 'dark', 'foreign top-level key preserved');
  assert.ok(j.mcpServers.other, 'foreign mcp server preserved');
  assert.deepStrictEqual(j.mcpServers.spor, { httpUrl: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer $SPOR_TOKEN' } });
  assert.ok(j.hooks && j.hooks.BeforeAgent, 'hooks still merged in the same install');
});

test('install opencode --mcp writes opencode.json mcp.spor, merges foreign content, and is idempotent', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local' } } }));
  const env = { HOME: home, SPOR_HOME: home };
  const args = ['install', 'opencode', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'];
  const r1 = runIn(cwd, args, env);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const once = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(once);
  assert.strictEqual(j.theme, 'dark', 'foreign top-level key preserved');
  assert.ok(j.mcp.other, 'foreign mcp server preserved');
  assert.deepStrictEqual(j.mcp.spor, { type: 'remote', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer {env:SPOR_TOKEN}' } });
  const r2 = runIn(cwd, args, env); // second run must be byte-identical
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), once, 'idempotent re-install');
});

test('install copilot --mcp writes mcp-config.json mcpServers.spor, merges foreign content, and is idempotent', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://y' } } }));
  const env = { HOME: home, SPOR_HOME: home };
  const args = ['install', 'copilot', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'];
  const r1 = runIn(cwd, args, env);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const once = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(once);
  assert.ok(j.mcpServers.other, 'foreign mcp server preserved');
  assert.deepStrictEqual(j.mcpServers.spor, { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer $SPOR_TOKEN' } });
  const r2 = runIn(cwd, args, env); // second run must be byte-identical
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), once, 'idempotent re-install');
});

test('install codex --mcp strips a hand-added subtable of our own section along with it', () => {
  // Regression: the TOML section-stripper used to treat ANY `[...]` header as
  // ending our `[mcp_servers.spor]` block, so a subtable like
  // `[mcp_servers.spor.env]` would wrongly survive, orphaned, past a freshly
  // appended replacement block.
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '[mcp_servers.spor]\nurl = "http://old/mcp"\n\n[mcp_servers.spor.env]\nFOO = "bar"\n\n[other_table]\nx = 1\n');
  const r = runIn(cwd, ['install', 'codex', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const toml = fs.readFileSync(f, 'utf8');
  assert.doesNotMatch(toml, /\[mcp_servers\.spor\.env\]/, 'the subtable of our own section is stripped, not orphaned');
  assert.match(toml, /^\[other_table\]$/m, 'an unrelated table survives');
  assert.match(toml, /^x = 1$/m);
  assert.match(toml, /^url = "http:\/\/127\.0\.0\.1:9\/mcp"$/m);
});

test('install --mcp uses an already-configured server (no --server/--token needed this run)', () => {
  // Regression: writeAgentsBlock resolves its server through the scripts/
  // engines/util.js active-config global, which used to only get set when
  // --server/--token were passed THIS invocation — a pre-existing
  // config.json server was invisible to it (AGENTS.md would omit the MCP
  // line or read raw env instead of the resolved cfg). A non-loopback host
  // is used here (unlike the 127.0.0.1:9 fake elsewhere in this file)
  // because the AGENTS.md assertion below checks the resolved server made
  // it into the committed tools line, which a loopback host is now
  // deliberately omitted from (issue-spor-agents-md-local-mcp-leak).
  const home = scratchHome();
  const cwd = mcpCwd();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'http://spor.example.com:9', token: 'tok9' }));
  const r = runIn(cwd, ['install', 'codex', '--mcp'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^url = "http:\/\/spor\.example\.com:9\/mcp"$/m);
  const agentsMd = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /reachable over MCP at http:\/\/spor\.example\.com:9\/mcp/, 'agents-md resolved the pre-configured server, not raw env');
});

test('install --mcp still reminds about the manual README recipe for a host --mcp does not cover', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const r = runIn(cwd, ['install', 'codex', 'cursor', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'config.toml')), 'codex got its mcp config');
  assert.match(r.stdout, /distiller backend \(hosts without the claude CLI\): see adapters\/<host>\/README\.md/, 'distiller reminder is unconditional');
  assert.match(r.stdout, /on-demand MCP access: see adapters\/<host>\/README\.md/, 'cursor still needs the manual recipe --mcp does not automate');
});

test('install --mcp aborts on an unparseable existing config, writing nothing', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not valid json');
  const r = runIn(cwd, ['install', 'copilot', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /isn't valid JSON/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{not valid json', 'left untouched');
  assert.ok(!fs.existsSync(path.join(cwd, 'AGENTS.md')), 'agents-md skipped after an mcp failure');
});

test('install --mcp aborts when the existing config path is unreadable (not just unparseable)', () => {
  // A well-formed-vs-malformed JSON distinction isn't the only "can't safely
  // touch this" case — an existing path this can't read at all (e.g. it's a
  // directory) must abort the same way, not treat it as absent and clobber it.
  // Uses copilot, whose mcp-config.json is a SEPARATE file from its hooks
  // manifest, so the scenario exercises only the new --mcp write path.
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(f, { recursive: true }); // a directory sits where the file should be
  const r = runIn(cwd, ['install', 'copilot', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /can't read/);
  assert.ok(fs.statSync(f).isDirectory(), 'left untouched — not replaced with a file');
});

test('install gemini --mcp aborts on an unparseable existing settings.json, writing nothing (shared hooks+mcp file)', () => {
  // Gemini's mcpServers entry lives in the SAME settings.json its hooks
  // manifest does, unlike copilot/opencode (separate mcp-config.json) or
  // codex (separate config.toml) — so the hook-install write and the mcp
  // write target one file. Without a pre-check, installHookHost's lenient
  // readJsonOr(target, {}) would silently discard a malformed existing file
  // before writeMcpJson's strict check ever got a chance to abort.
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not valid json');
  const r = runIn(cwd, ['install', 'gemini', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /isn't valid JSON/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{not valid json', 'left untouched — no partial hooks-only write');
  assert.ok(!fs.existsSync(path.join(cwd, 'AGENTS.md')), 'agents-md skipped after an mcp failure');
});

test('install --mcp aborts when the existing mcpServers key is a non-object, discarding nothing', () => {
  // Valid top-level JSON whose group key has the WRONG shape (an array here)
  // must abort like unparseable JSON does — replacing it with {spor: ...}
  // would silently discard whatever the user had there.
  const home = scratchHome();
  const cwd = mcpCwd();
  const f = path.join(home, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const original = JSON.stringify({ mcpServers: ['not', 'a', 'map'] }, null, 2) + '\n';
  fs.writeFileSync(f, original);
  const r = runIn(cwd, ['install', 'copilot', '--mcp', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { HOME: home, SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /non-object 'mcpServers'/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), original, 'left untouched');
});

test('install --mcp without a configured server errors and writes nothing', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const r = runIn(cwd, ['install', 'codex', '--mcp'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /needs a configured server/);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')));
});

test('install without --mcp writes no MCP config and no AGENTS.md (v1 default unchanged)', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const r = runIn(cwd, ['install', 'codex', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')), 'no MCP config written by default');
  assert.ok(!fs.existsSync(path.join(cwd, 'AGENTS.md')), 'no AGENTS.md written by default');
  assert.match(r.stdout, /see adapters\/<host>\/README\.md/);
});

test('install --mcp --print previews the MCP config and agents-md without writing', () => {
  const home = scratchHome();
  const cwd = mcpCwd();
  const r = runIn(cwd, ['install', 'codex', '--mcp', '--print', '--server', 'http://127.0.0.1:9', '--token', 'tok9'], { ...codexInstallEnv(home), SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /would write .*config\.toml/);
  assert.match(r.stdout, /\[mcp_servers\.spor\]/);
  assert.match(r.stdout, /would run: spor-hook agents-md/);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')), 'dry run wrote nothing');
  assert.ok(!fs.existsSync(path.join(cwd, 'AGENTS.md')), 'dry run wrote nothing');
});

// --- upgrade (issue-spor-upgrade-no-plugin-refresh) -----------------------
// A bumped package leaves Claude Code running its own stale copy until the
// plugin is updated. These exercise the claude CLI shell-outs through a fake
// `claude` (SPOR_CLAUDE_CMD), the same lever dispatch uses. Posix-only (the
// stub is a shell script). PKG is this package's version, so the asserts don't
// hard-code a number that a release bump would break.
const PKG = require('../package.json').version;

// A fake `claude plugin` CLI. `plugin list --json` echoes the currently-loaded
// version (from $STATE, defaulting to $STARTVER); `plugin update spor@spor`
// writes $NEWVER to $STATE (simulating the cache swap). It models the real
// claude's name@marketplace contract — a bare `plugin update spor` is rejected
// with exit 1 (issue-spor-upgrade-wrong-plugin-marketplace-id), so this stub is
// a true regression guard. $EMPTY makes list report no spor installed. Returns
// the stub path.
function claudeStub(home) {
  return writeSpawnableNodeStub(home, 'claude-plugin-stub', `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.EMPTY) {
  if (args[0] === "plugin" && args[1] === "list") process.stdout.write("[]\\n");
  process.exit(0);
}
let ver = process.env.STARTVER || "";
try { ver = fs.readFileSync(process.env.STATE, "utf8") || ver; } catch {}
if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ id: "spor@spor", version: ver, scope: "user", enabled: true, installPath: \`/x/\${ver}\` }]) + "\\n");
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "update") {
  if (args[2] === "spor@spor") {
    fs.writeFileSync(process.env.STATE, process.env.NEWVER || "");
    process.exit(0);
  }
  process.stderr.write(\`Failed to update plugin "\${args[2]}": Plugin "\${args[2]}" not found\\n\`);
  process.exit(1);
}
process.exit(0);
`);
}

test('upgrade claude --print shows the three plugin commands, runs nothing', () => {
  const r = run(['upgrade', 'claude', '--print'], { HOME: scratchHome() });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would run: claude plugin marketplace add /);
  assert.match(r.stdout, /would run: claude plugin marketplace update spor/);
  assert.match(r.stdout, /would run: claude plugin update spor@spor --scope user/);
});

test('upgrade codex --print refreshes the plugin install and hook files', () => {
  const home = scratchHome();
  const r = run(['upgrade', 'codex', '--print'], { HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would run: \(cd .+ && codex plugin marketplace add \.\)/);
  assert.match(r.stdout, /would run: codex plugin add spor@spor/);
  assert.match(r.stdout, /would write .*\.codex.*hooks\.json/);
});

test('upgrade claude refreshes a stale plugin and reports before → after', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: '0.0.1', NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`spor plugin: 0\\.0\\.1 → ${PKG.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /restart your Claude Code session/i);
  assert.match(r.stdout, /Restart any running sessions/);
});

test('upgrade claude reports already-current when the loaded version matches', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`already current \\(${PKG.replace(/\./g, '\\.')}\\)`));
});

test('upgrade claude errors when spor is not installed in Claude Code', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, EMPTY: '1' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /run 'spor install claude' first/);
});

test('install claude self-heals: an already-installed plugin is refreshed, not no-op', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['install', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: '0.0.1', NEWVER: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`spor plugin: 0\\.0\\.1 → ${PKG.replace(/\./g, '\\.')}`));
});

test('status flags a stale Claude plugin and stays quiet when current', () => {
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
test('upgrade flags a newer @sporhq/spor published to npm', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG, SPOR_NPM_LATEST: '99.0.0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /newer @sporhq\/spor is published — 99\.0\.0/);
  assert.match(r.stdout, /npm install -g @sporhq\/spor@latest/);
});

test('upgrade stays quiet when the installed package is the latest published', () => {
  const home = scratchHome();
  const stub = claudeStub(home);
  const r = run(['upgrade', 'claude'], { HOME: home, SPOR_CLAUDE_CMD: stub, STATE: path.join(home, 'loaded'), STARTVER: PKG, NEWVER: PKG, SPOR_NPM_LATEST: PKG });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /newer @sporhq\/spor/);
});

test('upgrade --no-net skips the registry check entirely', () => {
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
        if (parsed && parsed.root) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ found: true, text: `DIGEST for root: ${parsed.root}` }));
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

test('brief <id> (remote) emits the raw node plus a root-walk /v1/digest neighborhood', async () => {
  const { srv, hits, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['brief', 'dec-x'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-b' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Raw node body\./);          // the raw node
    assert.match(r.stdout, /DIGEST for root: dec-x/); // root-walk neighborhood, not a free-text approximation
    assert.ok(hits.some((h) => h.method === 'GET' && h.url === '/v1/nodes/dec-x'), 'fetched the node');
    const dig = hits.find((h) => h.url === '/v1/digest');
    assert.ok(dig, 'compiled a digest');
    assert.strictEqual(dig.body.root, 'dec-x', 'posted {root} instead of a title/summary-seeded query');
    assert.strictEqual(dig.body.query, undefined, 'no free-text query for a node-id briefing');
    assert.strictEqual(dig.auth, 'Bearer tok-b', 'bearer token sent');
  } finally {
    srv.close();
  }
});

test('brief <id> --project <slug> (remote) forwards project alongside root', async () => {
  const { srv, hits, base } = await digestStubServer();
  try {
    const r = await runAsyncCli(['brief', 'dec-x', '--project', 'demo'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-b' });
    assert.strictEqual(r.status, 0, r.stderr);
    const dig = hits.find((h) => h.url === '/v1/digest');
    assert.ok(dig, 'compiled a digest');
    assert.deepStrictEqual(dig.body, { root: 'dec-x', project: 'demo' });
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

// --- next (remote): queue.project default + best-effort zero-match note -------
// task-spor-queue-default-project-config (pinned default reaches the server) and
// issue-spor-next-project-token-not-roundtrippable (a SCOPED read that comes back
// empty earns a soft stderr note; the cwd-default firehose does not).
function queueStubServer() {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const m = req.url.match(/^\/v1\/queue\?(.*)$/);
    if (req.method === 'GET' && m) {
      const qs = new URLSearchParams(m[1]);
      const project = qs.get('project');
      // 'empty-scope' returns nothing; anything else returns one item.
      const items = project === 'empty-scope' ? [] : [{ id: 'task-a', score: 1, suggest: 'do', why: 'queueable and live' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('next (remote) queue.project pins the scope sent to /v1/queue; explicit --project wins', async () => {
  const { srv, hits, base } = await queueStubServer();
  try {
    // pinned default reaches the server when no explicit flag is given
    const pinned = await runAsyncCli(['next'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-q', SPOR_QUEUE_PROJECT: 'proj-pin' });
    assert.strictEqual(pinned.status, 0, pinned.stderr);
    assert.ok(hits.some((h) => /project=proj-pin/.test(h.url)), 'pinned scope sent to the server');
    // explicit --project beats the pinned default
    const explicit = await runAsyncCli(['next', '--project', 'proj-flag'], { SPOR_SERVER: base, SPOR_TOKEN: 'tok-q', SPOR_QUEUE_PROJECT: 'proj-pin' });
    assert.strictEqual(explicit.status, 0, explicit.stderr);
    assert.ok(hits.some((h) => /project=proj-flag/.test(h.url)), 'explicit scope overrides the pin');
  } finally {
    srv.close();
  }
});

test('next (remote) notes a scoped read that returns nothing; an unscoped firehose does not', async () => {
  const { srv, base } = await queueStubServer();
  try {
    // a SCOPED read (explicit --project) that returns count:0 earns the soft note
    const scoped = await runAsyncCli(['next', '--project', 'empty-scope'], { SPOR_SERVER: base, SPOR_TOKEN: 't' });
    assert.strictEqual(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stderr, /project 'empty-scope' returned an empty queue/);
    // a non-empty scoped read does NOT warn
    const nonEmpty = await runAsyncCli(['next', '--project', 'proj-ok'], { SPOR_SERVER: base, SPOR_TOKEN: 't' });
    assert.doesNotMatch(nonEmpty.stderr, /returned an empty queue/);
  } finally {
    srv.close();
  }
});

// --- add (remote) transport-failure spooling --------------------------------
// issue-spor-add-cli-residual-transport-failure-silent-loss: a one-shot `spor add`
// has no hook loop, so a transport failure / transient 5xx must SPOOL the capture
// to the shared outbox (the queue drain-outbox replays) instead of printing a
// retry promise it can't keep. Permanent 4xx rejects must NOT spool.
function captureStubServer(handler) {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
// A bound-then-closed port: connecting to it yields ECONNREFUSED -> remote.post
// returns {transport:true}, the genuine "server unreachable" case.
function deadBase() {
  const http = require('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      srv.close(() => resolve(base));
    });
  });
}
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-add-spool-'));
}
function spoolFiles(home) {
  const dir = path.join(home, 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.capture.json')) : [];
}

test('add (remote) transport failure spools the capture and reports the spool path', async () => {
  const home = freshHome();
  const base = await deadBase();
  const r = await runAsyncCli(['add', 'a durable finding worth keeping past an outage'],
    { SPOR_SERVER: base, SPOR_TOKEN: 'tok', SPOR_HOME: home });
  assert.strictEqual(r.status, 1, r.stdout);
  // accurate message: names the spool location + the real recovery path, NOT a
  // bare "retried by the hooks" promise a one-shot CLI cannot keep.
  assert.match(r.stderr, /Spooled to /);
  assert.match(r.stderr, /spor drain/);
  assert.doesNotMatch(r.stderr, /retried by the hooks/);
  const spooled = spoolFiles(home);
  assert.strictEqual(spooled.length, 1, 'exactly one capture spooled to the outbox');
  // the spooled body is the VERBATIM /v1/capture payload, so the drain replays it as-is
  const payload = JSON.parse(fs.readFileSync(path.join(home, 'outbox', spooled[0]), 'utf8'));
  assert.strictEqual(payload.text, 'a durable finding worth keeping past an outage');
  assert.ok(payload.context && typeof payload.context.project === 'string', 'context.project preserved');
});

test('add (remote) transient 5xx spools the capture for replay', async () => {
  const home = freshHome();
  const { srv, base } = await captureStubServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unavailable' } }));
  });
  try {
    const r = await runAsyncCli(['add', 'capture worth keeping while the server is down'],
      { SPOR_SERVER: base, SPOR_TOKEN: 'tok', SPOR_HOME: home });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /Spooled to /);
    assert.strictEqual(spoolFiles(home).length, 1, 'a 5xx is retryable -> spooled');
  } finally {
    srv.close();
  }
});

test('add (remote) permanent 4xx does NOT spool — it is a deterministic reject', async () => {
  const home = freshHome();
  const { srv, base } = await captureStubServer((req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_date' } }));
  });
  try {
    const r = await runAsyncCli(['add', 'a capture the server rejects on a bad field', '--needed-by', 'not-a-date'],
      { SPOR_SERVER: base, SPOR_TOKEN: 'tok', SPOR_HOME: home });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /capture error 422/);
    assert.strictEqual(spoolFiles(home).length, 0, 'a permanent 4xx must not spool (would only dead-letter)');
  } finally {
    srv.close();
  }
});

test('add (remote) happy path captures and spools nothing', async () => {
  const home = freshHome();
  const { srv, base } = await captureStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'captured', ids: ['task-fresh-capture'] }));
  });
  try {
    const r = await runAsyncCli(['add', 'a capture that ships cleanly on the first try'],
      { SPOR_SERVER: base, SPOR_TOKEN: 'tok', SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /captured: task-fresh-capture/);
    assert.strictEqual(spoolFiles(home).length, 0, 'a successful capture leaves the outbox empty');
  } finally {
    srv.close();
  }
});
