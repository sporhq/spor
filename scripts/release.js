#!/usr/bin/env node
'use strict';

// Cut a @sporhq/spor release: bump the version in lockstep across every
// manifest, commit "Release vX.Y.Z", tag it, push, and (with gh) publish a
// GitHub release. Pushing the tag is what triggers the OIDC npm publish in
// .github/workflows/publish.yaml — which re-runs the tests and hard-fails if
// the tag and the manifests disagree, so this script keeps all five version
// strings (package.json, package-lock.json ×2, .claude-plugin/plugin.json,
// .codex-plugin/plugin.json) in lockstep by construction.
//
// Usage:
//   node scripts/release.js [patch|minor|major|X.Y.Z] [flags]
//     (default bump: patch)
//   Flags:
//     -y, --yes        skip the confirmation prompt before the push
//     --dry-run        print the plan, change nothing
//     --no-push        commit + tag locally, then stop (print push commands)
//     --no-release     skip creating the GitHub release
//     --skip-tests     don't run `npm test` locally before releasing
//
// Zero-dependency, plain Node + git/gh binaries — runs anywhere the plugin does.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');

// The five version strings that MUST move together (publish.yaml enforces it).
const MANIFESTS = [
  { file: 'package.json', count: 1 },
  { file: '.claude-plugin/plugin.json', count: 1 },
  { file: '.codex-plugin/plugin.json', count: 1 },
  // package-lock carries the version at the root and again under packages[""].
  { file: 'package-lock.json', count: 2 },
];

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}
function info(msg) { console.log(msg); }
function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }

// Run a command, streaming output; return trimmed stdout when captured.
function run(cmd, args, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (res.error) {
    if (allowFail) return null;
    die(`failed to run ${cmd}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    if (allowFail) return null;
    if (capture && res.stderr) process.stderr.write(res.stderr);
    die(`\`${cmd} ${args.join(' ')}\` exited ${res.status}`);
  }
  return capture ? (res.stdout || '').trim() : '';
}

function git(args, opts) { return run('git', args, opts); }
function have(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0;
}

function parseArgs(argv) {
  const flags = { yes: false, dryRun: false, push: true, release: true, tests: true };
  let bump = 'patch';
  for (const a of argv) {
    switch (a) {
      case '-y': case '--yes': flags.yes = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--no-push': flags.push = false; break;
      case '--no-release': flags.release = false; break;
      case '--skip-tests': flags.tests = false; break;
      default:
        if (a.startsWith('-')) die(`unknown flag: ${a}`);
        bump = a;
    }
  }
  return { bump, flags };
}

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump; // explicit version
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) die(`current version is not X.Y.Z: ${current}`);
  let [maj, min, pat] = m.slice(1).map(Number);
  if (bump === 'major') { maj++; min = 0; pat = 0; }
  else if (bump === 'minor') { min++; pat = 0; }
  else if (bump === 'patch') { pat++; }
  else die(`bump must be patch|minor|major|X.Y.Z, got: ${bump}`);
  return `${maj}.${min}.${pat}`;
}

