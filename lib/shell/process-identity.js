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
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");
const { powershellPath } = require("./windows-process-tree.js");

// The start-time token for `pid`: a non-negative integer the OS fixes when
// the process is created, which a later process handed the same pid does not
// share. Its UNIT is per-platform, and a token is only ever compared with
// another read on the same host:
//
//   - Linux: the kernel's start-time tick count (`/proc/<pid>/stat`, field 22).
//   - Windows: the process creation time, in milliseconds since the Unix epoch
//     (PowerShell: `Get-Process` `.StartTime`, falling back to CIM
//     `Win32_Process.CreationDate` for a process this user cannot open — a
//     recycled pid is often exactly that). Both sources are floored to the
//     millisecond so either one names the same instant.
//   - macOS and other POSIX hosts: the start time from `ps -o lstart=`, in
//     seconds since the Unix epoch (ps's precision), read with `LC_ALL=C` and
//     `TZ=UTC0` pinned so the spelling does not drift with the caller's locale
//     or timezone.
//
// Best-effort — null (identity unknowable) when the pid is gone or the source
// is unreadable; callers fall back to the bare liveness probe then
// (issue-spor-dispatch-supervisor-identity-stale-timeout). The record field
// shape (a plain integer under `*_started_ticks`) is the same on every platform
// (issue-spor-process-identity-start-time-off-linux).
function processStartTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return processStartTicksMany([pid]).get(pid);
}

// Several pids' tokens in ONE read (a Map pid -> token|null): off Linux each
// read is a process spawn, so a caller that needs two (a supervisor stamping
// itself and its child) pays for one.
function processStartTicksMany(pids) {
  const want = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map(want.map((p) => [p, null]));
  if (hostPlatform === "linux") {
    for (const p of want) out.set(p, linuxStartTicks(p));
    return out;
  }
  // This process's own token never changes, and it is minted on hot paths
  // (every lock name), so it is read once. Any OTHER pid is read fresh —
  // a cached answer for it is exactly what a recycled pid would get wrong —
  // except inside one identity PASS (below), which bounds the cache to a
  // single synchronous stretch of work.
  if (selfTicks != null && out.has(process.pid)) out.set(process.pid, selfTicks);
  const cached = new Set(passCache ? want.filter((p) => out.get(p) == null && passFresh(p)) : []);
  for (const p of cached) out.set(p, passCache.get(p).ticks);
  const read = want.filter((p) => out.get(p) == null && !cached.has(p));
  if (read.length) {
    // Stamped from BEFORE the read: a start time was sampled somewhere inside
    // the spawn, so its age counts from the spawn's start. A failed (null)
    // read is not cached — the next check retries it, as it always did.
    const at = performance.now();
    const got = readOffLinux(read);
    const ttl = performance.now() - at + PASS_FRESH_MS;
    for (const [p, t] of got) {
      out.set(p, t);
      if (passCache && t != null) passCache.set(p, { ticks: t, at, ttl });
    }
  }
  if (out.get(process.pid) != null) selfTicks = out.get(process.pid); // a failed read is retried, not cached
  return out;
}
let selfTicks;
let hostPlatform = process.platform;
let readOffLinux = (pids) => (hostPlatform === "win32" ? windowsStartTicksMany(pids) : psStartTicksMany(pids));

// An identity PASS (issue-spor-windows-identity-read-powershell-boot-hot-paths):
// off Linux every start-time read is a process spawn — on Windows a PowerShell
// boot of 0.5-1s — and the hot paths (a lock listing in spool.js and
// preflight.js, activeRuns, the run reconcile, the worker-status read) used to
// pay one per pid they judged. Inside `withIdentityPass(fn)` a pid's token is
// read at most ONCE, and `prefetchStartTicks(pids)` reads every pid a pass is
// about to judge in ONE spawn. The cache lives at most as long as `fn`'s
// synchronous run (a pass is a listing, not a session).
//
// The trade, stated plainly: an unbatched check probes THEN reads, so a pid
// recycled before the read shows a mismatch. A cached read came BEFORE the
// check's probe, so a process that died and had its pid handed to a new one in
// between would be judged against its predecessor's start time and read as
// ours. That window is bounded: an entry is a miss, read again, once older than
// its read's own duration plus PASS_FRESH_MS (monotonic clock) — so a pass that
// does slow work between checks (the reconcile takes record locks, removes
// scratch dirs, kills process trees) re-reads a late record rather than judging
// it against a start time read seconds earlier. Passes nest (the outermost
// owns the cache).
// Linux is untouched: a `/proc` read costs nothing to repeat, and repeating it
// keeps every check reading the kernel at the moment it asks.
let passCache = null;
const PASS_FRESH_MS = 500;
function passFresh(pid) {
  const e = passCache && passCache.get(pid);
  return Boolean(e) && performance.now() - e.at <= e.ttl;
}
function withIdentityPass(fn) {
  if (passCache || hostPlatform === "linux") return fn();
  passCache = new Map();
  try {
    return fn();
  } finally {
    passCache = null;
  }
}

