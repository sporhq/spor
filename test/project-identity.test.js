// Project identity nodes (task-cc-project-identity-nodes): slug-alias
// resolution at read time, the .spor marker override, and fingerprint
// learning. Zero-dep node:test suite.
//
// Covers: parser slugs/fingerprints registers, buildGraph projectAliases +
// resolveProject, queue filter/mute resolution (and the no-project-nodes
// identity guarantee), validator slug warnings, projectSlug() marker
// override, repoFingerprints() normalization, session-start local alias
// brief lookup, and the remote ?fp= ride-along.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
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

// Identity node is now a REPO (renamed from the former `type: project`,
// dec-cc-repo-project-two-layer-identity; re-prefixed proj- -> repo-).
const PROJ = `---
id: repo-x
type: repo
title: Repo X
summary: Durable identity for the old-name/new-name lineage.
slugs: [old-name, new-name]
fingerprints: [remote:github.com/org/x, root:abc123]
date: 2026-06-12
---
The repo formerly known as old-name.
`;

const NOW = Date.parse('2026-06-11T00:00:00Z');

// ---------- parser + buildGraph ----------

test('parser: slugs and fingerprints parse as inline lists; buildGraph indexes aliases', () => {
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', PROJ],
    task('task-old', 'old-name'),
  ])).load();
  const p = g.nodes['repo-x'];
  assert.deepEqual(p.slugs, ['old-name', 'new-name']);
  assert.deepEqual(p.fingerprints, ['remote:github.com/org/x', 'root:abc123']);
  assert.deepEqual(g.projectAliases, { 'repo-x': 'repo-x', 'old-name': 'repo-x', 'new-name': 'repo-x' });
  assert.equal(graph.resolveProject(g, 'old-name'), 'repo-x');
  assert.equal(graph.resolveProject(g, 'new-name'), 'repo-x');
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
    ['repo-x.md', PROJ],
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
    task('task-other', 'elsewhere'),
  ])).load();
  for (const filter of ['new-name', 'old-name', 'repo-x']) {
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
    ['repo-x.md', PROJ],
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
  ])).load();
  const viewer = { queue_mute: ['old-name'] };
  const r = rankQueue(g, { now: NOW, viewer });
  assert.deepEqual(r.items, []);
  assert.equal(r.muted, 2);
});

// ---------- archived projects (issue-cc-project-lifecycle-queue-pollution) ----------

const ARCHIVED_PROJ = PROJ.replace('date: 2026-06-12\n', 'status: archived\ndate: 2026-06-12\n');

test('rankQueue: an archived project drops its items from the global queue for every viewer (counted, not silent)', () => {
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', ARCHIVED_PROJ],
    task('task-old', 'old-name'),    // archived via the old alias
    task('task-new', 'new-name'),    // archived via the current alias
    task('task-live', 'elsewhere'),  // live, unrelated project
  ])).load();
  assert.ok(graph.isArchivedProject(g, 'old-name'));
  assert.ok(graph.isArchivedProject(g, 'repo-x'));
  assert.ok(!graph.isArchivedProject(g, 'elsewhere'));
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), ['task-live']);
  assert.equal(r.archived, 2); // both archived-project items hidden, and reported
});

test('rankQueue: explicitly scoping to the archived project still ranks it (archival hides from the firehose, not from a direct look)', () => {
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', ARCHIVED_PROJ],
    task('task-old', 'old-name'),
    task('task-new', 'new-name'),
  ])).load();
  for (const filter of ['old-name', 'new-name', 'repo-x']) {
    const r = rankQueue(g, { now: NOW, project: filter });
    assert.deepEqual(r.items.map((i) => i.id).sort(), ['task-new', 'task-old'], `filter ${filter}`);
    assert.equal(r.archived, undefined, `filter ${filter}: nothing hidden when viewing the project itself`);
  }
});

