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
// …AND RAW BYTES, where the blob alone cannot vouch for them. The blob sha of a
// working file is computed through the .gitattributes CLEAN filters (that is what
// makes it comparable to a committed blob at all), so a LOSSY clean filter can
// normalize novel on-disk bytes to an old committed blob — content that exists
// nowhere else, wearing a stale path's fingerprint. A heal therefore also
// requires the raw, unfiltered bytes on disk to be exactly what a checkout of
// the matched commit would write (its blob with the smudge/eol side applied).
// A round-trip conversion like eol=crlf passes; anything lossy refuses.
//
// PATH BYTES ARE NOT UTF-8. A tracked path is a sequence of bytes with no
// encoding guarantee — git enforces none, and a legacy or migrated repo can
// hold latin1, cp1252, or simply invalid byte sequences in a filename. Node's
// child_process always re-encodes string argv as UTF-8 on the way out, so a
// path that was lossily decoded on the way in (replacing bad bytes with
// U+FFFD) can never be told apart from, or handed back to git as, the path it
// came from — that mismatch reads as WIP forever, wedging the very state this
// tool exists to unwedge. Every place a path crosses the node/git boundary
// below therefore carries raw bytes: output that embeds a path is decoded
// latin1 (a lossless byte<->codepoint mapping, unlike utf8's substitution),
// and a path is only ever placed in argv when re-encoding it as UTF-8 would
// reproduce those exact bytes (i.e. it already was valid UTF-8) — otherwise it
// travels through a file or stdin instead, neither of which re-encodes.
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
//     re-probed shut PER PATH, immediately before that path's own checkout (see
//     recheck): the last probe of a path and the write that spends its clearance
//     are adjacent subprocess spawns, with nothing else between — not closed,
//     but as narrow as a tool without a tree lock can make it.
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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The git blob of an empty file, derived per-repo rather than hardcoded: a
// SHA-256 repository (--object-format=sha256) hashes the same empty content to
// a different OID, and a hardcoded SHA-1 literal would never match there,
// silently disabling this guard. Empty content is weak evidence: a truncated
// working file would match any ancestor that happened to hold an empty file, so
// it is never counted as a rewind. Mirrors the same guard in spor-server's
// check-stale-tree-revert.js.
function emptyBlobSha(repo) {
  const out = git(repo, ['hash-object', '--stdin'], '');
  return out === null ? null : out.trim();
}

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

// Set once the heal has written anything. After that, exit 2 is a lie — the
// header promises it means "nothing was modified" — so even a git that will not
// launch (EAGAIN on a loaded box running five agents) has to leave through a
// reported verdict.
let hasWritten = false;

// Returns stdout, or null when git exits non-zero. No caller reads null as an
// answer: it means "we could not look", which lands on WIP or an exit.
function git(repo, args, input) {
  return gitRun(repo, args, input, 'utf8');
}

// As git(), but stdout stays a Buffer: committed blob content may be binary,
// and a utf8 round-trip is lossy on it.
function gitBuf(repo, args) {
  return gitRun(repo, args, undefined, 'buffer');
}

// As git(), but for output that EMBEDS PATHS (status/ls-tree/ls-files): decoded
// latin1, not utf8. latin1 maps every byte 0-255 to its own code unit — lossy
// in neither direction, unlike utf8 which folds any invalid byte sequence to
// U+FFFD and can never be told apart from another path that decoded the same
// way. Every delimiter these formats use (NUL, tab, space) is plain ASCII, so
// the existing split/slice/indexOf parsing below is byte-for-byte identical
// under latin1 — only the PATH portion's meaning changes, from "best-effort
// unicode text" to "exactly the bytes on disk".
function gitPaths(repo, args, input) {
  return gitRun(repo, args, input, 'latin1');
}