// Read, in one spawn, every pid in `pids` that is alive right now and not yet
// read in the current pass. Outside a pass (or on Linux) it does nothing, so a
// caller can prefetch unconditionally. Only LIVE pids are read: a gone pid's
// check never reads (isOurProcess probes first), and on Windows each dead pid
// costs the batch a CIM query.
function prefetchStartTicks(pids, { alive: probe = aliveProbe } = {}) {
  if (!passCache) return;
  const want = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid && !passFresh(p) && probe(p));
  if (want.length) processStartTicksMany(want);
}

function linuxStartTicks(pid) {
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

const READ_TIMEOUT_MS = 15000;

// `ps -o lstart=` prints e.g. `Mon Oct  3 07:50:17 2026` (C locale).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/;
function parseLstart(text) {
  const m = LSTART.exec(String(text || "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}

// One `ps` for every pid asked about: `<pid> <lstart>` per live one.
function psStartTicksMany(pids, { run = spawnSync } = {}) {
  const out = new Map(pids.map((p) => [p, null]));
  try {
    // By absolute path, never a PATH lookup (dec-spor-client-zero-dep-admits-os-binaries).
    const r = run("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      timeout: READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Not gated on the exit status: ps exits non-zero when ANY pid is gone,
    // and the live ones are still listed.
    for (const line of String((r && r.stdout) || "").split("\n")) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m && out.has(Number(m[1]))) out.set(Number(m[1]), parseLstart(m[2]));
    }
  } catch {
    /* unreadable: every token stays null */
  }
  return out;
}
function psStartTicks(pid, opts) {
  return psStartTicksMany([pid], opts).get(pid);
}

// FILETIME (100ns ticks since 1601-01-01 UTC) -> whole ms since the Unix epoch.
// BigInt, because a FILETIME is past 2^53 and a Number would round it.
const FILETIME_UNIX_EPOCH = 116444736000000000n;
function parseFileTime(text) {
  const s = String(text || "").trim();
  if (!/^\d+$/.test(s)) return null;
  const ft = BigInt(s);
  if (ft <= FILETIME_UNIX_EPOCH) return null;
  return Number((ft - FILETIME_UNIX_EPOCH) / 10000n);
}

// One PowerShell for every pid asked about (its boot is the whole cost):
// `<pid> <FILETIME>` per live one.
function windowsStartTicksMany(pids, { run = spawnSync } = {}) {
  const out = new Map(pids.map((p) => [p, null]));
  const script =
    `foreach ($i in @(${pids.join(",")})) { $t = $null; ` +
    `$p = Get-Process -Id $i -ErrorAction SilentlyContinue; ` +
    `try { if ($p) { $t = $p.StartTime } } catch { $t = $null }; ` +
    `if (-not $t) { $c = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $i) -ErrorAction SilentlyContinue; if ($c) { $t = $c.CreationDate } }; ` +
    `if ($t) { '' + $i + ' ' + $t.ToFileTimeUtc() } }`;
  try {
    const r = run(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!r || r.status !== 0) return out;
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m && out.has(Number(m[1]))) out.set(Number(m[1]), parseFileTime(m[2]));
    }
  } catch {
    /* unreadable: every token stays null */
  }
  return out;
}
function windowsStartTicks(pid, opts) {
  return windowsStartTicksMany([pid], opts).get(pid);
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
// that encodes only a pid, or a host whose start-time source is unreadable) — a caller with its own
// fallback for the unverifiable case (a silence timeout, a TTL) branches on it.
//
// `readTicks` is an injectable seam: it is the one platform-dependent input,
// so a test can drive the match/mismatch/unknown branches on any host
// (issue-spor-dispatch-supervisor-test-tick-count-non-linux).
function isOurProcess(pid, ticksRaw = null, { readTicks = processStartTicks, alive: probe = aliveProbe } = {}) {
  const want = recordedTicks(ticksRaw);
  const alive = probe(pid);
  // No recorded token means nothing to compare: skip the read, which off Linux
  // is a process spawn (a PowerShell boot on Windows) on hook paths.
  const current = alive && want != null ? readTicks(pid) : null;
  // A read that found nothing may mean the process exited DURING it (off
  // Linux the read is a process spawn, wide enough for a short-lived process
  // holding a recycled pid to come and go): ask again rather than report a
  // process that is gone as alive-but-unverifiable.
  const stillAlive = alive && want != null && current == null ? probe(pid) : alive;
  const identityKnown = stillAlive && want != null && current != null;
  const identityMismatch = identityKnown && current !== want;
  return { reallyAlive: stillAlive && !identityMismatch, identityKnown };
}

module.exports = {
  processStartTicks, processStartTicksMany, withIdentityPass, prefetchStartTicks, aliveProbe, mintIdentity, recordedTicks, isOurProcess,
  // platform readers, exported for their parsing tests on any host
  psStartTicks, psStartTicksMany, windowsStartTicks, windowsStartTicksMany, parseLstart, parseFileTime,
  // test seam: drive the off-Linux path (and count its spawns) on any host;
  // returns the restore function
  PASS_FRESH_MS,
  _setHost({ platform, read }) {
    const prev = { hostPlatform, readOffLinux, selfTicks };
    hostPlatform = platform;
    readOffLinux = read;
    selfTicks = undefined;
    return () => ({ hostPlatform, readOffLinux, selfTicks } = prev);
  },
};