test('rankQueue: a live (non-archived) project status behaves byte-for-byte as before', () => {
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', PROJ], // no status
    task('task-old', 'old-name'),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), ['task-old']);
  assert.equal(r.archived, undefined);
  assert.equal(g.archivedProjects.size, 0);
});

// ---------- validator ----------

test('validateGraph: warns on contested and non-kebab slugs', () => {
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', PROJ],
    ['repo-y.md', PROJ.replace(/repo-x/g, 'repo-y').replace('slugs: [old-name, new-name]', 'slugs: [old-name, Bad_Slug]')],
  ]));
  const r = graph.validateGraph(g.nodesDir);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("slug 'old-name' is claimed by both 'repo-x' and 'repo-y'")), r.warnings.join('; '));
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

// slugify is the ONE normalization projectSlug applies to a basename, exported so
// an explicit `spor add --project` gets the same canonical form
// (issue-spor-local-add-ask-project-normalization-edge-validation).
test('slugify: canonicalizes to the server SLUG_RE form; empty when no alphanumerics', () => {
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  assert.equal(u.slugify('My_Repo'), 'my-repo');
  assert.equal(u.slugify('MyProject.AppHost'), 'myproject-apphost');
  assert.equal(u.slugify('already-kebab'), 'already-kebab'); // identity for canonical input
  assert.equal(u.slugify('  spaced out  '), 'spaced-out');
  assert.equal(u.slugify('***'), ''); // no slug characters -> empty (caller rejects)
  assert.equal(u.slugify(null), '');
  for (const s of ['My_Repo', 'MyProject.AppHost', 'a/b/c', 'Weird.Slug']) {
    assert.match(u.slugify(s), SLUG_RE, `slugify(${s}) is canonical`);
  }
});

// ---------- project-grouping union reads (task-cc-project-grouping-union-reads) ----------

const repoNode = (id, slug, grouping) => [`${id}.md`,
  `---\nid: ${id}\ntype: repo\ntitle: ${id}\nsummary: Repo ${slug}.\nslugs: [${slug}]\ndate: 2026-06-01\nedges:\n  - {type: grouped-under, to: ${grouping}}\n---\nbody`];
const groupingNode = (id) => [`${id}.md`,
  `---\nid: ${id}\ntype: project\ntitle: ${id}\nsummary: Grouping ${id}.\ndate: 2026-06-01\n---\nbody`];

test('buildGraph: grouped-under edges index a grouping to its member repos', () => {
  const g = tmpGraph(Object.fromEntries([
    groupingNode('proj-g'),
    repoNode('repo-a', 'a', 'proj-g'),
    repoNode('repo-b', 'b', 'proj-g'),
    repoNode('repo-solo', 'solo', 'proj-other'),
  ])).load();
  assert.deepEqual([...g.groupingRepos['proj-g']].sort(), ['repo-a', 'repo-b']);
  assert.deepEqual([...g.groupingRepos['proj-other']], ['repo-solo']);
});

// ungrouped repo node (no grouped-under edge), unlike the repoNode helper
const repoSolo = ['repo-solo.md',
  `---\nid: repo-solo\ntype: repo\ntitle: repo-solo\nsummary: Solo repo.\nslugs: [solo]\ndate: 2026-06-01\n---\nbody`];

