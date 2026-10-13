"use strict";
// The start-time half of the run-identity token on every OS
// (issue-spor-process-identity-start-time-off-linux): Linux reads /proc,
// macOS (and other POSIX hosts) `ps -o lstart=`, Windows the process creation
// time via PowerShell. A recycled pid with a different start time must read
// as NOT ours on each of them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const identity = require("../lib/shell/process-identity.js");

function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  return child;
}

test("processStartTicks reads a real start time for this process and a child on this OS", () => {
  const mine = identity.processStartTicks(process.pid);
  assert.equal(Number.isInteger(mine) && mine > 0, true, `a start time for this process on ${process.platform}`);
  assert.equal(identity.processStartTicks(process.pid), mine, "stable across reads");
  const child = spawnSleeper();
  try {
    const ticks = identity.processStartTicks(child.pid);
    assert.equal(Number.isInteger(ticks) && ticks > 0, true, `a start time for a child on ${process.platform}`);
    assert.equal(identity.processStartTicks(child.pid), ticks, "a child's token is stable across reads");
    assert.ok(ticks >= mine, "a child cannot have started before its parent");
  } finally {
    child.kill();
  }
});

test("a reused pid (same pid, different recorded start time) is detected with the real reader on this OS", () => {
  const child = spawnSleeper();
  try {
    const ticks = identity.processStartTicks(child.pid);
    assert.equal(typeof ticks, "number");
    assert.deepEqual(identity.isOurProcess(child.pid, ticks), { reallyAlive: true, identityKnown: true });
    // The token a predecessor holding this pid would have recorded: any other start time.
    assert.deepEqual(identity.isOurProcess(child.pid, ticks - 1), { reallyAlive: false, identityKnown: true });
    assert.deepEqual(identity.isOurProcess(child.pid, String(ticks + 1)), { reallyAlive: false, identityKnown: true });
  } finally {
    child.kill();
  }
});

test("a gone pid reads as not ours and has no start time", async () => {
  const child = spawnSleeper();
  const pid = child.pid;
  const ticks = identity.processStartTicks(pid);
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGKILL");
  });
  assert.equal(identity.processStartTicks(pid), null);
  assert.equal(identity.isOurProcess(pid, ticks).reallyAlive, false);
});

// --- the platform readers, driven on any host through their `run` seam ---

const ran = (stdout, status = 0) => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status, stdout };
  };
  return { run, calls };
};

test("macOS: ps lstart is read in the C locale at UTC and normalized to epoch seconds", () => {
  const { run, calls } = ran("4242 Mon Oct 13 07:50:17 2026\n");
  assert.equal(identity.psStartTicks(4242, { run }), Date.UTC(2026, 9, 13, 7, 50, 17) / 1000);
  assert.equal(calls[0].cmd, "/bin/ps", "ps by absolute path");
  assert.deepEqual(calls[0].args, ["-o", "pid=,lstart=", "-p", "4242"]);
  assert.equal(calls[0].opts.env.LC_ALL, "C");
  assert.equal(calls[0].opts.env.TZ, "UTC0");
  // A single-digit day is space-padded.
  assert.equal(identity.parseLstart("Fri Oct  3 01:02:03 2026"), Date.UTC(2026, 9, 3, 1, 2, 3) / 1000);
  // A pid reused one second later is a different token.
  const a = identity.psStartTicks(4242, { run: ran("4242 Mon Oct 13 07:50:17 2026\n").run });
  const b = identity.psStartTicks(4242, { run: ran("4242 Mon Oct 13 07:50:18 2026\n").run });
  assert.notEqual(a, b);
  assert.deepEqual(identity.isOurProcess(process.pid, a, { readTicks: () => b }), { reallyAlive: false, identityKnown: true });
  // Gone pid (ps exits 1, prints nothing) and junk are unknowable, not a match.
  assert.equal(identity.psStartTicks(4242, { run: ran("", 1).run }), null);
  assert.equal(identity.psStartTicks(4242, { run: ran("garbage\n").run }), null);
  assert.equal(identity.psStartTicks(4242, { run: () => { throw new Error("ENOENT"); } }), null);
  // Several pids in ONE ps: a gone one (ps exits 1) does not hide the live one.
  const many = ran("  7 Mon Oct 13 07:50:17 2026\n", 1);
  const got = identity.psStartTicksMany([7, 8], { run: many.run });
  assert.equal(many.calls.length, 1);
  assert.deepEqual(many.calls[0].args, ["-o", "pid=,lstart=", "-p", "7,8"]);
  assert.deepEqual([...got], [[7, Date.UTC(2026, 9, 13, 7, 50, 17) / 1000], [8, null]]);
});

