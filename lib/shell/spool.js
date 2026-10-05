// shell/spool.js — the ONE module behind the client's hand-off spools
// (task-spor-client-spool-single-module): the async capture-nudge spool
// (journal/pending-nudges/<session>/), the async digest-intent spool
// (journal/pending-digests/<session>/), and the remote outbox
// (outbox/*.json). Before this module each of those grew its own write,
// claim, and expiry rule in whichever hook file touched it, and every leak got
// patched per file class. Three primitives live here instead, and every hook
// engine goes through them:
//
//   - writeSpoolFile / createExclusive: a spool file appears COMPLETE or not at
//     all (temp file + rename, or temp file + hard link for a first-writer-wins
//     create), so no drain, sweep, or worker ever parses a torn write.
//   - claimSpoolResult / claimSpoolJob / claimAndReadJson: a reader takes a
//     file by RENAMING it (or by creating its own uniquely named lock), never
//     by check-then-unlink, so exactly one of two overlapping drains acts.
//   - SPOOL_TTL: every horizon the spools are judged by, in one table, so
//     "how long until X is abandoned" is answered in one place and the
//     horizons can be read against each other (claim hold < orphan re-drive <
//     sweep interval < foreign collection < GC).
//
// Plain Node, zero deps. Returns/throws conventions are per function; callers
// on the hook path wrap them fail-open themselves.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isOurProcess } = require("./process-identity.js");
const { defaultOf: cfgDefault } = require("../config-keys.js");

// Every spool horizon, shortest first. The ORDER is load-bearing and pinned by
// test/spool.test.js: a claim must lapse well before its job is re-driven, a
// re-driven orphan must get its one retry before the cross-session sweeper
// runs, and every collector must come back for a result long before journal
// GC deletes it. The config-overridable ones (sweepInterval, gcInterval,
// gcMaxAge) are the DEFAULTS their cfgNum reads fall back to.
const SPOOL_TTL = Object.freeze({
  // A claim or job lock stamped by a live pid is honored at most this long —
  // longer than any drain, short enough to self-heal a recycled pid.
  claimHold: 300000, // 5min
  // A `.in.json` with no verdict (its worker never ran, or its backend
  // failed) is re-driven once, then pruned, after this. Digest inputs are
  // pruned outright at the same horizon.
  orphanInput: 3600000, // 1h
  // How often one box runs the detached cross-session spool sweeper
  // (nudge.sweepIntervalMs / SPOR_NUDGE_SWEEP_INTERVAL).
  sweepInterval: cfgDefault("nudge.sweepIntervalMs"), // 30min
  // SessionEnd collects ANOTHER session's untouched spool only after this —
  // while the owner may be alive, its own next prompt is the better home.
  collectForeign: 21600000, // 6h
  // Journal GC cadence (gc.intervalMs / SPOR_GC_INTERVAL).
  gcInterval: cfgDefault("gc.intervalMs"), // 1d
  // Journal GC deletes a dead session's spool dir past this
  // (gc.maxAgeMs / SPOR_GC_MAX_AGE) — the last horizon of all.
  gcMaxAge: cfgDefault("gc.maxAgeMs"), // 14d
});