test('rankQueue: a bare repo slug resolves UP to its grouping; the repo node id pins one repo (dec-spor-queue-slug-resolves-to-grouping)', () => {
  const g = tmpGraph(Object.fromEntries([
    groupingNode('proj-g'),
    repoNode('repo-a', 'a', 'proj-g'),
    repoNode('repo-b', 'b', 'proj-g'),
    repoSolo,                  // ungrouped repo (slug 'solo')
    task('task-a', 'a'),       // stamped a -> repo-a
    task('task-b', 'b'),       // stamped b -> repo-b
    task('task-solo', 'solo'),
    task('task-out', 'elsewhere'),
  ])).load();
  const ids = (project) => rankQueue(g, { now: NOW, project }).items.map((i) => i.id).sort();
  // a grouping id unions its member repos
  assert.deepEqual(ids('proj-g'), ['task-a', 'task-b']);
  // a BARE repo slug now resolves up to its home grouping and unions too —
  // either member slug returns the whole product
  assert.deepEqual(ids('a'), ['task-a', 'task-b']);
  assert.deepEqual(ids('b'), ['task-a', 'task-b']);
  // the repo NODE id is the escape hatch back to single-repo scope
  assert.deepEqual(ids('repo-a'), ['task-a']);
  assert.deepEqual(ids('repo-b'), ['task-b']);
  // an ungrouped repo (by slug or by id) falls back to itself
  assert.deepEqual(ids('solo'), ['task-solo']);
  assert.deepEqual(ids('repo-solo'), ['task-solo']);
  // an unknown slug stays exact (no repo node, no grouping)
  assert.deepEqual(ids('elsewhere'), ['task-out']);
});

test('groupingOf: a member repo and the grouping id both resolve to the grouping; ungrouped -> null (task-cc-grouping-brief-digest-reads)', () => {
  const g = tmpGraph(Object.fromEntries([
    groupingNode('proj-g'),
    repoNode('repo-a', 'a', 'proj-g'),
    repoNode('repo-b', 'b', 'proj-g'),
    repoSolo,
  ])).load();
  assert.equal(graph.groupingOf(g, 'repo-a'), 'proj-g'); // member repo -> its grouping
  assert.equal(graph.groupingOf(g, 'repo-b'), 'proj-g');
  assert.equal(graph.groupingOf(g, 'proj-g'), 'proj-g'); // grouping id maps to itself
  assert.equal(graph.groupingOf(g, 'repo-solo'), null);  // ungrouped repo
  assert.equal(graph.groupingOf(g, 'nonexistent'), null);
});

test('scopeFor: the shared slug->grouping up-resolution every read surface uses (dec-spor-queue-slug-resolves-to-grouping)', () => {
  const g = tmpGraph(Object.fromEntries([
    groupingNode('proj-g'),
    repoNode('repo-a', 'a', 'proj-g'),
    repoNode('repo-b', 'b', 'proj-g'),
    repoSolo,
  ])).load();
  const set = (p) => { const s = graph.scopeFor(g, p); return s == null ? null : [...s].sort(); };
  assert.equal(graph.scopeFor(g, null), null);   // no param -> unscoped (global)
  assert.equal(graph.scopeFor(g, ''), null);
  assert.deepEqual(set('proj-g'), ['repo-a', 'repo-b']);     // grouping id -> union
  assert.deepEqual(set('a'), ['repo-a', 'repo-b']);          // bare slug -> up to grouping
  assert.deepEqual(set('b'), ['repo-a', 'repo-b']);
  assert.deepEqual(set('repo-a'), ['repo-a']);               // repo NODE id -> single (escape hatch)
  assert.deepEqual(set('repo-b'), ['repo-b']);
  assert.deepEqual(set('solo'), ['repo-solo']);              // ungrouped repo, by slug...
  assert.deepEqual(set('repo-solo'), ['repo-solo']);         // ...or by id -> itself
  assert.deepEqual(set('nope'), ['nope']);                   // unknown slug -> itself
});

test('compile boost spans the grouping: a sibling-repo node outranks an equally-relevant foreign one (task-cc-grouping-brief-digest-reads)', () => {
  const g = tmpGraph(Object.fromEntries([
    groupingNode('proj-g'),
    repoNode('repo-a', 'a', 'proj-g'),
    repoNode('repo-b', 'b', 'proj-g'),
    repoSolo,
    task('task-sibling', 'b', ''),   // grouped with the session repo 'a'
    task('task-foreign', 'solo', ''),
  ])).load();
  // Session in repo 'a' (a member of proj-g): the sibling-repo node shares the
  // grouping so it is boosted (same-project) while the foreign one is not.
  const r = graph.compile(g, { query: 'Standalone summary task', digest: true, project: 'a' });
  assert.ok(r.relevant, 'query is relevant');
  const sib = r.text.indexOf('task-sibling');
  const frn = r.text.indexOf('task-foreign');
  assert.ok(sib !== -1, 'sibling-repo node surfaces');
  assert.ok(frn === -1 || sib < frn, `sibling should outrank foreign: sib=${sib} frn=${frn}`);
});

