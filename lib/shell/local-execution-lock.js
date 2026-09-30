"use strict";
const fs = require("node:fs");
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
function create(file, owner) {
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
  return true;
}
// A live process never loses exclusion because its transaction is slow.
// A lock from another host is never judged by this host's PID table. Unknown
// or malformed ownership and abandoned breaker locks fail closed; recovery
// requires stopped writers.
async function withLocalExecutionLock(file, fn, { attempts = 500, waitMs = 10 } = {}) {
  const lock = `${file}.lock`, breaker = `${lock}.break`;
  const owner = { host, ...mintIdentity(), token: crypto.randomUUID() };
  for (let i = 0; i < attempts; i++) {
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
                try { fs.linkSync(moved, lock); restored = true; break; } catch (e) { if (e.code !== "EEXIST") throw e; await sleep(waitMs); }
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
module.exports = { withLocalExecutionLock };
