#!/usr/bin/env node
'use strict';

// heal-stale-root.js — the orchestrator's root-reset guard
// (task-spor-orchestrator-merge-gate-stale-index-heal).
//
// THE PROBLEM: after the orchestrator lands a branch with a CAS
// `git update-ref refs/heads/main <new> <old>`, the shared root checkout's REF
// has moved but its index and working tree still hold the OLD commit's content.
// `git status` then reports every merged file as modified — a shape
// indistinguishable, by status alone, from a parallel job's uncommitted WIP. The
// norm (norm-spor-orchestrator-cas-merge) says to `git reset --hard main` after
// each merge, but only when the root is otherwise clean, so this false WIP makes
// the guard bail: the root stays behind main (ROOT-UNSYNCED) until a human looks.
// Three incidents came out of that unsynced root — a hand-commit from it stages
// the stale blobs verbatim and silently reverts merged work
// (inc-spor-npm-release-stale-index-revert-4801b52,
// inc-spor-triple-checkout-stale-revert-075adb2,
// inc-spor-orchestrator-stale-root-revert-26c9ef9).
//
// THE FINGERPRINT: stale content is content that is BEHIND, never novel. A path
// left over from a CAS advance holds, byte-for-byte, the blob it held at a
// recent ancestor of HEAD — that is what "the ref moved, the files didn't" means.
// Genuine WIP is an edit nobody has committed, so it essentially never
// reproduces an exact older version of the same file. So each tracked-modified
// path is classified by content identity, not by status letters:
//
//   STALE  every side that differs from HEAD (the index blob AND the working-tree
//          content) is byte-identical to that path's blob at some first-parent
//          ancestor of HEAD within the lookback window. Nothing on disk is novel,
//          so `git checkout HEAD -- <path>` discards nothing that isn't already
//          committed — the surgical heal.
//   WIP    anything else. Refused, untouched, reported.
//
// This is the working-tree twin of spor-server's commit-time
// scripts/check-stale-tree-revert.js (dec-spor-stale-tree-revert-commit-guard),
// which flags the same byte-identical-rewind signature once it has already been
// committed. Both err the same way: toward missing a stale path, never toward
// touching a live one. A missed stale path costs a manual sync; a wrongly-healed
// path is unrecoverable work.
//
// THE ASYMMETRY drives every judgment call below. Refusing to heal is cheap (the
// caller falls back to today's behavior: verify in a detached worktree, report
// ROOT-UNSYNCED). Healing wrongly destroys work that exists nowhere else. Hence:
// a staged ADD of a path absent at HEAD is never healed (the heal would be a
// delete, the one irreversible direction); renames, copies, typechanges and
// unmerged paths are WIP by construction; content that is merely empty is not
// evidence of a rewind (any truncation would otherwise look stale); and a probe
// that FAILS never reads as an answer — not "the file is gone", not "nothing is
// modified", not "no merge in progress". Every unknown lands on WIP or exit 2.
//
// A COROLLARY worth stating, because it is not obvious: if git calls a path
// modified while every blob matches HEAD, the difference is one content identity
// cannot see — an exec bit, a symlink swapped for a file. Such a path is
// uncommitted BY DEFINITION and is refused, even though it looks like "already at
// HEAD, nothing to lose".
//
// KNOWN RESIDUALS (documented, accepted):
//   - A file mixing stale content WITH a genuine edit hashes to neither the old
//     nor the new blob, so it reads as WIP and blocks the sync. Correct, and the
//     conservative direction.
//   - A path whose stale content predates the lookback window reads as WIP.
//     Raising --lookback only strengthens detection; it can never cause a false
//     heal (matching an older ancestor is still matching a committed blob).
//   - A merge that changed only a file's MODE leaves a stale path every blob
//     agrees on, so it is refused per the corollary above: a missed heal.
//   - A deliberate but uncommitted revert or `rm` of a file whose content still
//     lives at HEAD is byte-identical to a stale path, and is healed (i.e. put
//     back). Indistinguishable from the evidence — the same call a human makes by
//     eye — and it restores committed content rather than destroying new work.
//   - Nothing locks the tree, so a job writing to a path between this run's
//     classification and its checkout could still lose that write. The window is
//     re-probed shut immediately before the checkout (see recheck), not closed.
//
// Usage:
//   node scripts/heal-stale-root.js [--repo <dir>] [--lookback N] [--apply] [--json]
//     --repo <dir>   the checkout to guard (default: cwd)
//     --apply        heal the STALE paths; without it this is a dry run
//     --lookback N   ancestors of HEAD to scan (default 300, first-parent)
//     --json         machine-readable verdict on stdout
// Exit 0 = the root matches HEAD: IN-SYNC (nothing was modified) or HEALED (every
//          modification was stale and has been checked out). The caller may
//          `git reset --hard main`; after --apply the heal has already done it.
// Exit 1 = the root does NOT match HEAD. Verdict STALE means a dry run found only
//          healable staleness (re-run with --apply); ROOT-UNSYNCED means genuine
//          WIP is present — do NOT reset the root, verify the merge in a throwaway
//          detached worktree instead (norm-spor-orchestrator-cas-merge).
// Exit 2 = bad invocation / not a git repo / mid-merge or mid-rebase.
//
// WIRING — NOT DONE YET, AND DELIBERATELY SO. The consumer is the orchestrator's
// post-merge root sync (norm-spor-orchestrator-cas-merge), which lives in the
// spor-orchestrator SKILL at ~/.claude/skills/spor-orchestrator — a personal skill
// under no version control, so its call site cannot ride this branch or any
// review. Until someone adds it there, the next CAS merge still leaves the root
// unsynced by hand. The step is one command, replacing "reset --hard main if the
// root looks clean":
//
//     node scripts/heal-stale-root.js --repo <shared root> --apply || \
//       echo "ROOT-UNSYNCED: real WIP present — verify in a detached worktree"
//
// Exit 0 means the root already matches main. Exit 1 means leave it alone and
// fall back to today's detached-worktree verification; the report names the paths
// and why. Nothing else in the repo calls this, by design: it is an ops tool run
// from a checkout, so it stays out of package.json's `files` alongside release.js.
//
// Zero-dependency, plain Node + the git binary — runs anywhere the plugin does.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The git blob of an empty file. Empty content is weak evidence: a truncated
// working file would match any ancestor that happened to hold an empty file, so
// it is never counted as a rewind. Mirrors the same guard in spor-server's
// check-stale-tree-revert.js.
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const ABSENT = null; // no entry for a path in a given tree / index / working tree