test("Windows: the creation FILETIME is normalized to epoch milliseconds without float rounding", () => {
  // 2026-10-13T07:50:17.1234567Z as a FILETIME (100ns since 1601).
  const ms = Date.UTC(2026, 9, 13, 7, 50, 17, 123);
  const ft = (BigInt(ms) * 10000n + 4567n + 116444736000000000n).toString();
  const { run, calls } = ran(`77 ${ft}\r\n`);
  assert.equal(identity.windowsStartTicks(77, { run }), ms);
  assert.match(calls[0].cmd, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/, "PowerShell by absolute path");
  const script = calls[0].args.at(-1);
  assert.match(script, /foreach \(\$i in @\(77\)\)/);
  assert.match(script, /Get-Process -Id \$i\b/);
  assert.match(script, /'ProcessId=' \+ \$i/, "falls back to CIM for a process we cannot open");
  assert.doesNotMatch(script, /"/, "no double quotes for the Windows argv quoting to mangle");
  // Get-Process (100ns) and CIM (µs) spell one instant the same once floored to ms.
  const cim = (BigInt(ms) * 10000n + 4560n + 116444736000000000n).toString();
  assert.equal(identity.parseFileTime(cim), ms);
  // A pid reused a millisecond later is a different token.
  const later = identity.windowsStartTicks(77, { run: ran(`77 ${(BigInt(ms + 1) * 10000n + 116444736000000000n).toString()}\r\n`).run });
  assert.deepEqual(identity.isOurProcess(process.pid, ms, { readTicks: () => later }), { reallyAlive: false, identityKnown: true });
  assert.equal(identity.windowsStartTicks(77, { run: ran("", 0).run }), null, "no such process: PowerShell prints nothing");
  assert.equal(identity.windowsStartTicks(77, { run: ran("x", 1).run }), null);
  assert.equal(identity.windowsStartTicks(77, { run: () => { throw new Error("ENOENT"); } }), null);
  // Several pids in ONE PowerShell boot.
  const many = ran(`5 ${ft}\r\n`);
  const got = identity.windowsStartTicksMany([5, 6], { run: many.run });
  assert.equal(many.calls.length, 1);
  assert.match(many.calls[0].args.at(-1), /@\(5,6\)/);
  assert.deepEqual([...got], [[5, ms], [6, null]]);
});

test("processStartTicksMany reads several real pids at once and agrees with the single read", () => {
  const child = spawnSleeper();
  try {
    const got = identity.processStartTicksMany([process.pid, child.pid, child.pid, -1]);
    assert.deepEqual([...got.keys()], [process.pid, child.pid]);
    assert.equal(got.get(process.pid), identity.processStartTicks(process.pid));
    assert.equal(got.get(child.pid), identity.processStartTicks(child.pid));
    assert.equal(typeof got.get(child.pid), "number");
  } finally {
    child.kill();
  }
});

test("isOurProcess: a pid that dies DURING the start-time read is dead, not alive-but-unverifiable", () => {
  const answers = [true, false]; // alive at the probe, gone once the slow read returns empty
  const alive = () => answers.shift();
  assert.deepEqual(identity.isOurProcess(4242, 123, { readTicks: () => null, alive }), { reallyAlive: false, identityKnown: false });
  // Still there after an empty read: alive, and unverifiable — the old answer.
  assert.deepEqual(identity.isOurProcess(4242, 123, { readTicks: () => null, alive: () => true }), { reallyAlive: true, identityKnown: false });
  // No recorded token: no read, so no second probe either.
  let probes = 0;
  assert.deepEqual(identity.isOurProcess(4242, null, { readTicks: () => { throw new Error("must not read"); }, alive: () => (probes++, true) }), { reallyAlive: true, identityKnown: false });
  assert.equal(probes, 1);
});

// --- identity passes (issue-spor-windows-identity-read-powershell-boot-hot-paths)
// Off Linux every start-time read is a process spawn (a PowerShell boot on
// Windows), so a hot path judging N pids must pay ONE read, not N. The host
// seam drives the off-Linux path on any OS and counts the reads.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fakeHost(platform = "win32") {
  const calls = [];
  const restore = identity._setHost({
    platform,
    read: (pids) => {
      calls.push([...pids]);
      return new Map(pids.map((p) => [p, 1000 + p]));
    },
  });
  return { calls, restore };
}

