// Project identity nodes (task-cc-project-identity-nodes): slug-alias
// resolution at read time, the .spor marker override, and fingerprint
// learning. Zero-dep node:test suite.
//
// Covers: parser slugs/fingerprints registers, buildGraph projectAliases +
// resolveProject, queue filter/mute resolution (and the no-project-nodes
// identity guarantee), validator slug warnings, projectSlug() marker
// override, repoFingerprints() normalization, session-start local alias
// brief lookup, and the remote ?fp= ride-along.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const graph = require(path.join(__dirname, '..', 'lib', 'graph.js'));
const { rankQueue } = require(path.join(__dirname, '..', 'lib', 'queue.js'));
const u = require(path.join(__dirname, '..', 'scripts', 'engines', 'util.js'));

const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-projid-'));
  const nodesDir = path.join(dir, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

const task = (id, project, extra = '') => [
  `${id}.md`,
  `---
id: ${id}
type: task
project: ${project}
title: Title of ${id}
summary: Standalone summary for ${id}.
status: open
date: 2026-06-01
${extra}---
Body of ${id}.
`,
];

const PROJ = `---
id: proj-x
type: project
title: Project X
summary: Durable identity for the old-name/new-name lineage.
slugs: [old-name, new-name]
fingerprints: [remote:github.com/org/x, root:abc123]
date: 2026-06-12
---
The project formerly known as old-name.
`;

const NOW = Date.parse('2026-06-11T00:00:00Z');

// ---------- parser + buildGraph ----------

test('parser: slugs and fingerprints parse as inline lists; buildGraph indexes aliases', () => {
  const g = tmpGraph(Object.fromEntries([
    ['proj-x.md', PROJ],
    task('task-old', 'old-name'),
  ])).load();
  const p = g.nodes['proj-x'];
  assert.deepEqual(p.slugs, ['old-name', 'new-name']);
  assert.deepEqual(p.fingerprints, ['remote:github.com/org/x', 'root:abc123']);
  assert.deepEqual(g.projectAliases, { 'proj-x': 'proj-x', 'old-name': 'proj-x', 'new-name': 'proj-x' });
  assert.equal(graph.resolveProject(g, 'old-name'), 'proj-x');
  assert.equal(graph.resolveProject(g, 'new-name'), 'proj-x');
  assert.equal(graph.resolveProject(g, 'unrelated'), 'unrelated');
});

test('buildGraph: no project nodes -> empty alias map, resolution is identity', () => {
  const g = tmpGraph(Object.fromEntries([task('task-a', 'solo')])).load();
  assert.deepEqual(g.projectAliases, {});
  assert.equal(graph.resolveProject(g, 'solo'), 'solo');
});

// ---------- queue resolution ----------

test('rankQueue: project filter matches every alias the project node owns', () => {
  const g = tmpGraph(Object.fromEntries([
    ['proj-x.md', PROJ],
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
    task('task-other', 'elsewhere'),
  ])).load();
  for (const filter of ['new-name', 'old-name', 'proj-x']) {
    const ids = rankQueue(g, { now: NOW, project: filter }).items.map((i) => i.id).sort();
    assert.deepEqual(ids, ['task-new', 'task-old'], `filter ${filter}`);
  }
  // stamps are never rewritten — items keep their historical project field
  const r = rankQueue(g, { now: NOW, project: 'new-name' });
  assert.equal(r.items.find((i) => i.id === 'task-old').project, 'old-name');
});

test('rankQueue: without a project node the filter stays exact (byte-for-byte today)', () => {
  const g = tmpGraph(Object.fromEntries([
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
  ])).load();
  const ids = rankQueue(g, { now: NOW, project: 'new-name' }).items.map((i) => i.id);
  assert.deepEqual(ids, ['task-new']);
});

test('rankQueue: a mute naming any alias hides the whole project class', () => {
  const g = tmpGraph(Object.fromEntries([
    ['proj-x.md', PROJ],
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
  ])).load();
  const viewer = { queue_mute: ['old-name'] };
  const r = rankQueue(g, { now: NOW, viewer });
  assert.deepEqual(r.items, []);
  assert.equal(r.muted, 2);
});

// ---------- validator ----------

test('validateGraph: warns on contested and non-kebab slugs', () => {
  const g = tmpGraph(Object.fromEntries([
    ['proj-x.md', PROJ],
    ['proj-y.md', PROJ.replace(/proj-x/g, 'proj-y').replace('slugs: [old-name, new-name]', 'slugs: [old-name, Bad_Slug]')],
  ]));
  const r = graph.validateGraph(g.nodesDir);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("slug 'old-name' is claimed by both 'proj-x' and 'proj-y'")), r.warnings.join('; '));
  assert.ok(r.warnings.some((w) => w.includes("slug 'Bad_Slug' is not kebab-case")), r.warnings.join('; '));
});