// "Something is there, but we could not read what": an unreadable file, a
// directory where a file belongs, a probe that failed. Distinct from ABSENT,
// which is positive knowledge that a path is gone — conflating the two would let
// a failed probe match an ancestor that predates the path and heal a file that is
// sitting right there with live content in it. UNKNOWN matches nothing, ever.
const UNKNOWN = Symbol('unknown');

function usage(msg) {
  if (msg) process.stderr.write(`heal-stale-root: ${msg}\n`);
  process.stderr.write(
    'usage: node scripts/heal-stale-root.js [--repo <dir>] [--lookback N] [--apply] [--json]\n'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { repo: process.cwd(), lookback: 300, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) usage('--repo needs a directory');
    } else if (a === '--lookback') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) usage('--lookback needs a positive integer');
      opts.lookback = n;
    } else usage(`unknown argument: ${a}`);
  }
  return opts;
}

// ---------- git ----------

// Returns stdout, or null when git exits non-zero (every caller treats a failed
// probe as "no information", which classifies as WIP — the safe direction).
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    process.stderr.write(`heal-stale-root: cannot run git: ${r.error.message}\n`);
    process.exit(2);
  }
  return r.status === 0 ? r.stdout : null;
}

// As git(), but feeds stdin — used to hash a symlink's target string as git does.
function gitIn(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input });
  if (r.error) {
    process.stderr.write(`heal-stale-root: cannot run git: ${r.error.message}\n`);
    process.exit(2);
  }
  return r.status === 0 ? r.stdout : null;
}