function withSleepers(n, fn) {
  const kids = Array.from({ length: n }, spawnSleeper);
  return Promise.resolve()
    .then(() => fn(kids.map((k) => k.pid)))
    .finally(() => kids.forEach((k) => k.kill()));
}

test("outside a pass, every off-Linux read of another pid is a fresh spawn", async () => {
  await withSleepers(1, ([pid]) => {
    const { calls, restore } = fakeHost();
    try {
      assert.equal(identity.isOurProcess(pid, 1000 + pid).reallyAlive, true);
      assert.equal(identity.isOurProcess(pid, 1000 + pid).reallyAlive, true);
      assert.equal(calls.length, 2, "no cache across checks outside a pass");
    } finally {
      restore();
    }
  });
});

test("inside a pass, a prefetch reads every live pid in ONE spawn and the checks reuse it", async () => {
  await withSleepers(3, (pids) => {
    const { calls, restore } = fakeHost();
    try {
      const dead = 2 ** 22 + 12345; // beyond any default pid_max: not alive
      const verdicts = identity.withIdentityPass(() => {
        identity.prefetchStartTicks([...pids, dead, process.pid, pids[0]]);
        assert.equal(calls.length, 1, "one read for the whole pass");
        assert.deepEqual(calls[0].sort(), [...pids].sort(), "only live, distinct, non-self pids are read");
        // nested pass shares the outer cache
        return identity.withIdentityPass(() => pids.map((p) => identity.isOurProcess(p, 1000 + p)));
      });
      assert.equal(calls.length, 1, "the checks read nothing more");
      assert.deepEqual(verdicts, pids.map(() => ({ reallyAlive: true, identityKnown: true })));
      // a mismatch is still a mismatch from the cache
      identity.withIdentityPass(() => {
        identity.prefetchStartTicks(pids);
        assert.deepEqual(identity.isOurProcess(pids[0], 7), { reallyAlive: false, identityKnown: true });
      });
      // the cache dies with the pass
      identity.isOurProcess(pids[0], 1000 + pids[0]);
      assert.equal(calls.length, 3);
      // an un-prefetched pid inside a pass is read once, then reused
      identity.withIdentityPass(() => {
        identity.isOurProcess(pids[1], 1000 + pids[1]);
        identity.isOurProcess(pids[1], 1000 + pids[1]);
      });
      assert.equal(calls.length, 4);
      // an entry past its freshness bound is read again, even inside the pass
      identity.withIdentityPass(() => {
        identity.prefetchStartTicks(pids);
        const until = Date.now() + identity.PASS_FRESH_MS + 20;
        while (Date.now() < until) { /* a pass doing slow work between checks */ }
        identity.isOurProcess(pids[2], 1000 + pids[2]);
      });
      assert.equal(calls.length, 6, "a stale entry is a miss");
    } finally {
      restore();
    }
  });
});