// ---------- projectSlug marker override ----------

test('projectSlug: a .spor marker beats basename inference; invalid values fall through', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-marker-My_Repo-'));
  fs.writeFileSync(path.join(cwd, '.spor'), 'project: durable-id\n');
  assert.equal(u.projectSlug(cwd), 'durable-id');
  fs.writeFileSync(path.join(cwd, '.spor'), 'project: Not_Canonical\n');
  assert.equal(u.projectSlug(cwd), path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  fs.rmSync(path.join(cwd, '.spor'));
  assert.equal(u.projectSlug(cwd), path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
});

// ---------- repo fingerprints ----------

function gitRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-fp-'));
  const g = (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'f.txt'), 'x');
  g(['add', 'f.txt']);
  g(['commit', '-q', '-m', 'root']);
  return { cwd, g, root: g(['rev-parse', 'HEAD']).trim() };
}

test('repoFingerprints: root sha plus normalized remotes (ssh/https converge, no credentials)', () => {
  const { cwd, g, root } = gitRepo();
  g(['remote', 'add', 'origin', 'git@github.com:Org/Repo.git']);
  g(['remote', 'add', 'mirror', 'https://user:tok@example.com/a/b.git']);
  g(['remote', 'add', 'dupe', 'https://github.com/org/repo']);
  const fp = u.repoFingerprints(cwd);
  assert.deepEqual(fp.sort(), [
    `root:${root}`,
    'remote:example.com/a/b',
    'remote:github.com/org/repo',
  ].sort());
  assert.ok(!fp.join(',').includes('tok'));
});

test('repoFingerprints: not a git repo -> empty (fail-open)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-fp-norepo-'));
  assert.deepEqual(u.repoFingerprints(cwd), []);
});

// ---------- session-start engine (black-box via the dispatcher) ----------

function freshEnv(home) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_')) delete env[k];
    if (k.startsWith('SPOR_') && k !== 'SPOR_HOME') delete env[k];
  }
  return env;
}

function run(args, input, env) {
  const r = spawnSync('bash', [BIN, ...args], { input, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `exit 0 expected (fail-open): ${r.stderr}`);
  return r.stdout;
}

const OLD_BRIEF = `---
id: brief-old-name
type: briefing
project: old-name
title: Standing briefing for old-name
summary: Test briefing.
version: 7
---

The old-name standing briefing body survives the rename.
`;

test('session-start local: brief lookup and project count resolve through slug aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-ss-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'new-name'); // slug = basename
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'nodes', 'proj-x.md'), PROJ);
  fs.writeFileSync(path.join(home, 'nodes', 'brief-old-name.md'), OLD_BRIEF);
  fs.writeFileSync(path.join(home, 'nodes', 'task-old.md'), task('task-old', 'old-name')[1]);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /brief-old-name v7/);
  assert.match(ctx, /old-name standing briefing body/);
  // task-old (project: old-name) + brief-old-name count under the new slug
  assert.match(ctx, /\(2 tagged project: new-name\)/);
});

test('session-start local: no project node -> exact-slug behavior unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-ss2-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'new-name');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'nodes', 'brief-old-name.md'), OLD_BRIEF);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\(0 tagged project: new-name\)/);
  assert.ok(!ctx.includes('Standing project briefing'), 'alias brief must not leak without a project node');
});

// Stub server: records requests; answers the briefing fetch found:false.
function stubServer() {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ found: false, graph_status: { node_count: 0 }, items: [], questions: [] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    const c = spawn('bash', [BIN, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    c.stdin.end(input);
  });
}

test('session-start remote: repo fingerprints ride the briefing fetch as ?fp=', async () => {
  const { cwd, root } = gitRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-ssr-'));
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_test';
    await runAsync(
      ['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
      env
    );
    const brief = hits.find((h) => h.url.startsWith('/v1/briefing/'));
    assert.ok(brief, `briefing fetch missing: ${JSON.stringify(hits)}`);
    const fp = decodeURIComponent(brief.url.split('?fp=')[1] ?? '');
    assert.ok(fp.includes(`root:${root}`), fp);
  } finally {
    srv.close();
  }
});