const splitZ = (out) => (out ? out.split('\0').filter((s) => s !== '') : []);

// git status prints literal filenames, but every command we hand them back to
// reads them as PATHSPECS. A name like `:x` parses as pathspec magic and errors
// out; a name like `a*.js` or `a?.js` is a wildcard that also matches its
// neighbours (`git ls-files -- 'a*.js'` returns ab.js too). `:(literal)` says
// what we mean.
//
// Today the wildcard cannot actually mis-heal: every path here comes from git
// status, so a tree entry of exactly that name always exists, and git then
// matches it literally rather than globbing (checked on git 2.43 — the glob only
// takes over when nothing matches the name exactly). That is luck, not a
// guarantee we should hold a data-loss tool up with.
const spec = (p) => `:(literal)${p}`;

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// A merge/rebase/cherry-pick/bisect in progress means the modifications on disk
// are mid-operation state, not a stale ref advance. Nothing here is safe then.
// A probe that cannot answer returns 'unknown' rather than "no operation": the
// same failed-probe-reads-as-absence trap the classifier guards against, and just
// as destructive here — it would hand a mid-merge tree to the checkout.
function inProgressOp(repo) {
  const marker = (name) => {
    const p = git(repo, ['rev-parse', '--git-path', name]);
    if (p === null) return 'unknown';
    return fs.existsSync(path.resolve(repo, p.trim()));
  };
  const named = { MERGE_HEAD: 'merge', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase',
    CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', BISECT_LOG: 'bisect' };
  for (const [file, op] of Object.entries(named)) {
    const m = marker(file);
    if (m === 'unknown') return `git operation (could not read ${file})`;
    if (m) return op;
  }
  return null;
}

// `git status --porcelain=v1 -z -uno` records are NUL-terminated `XY <path>`.
// A rename/copy record is followed by a SECOND NUL-terminated field (its source
// path), so the stream must be walked sequentially rather than split — and the
// rename letter can sit in EITHER column: git detects worktree-side renames too
// (`git add -N` then move gives " R new\0old\0"). Testing only xy[0] desyncs the
// walk, so the source path gets parsed as the next status record and the tool
// reports a path that does not exist.
function trackedModified(repo) {
  const out = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (out === null) return null;
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec === '') continue;
    const xy = rec.slice(0, 2);
    if ('RC'.includes(xy[0]) || 'RC'.includes(xy[1])) i++; // consume the source-path field
    entries.push({ path: rec.slice(3), xy });
  }
  return entries;
}

// The paths git holds at a non-zero stage: an unresolved conflict. `git stash
// apply` and `git apply --3way` leave these with NO MERGE_HEAD, so inProgressOp
// does not see them, and their status letters are not always U (an add/add
// conflict reads AA). ls-files -u is the direct question, so ask it rather than
// inferring from letters.
function unmergedPaths(repo, paths) {
  const set = new Set();
  for (const chunk of chunks(paths, 200)) {
    const out = git(repo, ['ls-files', '-u', '-z', '--', ...chunk.map(spec)]);
    if (out === null) return null;
    for (const rec of splitZ(out)) {
      const tab = rec.indexOf('\t');
      if (tab >= 0) set.add(rec.slice(tab + 1));
    }
  }
  return set;
}

// path -> blob sha at `commit`, restricted to `paths`. A submodule or subtree
// entry is left out: never matchable, so it reads as WIP and blocks the sync
// rather than being healed blind.
// Returns null if any probe fails: a half-populated map is worse than none, since
// a path missing from it reads as ABSENT — positive knowledge we do not have.
function treeBlobs(repo, commit, paths) {
  const map = new Map();
  for (const chunk of chunks(paths, 200)) {
    const out = git(repo, ['ls-tree', '-z', '--full-name', commit, '--', ...chunk.map(spec)]);
    if (out === null) return null;
    for (const rec of splitZ(out)) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [, type, sha] = rec.slice(0, tab).split(/\s+/);
      if (type === 'blob') map.set(rec.slice(tab + 1), sha);
    }
  }
  return map;
}

