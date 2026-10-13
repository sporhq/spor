"use strict";
// The Windows crash reaper for a supervised run
// (lib/shell/windows-run-watchdog.js,
// issue-spor-windows-crashed-supervisor-agent-grandchild-survives): a detached
// watchdog on a pipe only the supervisor holds ends the harness's tree when
// that pipe closes undisarmed. The arming, the disarm and the EOF reading are
// checked on every OS; the real crash runs on Windows.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");

const wd = require("../lib/shell/windows-run-watchdog.js");
const identity = require("../lib/shell/process-identity.js");
const { atomicJson, readJson } = require("../lib/shell/agent-dispatch-runner.js");
const { writeSpawnableNodeStub } = require("./helpers/portable.js");

function fakeSpawn(calls, { throws = false } = {}) {
  return (cmd, args, opts) => {
    if (throws) throw new Error("EPERM");
    const proc = new EventEmitter();
    proc.pid = 4242;
    proc.stdin = new PassThrough();
    proc.stdin.unref = () => { proc.stdinUnref = true; };
    proc.unref = () => { proc.unrefd = true; };
    let written = "";
    proc.stdin.on("data", (c) => { written += c; });
    proc.written = () => written;
    calls.push({ cmd, args, opts, proc });
    return proc;
  };
}

test("armRunWatchdog: Windows only, detached outside the run's cwd, credentials dropped, never holding the supervisor open", () => {
  const calls = [];
  const child = { pid: 77 };
  assert.equal(wd.armRunWatchdog(child, { since: 1000, platform: "linux", spawnImpl: fakeSpawn(calls) }), null);
  assert.equal(calls.length, 0, "POSIX kills the process group; no watchdog");
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\bin", SPOR_TOKEN: "secret", SPOR_DISPATCH_BIND_TOKEN: "b", SPOR_ATTESTATION_KEY: "k" };
  const armed = wd.armRunWatchdog(child, { since: 1000.7, platform: "win32", env, spawnImpl: fakeSpawn(calls), execPath: "node.exe" });
  assert.ok(armed);
  assert.equal(calls.length, 1);
  const { cmd, args, opts, proc } = calls[0];
  assert.equal(cmd, "node.exe");
  assert.deepEqual(args, [require.resolve("../lib/shell/windows-run-watchdog.js"), "77", "1000"]);
  assert.equal(opts.detached, true, "outside libuv's kill-on-close job, so it outlives the supervisor");
  assert.deepEqual(opts.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.cwd, os.tmpdir(), "never the run's worktree");
  assert.deepEqual(opts.env, { SystemRoot: "C:\\Windows", PATH: "C:\\bin" }, "no run credential reaches the watchdog");
  assert.ok(proc.unrefd && proc.stdinUnref, "the watchdog never keeps the supervisor alive");
  assert.equal(armed.pid, 4242);
  armed.disarm();
  armed.disarm();
  assert.equal(proc.written(), `${wd.DISARM}\n`, "disarmed once");
  assert.equal(wd.armRunWatchdog({ pid: undefined }, { since: 1, platform: "win32", spawnImpl: fakeSpawn(calls) }), null, "no child pid, no watchdog");
  assert.equal(wd.armRunWatchdog(child, { since: 1, platform: "win32", spawnImpl: fakeSpawn(calls, { throws: true }) }), null, "a watchdog that cannot start never fails the run");
});

test("watchSupervisor: the pipe closing undisarmed reaps the tree in the run's window; a disarm stands it down", async () => {
  const reaps = [];
  const reap = (pid, opts) => { reaps.push({ pid, opts }); return [pid + 1]; };
  const crashed = new PassThrough();
  const p1 = wd.watchSupervisor(crashed, { childPid: 9, since: 500, reap, now: () => 900 });
  crashed.write("noise\n");
  crashed.end();
  crashed.resume();
  assert.deepEqual(await p1, { action: "reaped", pids: [10] });
  assert.deepEqual(reaps, [{ pid: 9, opts: { since: 500, until: 900 } }], "the dead root's children inside [spawn, death]");

  const finished = new PassThrough();
  const p2 = wd.watchSupervisor(finished, { childPid: 9, since: 500, reap, now: () => 900 });
  finished.write("dis");
  finished.end("arm\r\n");
  assert.deepEqual(await p2, { action: "disarmed" });
  assert.equal(reaps.length, 1, "a disarmed watchdog reaps nothing, even when the pipe then closes");

  const broken = new PassThrough();
  const p3 = wd.watchSupervisor(broken, { childPid: 9, since: 500, reap: () => { throw new Error("boom"); } });
  broken.destroy(new Error("EPIPE"));
  assert.deepEqual(await p3, { action: "reaped", pids: [] }, "a pipe error is the supervisor's death too; a failed reap never throws");
});