test("a failed (null) read inside a pass is not cached: the next check retries it", async () => {
  await withSleepers(1, ([pid]) => {
    let fail = true;
    const calls = [];
    const restore = identity._setHost({ platform: "win32", read: (pids) => (calls.push(pids), new Map(pids.map((p) => [p, fail ? null : 1000 + p]))) });
    try {
      identity.withIdentityPass(() => {
        identity.prefetchStartTicks([pid]);
        fail = false;
        assert.deepEqual(identity.isOurProcess(pid, 1000 + pid), { reallyAlive: true, identityKnown: true });
      });
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });
});

test("prefetch outside a pass, and any pass on Linux, reads nothing", async () => {
  await withSleepers(1, ([pid]) => {
    let h = fakeHost();
    try {
      identity.prefetchStartTicks([pid]);
      assert.equal(h.calls.length, 0);
    } finally {
      h.restore();
    }
    h = fakeHost("linux");
    try {
      identity.withIdentityPass(() => identity.prefetchStartTicks([pid]));
      assert.equal(h.calls.length, 0, "Linux reads /proc per check and never caches");
    } finally {
      h.restore();
    }
  });
});

test("the hot paths judge N pids with ONE read: activeRuns, reconcileRuns, worker statuses, spool and workspace locks", async () => {
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const workLoop = require("../lib/shell/work-loop.js");
  const spool = require("../lib/shell/spool.js");
  const preflight = require("../lib/shell/preflight.js");
  await withSleepers(3, async (pids) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-identity-pass-"));
    const { calls, restore } = fakeHost();
    try {
      const runDir = path.join(home, "journal", "dispatch");
      fs.mkdirSync(runDir, { recursive: true });
      pids.forEach((p, i) => {
        const rec = { run_id: `r${i}`, state: "running", launch_mode: "supervised-jsonl", runner_pid: p, runner_started_ticks: 1000 + p, started_at: new Date().toISOString() };
        fs.writeFileSync(path.join(runDir, `r${i}.run.json`), JSON.stringify(rec));
      });
      assert.equal(dispatchRuns.activeRuns(home, {}).length, 3);
      assert.equal(calls.length, 1, "activeRuns: one read for three supervisors");

      calls.length = 0;
      const reconciled = dispatchRuns.reconcileRuns(home);
      assert.equal(reconciled.filter((r) => r.state === "running").length, 3, "live supervisors stay open");
      assert.equal(calls.length, 1, "reconcileRuns: one read for three supervisors");

      calls.length = 0;
      const workDir = path.join(home, "journal", "work");
      fs.mkdirSync(workDir, { recursive: true });
      pids.forEach((p, i) => fs.writeFileSync(path.join(workDir, `w${i}.work.json`), JSON.stringify({ worker_id: `w${i}`, pid: p, started_ticks: 1000 + p, started_at: new Date().toISOString() })));
      const workers = workLoop.readWorkerStatuses(home, { alive: (p, t) => identity.isOurProcess(p, t).reallyAlive });
      assert.equal(workers.filter((w) => w.live).length, 3);
      assert.equal(calls.length, 1, "worker statuses: one read for three workers");

      calls.length = 0;
      const lockDir = path.join(home, "spool");
      fs.mkdirSync(lockDir);
      const old = Date.now() - 24 * 3600 * 1000; // expired, so only identity decides
      pids.forEach((p) => fs.writeFileSync(path.join(lockDir, `h.redrive.lock-${p}-${old}-${(1000 + p).toString(16).padStart(16, "0")}abcd0123`), ""));
      // A recycled pid (ticks mismatch) is reaped; the claim is ours.
      fs.readdirSync(lockDir).forEach((f) => fs.renameSync(path.join(lockDir, f), path.join(lockDir, f.replace(/-[0-9a-f]{16}(abcd0123)$/, `-${"0".repeat(15)}7$1`))));
      const release = spool.claimSpoolJob(lockDir, "h");
      assert.ok(release, "recycled holders do not contend");
      release();
      // One read lists all three rivals; clearing each one is a destructive act,
      // re-judged by its own FRESH read (dec-spor-process-identity-per-pass-batched-read).
      assert.deepEqual(calls.filter((c) => !c.includes(process.pid)).map((c) => c.length), [3, 1, 1, 1], "spool lock listing: one read for three rivals, one fresh read per lock cleared");

      calls.length = 0;
      const ws = path.join(home, "ws");
      fs.mkdirSync(ws);
      const wsLockDir = preflight.workspaceLockDir(home);
      fs.mkdirSync(wsLockDir, { recursive: true });
      const prefix = preflight.workspaceLockPrefix(ws);
      pids.forEach((p) => fs.writeFileSync(path.join(wsLockDir, `${prefix}${p}-7-${Date.now()}-abcd`), ""));
      const got = await preflight.acquireWorkspace(home, ws, { waitMs: 0 });
      assert.equal(got.ok, true, "recycled holders do not hold the workspace");
      preflight.releaseWorkspace(got.token);
      assert.deepEqual(calls.filter((c) => !c.includes(process.pid)).map((c) => c.length), [3, 1, 1, 1], "workspace lock listing: one read for three rivals, one fresh read per lock cleared");
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- destructive acts read FRESH (dec-spor-process-identity-per-pass-batched-read)
// A pass's cache may serve listing/status/liveness answers, but a kill or a
// lock break must re-read the kernel immediately before acting. These drive a
// cached "ours" (or "not ours") and then flip what a fresh read says, as a
// recycled pid would, and prove the destructive site acts on the FRESH answer.
test("a kill site ignores a cached identity: stopRun reads supervisor and child fresh inside a pass", async () => {
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  await withSleepers(2, async ([sup, kid]) => {
    let recycled = false;
    const calls = [];
    const restore = identity._setHost({ platform: "darwin", read: (pids) => (calls.push([...pids]), new Map(pids.map((p) => [p, recycled ? 7 : 1000 + p]))) });
    try {
      const record = { run_id: "r", state: "running", launch_mode: "supervised-jsonl", runner_pid: sup, runner_started_ticks: 1000 + sup, child_pid: kid, child_started_ticks: 1000 + kid };
      const pending = identity.withIdentityPass(() => {
        identity.prefetchStartTicks([sup, kid]);
        recycled = true; // both pids now name strangers
        // the cache still says ours: a listing inside the pass would believe it
        assert.equal(identity.isOurProcess(sup, 1000 + sup).reallyAlive, true, "the cached answer is stale-ours");
        return dispatchRuns.stopRun(record, { platform: "darwin", sleep: async () => {}, graceMs: 0 });
      });
      const stopped = await pending;
      assert.equal(stopped.supervisor, false, "a supervisor proven not ours by a fresh read is never signalled");
      assert.equal(stopped.child, false, "a child proven not ours by a fresh read is never signalled");
      assert.equal(identity.aliveProbe(sup) && identity.aliveProbe(kid), true, "nothing was killed");
      assert.ok(calls.length >= 3, "the kill decision paid its own fresh reads");
    } finally {
      restore();
    }
  });
});

test("a lock break ignores a cached identity: a cached not-ours holder that a fresh read finds ours is not cleared", async () => {
  const spool = require("../lib/shell/spool.js");
  await withSleepers(1, ([pid]) => {
    let cachedWrong = true;
    const restore = identity._setHost({ platform: "win32", read: (pids) => new Map(pids.map((p) => [p, p === process.pid ? 1 : cachedWrong ? 7 : 1000 + p])) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-identity-fresh-"));
    try {
      const lock = `h.redrive.lock-${pid}-${Date.now()}-${(1000 + pid).toString(16).padStart(16, "0")}abcd0123`;
      fs.writeFileSync(path.join(dir, lock), "");
      const release = identity.withIdentityPass(() => {
        identity.prefetchStartTicks([pid]); // cached: a mismatch (not ours, so prunable)
        cachedWrong = false; // the kernel, read fresh: the holder IS ours and live
        return spool.claimSpoolJob(dir, "h");
      });
      assert.equal(release, null, "the live holder still owns the pair");
      assert.ok(fs.existsSync(path.join(dir, lock)), "its lock was not cleared on the cached verdict");
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