// path -> index blob sha. A path at a non-zero stage (unmerged) is skipped, so it
// reads as ABSENT and is refused by the classifier.
function indexBlobs(repo, paths) {
  const map = new Map();
  for (const chunk of chunks(paths, 200)) {
    const out = git(repo, ['ls-files', '-s', '-z', '--', ...chunk.map(spec)]);
    if (out === null) return null; // as in treeBlobs: no map beats a partial one
    for (const rec of splitZ(out)) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [, sha, stage] = rec.slice(0, tab).split(/\s+/);
      if (stage === '0') map.set(rec.slice(tab + 1), sha);
    }
  }
  return map;
}

// The working tree's content hash for a path, as git itself would record it
// (--path makes the .gitattributes clean filters apply, so the sha is comparable
// to a committed blob rather than to the raw bytes on disk).
function worktreeBlob(repo, p) {
  let st;
  try {
    st = fs.lstatSync(path.resolve(repo, p));
  } catch (e) {
    // ENOENT is the only error that proves the path is gone; anything else (a
    // permission error on a parent, say) leaves us ignorant, not informed.
    return e && e.code === 'ENOENT' ? ABSENT : UNKNOWN;
  }
  // git stores a symlink as a blob holding its TARGET PATH, so the committed blob
  // must be compared against the link itself. `hash-object <link>` follows the
  // link and hashes the target's CONTENT instead — a sha that can never match, so
  // every tracked symlink a merge touched would read as WIP and wedge the sync.
  if (st.isSymbolicLink()) {
    let target;
    try {
      target = fs.readlinkSync(path.resolve(repo, p));
    } catch {
      return UNKNOWN;
    }
    const out = gitIn(repo, ['hash-object', '--stdin'], target);
    return out === null ? UNKNOWN : out.trim();
  }
  if (!st.isFile()) return UNKNOWN; // a directory, a fifo, a socket…
  const out = git(repo, ['hash-object', '--path', p, '--', p]);
  return out === null ? UNKNOWN : out.trim(); // unreadable file: present, uninspectable
}

// ---------- classification ----------

// Is `value` safely discardable for this path — either it IS what HEAD holds
// (nothing to lose), or it is byte-identical to what some first-parent ancestor
// of HEAD holds (committed, therefore recoverable)? Returns the explaining
// ancestor sha, '' for "same as HEAD", or null for novel content.
function behindOrHead(value, head, p, ancestors) {
  if (value === UNKNOWN) return null; // present but uninspectable — never discardable
  if (value === head) return '';
  if (value === EMPTY_BLOB && head !== EMPTY_BLOB) return null;
  for (const anc of ancestors) {
    const at = anc.blobs.has(p) ? anc.blobs.get(p) : ABSENT;
    if (at === value) return anc.commit;
  }
  return null;
}