// --- the real crash, on Windows ---------------------------------------------

const winOnly = { skip: process.platform !== "win32" && "Windows-only: a real supervisor crash" };
const alive = (pid) => identity.aliveProbe(pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}
const readPid = (f) => { try { return Number(fs.readFileSync(f, "utf8")) || 0; } catch { return 0; } };

// A supervisor running a harness that itself spawns a child, DETACHED so the
// harness's own libuv job cannot be what ends it — only the watchdog's tree
// walk can. Shimmed (cmd.exe -> node, the shape libuv's kill-on-close cannot
// reach) unless `direct`, where the harness node is the supervisor's child
// and so the reap root.
function supervisedFamily({ harnessExits = false, direct = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-win-watchdog-"));
  const harnessPid = path.join(dir, "harness.pid");
  const grandPid = path.join(dir, "grandchild.pid");
  const grandSrc = `require("node:fs").writeFileSync(${JSON.stringify(grandPid)}, String(process.pid)); setInterval(() => {}, 1e9);`;
  const body = [
    `require("node:fs").writeFileSync(${JSON.stringify(harnessPid)}, String(process.pid));`,
    `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandSrc)}], { stdio: "ignore", detached: true });`,
    harnessExits ? `setTimeout(() => process.exit(0), 1000);` : "setInterval(() => {}, 1e9);",
  ].join("\n");
  const stub = writeSpawnableNodeStub(dir, "harness", body);
  const [command, args] = direct ? [process.execPath, [path.join(dir, "harness.js")]] : [stub, []];
  const record = path.join(dir, "run.run.json");
  const job = path.join(dir, "run.job.json");
  const promptPath = path.join(dir, "run.prompt");
  const log = path.join(dir, "run.log");
  fs.writeFileSync(promptPath, "p\n");
  atomicJson(record, { run_id: "wd-test", name: "task-wd-test", harness: "codex", state: "launching", cwd: dir, log_path: log });
  atomicJson(job, { run_id: "wd-test", harness: "codex", command, args, cwd: dir, record_path: record, prompt_path: promptPath, log_path: log });
  const supervisor = spawn(process.execPath, [require.resolve("../lib/shell/agent-dispatch-runner.js"), job], { stdio: "ignore", windowsHide: true });
  return { dir, supervisor, record, harnessPid, grandPid };
}

test("a hard-killed supervisor on Windows takes its shimmed harness and the harness's own child with it", winOnly, async () => {
  const f = supervisedFamily();
  let harness = 0;
  let grand = 0;
  try {
    harness = await waitFor(() => readPid(f.harnessPid));
    grand = await waitFor(() => readPid(f.grandPid));
    assert.ok(harness > 0 && grand > 0, "the fixture must have a live harness behind the shim, and its child");
    const exited = new Promise((r) => f.supervisor.once("exit", r));
    f.supervisor.kill(); // TerminateProcess: no handler runs, nothing is finalized
    await exited;
    assert.equal(await waitFor(() => !alive(harness), 45000), true, "the harness behind the shim is ended by the watchdog");
    assert.equal(await waitFor(() => !alive(grand), 45000), true, "and so is everything it spawned");
  } finally {
    for (const pid of [harness, grand]) { try { if (pid) process.kill(pid); } catch { /* gone */ } }
    try { f.supervisor.kill(); } catch { /* gone */ }
  }
});

test("a supervisor whose harness exits on its own disarms the watchdog: what the harness left behind is untouched", winOnly, async () => {
  // Direct, so the left-behind child is the reap root's own child, inside its
  // window: an undisarmed watchdog WOULD end it (a shimmed root's only child
  // is the exited harness, and the walk could not reach past it).
  const f = supervisedFamily({ harnessExits: true, direct: true });
  let grand = 0;
  try {
    grand = await waitFor(() => readPid(f.grandPid));
    assert.ok(grand > 0);
    await new Promise((r) => (f.supervisor.exitCode != null ? r() : f.supervisor.once("exit", r)));
    assert.ok(["done", "failed"].includes((readJson(f.record) || {}).state), "the run finalized normally");
    await sleep(8000); // longer than a watchdog's PowerShell boot
    assert.equal(alive(grand), true, "a disarmed watchdog reaps nothing");
  } finally {
    try { if (grand) process.kill(grand); } catch { /* gone */ }
  }
});
