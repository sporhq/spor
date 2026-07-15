// lib/config.js — the client configuration cascade
// (dec-spor-client-config-cascade). Layers, precedence, secret stripping,
// dual-read, and the byte-identical guarantee (env-above-config) are the
// contract.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
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
// A flat `.spor` identity marker (key: value), like projectSlug reads.
function writeMarker(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.spor'), body);
}

test('defaults: unset values fall through to caller fallback (byte-identical)', () => {
  const dir = tmp();
  const c = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(c.getNum('search.minSim', 0.08), 0.08);
  assert.strictEqual(c.getNum('distill.debounce', 900), 900);
  assert.strictEqual(c.get('distill.model', 'haiku'), 'haiku');
  assert.strictEqual(c.mode(), 'local'); // no server
  // opt-in default (task-spor-plugin-opt-in-default): a markerless cwd with no
  // enable flag is a no-op. The get() fallbacks above remain byte-identical; the
  // activation gate is the one deliberate behavior change.
  assert.strictEqual(c.enabled(), false);
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

test('env: SPOR_DISPATCH_AGENT maps to dispatch.agent (per-machine dispatch identity)', () => {
  const dir = tmp();
  // the documented env knob must resolve dispatch.agent; unset stays null
  assert.strictEqual(loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) }).get('dispatch.agent', null), null);
  const c = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_DISPATCH_AGENT: 'agent-env-laptop' }) });
  assert.strictEqual(c.get('dispatch.agent', null), 'agent-env-laptop');
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

// --- opt-in activation (task-spor-plugin-opt-in-default): installing the
// plugin must not make every repo participate. A repo is a no-op until it has a
// .spor/.spor.json marker OR an explicit enabled flag somewhere in the cascade.

test('opt-in: a markerless repo is a no-op — even in remote mode (the core guarantee)', () => {
  const root = tmp();
  const side = path.join(root, 'side-project');
  fs.mkdirSync(side);
  const local = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(local.enabled(), false);
  // a globally-configured server (remote mode) must NOT silently re-enable an
  // unrelated side project — distilling it into the team graph is the harm.
  const remote = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: root, SPOR_SERVER: 'https://srv' }) });
  assert.strictEqual(remote.mode(), 'remote');
  assert.strictEqual(remote.enabled(), false);
});

test('opt-in: a .spor.json marker (no enabled key) activates the repo', () => {
  const root = tmp();
  write(path.join(root, 'repo', '.spor.json'), { search: { minSim: 0.2 } });
  const c = loadConfig({ cwd: path.join(root, 'repo'), env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.enabled(), true);
});

test('opt-in: a flat .spor identity marker activates the repo, and an ancestor marker covers a subdir', () => {
  const root = tmp();
  writeMarker(path.join(root, 'repo'), 'repo: thing\n');
  const c = loadConfig({ cwd: path.join(root, 'repo'), env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.enabled(), true);
  // nearest-ancestor walk: a markerless deep subdir inherits the repo's opt-in
  const sub = path.join(root, 'repo', 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const cs = loadConfig({ cwd: sub, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(cs.enabled(), true);
});

test('opt-in: a `.spor` DIRECTORY (the graph home) is NOT a repo marker — markerless repos under it stay no-ops (issue-spor-home-dir-marker-opt-in-leak)', () => {
  const root = tmp();
  // The default LOCAL graph home `~/.spor` is a DIRECTORY. Place one at the
  // ancestor of an unrelated side project — exactly the home-dir layout that
  // made a bare existsSync treat the graph home as a repo opt-in marker and
  // falsely enable every markerless repo nested under $HOME.
  const graphHome = path.join(root, '.spor');
  fs.mkdirSync(graphHome, { recursive: true });
  const side = path.join(root, 'side-project');
  fs.mkdirSync(side);
  const c = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: graphHome }) });
  assert.strictEqual(c.enabled(), false);
  // remote mode must not re-enable it either (a globally-set SPOR_SERVER only
  // resolves the MODE, never opt-in — the core guarantee).
  const remote = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: graphHome, SPOR_SERVER: 'https://srv' }) });
  assert.strictEqual(remote.enabled(), false);
  // a real flat `.spor` FILE marker at the project still activates it — the
  // file-vs-directory distinction is what tells the marker from the graph home.
  writeMarker(side, 'repo: side\n');
  const enabled = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: graphHome }) });
  assert.strictEqual(enabled.enabled(), true);
});

test('opt-in: enabled via the cascade (SPOR_ENABLED env, user config.json) activates a markerless repo', () => {
  const root = tmp();
  const side = path.join(root, 'side');
  fs.mkdirSync(side);
  // env flag (sits above the config files)
  const ce = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: root, SPOR_ENABLED: '1' }) });
  assert.strictEqual(ce.enabled(), true);
  // user config.json flag (read from SPOR_HOME/config.json)
  write(path.join(root, 'config.json'), { enabled: true });
  const cu = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(cu.enabled(), true);
  // an explicit SPOR_ENABLED=0 disables even a marked repo (explicit beats marker)
  writeMarker(side, 'repo: side\n');
  const c0 = loadConfig({ cwd: side, env: bareEnv({ SPOR_HOME: root, SPOR_ENABLED: '0' }) });
  assert.strictEqual(c0.enabled(), false);
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