function classify(repo, entry, headBlobs, idxBlobs, unmerged, ancestors) {
  const { path: p, xy } = entry;

  // An unresolved conflict holds its other side ONLY in the index's higher
  // stages, which a checkout silently collapses away. Never the shape a stale ref
  // advance leaves behind.
  if (unmerged.has(p)) {
    return { verdict: 'wip', why: `the index holds an unresolved conflict (${xy})` };
  }
  // Renames, copies and typechanges are deliberate index/worktree state, and a
  // typechange (file <-> symlink) is a difference content identity cannot see.
  // Refuse without looking.
  if ('RCUT'.includes(xy[0]) || 'RCUT'.includes(xy[1])) {
    return { verdict: 'wip', why: `the index carries a rename/copy/typechange/unmerged entry (${xy})` };
  }

  const head = headBlobs.has(p) ? headBlobs.get(p) : ABSENT;
  if (head === ABSENT) {
    // Nothing at HEAD to heal TO: `git checkout HEAD -- <path>` cannot restore it,
    // and the only "heal" would be deleting it — the irreversible direction.
    return { verdict: 'wip', why: 'the path does not exist at HEAD (a staged add)' };
  }

  const idx = idxBlobs.has(p) ? idxBlobs.get(p) : ABSENT;
  const idxAt = behindOrHead(idx, head, p, ancestors);
  if (idxAt === null) {
    return { verdict: 'wip', why: 'the index holds content committed neither at HEAD nor in its recent ancestry' };
  }
  const cur = worktreeBlob(repo, p);
  const curAt = behindOrHead(cur, head, p, ancestors);
  if (curAt === null) {
    return { verdict: 'wip', why: 'the working tree holds content committed neither at HEAD nor in its recent ancestry' };
  }

  // git called this path modified, yet every blob matches HEAD's: whatever
  // differs is something content identity cannot see — an executable bit, a
  // typechange. It is therefore uncommitted BY DEFINITION, and a checkout would
  // revert it. Content evidence cannot vouch for a non-content difference.
  if (idxAt === '' && curAt === '') {
    return { verdict: 'wip', why: 'git reports it modified though every blob matches HEAD — the difference is mode or type, which no content match can vouch for' };
  }

  // Every side is either HEAD's own content or a committed older version of it:
  // nothing on disk is novel, so checking out HEAD discards nothing.
  const base = curAt || idxAt;
  return { verdict: 'stale', base, cur, idx, why: `content matches this path at ${base.slice(0, 7)}` };
}

// The newest ancestor that explains EVERY stale path. Not required to heal (each
// path stands on its own evidence); it is the evidence line a human reads — "the
// root is sitting at <sha>, N paths behind main".
function commonBase(stale, ancestry) {
  const bases = stale.map((s) => s.base).filter(Boolean);
  if (!bases.length) return null;
  for (const c of ancestry) if (bases.every((b) => b === c)) return c; // newest-first
  return null;
}

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const top = git(opts.repo, ['rev-parse', '--show-toplevel']);
  if (top === null) usage(`not a git repository: ${opts.repo}`);
  const repo = top.trim();

  const op = inProgressOp(repo);
  if (op) usage(`a ${op} is in progress — resolve it before syncing the root`);

  const headOut = git(repo, ['rev-parse', 'HEAD']);
  if (headOut === null) usage('no HEAD commit');
  const head = headOut.trim();

  // NOT `|| []`: a status probe that failed tells us nothing, and "nothing"
  // collapsed to "nothing modified" would report IN-SYNC/exit 0 — which licenses
  // the caller to `git reset --hard main` over whatever is actually there. This is
  // the single most load-bearing probe in the tool; it must fail like the rest.
  const entries = trackedModified(repo);
  if (entries === null) usage('cannot read git status — refusing to classify');
  if (entries.length === 0) {
    report(opts, { verdict: 'IN-SYNC', head, base: null, stale: [], wip: [], healed: [] }, 0);
  }

  const paths = entries.map((e) => e.path);
  const headBlobs = treeBlobs(repo, head, paths);
  const idxBlobs = indexBlobs(repo, paths);
  const unmerged = unmergedPaths(repo, paths);
  if (headBlobs === null || idxBlobs === null || unmerged === null) {
    usage('cannot read HEAD, the index, or its conflict stages — refusing to classify');
  }

  // main's recent ancestry, newest first. First-parent: a stale root is behind the
  // tip's own line of advance, not behind some side branch's private history.
  const ancestry = (git(repo, ['rev-list', '--first-parent', '-n', String(opts.lookback + 1), head]) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((c) => c && c !== head);
  // An ancestor whose tree cannot be read contributes no evidence; dropping it can
  // only cost a heal, never cause one.
  const ancestors = ancestry
    .map((commit) => ({ commit, blobs: treeBlobs(repo, commit, paths) }))
    .filter((a) => a.blobs !== null);

  const stale = [];
  const wip = [];
  for (const e of entries) {
    const c = classify(repo, e, headBlobs, idxBlobs, unmerged, ancestors);
    if (c.verdict === 'stale') stale.push({ path: e.path, base: c.base, cur: c.cur, idx: c.idx, why: c.why });
    else wip.push({ path: e.path, why: c.why });
  }
  const base = commonBase(stale, ancestry);

  if (opts.apply && stale.length) {
    // Re-verify immediately before writing. Classification costs one git call per
    // ancestor — seconds on a real repo — and the whole premise of this tool is a
    // SHARED root that other jobs write to. A path that moved under us in that
    // window is not the path we cleared, so it loses its clearance.
    const raced = [];
    const fresh = recheck(repo, stale, raced);
    const written = [];
    for (const chunk of chunks(fresh.map((s) => s.path), 200)) {
      if (git(repo, ['checkout', head, '--', ...chunk.map(spec)]) === null) {
        process.stderr.write('heal-stale-root: git checkout failed; root left partially healed\n');
        // Report what was ALREADY written, not an empty list: a caller told
        // `healed: []` believes the tree is untouched, and acts on that.
        report(opts, { verdict: 'ROOT-UNSYNCED', head, base, stale, wip: wip.concat(raced), healed: written }, 1);
      }
      written.push(...chunk);
    }
    // Trust the tree, not our own bookkeeping: re-read status and let what is
    // actually left decide the verdict.
    const left = trackedModified(repo);
    if (left === null) usage('cannot re-read git status after the heal — the root state is unverified');
    const healed = fresh.map((s) => s.path).filter((p) => !left.some((e) => e.path === p));
    const known = wip.concat(raced);
    const stillWip = left.map((e) => ({
      path: e.path,
      why: (known.find((w) => w.path === e.path) || {}).why || `still modified after the heal (${e.xy})`,
    }));
    report(
      opts,
      { verdict: left.length === 0 ? 'HEALED' : 'ROOT-UNSYNCED', head, base, stale, wip: stillWip, healed },
      left.length === 0 ? 0 : 1
    );
  }

  report(opts, { verdict: wip.length ? 'ROOT-UNSYNCED' : 'STALE', head, base, stale, wip, healed: [] }, 1);
}

