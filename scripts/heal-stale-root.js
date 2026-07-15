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
// THE FINGERPRINT: stale state is state that is BEHIND, never novel. A path left
// over from a CAS advance holds, byte-for-byte, what it held at a recent ancestor
// of HEAD — that is what "the ref moved, the files didn't" means. Genuine WIP is
// a change nobody has committed, so it essentially never reproduces an exact
// older version of the same path. So each tracked-modified path is classified by
// IDENTITY, not by status letters:
//
//   STALE  every side that differs from HEAD (the index entry AND the working
//          tree) is identical to what that path was at some first-parent ancestor
//          of HEAD within the lookback window. Nothing there is novel, so
//          `git checkout HEAD -- <path>` discards nothing that isn't already
//          committed — the surgical heal.
//   WIP    anything else. Refused, untouched, reported.
//
// IDENTITY IS (mode, blob) — git's own, not just content. An uncommitted
// `chmod +x` changes no blob, so a content-only comparison calls the path
// unchanged-from-HEAD and heals the exec bit away; a symlink swapped for a file
// hides the same way. Both sides of every comparison below therefore carry the
// mode, and a path is only ever cleared when mode AND blob match.
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
// modified", not "no merge in progress". Every unknown lands on WIP or an exit.
//
// KNOWN RESIDUALS (documented, accepted):
//   - A file mixing stale content WITH a genuine edit hashes to neither the old
//     nor the new blob, so it reads as WIP and blocks the sync. Correct, and the
//     conservative direction.
//   - A path whose stale state predates the lookback window reads as WIP.
//     Raising --lookback only strengthens detection; it can never cause a false
//     heal (matching an older ancestor is still matching a committed state).
//   - A deliberate but uncommitted revert or `rm` of a path whose old state is
//     still committed is identical to a stale path, and is healed (i.e. put
//     back). Indistinguishable from the evidence — the same call a human makes by
//     eye — and it restores committed state rather than destroying new work.
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
// Exit 1 = the root does NOT match HEAD, or could not be proven to. Verdict STALE
//          means a dry run found only healable staleness (re-run with --apply);
//          ROOT-UNSYNCED means genuine WIP is present; UNVERIFIED means a heal ran
//          but its result could not be re-read. In every case: do NOT reset the
//          root — verify the merge in a throwaway detached worktree instead
//          (norm-spor-orchestrator-cas-merge). A verdict is always reported.
// Exit 2 = the run never got far enough to touch anything: a bad invocation, not
//          a git repo, an operation (merge/rebase/…) in progress, or a probe that
//          could not answer BEFORE any write. Nothing was modified.
//
// WIRING — NOT DONE YET, AND DELIBERATELY SO. The consumer is the orchestrator's
// post-merge root sync (norm-spor-orchestrator-cas-merge), which lives in the
// spor-orchestrator SKILL at ~/.claude/skills/spor-orchestrator — a personal skill
// under no version control, so its call site cannot ride this branch or any
// review. Until someone adds it there, the next CAS merge still leaves the root
// unsynced by hand. The step replaces "reset --hard main if the root looks clean":
//
//     node scripts/heal-stale-root.js --repo <shared root> --apply
//     case $? in
//       0) ;;  # the root matches main
//       *) echo "root NOT synced — verify this merge in a detached worktree" ;;
//     esac
//
// Nothing else in the repo calls this, by design: it is an ops tool run from a
// checkout, so it stays out of package.json's `files` alongside release.js.
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

// Returns stdout, or null when git exits non-zero. No caller reads null as an
// answer: it means "we could not look", which lands on WIP or an exit.
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
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

// ---------- identity ----------
//
// A path's state is (mode, blob) — or ABSENT, or UNKNOWN. `same` is the only
// comparison in this file, so mode can never be forgotten at a call site.

const at = (mode, sha) => ({ mode, sha });

function same(a, b) {
  if (a === UNKNOWN || b === UNKNOWN) return false; // never clear what we could not read
  if (a === ABSENT || b === ABSENT) return a === b; // both gone
  return a.mode === b.mode && a.sha === b.sha;
}

