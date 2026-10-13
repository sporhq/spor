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