// Re-probe the stale set and keep only the paths still holding exactly what they
// held when they were cleared. Anything that moved goes to `raced` as WIP — it
// narrows the classify→checkout window to one probe, which is the best a tool can
// do over a tree it does not lock.
function recheck(repo, stale, raced) {
  const idxNow = indexBlobs(repo, stale.map((s) => s.path));
  if (idxNow === null) usage('cannot re-read the index before healing');
  const fresh = [];
  for (const s of stale) {
    const idx = idxNow.has(s.path) ? idxNow.get(s.path) : ABSENT;
    if (worktreeBlob(repo, s.path) === s.cur && idx === s.idx) fresh.push(s);
    else raced.push({ path: s.path, why: 'it changed while this run was classifying — another job is writing here' });
  }
  return fresh;
}

function report(opts, r, code) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(code);
  }
  const lines = [];
  if (r.verdict === 'IN-SYNC') {
    lines.push('IN-SYNC: no tracked modifications — the root may be reset to main.');
  } else if (r.verdict === 'HEALED') {
    lines.push(`HEALED: ${r.healed.length} stale path(s) checked out from HEAD; the root is now in sync.`);
  } else if (r.verdict === 'STALE') {
    lines.push(`STALE: ${r.stale.length} path(s) are behind HEAD and safe to heal (re-run with --apply).`);
  } else {
    lines.push(`ROOT-UNSYNCED: ${r.wip.length} path(s) carry uncommitted work — do NOT reset the root.`);
  }
  if (r.base) lines.push(`stale base: ${r.base.slice(0, 8)} (every stale path matches this path there)`);
  for (const s of r.stale) lines.push(`  ${r.healed.includes(s.path) ? 'healed' : 'stale '}  ${s.path} — ${s.why}`);
  for (const w of r.wip) lines.push(`  wip     ${w.path} — ${w.why}`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(code);
}

main();