const isEmptyBlob = (s) => s !== ABSENT && s !== UNKNOWN && s.sha === EMPTY_BLOB;

// ---------- probes ----------

// A merge/rebase/cherry-pick/bisect in progress means the modifications on disk
// are mid-operation state, not a stale ref advance. Nothing here is safe then.
// Returns {op} for a real operation, {unreadable} when a probe could not answer —
// separate channels, because they are separate messages to the operator.
function inProgressOp(repo) {
  const named = { MERGE_HEAD: 'merge', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase',
    CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', BISECT_LOG: 'bisect' };
  for (const [file, op] of Object.entries(named)) {
    const p = git(repo, ['rev-parse', '--git-path', file]);
    // A probe that cannot answer is not a "no": reading it as one would hand a
    // mid-merge tree to the checkout.
    if (p === null) return { unreadable: file };
    if (fs.existsSync(path.resolve(repo, p.trim()))) return { op };
  }
  return {};
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

// path -> (mode, blob) at `commit`, restricted to `paths`. A submodule or subtree
// entry is left out: never matchable, so it reads as WIP and blocks the sync
// rather than being healed blind.
// Returns null if any probe fails: a half-populated map is worse than none, since
// a path missing from it reads as ABSENT — positive knowledge we do not have.
function treeState(repo, commit, paths) {
  const map = new Map();
  for (const chunk of chunks(paths, 200)) {
    const out = git(repo, ['ls-tree', '-z', '--full-name', commit, '--', ...chunk.map(spec)]);
    if (out === null) return null;
    for (const rec of splitZ(out)) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, sha] = rec.slice(0, tab).split(/\s+/);
      if (type === 'blob') map.set(rec.slice(tab + 1), at(mode, sha));
    }
  }
  return map;
}

// The index, in one pass: `state` is path -> (mode, blob) for ordinary stage-0
// entries, `unmerged` is the set of paths git holds at a higher stage.
//
// The unmerged set has to come from here rather than from status letters: an
// add/add conflict reads `AA`, with no `U` for a letter check to catch, and
// `git stash apply` / `git apply --3way` leave one with no MERGE_HEAD for
// inProgressOp to catch either. Its other side then exists ONLY in the index, and
// a checkout silently collapses it away.
function indexState(repo, paths) {
  const state = new Map();
  const unmerged = new Set();
  for (const chunk of chunks(paths, 200)) {
    const out = git(repo, ['ls-files', '-s', '-z', '--', ...chunk.map(spec)]);
    if (out === null) return null; // as in treeState: no map beats a partial one
    for (const rec of splitZ(out)) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, sha, stage] = rec.slice(0, tab).split(/\s+/);
      const p = rec.slice(tab + 1);
      if (stage === '0') state.set(p, at(mode, sha));
      else unmerged.add(p);
    }
  }
  return { state, unmerged };
}

// The working tree's (mode, blob) for a path, as git itself would record it.
function worktreeState(repo, p) {
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
    const out = git(repo, ['hash-object', '--stdin'], target);
    return out === null ? UNKNOWN : at('120000', out.trim());
  }
  if (!st.isFile()) return UNKNOWN; // a directory, a fifo, a socket…
  // --path makes the .gitattributes clean filters apply, so the sha is comparable
  // to a committed blob rather than to the raw bytes on disk.
  const out = git(repo, ['hash-object', '--path', p, '--', p]);
  if (out === null) return UNKNOWN; // unreadable file: present, uninspectable
  return at(st.mode & 0o111 ? '100755' : '100644', out.trim());
}

// ---------- classification ----------

// Is `value` safely discardable for this path — either it IS what HEAD holds
// (nothing to lose), or it is identical to what some first-parent ancestor of
// HEAD holds (committed, therefore recoverable)? Returns the explaining ancestor
// sha, '' for "same as HEAD", or null for novel state.
function behindOrHead(value, head, p, ancestors) {
  if (value === UNKNOWN) return null; // present but uninspectable — never discardable
  if (same(value, head)) return '';
  if (isEmptyBlob(value) && !isEmptyBlob(head)) return null;
  for (const anc of ancestors) {
    if (same(anc.state.has(p) ? anc.state.get(p) : ABSENT, value)) return anc.commit;
  }
  return null;
}