test('queue.front: structural defaults, env override, and disable convention', () => {
  // task-cc-local-front-productionize: the local git-derived front window/toggle
  // live in the cascade. Defaults are baked into DEFAULTS (not get() fallbacks).
  const dir = tmp();
  const cd = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(cd.getNum('queue.front.days', 7), 7);
  assert.strictEqual(cd.getBool('queue.front.enabled', true), true);
  assert.deepStrictEqual(cd.warnings, []); // `queue` is a known key
  // env overrides (above the files): SPOR_QUEUE_FRONT=0 disables, _DAYS tunes.
  const ce = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_QUEUE_FRONT: '0', SPOR_QUEUE_FRONT_DAYS: '30' }) });
  assert.strictEqual(ce.getBool('queue.front.enabled', true), false);
  assert.strictEqual(ce.getNum('queue.front.days', 7), 30);
  // repo .spor.json sits below env, above defaults.
  write(path.join(dir, '.spor.json'), { queue: { front: { days: 14 } } });
  const cr = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(cr.getNum('queue.front.days', 7), 14);
  assert.strictEqual(cr.getBool('queue.front.enabled', true), true); // still the default
});

test('queue.project: resolves through env, legacy SUBSTRATE_*, and .spor.json; absent => caller fallback', () => {
  // task-spor-queue-default-project-config: a default --project scope for `spor
  // next` (both modes). Lives under the already-known `queue` key, so no DEFAULTS
  // entry and no warning; absent it resolves to the caller's fallback (the prior
  // behavior). An explicit --project still wins at the CLI; this is only the gap-fill.
  const dir = tmp();
  const cd = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(cd.get('queue.project', null), null); // absent: caller's fallback
  assert.deepStrictEqual(cd.warnings, []); // `queue` is a known key
  // env override (SPOR_QUEUE_PROJECT, sits above the files)
  const ce = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_QUEUE_PROJECT: 'proj-x' }) });
  assert.strictEqual(ce.get('queue.project', null), 'proj-x');
  // legacy SUBSTRATE_* spelling is honored too (dual-read)
  const cs = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SUBSTRATE_QUEUE_PROJECT: 'proj-legacy' }) });
  assert.strictEqual(cs.get('queue.project', null), 'proj-legacy');
  // repo .spor.json sits below env, above defaults
  write(path.join(dir, '.spor.json'), { queue: { project: 'proj-repo' } });
  const cr = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir }) });
  assert.strictEqual(cr.get('queue.project', null), 'proj-repo');
  assert.deepStrictEqual(cr.warnings, []); // still a known key, no warning
  // env still wins over the repo file
  const cre = loadConfig({ cwd: dir, env: bareEnv({ SPOR_HOME: dir, SPOR_QUEUE_PROJECT: 'proj-env' }) });
  assert.strictEqual(cre.get('queue.project', null), 'proj-env');
  // it coexists with queue.front — the `queue` object merges, not replaces
  assert.strictEqual(cr.getBool('queue.front.enabled', true), true);
});

test('unknown top-level key earns a warning but is otherwise ignored', () => {
  const root = tmp();
  write(path.join(root, '.spor.json'), { searhc: { minSim: 0.5 }, enabled: true });
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.ok(c.warnings.some((w) => /unknown config key 'searhc'/.test(w)));
  assert.strictEqual(c.getNum('search.minSim', 0.08), 0.08); // typo'd key had no effect
});

test('SPOR_SESSION_LEASE env resolves through the cascade with no "unknown config key" warning', () => {
  // Regression: ENV_MAP registered sessionLease.* but KNOWN_KEYS omitted the
  // "sessionLease" top-level namespace, so setting the env var alone (no repo
  // config file) tripped the unknown-key sweep on every hook dispatch.
  const root = tmp();
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root, SPOR_SESSION_LEASE: '0' }) });
  assert.deepStrictEqual(c.warnings, []);
  assert.strictEqual(c.getBool('sessionLease.enabled', true), false);
});

test('fail-open: malformed config file is skipped with a warning', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.spor.json'), '{ not json ');
  const c = loadConfig({ cwd: root, env: bareEnv({ SPOR_HOME: root }) });
  assert.strictEqual(c.warnings.length, 1);
  assert.match(c.warnings[0], /malformed config/);
  // a malformed .spor.json contributes no values, but its PRESENCE is still an
  // opt-in marker (task-spor-plugin-opt-in-default), so the repo stays active.
  assert.strictEqual(c.enabled(), true);
});

// --- per-repo `.spor` marker graph home (issue-cc-local-mode-graph-sharing-gap,
// dec-spor-local-mode-sharing-boundary): free local mode's git-shared graph.

