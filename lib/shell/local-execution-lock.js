"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const host = require("node:os").hostname();
const { isOurProcess, mintIdentity } = require("./process-identity.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
// The owner token is the shared run identity (process-identity.js): dead only
// on positive evidence — no such pid, or a confirmed start-time mismatch. An
// unverifiable identity (no ticks recorded, or none readable) stays alive, so
// an unknown owner fails closed.
function dead(owner) {
  if (owner?.host !== host || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  return !isOurProcess(owner.pid, owner.ticks).reallyAlive;
}
function removeOwn(file, owner) {
  if (read(file)?.token === owner.token) try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
// On Windows a lock file just unlinked while another contender still has it
// open (every contender read()s it) stays "delete pending", and an exclusive
// create of that name fails EPERM/EACCES instead of EEXIST until the last
// handle closes. That is the lock being held a moment longer, so it reads as
// "not created" and the caller's bounded wait retries
// (issue-spor-main-ci-windows-dispatch-flakes-red-3ab8e46).
const PENDING_DELETE_CODES = new Set(["EPERM", "EACCES"]);
function occupied(e) {
  return e.code === "EEXIST" || (process.platform === "win32" && PENDING_DELETE_CODES.has(e.code));
}
function create(file, owner) {
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); } catch (e) {
    if (occupied(e)) return false;
    throw e;
  }
  try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
  return true;
}
// Is a lock a breaker moved aside (`<lock>.dead-<token>`) still held by a
// process that is not positively gone? Then a breaker may have been
// restoring it, and the breaker is not judgeable from here.
function movedLockLive(lock) {
  const dir = path.dirname(lock), stem = `${path.basename(lock)}.dead-`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return true; }
  return names.some(n => n.startsWith(stem) && !dead(read(path.join(dir, n))));
}
// Remove `<lock>.break` when `judge(breakerPath)` says its holder is gone
// (issue-spor-execution-store-residual-hardening: a breaker that died
// mid-break otherwise wedges the lock until the GC sweep's 15-minute
// horizon). A breaker is removed BY NAME, which is only safe while nobody
// else can remove the judged file first and let a live breaker take the path
// before the unlink lands. So every by-name removal — an acquirer's here, the
// sweep's through the same door — runs under the exclusive guard
// `<lock>.break.clear`, re-judging under it: a breaker's own holder removes
// only its own token, so under the guard the file judged dead is the file
// unlinked. A guard that is held means "not now", never a wait. A moved lock
// still held by a live process means a live holder's lock may be off its path
// mid-restore: not judgeable, the breaker stays (fail closed). A guard left by
// a clearer that died in its microsecond window is the sweep's to remove.
function clearBreaker(lock, judge, owner = { host, ...mintIdentity(), token: crypto.randomUUID() }) {
  const breaker = `${lock}.break`, guard = `${breaker}.clear`;
  if (!judge(breaker) || !create(guard, owner)) return false;
  try {
    if (!judge(breaker) || movedLockLive(lock)) return false;
    try { fs.unlinkSync(breaker); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  } finally { removeOwn(guard, owner); }
}
// A live process never loses exclusion because its transaction is slow.
// A lock from another host is never judged by this host's PID table. Unknown
// or malformed ownership fails closed; recovery requires stopped writers. A
// breaker left by a dead process is cleared (clearBreaker).
async function withLocalExecutionLock(file, fn, { attempts = 500, waitMs = 10 } = {}) {
  const lock = `${file}.lock`, breaker = `${lock}.break`;
  const owner = { host, ...mintIdentity(), token: crypto.randomUUID() };
  for (let i = 0; i < attempts; i++) {
    if (fs.existsSync(breaker)) clearBreaker(lock, f => dead(read(f)), owner);
    if (create(lock, owner)) {
      if (fs.existsSync(breaker)) { removeOwn(lock, owner); await sleep(waitMs); continue; }
      try {
        const value = await fn();
        return { ok: true, value };
      } finally { removeOwn(lock, owner); }
    }
    if (dead(read(lock)) && create(breaker, owner)) {
      let safeToRelease = true;
      try {
        // Acquirers must check the breaker after their exclusive open. A
        // successor may appear between inspection and rename; inspect the
        // moved inode and restore it before allowing another holder through.
        if (dead(read(lock))) {
          const moved = `${lock}.dead-${owner.token}`;
          try { fs.renameSync(lock, moved); } catch (e) { if (e.code !== "ENOENT") throw e; }
          if (fs.existsSync(moved)) {
            if (dead(read(moved))) fs.unlinkSync(moved);
            else {
              let restored = false;
              for (let n = 0; n < attempts; n++) {
                // A racer's just-released lock is delete-pending on Windows,
                // so the link fails EPERM/EACCES instead of EEXIST: the path
                // is still occupied, and the handback waits it out the same.
                try { fs.linkSync(moved, lock); restored = true; break; } catch (e) { if (!occupied(e)) throw e; await sleep(waitMs); }
              }
              if (!restored) { safeToRelease = false; throw new Error("local execution lock handback blocked"); }
              fs.unlinkSync(moved);
            }
          }
        }
      } catch (e) { safeToRelease = false; throw e; } finally { if (safeToRelease) removeOwn(breaker, owner); }
    }
    await sleep(waitMs);
  }
  return { ok: false, reason: "local execution item lock contended" };
}
// Is the lock artifact at `file` (a `.lock`, its `.break`, or a breaker's
// moved `.dead-<token>`) held by a process positively gone from THIS host?
// The same reading the breaker makes; unknown, malformed or foreign-host
// ownership is never dead, so a sweeper that trusts it fails closed.
function lockHolderDead(file) {
  return dead(read(file));
}
module.exports = { withLocalExecutionLock, lockHolderDead, clearBreaker };