// Is `p` (a latin1-decoded path, i.e. its original raw bytes one-to-one) safe
// to hand back to git as a plain argv string? Node re-encodes argv as UTF-8 no
// matter what encoding produced the JS string, so the only paths that survive
// that round trip are ones whose raw bytes already WERE valid UTF-8 — decoding
// them and letting node re-encode reproduces the identical bytes. Returns the
// decoded string to embed in argv, or null when the path cannot be expressed
// there at all (the caller must route it through a file or stdin instead, or
// refuse). TextDecoder's `fatal` option is the strict validator: unlike
// Buffer#toString('utf8'), it throws on the very sequences that motivate this
// whole file rather than silently substituting U+FFFD.
function utf8OrNull(p) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(p, 'latin1'));
  } catch {
    return null;
  }
}

function gitRun(repo, args, input, encoding) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (r.error) {
    process.stderr.write(`heal-stale-root: cannot run git: ${r.error.message}\n`);
    if (hasWritten) return null; // the caller reports; it knows what it wrote
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
//
// `p` must already be argv-safe (utf8OrNull's non-null result) — this goes
// straight into a spawn argv, so a raw latin1 byte string here would silently
// re-encode to the wrong bytes on the way out. Callers that only have a path's
// latin1 form route it through a pathspec file or stdin instead (see below).
const spec = (p) => `:(literal)${p}`;

// Chunk paths for one git invocation: at most `n` entries AND at most ~20KB of
// path bytes, whichever fills first. The byte cap is for Windows, where the
// whole argv becomes one CreateProcess command line hard-capped at ~32,767
// chars — 200 deep-monorepo paths wrapped in `:(literal)` can overrun it, and
// the spawn failure would end a classification with no verdict at all. `arr`
// holds latin1-decoded paths (one code unit per raw byte), so `p.length` here
// is an exact byte count, not the utf8-multibyte-undercounting approximation a
// plain string length would give.
function chunks(arr, n) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const p of arr) {
    if (cur.length && (cur.length >= n || bytes + p.length > 20000)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += p.length;
  }
  if (cur.length) out.push(cur);
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

const isEmptyBlob = (s, emptyBlob) => s !== ABSENT && s !== UNKNOWN && s.sha === emptyBlob;

// The mode of a state, or undefined when there is no state to have one (a path
// that is ABSENT or unreadable). Both are real cases for a stale path — a file
// the merge ADDED is absent from the stale tree — so no call site may assume
// a state object is there to dereference.
const modeOf = (s) => (s === ABSENT || s === UNKNOWN ? undefined : s.mode);

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
    // mid-merge tree to the checkout. That is also why this is NOT existsSync,
    // which folds every stat error (EACCES, ELOOP, …) into "not there" —
    // only a missing path proves the marker absent.
    if (p === null) return { unreadable: file };
    try {
      fs.statSync(path.resolve(repo, p.trim()));
      return { op };
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return { unreadable: file };
    }
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
  const out = gitPaths(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
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

// Splits paths into ones whose raw bytes round-trip through argv (see
// utf8OrNull) and ones that don't. Only the latter pay for the unrestricted-
// listing fallback in treeState/indexState below; the former take the same
// chunked-pathspec route as before this fix, so the common all-UTF-8 case —
// everything the existing suite exercises — is unaffected in shape or cost.
function partitionArgvSafe(paths) {
  const safe = [];
  const unsafe = [];
  for (const p of paths) (utf8OrNull(p) === null ? unsafe : safe).push(p);
  return { safe, unsafe };
}

// Parses `-z`-terminated `<prefix tokens>\t<path>` records — the shape shared
// by `ls-tree -z` (mode/type/sha) and `ls-files -s -z` (mode/sha/stage) — into
// one array. Shared by each function's chunked and unrestricted-fallback
// listing below, so the two stay behaviorally identical by construction
// instead of by two hand-kept-in-sync copies.
function parseTabRecords(out) {
  const recs = [];
  for (const rec of splitZ(out)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    recs.push({ fields: rec.slice(0, tab).split(/\s+/), path: rec.slice(tab + 1) });
  }
  return recs;
}

// path -> (mode, blob) at `commit`, restricted to `paths`. A submodule or subtree
// entry is left out: never matchable, so it reads as WIP and blocks the sync
// rather than being healed blind.
// Returns null if any probe fails: a half-populated map is worse than none, since
// a path missing from it reads as ABSENT — positive knowledge we do not have.
//
// `ls-tree` has no stdin or pathspec-file form (unlike checkout below), so a
// path whose raw bytes are not valid UTF-8 cannot be named by pathspec at all
// — argv would silently re-encode it into different bytes, matching nothing or,
// worse, matching some other path that happens to decode to the same U+FFFD
// sequence. Such paths instead pay for ONE unrestricted recursive listing,
// matched against the wanted set by exact raw-byte equality.
function treeState(repo, commit, paths) {
  const map = new Map();
  const { safe, unsafe } = partitionArgvSafe(paths);
  const absorb = (recs) => {
    for (const { fields: [mode, type, sha], path: p } of recs) {
      if (type === 'blob') map.set(p, at(mode, sha));
    }
  };
  for (const chunk of chunks(safe, 200)) {
    const out = gitPaths(repo, ['ls-tree', '-z', '--full-name', commit, '--', ...chunk.map((p) => spec(utf8OrNull(p)))]);
    if (out === null) return null;
    absorb(parseTabRecords(out));
  }
  if (unsafe.length) {
    const wanted = new Set(unsafe);
    const out = gitPaths(repo, ['ls-tree', '-r', '-z', '--full-name', commit]);
    if (out === null) return null;
    absorb(parseTabRecords(out).filter((r) => wanted.has(r.path)));
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
//
// Same argv-safety split as treeState, and for the same reason: `ls-files` has
// no stdin/pathspec-file restriction form either.
function indexState(repo, paths) {
  const state = new Map();
  const unmerged = new Set();
  const { safe, unsafe } = partitionArgvSafe(paths);
  const absorb = (recs) => {
    for (const { fields: [mode, sha, stage], path: p } of recs) {
      if (stage === '0') state.set(p, at(mode, sha));
      else unmerged.add(p);
    }
  };
  for (const chunk of chunks(safe, 200)) {
    const out = gitPaths(repo, ['ls-files', '-s', '-z', '--', ...chunk.map((p) => spec(utf8OrNull(p)))]);
    if (out === null) return null; // as in treeState: no map beats a partial one
    absorb(parseTabRecords(out));
  }
  if (unsafe.length) {
    const wanted = new Set(unsafe);
    const out = gitPaths(repo, ['ls-files', '-s', '-z']);
    if (out === null) return null;
    absorb(parseTabRecords(out).filter((r) => wanted.has(r.path)));
  }
  return { state, unmerged };
}

// What can this checkout's filesystem actually represent? Two git settings say,
// and both default to FALSE on Windows — the platform this plugin supports
// natively:
//   core.fileMode  false → git ignores the exec bit and keeps the recorded mode
//   core.symlinks  false → git materializes a tracked symlink as a plain file
//                          holding the target path, and keeps mode 120000
// Deriving either off disk where git does not would invent a difference git
// cannot see — a 100755 script reads as 0644, a 120000 link reads as a 100644
// file — so every such path a merge touched would look novel and wedge the sync
// forever. Mode is evidence exactly where git treats it as evidence.
//
// --type=bool because git accepts 0/off/no/FALSE/'' for false, not just the
// literal spelling, and git resolves all of them; a string compare would honor a
// bit git is ignoring.
function boolConfig(repo, key, dflt) {
  const v = git(repo, ['config', '--type=bool', '--get', key]);
  return v === null ? dflt : v.trim() !== 'false'; // unset (exit 1) → the default
}
const fsCapabilities = (repo) => ({
  fileMode: boolConfig(repo, 'core.fileMode', true),
  symlinks: boolConfig(repo, 'core.symlinks', true),
});

// `p` is a latin1-decoded path (raw bytes as code units); fs, like
// child_process, re-encodes a plain JS string path as UTF-8 on POSIX, so
// reaching the actual bytes on disk needs a Buffer. `path.resolve` itself is
// pure string manipulation (splitting/joining on ASCII '/'), so it is safe to
// run on a latin1 string before this final conversion.
const resolveBuf = (repo, p) => Buffer.from(path.resolve(repo, p), 'latin1');

// hash-object's `--path <file> -- <file>` form takes the file location as
// argv — the same argv-re-encoding trap as ls-tree/ls-files pathspecs (see
// gitPaths above). `--stdin-paths` instead reads the path list from stdin, one
// path per line, as raw bytes with no re-encoding, and hashes the real file at
// that path exactly as `--path`/`--no-filters` would (verified against both:
// same clean sha, same raw sha). Every path goes through this, argv-safe or
// not — unlike ls-tree/ls-files there is no safe/unsafe split to make here.
function hashObjectAtPath(repo, p, noFilters) {
  const input = Buffer.concat([Buffer.from(p, 'latin1'), Buffer.from('\n')]);
  const args = noFilters
    ? ['hash-object', '--no-filters', '--stdin-paths']
    : ['hash-object', '--stdin-paths'];
  return git(repo, args, input);
}

// The working tree's (mode, blob) for a path, as git itself would record it —
// plus `raw`, the sha of the bytes actually on disk with no filter applied,
// which is what the clean-filter gate in classify() and the recheck compare.
// `recordedMode` is the mode git keeps when the filesystem cannot represent the
// real one (the index's, falling back to HEAD's).
function worktreeState(repo, p, fsCaps, recordedMode) {
  let st;
  try {
    st = fs.lstatSync(resolveBuf(repo, p));
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
      target = fs.readlinkSync(resolveBuf(repo, p), { encoding: 'buffer' }); // the target itself may hold raw bytes too
    } catch {
      return UNKNOWN;
    }
    const out = git(repo, ['hash-object', '--stdin'], target);
    if (out === null) return UNKNOWN;
    // No filter ever applies to a link, so its target IS its raw bytes.
    return { ...at('120000', out.trim()), raw: out.trim() };
  }
  if (!st.isFile()) return UNKNOWN; // a directory, a fifo, a socket…
  const out = hashObjectAtPath(repo, p, false); // .gitattributes clean filters applied
  if (out === null) return UNKNOWN; // unreadable file: present, uninspectable
  const raw = hashObjectAtPath(repo, p, true);
  if (raw === null) return UNKNOWN;
  let mode;
  if (!fsCaps.symlinks && recordedMode === '120000') {
    // A checked-out symlink on a filesystem without them: a plain file holding
    // the target path, which is byte-identical to what git stored, so only the
    // mode needs restoring from the record.
    mode = '120000';
  } else if (!fsCaps.fileMode) {
    mode = recordedMode || '100644'; // git keeps the recorded mode; so do we
  } else {
    // git reads the OWNER exec bit alone (S_IXUSR). Masking 0o111 would call a
    // group-exec-only file 100755 while git records 100644, and that invented
    // difference refuses a healable path.
    mode = st.mode & 0o100 ? '100755' : '100644';
  }
  return { ...at(mode, out.trim()), raw: raw.trim() };
}

// The exact bytes `git checkout <commit> -- <path>` would write into the working
// tree: the committed blob with the smudge/eol side of the filters applied.
// Reduced to a sha (of the bytes as-is, no clean filter) so the comparison
// against the on-disk raw sha never decodes binary content and stays agnostic of
// the repo's object format. null when either probe fails — never read as a match.
//
// `<rev>:<path>` has no stdin form (cat-file's --batch family does, but not
// combined with --filters in a way that is worth the added parsing here — see
// the traversal note below), so `p` goes into a single argv string and is
// therefore subject to the same argv-safety rule as ls-tree/ls-files: if it
// cannot be expressed as a re-encodable UTF-8 string, this probe cannot run at
// all. That reads as "cannot verify", which is exactly the safe direction —
// this gate only ever runs when a clean filter is already suspected of
// laundering novel bytes (classify()'s `cur.raw !== cur.sha` check), so
// refusing here means refusing a path already flagged as ambiguous, not a
// healable one.
function smudgedSha(repo, commit, p) {
  const argvSafe = utf8OrNull(p);
  if (argvSafe === null) return null;
  const content = gitBuf(repo, ['cat-file', '--filters', `${commit}:${argvSafe}`]);
  if (content === null) return null;
  const out = git(repo, ['hash-object', '--stdin', '--no-filters'], content);
  return out === null ? null : out.trim();
}

// ---------- classification ----------

// Is `value` safely discardable for this path — either it IS what HEAD holds
// (nothing to lose), or it is identical to what some first-parent ancestor of
// HEAD holds (committed, therefore recoverable)? Returns the explaining ancestor
// sha, '' for "same as HEAD", or null for novel state.
function behindOrHead(value, head, p, ancestors, emptyBlob) {
  if (value === UNKNOWN) return null; // present but uninspectable — never discardable
  if (same(value, head)) return '';
  if (isEmptyBlob(value, emptyBlob) && !isEmptyBlob(head, emptyBlob)) return null;
  for (const anc of ancestors) {
    if (same(anc.state.has(p) ? anc.state.get(p) : ABSENT, value)) return anc.commit;
  }
  return null;
}

function classify(repo, entry, headSha, headState, idx, ancestors, fsCaps, emptyBlob) {
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
  const idxAt = behindOrHead(idxNow, head, p, ancestors, emptyBlob);
  if (idxAt === null) {
    return { verdict: 'wip', why: 'the index holds a state committed neither at HEAD nor in its recent ancestry' };
  }
  const cur = worktreeState(repo, p, fsCaps, modeOf(idxNow) || modeOf(head));
  const curAt = behindOrHead(cur, head, p, ancestors, emptyBlob);
  if (curAt === null) {
    return { verdict: 'wip', why: 'the working tree holds a state committed neither at HEAD nor in its recent ancestry' };
  }

  // git called this path modified, yet both sides match HEAD exactly: something
  // we do not model differs. Refuse rather than guess.
  if (idxAt === '' && curAt === '') {
    return { verdict: 'wip', why: 'git reports it modified though the index and working tree both match HEAD' };
  }

  // The clean-filter blind spot: `cur.sha` above went through the .gitattributes
  // clean filters, so when the raw bytes on disk differ from that blob, the match
  // vouches for the FILTERED content only — a lossy clean filter can normalize
  // novel bytes to an old committed blob, and the checkout would destroy the one
  // copy of them. Clear the path only when the raw bytes are exactly what a
  // checkout of the matched commit would write (round-trip conversions like
  // eol=crlf pass this; anything lossy does not).
  if (cur !== ABSENT && cur.raw !== cur.sha) {
    const smudged = smudgedSha(repo, curAt === '' ? headSha : curAt, p);
    if (smudged === null || smudged !== cur.raw) {
      return { verdict: 'wip', why: 'the raw on-disk bytes are not what any committed state checks out as — a clean filter is normalizing novel content' };
    }
  }

  // Every side is either HEAD's own state or a committed older one: nothing here
  // is novel, so checking out HEAD discards nothing. `ev` is the state whose
  // ancestor match is the evidence (the working tree's, unless only the index
  // dissents) — commonBase re-tests it against each ancestor.
  const base = curAt || idxAt;
  return { verdict: 'stale', base, cur, idx: idxNow, ev: curAt ? cur : idxNow, why: `matches this path at ${base.slice(0, 7)}` };
}

// The newest ancestor that explains EVERY stale path. Not required to heal (each
// path stands on its own evidence); it is the evidence line a human reads — "the
// root is sitting at <sha>, N paths behind main". Each path's stored `base` is
// its own NEWEST match, and those legitimately differ when the root lags several
// merges (a path untouched by the later merges also matches the newer commits),
// so the common base is found by re-testing every path's evidence per ancestor,
// newest first — not by expecting the stored bases to coincide.
function commonBase(stale, ancestors) {
  if (!stale.length) return null;
  for (const a of ancestors) {
    if (stale.every((s) => same(a.state.has(s.path) ? a.state.get(s.path) : ABSENT, s.ev))) return a.commit;
  }
  return null;
}

// Re-probe stale paths and keep only those still holding exactly what they held
// when they were cleared — (mode, blob) AND raw bytes, so a racer whose novel
// content clean-normalizes to the same blob loses clearance too. Anything that
// moved goes to `raced` as WIP. The heal calls this with ONE path immediately
// before that path's own checkout, so the last probe and the write that spends
// its clearance are adjacent spawns — the best a tool can do over a tree it does
// not lock. Returns null when the index cannot be re-read: the caller decides,
// because mid-heal an exit 2 would be a lie.
function recheck(repo, stale, raced, fsCaps) {
  const idx = indexState(repo, stale.map((s) => s.path));
  if (idx === null) return null;
  const fresh = [];
  for (const s of stale) {
    // Re-test unmergedness too: a job running `git stash apply` in the window
    // leaves higher stages whose stage-0 lookup is ABSENT — which would compare
    // equal to a classify-time ABSENT and clear a conflict for collapsing.
    const now = idx.unmerged.has(s.path)
      ? UNKNOWN
      : idx.state.has(s.path) ? idx.state.get(s.path) : ABSENT;
    const cur = worktreeState(repo, s.path, fsCaps, modeOf(now) || modeOf(s.cur));
    // same() passing means cur and s.cur are both ABSENT or both real worktree
    // states, and worktree states always carry raw — compared on the side, since
    // same() also serves tree and index states, which have no raw bytes to hold.
    if (same(cur, s.cur) && (cur === ABSENT || cur.raw === s.cur.raw) && same(now, s.idx)) fresh.push(s);
    else raced.push({ path: s.path, why: 'it changed after this run classified it — another job is writing here' });
  }
  return fresh;
}

// checkout's argv pathspec has the same argv-re-encoding trap as ls-tree's and
// ls-files's, but checkout alone among them also accepts
// --pathspec-from-file: the pathspec then travels through a FILE we write
// ourselves — raw bytes via fs, no argv involvement for the path itself, only
// for the temp file's own name, which we control and keep plain ASCII. That
// sidesteps the trap for every path, argv-safe or not, so (unlike
// ls-tree/ls-files) there is no safe/unsafe split to make here either. One
// NUL-terminated `:(literal)<path>` entry per call, reusing a single
// per-process file across the whole heal loop below.
function checkoutPath(repo, head, pspecFile, p) {
  const body = Buffer.concat([Buffer.from(':(literal)', 'ascii'), Buffer.from(p, 'latin1'), Buffer.from([0])]);
  try {
    fs.writeFileSync(pspecFile, body);
  } catch {
    return null; // could not stage the pathspec — the same shape as any other failed probe
  }
  return git(repo, ['checkout', head, `--pathspec-from-file=${pspecFile}`, '--pathspec-file-nul']);
}

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // The repo root itself is a path FROM git, subject to the same argv
  // re-encoding trap as every tracked path above (see "PATH BYTES ARE NOT
  // UTF-8" at the top of this file): `git rev-parse --show-toplevel` can print
  // a directory name with no UTF-8 guarantee, and `repo` is then handed back
  // to git as `-C <repo>` argv on EVERY spawn this tool makes. Unlike
  // pathspecs (chunks/checkoutPath), `-C` has no stdin/pathspec-file escape
  // hatch — there is no byte-safe way to name a working directory to git at
  // all — so the best this tool can do is read it losslessly (latin1,
  // matching gitPaths) and use it only when those raw bytes round-trip
  // through argv unchanged. When they don't, refuse cleanly up front instead
  // of letting a silent utf8 decode mangle them into a path that no longer
  // names the real directory (every subsequent `git -C` call would then just
  // fail to find the repo — not a wrong heal, but a confusing "cannot run
  // git" instead of a clear diagnosis).
  const topRaw = gitPaths(opts.repo, ['rev-parse', '--show-toplevel']);
  if (topRaw === null) usage(`not a git repository: ${opts.repo}`);
  // Strip only git's own trailing line terminator, not a JS `.trim()`: `topRaw`
  // is latin1-decoded (one code unit per raw byte), and `.trim()` strips any
  // Unicode-whitespace CODE POINT — including U+00A0, which is exactly what
  // byte 0xA0 decodes to under latin1. That byte is a common UTF-8
  // continuation byte (e.g. "à" = 0xC3 0xA0), so a root path ending in such a
  // character would have its real last byte stripped as if it were
  // whitespace, corrupting a valid UTF-8 path into an incomplete sequence and
  // refusing it falsely.
  const repo = utf8OrNull(topRaw.replace(/\r?\n$/, ''));
  if (repo === null) {
    usage('repo root path is not valid UTF-8 — cannot be passed to git as an argument (no -C stdin/file form exists)');
  }

  const prog = inProgressOp(repo);
  if (prog.op) usage(`a ${prog.op} is in progress — resolve it before syncing the root`);
  if (prog.unreadable) usage(`cannot read ${prog.unreadable}, so an operation in progress cannot be ruled out`);

  const headOut = git(repo, ['rev-parse', 'HEAD']);
  if (headOut === null) usage('no HEAD commit');
  const head = headOut.trim();

  const emptyBlob = emptyBlobSha(repo);
  if (emptyBlob === null) usage('cannot derive the empty-blob OID — refusing to classify');

  // NOT `|| []`: a status probe that failed tells us nothing, and "nothing"
  // collapsed to "nothing modified" would report IN-SYNC/exit 0 — which licenses
  // the caller to `git reset --hard main` over whatever is actually there. This is
  // the single most load-bearing probe in the tool; it must fail like the rest.
  const fsCaps = fsCapabilities(repo);
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
    const c = classify(repo, e, head, headState, idx, ancestors, fsCaps, emptyBlob);
    if (c.verdict === 'stale') stale.push({ path: e.path, base: c.base, cur: c.cur, idx: c.idx, ev: c.ev, why: c.why });
    else wip.push({ path: e.path, why: c.why });
  }

  if (opts.apply && stale.length) {
    // Re-verify immediately before writing — per PATH, not once for the whole
    // set. Classification costs one git call per ancestor — seconds on a real
    // repo — and the whole premise of this tool is a SHARED root that other jobs
    // write to. An up-front recheck (even a chunked one) would leave later paths
    // sitting cleared-but-unwritten for the wall-clock of everything probed and
    // written before them; here each path's clearance is spent by the very next
    // spawn. A path that moved in even that window is not the path we cleared,
    // so it loses its clearance and stays untouched.
    const raced = [];
    const attempted = [];
    let failed = false;
    // A private, randomly-named 0700 dir (fs.mkdtempSync) rather than a
    // pid-predictable path directly under os.tmpdir(): a fixed name is
    // guessable by another same-user process, which could pre-plant a
    // symlink there and have our writeFileSync/git checkout follow it
    // (code-review finding at the CAS merge gate, issue-spor-heal-stale-root-non-utf8-mangling).
    const pspecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-stale-root-'));
    const pspecFile = path.join(pspecDir, 'pathspec');
    try {
      for (const s of stale) {
        const fresh = recheck(repo, [s], raced, fsCaps);
        if (fresh === null) {
          // The index went unreadable under us. Before any write that is a clean
          // exit-2 refusal; after one, exit 2 would lie ("nothing was modified"),
          // so fall through and let the tree say what actually landed. The
          // un-rechecked remainder keeps its classification but is never written.
          if (!hasWritten) usage('cannot re-read the index before healing');
          process.stderr.write('heal-stale-root: cannot re-read the index mid-heal; root left partially healed\n');
          failed = true;
          break;
        }
        if (!fresh.length) continue; // raced away; recheck recorded why
        attempted.push(s.path);
        hasWritten = true; // git may write the index entry before it reports failure
        if (checkoutPath(repo, head, pspecFile, s.path) === null) {
          process.stderr.write('heal-stale-root: git checkout failed; root left partially healed\n');
          failed = true;
          break;
        }
      }
    } finally {
      try {
        fs.rmSync(pspecDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; a leftover temp dir outside the repo is harmless
      }
    }
    // A raced path lost its clearance: it reports as WIP, not as stale. Paths
    // after a mid-heal break keep their classification — never written, still
    // stale evidence.
    const racedPaths = new Set(raced.map((r) => r.path));
    stale = stale.filter((s) => !racedPaths.has(s.path));
    const known = wip.concat(raced);
    const base = commonBase(stale, ancestors);

    // Trust the tree, not our own bookkeeping: re-read status and let what is
    // actually left say what was healed. This is also why a failed checkout is
    // not fatal — git may update the index entry before it dies, so only the
    // tree knows what landed.
    const left = trackedModified(repo);
    if (left === null) {
      // Nothing written yet (every path raced away before the first checkout)
      // makes this an honest exit 2; after a write it would be a lie, and
      // exiting 2 through usage() would also print a usage banner and no report
      // — telling a caller "you invoked me wrong" about a run that mutated the
      // shared root, and handing a --json consumer an empty stdout to parse.
      // Report what was attempted instead: `attempted`, not `healed`, because
      // which of them landed is exactly what we cannot say.
      if (!hasWritten) usage('cannot re-read git status — nothing was written, but the root cannot be verified');
      report(opts, {
        verdict: 'UNVERIFIED', head, base, stale, wip: known, healed: [],
        attempted,
        note: 'the heal ran but git status could not be re-read, so what landed is unknown',
      }, 1);
    }
    // `healed` claims only what this run wrote AND status now shows clean —
    // an attempted-set filter, so a path some OTHER job cleaned in the window
    // is never reported as this run's work.
    const leftPaths = new Set(left.map((e) => e.path));
    const healed = attempted.filter((p) => !leftPaths.has(p));
    const tried = new Set(attempted);
    const stillWip = left.map((e) => ({
      path: e.path,
      why: (known.find((w) => w.path === e.path) || {}).why
        || (tried.has(e.path) ? `still modified after the heal (${e.xy})` : 'the heal stopped before reaching it'),
    }));
    // A checkout that failed leaves the run unable to claim the root is synced,
    // even if what remains looks clean — the verdict and the exit code have to say
    // the same thing, or the caller reads HEALED and resets on the strength of it.
    const synced = left.length === 0 && !failed;
    report(
      opts,
      { verdict: synced ? 'HEALED' : 'ROOT-UNSYNCED', head, base, stale, wip: stillWip, healed },
      synced ? 0 : 1
    );
  }

  report(
    opts,
    { verdict: wip.length ? 'ROOT-UNSYNCED' : 'STALE', head, base: commonBase(stale, ancestors), stale, wip, healed: [] },
    1
  );
}

// `path` fields on the way into report() are latin1-decoded raw bytes (see
// gitPaths above) — exactly what git and fs need, but not what a human or a
// JSON consumer expects to read. Convert to the text a plain utf8-decoding
// git() call would have produced: identical to today for every valid-UTF-8
// path (everything the existing suite exercises), and U+FFFD for the same
// bytes that motivated this file — a display nicety, never load-bearing,
// since every actual decision above this point was made on the raw bytes.
const displayPath = (p) => Buffer.from(p, 'latin1').toString('utf8');

function report(opts, r, code) {
  r = {
    ...r,
    stale: r.stale.map((s) => ({ ...s, path: displayPath(s.path) })),
    wip: r.wip.map((w) => ({ ...w, path: displayPath(w.path) })),
    healed: r.healed.map(displayPath),
    ...(r.attempted ? { attempted: r.attempted.map(displayPath) } : {}),
  };
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
  } else if (r.wip.length) {
    lines.push(`ROOT-UNSYNCED: ${r.wip.length} path(s) carry uncommitted work — do NOT reset the root.`);
  } else {
    // Reachable when a checkout failed but the re-read status shows nothing
    // modified (git can update the entry before it dies): no WIP to point at,
    // yet the run cannot vouch for the root either.
    lines.push('ROOT-UNSYNCED: a heal step failed, so the root cannot be proven in sync — do NOT reset it.');
  }
  if (r.base) lines.push(`stale base: ${r.base.slice(0, 8)} (every stale path matches this path there)`);
  for (const s of r.stale) lines.push(`  ${r.healed.includes(s.path) ? 'healed' : 'stale '}  ${s.path} — ${s.why}`);
  for (const w of r.wip) lines.push(`  wip     ${w.path} — ${w.why}`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(code);
}

main();
