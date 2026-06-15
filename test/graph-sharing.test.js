// Local-mode git-shared graph (issue-cc-local-mode-graph-sharing-gap,
// dec-spor-local-mode-sharing-boundary): the shared-home .gitignore helper and
// the distill auto-commit nested-repo guard. The `.spor` marker -> home
// precedence lives in config.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const u = require('../scripts/engines/util.js');
const { graphInsideCodeRepo } = require('../scripts/engines/distill.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spor-share-'));
}
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  return dir;
}
const IGNORES = ['/journal/', '/cache/', '/outbox/', '/auth/', '/config.json'];

// --- ensureGraphGitignore -------------------------------------------------

test('gitignore: absent -> creates a header + every machine-local entry', () => {
  const home = tmp();
  assert.strictEqual(u.ensureGraphGitignore(home), true);
  const body = fs.readFileSync(path.join(home, '.gitignore'), 'utf8');
  assert.match(body, /^# Spor machine-local/m);
  for (const ig of IGNORES) assert.ok(body.includes(ig + '\n'), `missing ${ig}`);
  // The durable graph is never ignored.
  assert.ok(!/\/nodes\//.test(body));
  assert.ok(!/\/history\//.test(body));
});

test('gitignore: idempotent — a second call writes nothing and adds no dupes', () => {
  const home = tmp();
  u.ensureGraphGitignore(home);
  const first = fs.readFileSync(path.join(home, '.gitignore'), 'utf8');
  assert.strictEqual(u.ensureGraphGitignore(home), false);
  const second = fs.readFileSync(path.join(home, '.gitignore'), 'utf8');
  assert.strictEqual(second, first);
  // each entry appears exactly once
  for (const ig of IGNORES) {
    const n = second.split('\n').filter((l) => l.trim() === ig).length;
    assert.strictEqual(n, 1, `${ig} appears ${n} times`);
  }
});

test('gitignore: additive — preserves a contributor file, appends only the missing lines', () => {
  const home = tmp();
  // Pre-existing file with the user's own rule and ONE of ours, no trailing NL.
  fs.writeFileSync(path.join(home, '.gitignore'), '# mine\n*.log\n/cache/');
  assert.strictEqual(u.ensureGraphGitignore(home), true);
  const body = fs.readFileSync(path.join(home, '.gitignore'), 'utf8');
  assert.ok(body.includes('# mine'), 'clobbered user header');
  assert.ok(body.includes('*.log'), 'clobbered user rule');
  // /cache/ was already present -> not duplicated
  assert.strictEqual(body.split('\n').filter((l) => l.trim() === '/cache/').length, 1);
  // the other four were appended
  for (const ig of IGNORES.filter((x) => x !== '/cache/')) assert.ok(body.includes(ig), `missing ${ig}`);
});

test('gitignore: empty value yields no work', () => {
  assert.strictEqual(u.ensureGraphGitignore(''), false);
  assert.strictEqual(u.ensureGraphGitignore(null), false);
});

// --- distill nested-repo guard (graphInsideCodeRepo) ----------------------

test('distill guard: separate graph & code repos are NOT the same repo (commit proceeds)', () => {
  const root = tmp();
  const graph = gitInit(path.join(root, 'graph'));
  const code = gitInit(path.join(root, 'code'));
  assert.strictEqual(graphInsideCodeRepo(graph, code), false);
});

test('distill guard: graph home == code repo is flagged (auto-commit suppressed)', () => {
  const repo = gitInit(path.join(tmp(), 'repo')); // graph: . — home is the code repo
  assert.strictEqual(graphInsideCodeRepo(repo, repo), true);
});

test('distill guard: graph home is a subdir tracked by the code repo -> same repo', () => {
  const code = gitInit(path.join(tmp(), 'code'));
  const sub = path.join(code, 'graph'); // a plain subdir, no nested .git
  fs.mkdirSync(sub, { recursive: true });
  // Both resolve to the same git toplevel (the code repo).
  assert.strictEqual(graphInsideCodeRepo(sub, code), true);
});

test('distill guard: a nested graph repo WITH its own .git is its own repo (commit proceeds)', () => {
  const code = gitInit(path.join(tmp(), 'code'));
  const nested = gitInit(path.join(code, 'graph')); // own .git inside the code tree
  assert.strictEqual(graphInsideCodeRepo(nested, code), false);
});

test('distill guard: fail-open when a dir is not a git repo, or cwd is empty', () => {
  const plain = tmp();
  const code = gitInit(path.join(tmp(), 'code'));
  assert.strictEqual(graphInsideCodeRepo(plain, code), false);
  assert.strictEqual(graphInsideCodeRepo(code, ''), false);
});

// --- machine-local user-config home vs the marker-shared graph home
// (issue-spor-config-desync-shared-graph-home): the engine-side seam
// session-start writes the dispatch.repos map through. With a marker `graph:`
// home active, u.graphHome() points at the shared graph but u.userConfigHome()
// must stay at the personal env home, so passive learning never desyncs.

test('util: userConfigHome stays personal while graphHome follows the marker; standalone they coincide', () => {
  const env = (e) => {
    const o = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('SPOR_') || k.startsWith('SUBSTRATE_') || k === 'XDG_CONFIG_HOME') continue;
      o[k] = v;
    }
    return Object.assign(o, e);
  };
  const root = tmp();
  const code = path.join(root, 'code');
  fs.mkdirSync(code, { recursive: true });
  const shared = path.join(root, 'team-graph');
  const personal = path.join(root, 'personal');
  fs.writeFileSync(path.join(code, '.spor'), `repo: code\ngraph: ${shared}\n`);
  try {
    u.useConfig({ cwd: code, env: env({ SPOR_HOME: personal }) });
    assert.strictEqual(u.graphHome(), shared); // the GRAPH follows the marker
    assert.strictEqual(u.userConfigHome(), personal); // machine-local config does NOT
  } finally {
    u.clearConfig();
  }
  // No active config (standalone util call / unit test): both fall back to the
  // env home, so the two coincide — byte-identical with no marker in play.
  process.env.SPOR_HOME = personal;
  try {
    assert.strictEqual(u.userConfigHome(), u.graphHome());
  } finally {
    delete process.env.SPOR_HOME;
  }
});