test('marker graph: overrides SPOR_HOME (local), resolved relative to the marker dir', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'repo: code\ngraph: ../team-graph\n');
  const envHome = path.join(root, 'personal');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: envHome }) });
  const expected = path.resolve(repo, '../team-graph'); // == <root>/team-graph
  assert.strictEqual(c.graphHome(), expected); // beats SPOR_HOME
  assert.strictEqual(c.sharedGraphHome(), expected);
  assert.strictEqual(c.nodesDir(), path.join(expected, 'nodes'));
  assert.strictEqual(c.mode(), 'local');
});

test('marker graph: an absolute path is used as-is', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  const abs = path.join(root, 'abs-graph');
  writeMarker(repo, `graph: ${abs}\n`);
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: path.join(root, 'env') }) });
  assert.strictEqual(c.graphHome(), abs);
});

test('marker graph: deeper graph: binding wins over an ancestor binding', () => {
  const root = tmp();
  writeMarker(root, 'graph: root-graph\n');
  const sub = path.join(root, 'svc');
  writeMarker(sub, 'graph: sub-graph\n');
  const c = loadConfig({ cwd: sub, env: bareEnv({ SPOR_HOME: path.join(root, 'env') }) });
  assert.strictEqual(c.graphHome(), path.join(sub, 'sub-graph'));
});

test('marker graph: an identity-only deeper marker does NOT shadow an ancestor binding', () => {
  const root = tmp();
  writeMarker(root, 'graph: root-graph\n');
  const sub = path.join(root, 'svc');
  writeMarker(sub, 'repo: svc\n'); // identity split, no graph: key
  const c = loadConfig({ cwd: sub, env: bareEnv({ SPOR_HOME: path.join(root, 'env') }) });
  assert.strictEqual(c.graphHome(), path.join(root, 'root-graph')); // resolved at the root marker dir
});

test('marker graph: an explicit CLI --home still wins (marker not applied)', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'graph: team-graph\n');
  const cliHome = path.join(root, 'cli');
  const c = loadConfig({
    cwd: repo,
    env: bareEnv({ SPOR_HOME: path.join(root, 'env') }),
    cli: { home: cliHome },
  });
  assert.strictEqual(c.graphHome(), cliHome);
  assert.strictEqual(c.sharedGraphHome(), null);
});

test('marker graph: ignored in remote mode — the server is the graph', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'graph: team-graph\n');
  const envHome = path.join(root, 'env');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: envHome, SPOR_SERVER: 'https://srv' }) });
  assert.strictEqual(c.mode(), 'remote');
  assert.strictEqual(c.graphHome(), envHome); // marker NOT applied
  assert.strictEqual(c.sharedGraphHome(), null);
});

test('no graph: marker — home is byte-identical to env, sharedGraphHome is null', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'repo: code\n'); // identity only
  const envHome = path.join(root, 'env');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: envHome }) });
  assert.strictEqual(c.graphHome(), envHome);
  assert.strictEqual(c.sharedGraphHome(), null);
});

test('.spor.json home stays BELOW env; only the .spor marker graph beats env', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  write(path.join(repo, '.spor.json'), { home: path.join(root, 'json-home') });
  const envHome = path.join(root, 'env');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: envHome }) });
  assert.strictEqual(c.graphHome(), envHome); // env wins over .spor.json home (cascade)
  assert.strictEqual(c.sharedGraphHome(), null);
});

// --- machine-local user-config home vs the (marker-shared) graph home
// (issue-spor-config-desync-shared-graph-home): the user config.json — server,
// token, and the dispatch.repos slug->path map — is machine-local and must be
// READ and WRITTEN at the personal env/default home, NEVER the marker-shared
// graph home. userConfigHome() is the single anchor the WRITE paths use; the
// cascade reads the user layer from the same place, so they round-trip.

test('userConfigHome stays at the PERSONAL home when a marker graph: redirects the graph', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'repo: code\ngraph: ../team-graph\n');
  const personal = path.join(root, 'personal');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: personal }) });
  const shared = path.resolve(repo, '../team-graph');
  assert.strictEqual(c.graphHome(), shared); // the GRAPH follows the marker
  assert.strictEqual(c.sharedGraphHome(), shared);
  assert.strictEqual(c.userConfigHome(), personal); // but machine-local config does NOT
  assert.notStrictEqual(c.userConfigHome(), c.graphHome());
});

test('userConfigHome equals graphHome when no marker / override moves the graph (byte-identical)', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  writeMarker(repo, 'repo: code\n'); // identity only — no graph: key
  const personal = path.join(root, 'personal');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: personal }) });
  assert.strictEqual(c.userConfigHome(), personal);
  assert.strictEqual(c.graphHome(), personal); // they coincide with no marker
});

test('userConfigHome ignores even an explicit --home / .spor.json home (config is machine-local, env-anchored)', () => {
  const root = tmp();
  const repo = path.join(root, 'code');
  write(path.join(repo, '.spor.json'), { home: path.join(root, 'json-home') });
  const personal = path.join(root, 'personal');
  const cliHome = path.join(root, 'cli');
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: personal }), cli: { home: cliHome } });
  assert.strictEqual(c.graphHome(), cliHome); // --home wins for the GRAPH
  assert.strictEqual(c.userConfigHome(), personal); // but the user config layer is read from here, so writes must land here too
});