function classify(repo, entry, headState, idx, ancestors) {
  const { path: p, xy } = entry;

  // An unresolved conflict holds its other side ONLY in the index's higher
  // stages, which a checkout silently collapses away. Never the shape a stale ref
  // advance leaves behind.
  if (idx.unmerged.has(p)) {
    return { verdict: 'wip', why: `the index holds an unresolved conflict (${xy})` };
  }
  // Renames, copies and typechanges are deliberate state, not a ref that moved.
  // Refuse without looking. (The mode comparison below would also catch a
  // typechange; a data-loss tool can afford both.)
  if ('RCUT'.includes(xy[0]) || 'RCUT'.includes(xy[1])) {
    return { verdict: 'wip', why: `the index carries a rename/copy/typechange/unmerged entry (${xy})` };
  }

  const head = headState.has(p) ? headState.get(p) : ABSENT;
  if (head === ABSENT) {
    // Nothing at HEAD to heal TO: `git checkout HEAD -- <path>` cannot restore it,
    // and the only "heal" would be deleting it — the irreversible direction.
    return { verdict: 'wip', why: 'the path does not exist at HEAD (a staged add)' };
  }

  const idxNow = idx.state.has(p) ? idx.state.get(p) : ABSENT;
  const idxAt = behindOrHead(idxNow, head, p, ancestors);
  if (idxAt === null) {
    return { verdict: 'wip', why: 'the index holds a state committed neither at HEAD nor in its recent ancestry' };
  }
  const cur = worktreeState(repo, p);
  const curAt = behindOrHead(cur, head, p, ancestors);
  if (curAt === null) {
    return { verdict: 'wip', why: 'the working tree holds a state committed neither at HEAD nor in its recent ancestry' };
  }

  // git called this path modified, yet both sides match HEAD exactly: something
  // we do not model differs. Refuse rather than guess.
  if (idxAt === '' && curAt === '') {
    return { verdict: 'wip', why: 'git reports it modified though the index and working tree both match HEAD' };
  }

  // Every side is either HEAD's own state or a committed older one: nothing here
  // is novel, so checking out HEAD discards nothing.
  const base = curAt || idxAt;
  return { verdict: 'stale', base, cur, idx: idxNow, why: `matches this path at ${base.slice(0, 7)}` };
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

// Re-probe the stale set and keep only the paths still holding exactly what they
// held when they were cleared. Anything that moved goes to `raced` as WIP — it
// narrows the classify→checkout window to one probe, which is the best a tool can
// do over a tree it does not lock.
function recheck(repo, stale, raced) {
  const idx = indexState(repo, stale.map((s) => s.path));
  if (idx === null) usage('cannot re-read the index before healing');
  const fresh = [];
  for (const s of stale) {
    // Re-test unmergedness too: a job running `git stash apply` in the window
    // leaves higher stages whose stage-0 lookup is ABSENT — which would compare
    // equal to a classify-time ABSENT and clear a conflict for collapsing.
    const now = idx.unmerged.has(s.path)
      ? UNKNOWN
      : idx.state.has(s.path) ? idx.state.get(s.path) : ABSENT;
    if (same(worktreeState(repo, s.path), s.cur) && same(now, s.idx)) fresh.push(s);
    else raced.push({ path: s.path, why: 'it changed while this run was classifying — another job is writing here' });
  }
  return fresh;
}

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const top = git(opts.repo, ['rev-parse', '--show-toplevel']);
  if (top === null) usage(`not a git repository: ${opts.repo}`);
  const repo = top.trim();

  const prog = inProgressOp(repo);
  if (prog.op) usage(`a ${prog.op} is in progress — resolve it before syncing the root`);
  if (prog.unreadable) usage(`cannot read ${prog.unreadable}, so an operation in progress cannot be ruled out`);

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
  const headState = treeState(repo, head, paths);
  const idx = indexState(repo, paths);
  if (headState === null || idx === null) usage('cannot read HEAD or the index — refusing to classify');

  // main's recent ancestry, newest first. First-parent: a stale root is behind the
  // tip's own line of advance, not behind some side branch's private history.
  const ancestry = (git(repo, ['rev-list', '--first-parent', '-n', String(opts.lookback + 1), head]) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((c) => c && c !== head);
  // An ancestor whose tree cannot be read contributes no evidence; dropping it can
  // only cost a heal, never cause one.
  const ancestors = ancestry
    .map((commit) => ({ commit, state: treeState(repo, commit, paths) }))
    .filter((a) => a.state !== null);

  let stale = [];
  const wip = [];
  for (const e of entries) {
    const c = classify(repo, e, headState, idx, ancestors);
    if (c.verdict === 'stale') stale.push({ path: e.path, base: c.base, cur: c.cur, idx: c.idx, why: c.why });
    else wip.push({ path: e.path, why: c.why });
  }

  if (opts.apply && stale.length) {
    // Re-verify immediately before writing. Classification costs one git call per
    // ancestor — seconds on a real repo — and the whole premise of this tool is a
    // SHARED root that other jobs write to. A path that moved under us in that
    // window is not the path we cleared, so it loses its clearance.
    const raced = [];
    stale = recheck(repo, stale, raced);
    const known = wip.concat(raced);
    const base = commonBase(stale, ancestry);
    let failed = false;
    for (const chunk of chunks(stale.map((s) => s.path), 200)) {
      if (git(repo, ['checkout', head, '--', ...chunk.map(spec)]) === null) {
        process.stderr.write('heal-stale-root: git checkout failed; root left partially healed\n');
        failed = true;
        break;
      }
    }

    // Trust the tree, not our own bookkeeping: re-read status and let what is
    // actually left say what was healed. This is also why a failed chunk is not
    // fatal — git updates the entries it managed before it dies, so only the tree
    // knows what landed.
    const left = trackedModified(repo);
    if (left === null) {
      // The heal already wrote. Exiting 2 through usage() here would print a
      // usage banner and no report, telling a caller "you invoked me wrong" about
      // a run that mutated the shared root — and handing a --json consumer an
      // empty stdout to parse. Report what was attempted instead.
      report(opts, {
        verdict: 'UNVERIFIED', head, base, stale, wip: known, healed: [],
        note: 'the heal ran but git status could not be re-read, so what landed is unknown',
      }, 1);
    }
    const healed = stale.map((s) => s.path).filter((p) => !left.some((e) => e.path === p));
    const stillWip = left.map((e) => ({
      path: e.path,
      why: (known.find((w) => w.path === e.path) || {}).why || `still modified after the heal (${e.xy})`,
    }));
    report(
      opts,
      { verdict: left.length === 0 ? 'HEALED' : 'ROOT-UNSYNCED', head, base, stale, wip: stillWip, healed },
      left.length === 0 && !failed ? 0 : 1
    );
  }

  report(
    opts,
    { verdict: wip.length ? 'ROOT-UNSYNCED' : 'STALE', head, base: commonBase(stale, ancestry), stale, wip, healed: [] },
    1
  );
}

function report(opts, r, code) {
  if (opts.json) {
    // The stale entries carry probe state (cur/idx) that is nobody's business but
    // recheck's; the contract is the path, its base, and why.
    const shape = { ...r, stale: r.stale.map((s) => ({ path: s.path, base: s.base, why: s.why })) };
    process.stdout.write(JSON.stringify(shape) + '\n');
    process.exit(code);
  }
  const lines = [];
  if (r.verdict === 'IN-SYNC') {
    lines.push('IN-SYNC: no tracked modifications — the root may be reset to main.');
  } else if (r.verdict === 'HEALED') {
    lines.push(`HEALED: ${r.healed.length} stale path(s) checked out from HEAD; the root is now in sync.`);
  } else if (r.verdict === 'STALE') {
    lines.push(`STALE: ${r.stale.length} path(s) are behind HEAD and safe to heal (re-run with --apply).`);
  } else if (r.verdict === 'UNVERIFIED') {
    lines.push(`UNVERIFIED: ${r.note}. Do NOT reset the root; inspect it by hand.`);
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