// Byte-minimal edit: replace the exact `"version": "<old>"` strings in place,
// asserting the expected occurrence count so a surprise (e.g. a dep pinned to
// the same string, or a manifest already bumped) fails loud instead of silent.
function bumpFile(rel, oldV, newV, expected) {
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const needle = `"version": "${oldV}"`;
  const found = text.split(needle).length - 1;
  if (found !== expected) {
    die(`${rel}: expected ${expected} occurrence(s) of ${needle}, found ${found}`);
  }
  fs.writeFileSync(abs, text.split(needle).join(`"version": "${newV}"`));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const { bump, flags } = parseArgs(process.argv.slice(2));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const current = pkg.version;
  const next = nextVersion(current, bump);
  const tag = `v${next}`;

  if (next === current) die(`next version equals current (${current}) — nothing to do`);

  info(`\nRelease \x1b[1m${pkg.name}\x1b[0m: ${current} → \x1b[1m${next}\x1b[0m  (tag ${tag})\n`);

  // ---- Preflight -----------------------------------------------------------
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (branch !== 'main') die(`must be on main, on ${branch}`);

  // Only TRACKED changes matter — the release commit stages just the
  // manifests, so untracked local dirs (.claude/, tooling caches) are fine.
  if (git(['status', '--porcelain', '--untracked-files=no'], { capture: true })) {
    die('tracked files are modified — the release commit must be version-only. Commit or stash first.');
  }

  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { capture: true, allowFail: true })) {
    die(`tag ${tag} already exists`);
  }

  info('Fetching origin…');
  git(['fetch', 'origin', '--quiet']);
  const counts = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], { capture: true });
  const [behind] = counts.split(/\s+/).map(Number);
  if (behind > 0) die(`local main is ${behind} commit(s) behind origin/main — pull first`);
  ok(`preflight passed (branch=main, tree clean, ${tag} free, in sync with origin)`);

  // Commits that will ship, for the changelog / confirmation.
  const lastTag = git(['describe', '--tags', '--abbrev=0'], { capture: true, allowFail: true });
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const log = git(['log', '--no-merges', '--pretty=format:- %s', range], { capture: true });
  if (log) info(`\nCommits since ${lastTag || 'start'}:\n${log}\n`);

  if (flags.dryRun) {
    info('\x1b[33m--dry-run: no changes made.\x1b[0m');
    info(`Would bump ${MANIFESTS.map((m) => m.file).join(', ')}, commit "Release ${tag}", tag ${tag}` +
      (flags.push ? ', push main + tag (triggers npm publish)' : '') +
      (flags.release ? ', and create the GitHub release.' : '.'));
    return;
  }

  // ---- Tests ---------------------------------------------------------------
  if (flags.tests) {
    info('\nRunning test suite (--skip-tests to bypass)…');
    run('npm', ['test']);
    ok('tests passed');
  }

  // ---- Confirm the irreversible step --------------------------------------
  if (flags.push && !flags.yes) {
    const a = (await ask(`\nProceed to bump, commit, tag, and \x1b[1mpush ${tag}\x1b[0m (this publishes to npm)? [y/N] `)).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') die('aborted');
  }

  // ---- Bump ----------------------------------------------------------------
  for (const m of MANIFESTS) bumpFile(m.file, current, next, m.count);
  // Sanity: every manifest must now be re-parseable and carry the new version.
  for (const m of MANIFESTS) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, m.file), 'utf8'));
    if (j.version !== next) die(`${m.file}: version did not update to ${next}`);
  }
  ok(`bumped ${MANIFESTS.length} manifests to ${next}`);

  // ---- Commit + tag --------------------------------------------------------
  git(['add', ...MANIFESTS.map((m) => m.file)]);
  git(['commit', '-m', `Release ${tag}`, '-m', 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>']);
  git(['tag', tag]);
  ok(`committed and tagged ${tag}`);

  if (!flags.push) {
    info(`\nLocal release ready. To publish:\n  git push origin main && git push origin ${tag}`);
    return;
  }

  // ---- Push (triggers the OIDC npm publish workflow) -----------------------
  git(['push', 'origin', 'main']);
  git(['push', 'origin', tag]);
  ok(`pushed main + ${tag} — the publish workflow is now building`);

  // ---- GitHub release ------------------------------------------------------
  if (!flags.release) return;
  if (!have('gh')) {
    info('\n`gh` not found — create the GitHub release manually:');
    info(`  gh release create ${tag} --title "${tag}" --generate-notes`);
    return;
  }

  const compare = lastTag
    ? `\n\n**Full Changelog**: https://github.com/sporhq/spor/compare/${lastTag}...${tag}`
    : '';
  const notes = `${log || 'Release.'}${compare}\n`;
  run('gh', ['release', 'create', tag, '--title', tag, '--notes', notes]);
  ok(`GitHub release ${tag} created`);
  info('\nDone. Watch the publish run:  gh run watch --workflow=publish.yaml');
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