// ---------- stamp field: repo: with legacy project: (task-cc-repo-stamp-field-rename) ----------

test('parseFrontmatter: repo: stamp populates n.project; legacy project: still read; repo: wins', () => {
  const mk = (fm) => graph.parseFrontmatter(`---\nid: x\ntype: task\n${fm}\n---\nbody`, 'x.md');
  assert.equal(mk('repo: spor').project, 'spor');         // new stamp
  assert.equal(mk('project: spor').project, 'spor');      // legacy stamp
  assert.equal(mk('repo: spor\nproject: old').project, 'spor'); // repo: wins on both
});

test('rankQueue: a repo:-stamped node resolves through the same aliases as project:', () => {
  const repoTask = ['task-repo-stamped.md', `---\nid: task-repo-stamped\ntype: task\nrepo: old-name\ntitle: T\nsummary: A repo-stamped task.\nstatus: open\ndate: 2026-06-01\n---\nbody`];
  const g = tmpGraph(Object.fromEntries([
    ['repo-x.md', PROJ],
    repoTask,
    task('task-proj-stamped', 'new-name'),
  ])).load();
  // filtering by any alias of repo-x surfaces both the repo:- and project:-stamped tasks
  const ids = rankQueue(g, { now: NOW, project: 'repo-x' }).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['task-proj-stamped', 'task-repo-stamped']);
});

// ---------- two-layer marker: repo: identity + project: grouping ----------
// (dec-cc-repo-project-two-layer-identity, dec-cc-active-project-declared-default)

test('marker: repo: names the identity; legacy project: still read as the repo slug; repo: wins', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-marker2-'));
  // New format: repo: is the identity.
  fs.writeFileSync(path.join(cwd, '.spor'), 'repo: my-repo\nproject: my-product\n');
  assert.equal(u.projectSlug(cwd), 'my-repo');
  assert.equal(u.projectGrouping(cwd), 'my-product');
  // repo: wins over a stray project: for identity.
  fs.writeFileSync(path.join(cwd, '.spor'), 'project: legacy-id\nrepo: real-repo\n');
  assert.equal(u.projectSlug(cwd), 'real-repo');
  assert.equal(u.projectGrouping(cwd), 'legacy-id');
  // Legacy format (no repo:): project: is the repo slug, NOT a grouping.
  fs.writeFileSync(path.join(cwd, '.spor'), 'project: legacy-repo\n');
  assert.equal(u.projectSlug(cwd), 'legacy-repo');
  assert.equal(u.projectGrouping(cwd), null);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('projectGrouping: a nearest-ancestor subtree marker beats the repo root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-grp-'));
  const repo = path.join(base, 'mono');
  const sub = path.join(repo, 'services', 'api');
  fs.mkdirSync(sub, { recursive: true });
  gitInit(repo);
  // No declaration anywhere -> null (caller falls back to the repo's home project).
  assert.equal(u.projectGrouping(sub), null);
  // Root declares platform; subtree overrides to its own grouping.
  fs.writeFileSync(path.join(repo, '.spor'), 'repo: mono\nproject: platform\n');
  fs.writeFileSync(path.join(sub, '.spor'), 'repo: mono\nproject: payments\n');
  assert.equal(u.projectGrouping(repo), 'platform');
  assert.equal(u.projectGrouping(sub), 'payments');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------- monorepo subtrees + git worktrees (issue-cc-project-identity-monorepo-worktree) ----------