// A temp name no other writer can collide with — pid alone is not enough when
// one process writes the same target twice in flight, or two hosts share a
// home over a network filesystem.
function tmpName(file) {
  return `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
}

// Write `data` to `file` so a concurrent reader sees the old file, the new
// file, or no file — never a prefix of one. Throws on failure (the temp file
// is removed first); fail-open callers wrap it. {mkdir: true} creates the
// parent directory first; {mode} is the permission bits the file lands with
// (the temp file is created and chmod'd to it BEFORE the rename, so the target
// never exists with wider bits than asked — and a rename over an existing file
// would otherwise swap in the temp file's default mode). {durable} fsyncs the
// temp file before the rename and the parent directory after, so a crash cannot
// leave a zero-length or stale target (credentials/config; off for hot spools).
function writeSpoolFile(file, data, opts = {}) {
  if (opts.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    const fd = fs.openSync(tmp, "w", opts.mode != null ? opts.mode : 0o666);
    try {
      if (opts.mode != null) {
        try {
          fs.fchmodSync(fd, opts.mode); // create-mode is umask-filtered; enforce it
        } catch {
          /* platform without POSIX perms */
        }
      }
      fs.writeFileSync(fd, data);
      if (opts.durable) fs.fsyncSync(fd); // data on disk BEFORE the rename can reach it
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    if (opts.durable) fsyncDir(path.dirname(file)); // make the rename itself survive a crash
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

// fsync a directory so a rename/create inside it is durable. Best effort: a
// platform that cannot open or sync a directory (Windows) skips it — the file
// fsync before the rename is the part that prevents a zero-length target.
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* unsupported on this platform/filesystem */
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

// Create `file` with `data` if and only if nothing occupies it yet, and make
// it appear COMPLETE or not at all. Returns true when this call created it,
// false when another actor won the race; throws on a real IO failure, so a
// caller can tell "someone else has it" from "we could not write".
//
// hardlink-then-unlink is the primitive that gives both properties at once:
// the temp file is fully written before it is linked, and link() fails with
// EEXIST rather than clobbering. Where the filesystem has no usable link()
// (EPERM/EOPNOTSUPP/ENOSYS on some mounts), the fallback must keep BOTH — an
// in-place `wx` write keeps exclusivity but gives up atomicity, and a
// concurrent drain that reads a half-written node parses a matching
// `capture_key` out of complete frontmatter, calls the finding settled, and
// consumes the only spool copy of a body that was never written. So the
// fallback reserves the pathname with the exclusive create and then RENAMES
// the finished temp file over its own reservation.
function createExclusive(file, data) {
  const tmp = tmpName(file);
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (e) {
      if (e && e.code === "EEXIST") return false;
      if (e && ["EPERM", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(e.code)) {
        // `wx` is an ATOMIC exclusive create everywhere — it is only the
        // WRITING that is not atomic — so use it purely as the reservation and
        // let rename() publish the bytes. Nobody else can hold this
        // reservation, so the rename replaces a placeholder that is provably
        // ours and never another actor's file.
        let fd;
        try {
          fd = fs.openSync(file, "wx");
        } catch (e2) {
          if (e2 && e2.code === "EEXIST") return false;
          throw e2;
        }
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
        try {
          fs.renameSync(tmp, file);
          return true;
        } catch (e3) {
          // Hand the pathname back rather than leaving an empty file squatting
          // it: the caller keeps its debt and a later pass retries the same
          // name instead of minting a longer one.
          try {
            fs.rmSync(file, { force: true });
          } catch {
            /* best effort */
          }
          throw e3;
        }
      }
      throw e;
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// Is `pid` a live process? A spool claim encodes only the pid (its name is
// the whole token), so this is the shared identity check with no start ticks
// to verify: EPERM-tolerant liveness, the TTL in the claim name standing in
// for the recycled-pid case (process-identity.js).
function pidAlive(pid) {
  return isOurProcess(pid).reallyAlive;
}

// Atomic CLAIM on an async-nudge spool result (dec-spor-nudge-drain-atomic-claim).
// Both drains read the same `<hash>.out.json` — the prompt-time one injects it,
// the SessionEnd one captures it — so without a claim an overlapping pair can
// act on ONE finding twice. The claim is a rename, not a check-then-act: exactly
// one caller's rename succeeds and every loser gets ENOENT and skips. Two
// properties make it safe for a drain that must not destroy what it cannot yet
// place: the claimed name still ends in `.out.json`, so a result the SessionEnd
// drain deliberately KEEPS (a transient failure) stays visible to every later
// sweep, and a crash between the claim and the capture strands nothing. Any
// previous claim segment is stripped first, so re-claiming across sweeps cannot
// grow the name. Returns the claimed basename, or null when the claim was lost.
//
// That same visibility is why a claim is not only taken but HELD: a name ending
// in `.out.json` can be re-claimed the instant it is written, including while
// its first owner is still acting on it — the double action the claim exists to
// stop (the prompt drain injecting a finding the SessionEnd drain is
// mid-capture, say). So a claim stamped by a pid that is still ALIVE is refused
// until it goes stale. Liveness, not a bare timeout, is what makes the hold
// safe for a last-chance drain: a hook process is over in milliseconds, so it
// hands its claim back by exiting, and only a drain genuinely still running
// keeps one. The TTL is the backstop for the one case liveness misreads — a
// recycled pid — and bounds any hold at SPOOL_TTL.claimHold.
//
// `suffix` (default `.out.json`) is the spool's file suffix, kept on the
// claimed name. The remote outbox claims through this same function with its
// own suffixes (`.capture.json` / `.json`), so a claimed capture still routes
// to the same endpoint and still counts in `spoolStats` (doctor's outbox age).
const SUFFIX_RE_CACHE = new Map();
function claimRes(suffix) {
  let r = SUFFIX_RE_CACHE.get(suffix);
  if (!r) {
    const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    r = { strip: new RegExp(`(?:\\.claim-\\d+-\\d+)?${esc}$`), stamp: new RegExp(`\\.claim-(\\d+)-(\\d+)${esc}$`) };
    SUFFIX_RE_CACHE.set(suffix, r);
  }
  return r;
}
function spoolResultHash(f, suffix = ".out.json") {
  return f.replace(claimRes(suffix).strip, "");
}
function claimHeldByLiveOwner(f, suffix = ".out.json") {
  const m = claimRes(suffix).stamp.exec(f);
  if (!m) return false;
  const pid = Number(m[1]);
  if (pid === process.pid) return false; // our own claim is ours to retake
  if (Date.now() - Number(m[2]) >= SPOOL_TTL.claimHold) return false;
  return pidAlive(pid); // alive: it may still be acting on this finding
}

// The optional `status` out-param records WHY a claim came back null, because
// the three reasons are not the same fact and a caller that collapses them
// destroys work (F16/F17): "held" — a live owner has it and has not yet decided
// what its bytes even are; "gone" — it was renamed or consumed out from under
// us, which says who no longer has it, never that a verdict was reached;
// "failed" — the claim RENAME itself failed (EACCES, EBUSY, EIO, a Windows
// sharing violation), so nobody owns it, nothing was read, and the result is
// still sitting there recoverable. None of the three is a read verdict, so none
// of them is proof that the worker input backing it may be deleted.
function claimSpoolResult(dir, f, status, suffix = ".out.json") {
  const say = (outcome) => {
    if (status) status.outcome = outcome;
  };
  if (claimHeldByLiveOwner(f, suffix)) {
    say("held");
    return null;
  }
  const claimed = `${spoolResultHash(f, suffix)}.claim-${process.pid}-${Date.now()}${suffix}`;
  try {
    fs.renameSync(path.join(dir, f), path.join(dir, claimed));
    say("claimed");
    return claimed;
  } catch (e) {
    say(e && e.code === "ENOENT" ? "gone" : "failed");
    return null;
  }
}

// Single-consumer take of a spool result whose loss is cheap (a digest
// snapshot the next prompt supersedes anyway): claim by rename, read, unlink.
// Two overlapping drains can therefore never both inject one result — the
// loser's rename gets ENOENT and it reads nothing — which the old
// read-then-unlink could not promise. Returns the parsed JSON, or null when the
// claim was lost or the bytes did not parse (either way the file is gone or
// someone else's). A live owner's held claim is left alone.
function claimAndReadJson(dir, f) {
  const claimed = claimSpoolResult(dir, f);
  if (!claimed) return null;
  const fp = path.join(dir, claimed);
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {}
  try {
    fs.unlinkSync(fp);
  } catch {}
  return r;
}

// Exclusive lock over ONE spool JOB — the `<hash>.in.json` +
// `<hash>.redriven.in.json` pair the prompt-time orphan sweep re-drives.
// COPYFILE_EXCL is the atomic claim for a FIRST re-drive, but it cannot guard
// the recovery arm, which re-copies over a `.redriven.in.json` that already
// exists: two overlapping sweeps would both copy (tearing the copy under a
// worker already reading it) and both spawn. This is that arm's missing claim
// (F17), and it covers every mutation of the pair — the settled prune
// included, so a prune can never delete files a sweep is mid-recovery on.
//
// The lock is self-healing like the result claim above — a holder that dies
// must not wedge the job forever — but it reaches that WITHOUT ever deleting
// another actor's lock (F19). A single well-known lock pathname forced the old
// shape: see it, judge it stale, unlink it, re-create it. That check-then-unlink
// is not a claim. Two sweepers could both judge one stale lock, both break it,
// and both `wx` — worse, the loser's break deletes the WINNER's fresh lock, and
// the winner's `release()` then deletes its successor's, so a third sweeper
// walks in on a pair two others are already mutating. That is precisely the
// concurrent re-copy/re-spawn the lock exists to prevent.
//
// So each contender creates ONLY its own uniquely-named lock file
// (`<hash>.redrive.lock-<pid>-<ts>-<rand>`) and deletes ONLY its own. Everything
// a racer needs to judge a lock is in its NAME, so there is no create-then-write
// window to misread and no file to read at all. Ownership is decided by a listing
// AFTER the create: you hold the job only if no OTHER live contender is present.
// Two contenders can never both win — each creates before it lists, so if A's
// listing missed B then B was created after A, and B's own listing must see A.
// A collision simply means "not ours this pass" for one or both, which is the
// safe answer: the pair is left exactly as it is for a later sweep.
//
// Staleness is per-contender and read-only: a lock whose pid is gone or whose
// stamp is past SPOOL_TTL.claimHold is IGNORED by every racer, so a crashed
// holder costs one horizon, not the job. Such a file is unlinked only when it is
// provably dead AND expired — and because every racer already ignores it, that
// unlink can neither grant nor revoke ownership.
const SPOOL_JOB_LOCK_STAMP = /^(\d+)-(\d+)-[0-9a-f]+$/;
function spoolJobLockContends(name) {
  const m = SPOOL_JOB_LOCK_STAMP.exec(name);
  if (!m) return { contends: false, prunable: false }; // not one of ours: never touch it
  const pid = Number(m[1]);
  const expired = Date.now() - Number(m[2]) >= SPOOL_TTL.claimHold;
  if (pid === process.pid) return { contends: false, prunable: false }; // ours to ignore, never to reap blindly
  const alive = pidAlive(pid);
  return { contends: alive && !expired, prunable: !alive && expired };
}
function claimSpoolJob(dir, hash) {
  const prefix = `${hash}.redrive.lock-`;
  const mine = `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const p = path.join(dir, mine);
  try {
    fs.writeFileSync(p, "", { flag: "wx" });
  } catch {
    return null; // cannot lock here at all: do not act
  }
  const release = () => {
    try {
      fs.unlinkSync(p);
    } catch {}
  };
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    release();
    return null; // cannot tell who else is here: not ours this pass
  }
  for (const f of entries) {
    if (f === mine || !f.startsWith(prefix)) continue;
    const { contends, prunable } = spoolJobLockContends(f.slice(prefix.length));
    if (contends) {
      release();
      return null; // a live contender owns the pair this pass
    }
    if (prunable) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
  return release;
}

module.exports = {
  SPOOL_TTL,
  writeSpoolFile,
  createExclusive,
  pidAlive,
  spoolResultHash,
  claimSpoolResult,
  claimAndReadJson,
  claimSpoolJob,
};
