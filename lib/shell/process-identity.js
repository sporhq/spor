"use strict";
// Run identity: is the process behind a recorded pid still the one we
// launched? (task-spor-extract-work-loop-plan-execute-and-outcome-door)
//
// A pid is not identity — pid spaces recycle, so an answering `kill(pid, 0)`
// can mean either "our process" or "some unrelated process the kernel later
// handed the same number". The identity token is the pair minted at launch:
// the pid AND the kernel's start-time tick count for it, which a reused pid
// does not inherit from its predecessor. This module is the ONE place that
// token is minted and checked; the run store (agent-dispatch-runner.js
// `isSameSupervisor`, `workerAlive`, `runSupervisorAlive`), the local
// execution lock and the spool claims all used to carry their own copy, and
// the copies had already diverged once (issue-spor-dispatch-supervisor-
// liveness-check-divergence: an EPERM probe read as "dead" in one and "alive"
// in another).

const fs = require("node:fs");

// The kernel's start-time tick count for `pid` (Linux `/proc/<pid>/stat`,
// field 22). Best-effort — null (identity unknowable) off Linux, or when the
// pid is gone or `/proc` is unreadable; callers fall back to the bare
// liveness probe then (issue-spor-dispatch-supervisor-identity-stale-timeout).
function processStartTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is parenthesized and may itself contain ")" or spaces, so
    // split after its LAST close-paren rather than assuming fixed columns.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ticks = Number(fields[19]); // field 22 (starttime): 19 fields after state (field 3)
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

// Kernel evidence for "is `pid` alive right now" — EPERM tolerant.
// `process.kill(pid, 0)` throws ESRCH when there is no such process, but also
// EPERM when the pid exists and we lack permission to signal it (it now
// belongs to another uid after a pid-space reuse); reading that as "dead"
// would misreport a permissions error. Only ESRCH (or any other error), or an
// invalid pid, means not alive.
function aliveProbe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

// The token to record at launch: `{pid, ticks}` for a process (default: this
// one). `ticks` is null where the platform cannot read it.
function mintIdentity(pid = process.pid, { readTicks = processStartTicks } = {}) {
  return { pid, ticks: readTicks(pid) };
}

// A recorded tick count, normalized. Older writers stored it as the raw
// `/proc` field (a digit string); both spellings name the same instant.
function recordedTicks(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

// The ONE answer to "is this still our process". `reallyAlive` is false for a
// dead pid or a CONFIRMED start-time mismatch (the pid was reused).
// `identityKnown` says whether the match was actually VERIFIED, as opposed to
// assumed because no tick count exists to check (an older record, a claim
// that encodes only a pid, or a non-Linux host) — a caller with its own
// fallback for the unverifiable case (a silence timeout, a TTL) branches on it.
//
// `readTicks` is an injectable seam: it is the one platform-dependent input,
// so a test can drive the match/mismatch/unknown branches on any host
// (issue-spor-dispatch-supervisor-test-tick-count-non-linux).
function isOurProcess(pid, ticksRaw = null, { readTicks = processStartTicks } = {}) {
  const want = recordedTicks(ticksRaw);
  const alive = aliveProbe(pid);
  const current = alive ? readTicks(pid) : null;
  const identityKnown = alive && want != null && current != null;
  const identityMismatch = identityKnown && current !== want;
  return { reallyAlive: alive && !identityMismatch, identityKnown };
}

module.exports = { processStartTicks, aliveProbe, mintIdentity, recordedTicks, isOurProcess };