function gitInit(dir) {
  const g = (args, cwd = dir) => {
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
  return g;
}

test('projectSlug: a nearest-ancestor .spor marker in a monorepo subtree beats the repo root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-mono-'));
  const repo = path.join(base, 'My_Monorepo');
  fs.mkdirSync(repo);
  const g = gitInit(repo);
  const sub = path.join(repo, 'services', 'api');
  fs.mkdirSync(sub, { recursive: true });

  // No marker anywhere: subtree infers the repo-root basename, not the subdir.
  assert.equal(u.projectSlug(sub), 'my-monorepo');

  // Subtree marker beats inference and does NOT leak up to the repo root.
  fs.writeFileSync(path.join(sub, '.spor'), 'project: my-api\n');
  assert.equal(u.projectSlug(sub), 'my-api');
  assert.equal(u.projectSlug(repo), 'my-monorepo');

  // A root marker still works, and the nearer subtree marker still wins.
  fs.writeFileSync(path.join(repo, '.spor'), 'project: mono-root\n');
  assert.equal(u.projectSlug(repo), 'mono-root');
  assert.equal(u.projectSlug(sub), 'my-api');

  fs.rmSync(base, { recursive: true, force: true });
});

test('projectSlug: a linked git worktree resolves to its main repo, not the worktree basename', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-wt-'));
  const repo = path.join(base, 'my-service');
  fs.mkdirSync(repo);
  const g = gitInit(repo);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  g(['add', 'f.txt']);
  g(['commit', '-q', '-m', 'root']);

  const wt = path.join(base, 'overnight-checkout-xyz');
  g(['worktree', 'add', '-q', wt, 'HEAD']);

  // The bogus worktree basename must NOT become the slug — that mints a
  // wrong identity and (sharing the main repo's fingerprints) files false
  // rename evidence. It collapses onto the main repo's slug instead.
  assert.equal(u.projectSlug(wt), 'my-service');
  // A subdir inside the worktree resolves the same.
  const wtsub = path.join(wt, 'services', 'api');
  fs.mkdirSync(wtsub, { recursive: true });
  assert.equal(u.projectSlug(wtsub), 'my-service');

  // A committed root marker is honored from inside the worktree too.
  fs.writeFileSync(path.join(repo, '.spor'), 'project: durable-id\n');
  g(['add', '.spor']);
  g(['commit', '-q', '-m', 'marker']);
  g(['worktree', 'remove', '--force', wt]);
  g(['worktree', 'add', '-q', wt, 'HEAD']);
  assert.equal(u.projectSlug(wt), 'durable-id');

  g(['worktree', 'remove', '--force', wt]);
  fs.rmSync(base, { recursive: true, force: true });
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
  // Opt these scratch repos in (task-spor-plugin-opt-in-default): the identity
  // tests assert slug/repo-node behavior, which only runs when the hook is active.
  env.SPOR_ENABLED = '1';
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
  fs.writeFileSync(path.join(home, 'nodes', 'repo-x.md'), PROJ);
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
  assert.match(ctx, /\(2 tagged repo: new-name\)/);
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
  assert.match(ctx, /\(0 tagged repo: new-name\)/);
  assert.ok(!ctx.includes('Standing project briefing'), 'alias brief must not leak without a project node');
});

test('session-start local: an archived project is announced, not briefed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-ss-arch-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'new-name'); // slug new-name -> repo-x (archived)
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'nodes', 'repo-x.md'), ARCHIVED_PROJ);
  fs.writeFileSync(path.join(home, 'nodes', 'brief-old-name.md'), OLD_BRIEF);
  fs.writeFileSync(path.join(home, 'nodes', 'task-old.md'), task('task-old', 'old-name')[1]);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /repo-x \(new-name\) is ARCHIVED/);
  assert.ok(!ctx.includes('Standing project briefing'), 'archived project must not inject a stale brief');
  assert.ok(!ctx.includes('next up:'), 'archived project has no live front to surface');
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
