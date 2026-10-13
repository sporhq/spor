"use strict";
// The ONE Windows process-tree kill (lib/shell/windows-process-tree.js,
// task-spor-windows-shared-process-tree-helper): the root proven by its start
// time, a live handle, or a dead root's creation window; only true descendants
// walked; each stopped by pid; never `taskkill /T`. The script shape and the
// exit-status mapping are checked on every OS; the real kills run on Windows.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const tree = require("../lib/shell/windows-process-tree.js");
const identity = require("../lib/shell/process-identity.js");

const FT_EPOCH = 116444736000000000n;
const ft = (ms) => BigInt(ms) * 10000n + FT_EPOCH;

test("treeScript: a recorded token is re-proved in the kill pass, to the millisecond", () => {
  const ms = Date.UTC(2026, 9, 13, 8, 27, 29, 810);
  const s = tree.treeScript(42, { ticks: ms });
  assert.ok(s.includes("$root = $byId[42]"));
  assert.ok(s.includes(`$proofFt -lt ${ft(ms)} -or $proofFt -ge ${ft(ms) + 10010n}`), "the root's FILETIME must fall in the recorded millisecond");
  assert.match(s, /\(Get-Process -Id 42 -ErrorAction Stop\)\.StartTime\.ToFileTimeUtc\(\) \} catch \{ \$proofFt = \$root\.CreationDate/, "proved the way the token was minted: Get-Process, then CIM");
  assert.ok(s.indexOf("$snapAt = ") < s.indexOf("Get-CimInstance"), "the snapshot instant is taken before the snapshot");
  assert.match(s, /\$null = \$gp\.Handle; if \(\$gp\.StartTime\.ToFileTimeUtc\(\) -lt \$snapAt\)/, "each target is pinned by a handle and must predate the snapshot");
  assert.match(s, /Stop-Process -InputObject \$gp -Force/, "killed through the pinned handle, not a fresh open-by-pid");
  assert.match(s, /\$up = \[int\]\$PID/, "the script's own ancestry is protected");
  assert.doesNotMatch(s, /New-Object|\[Console\]/, "Constrained-Language-safe");
  assert.match(s, /exit \$rootMiss/, "a root that could not be pinned is answered with why");
  assert.match(s, /exit 3 \}/, "a root that is gone is answered, not killed");
  assert.match(s, /exit 4 \}/, "a root whose start time differs is someone else's");
  assert.match(s, /if \(\$cft -ge \$pft\)/, "a child older than its parent is a previous holder's, never ours");
  assert.ok(s.includes("$kill = @(42)"), "the root is stopped FIRST");
  assert.doesNotMatch(s, /taskkill/i);
  assert.doesNotMatch(s, /"/, "no double quotes for the Windows argv quoting to mangle");
});

test("treeScript: a trusted root still walks only true descendants; a dead root's children must fall in its window, and the root is never signalled", () => {
  const trusted = tree.treeScript(7, { trustRoot: true });
  assert.doesNotMatch(trusted, /exit 4/, "a live handle needs no start-time proof");
  assert.ok(trusted.includes("$kill = @(7)"));
  const dead = tree.treeScript(7, { since: 5000, until: 6000 });
  assert.ok(dead.includes("$kill = @()"), "the unproven dead root is not stopped");
  assert.ok(dead.includes(`$cft -ge ${ft(4000)} -and $cft -le ${ft(7000)}`), "the root's direct children: inside the run's window, a second's slack either side");
  assert.throws(() => tree.treeScript(7, {}), /one of ticks, trustRoot or since\/until/);
  assert.throws(() => tree.treeScript(0, { trustRoot: true }), /positive integer/);
});

test("killWindowsTree maps PowerShell's answer to what a caller may still do", () => {
  const env = { SystemRoot: "D:\\Win" };
  const calls = [];
  const answer = (r) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return r; };
  assert.deepEqual(tree.killWindowsTree(9, { trustRoot: true, env, run: answer({ status: 0, stdout: "9\r\n10\r\n" }) }), { status: "killed", pids: [9, 10] });
  assert.equal(calls[0].cmd, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "by absolute path, never PATH");
  assert.deepEqual(calls[0].args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.equal(calls[0].opts.shell, undefined, "no shell");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 3, stdout: "" }) }).status, "gone");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 4, stdout: "" }) }).status, "foreign");
  assert.deepEqual(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 5, stdout: "10\r\n" }) }), { status: "protected", pids: [10] }, "the root is this pass's own ancestry: descendants only, no fallback");
  assert.deepEqual(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 0, stdout: "" }) }), { status: "killed", pids: [] }, "ran to the end: never 'failed', whatever it could not stop");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: null, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), stdout: "" }) }).status, "interrupted", "a timed-out pass may have stopped the root: no bare-pid fallback after it");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 1, stdout: "9\r\n" }) }).status, "interrupted", "a pass that reached the kill step is never 'failed'");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: answer({ status: 1, stdout: "" }) }).status, "failed");
  assert.equal(tree.killWindowsTree(9, { ticks: 1, env, run: () => { throw new Error("ENOENT"); } }).status, "failed");
  const before = calls.length;
  assert.equal(tree.killWindowsTree(0, { trustRoot: true, env, run: answer({ status: 0 }) }).status, "failed");
  assert.equal(tree.killWindowsTree(9, { ticks: "junk", env, run: answer({ status: 0 }) }).status, "failed");
  assert.equal(tree.killWindowsTree(9, { env, run: answer({ status: 0 }) }).status, "failed", "no proof, no kill");
  assert.equal(calls.length, before, "none of those ran PowerShell");
});

// A leader node process that spawns a grandchild and writes its pid.
async function spawnFamily({ detached = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-win-tree-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const grandSrc = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9);`;
  const leaderSrc = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandSrc)}], { stdio: "ignore", detached: ${detached} }); setInterval(() => {}, 1e9);`;
  const leader = spawn(process.execPath, ["-e", leaderSrc], { stdio: "ignore", windowsHide: true });
  let text = "";
  for (let i = 0; i < 400 && !text; i += 1) {
    try { text = fs.readFileSync(pidFile, "utf8"); } catch { /* not yet */ }
    if (!text) await new Promise((r) => setTimeout(r, 25));
  }
  return { leader, grandchild: Number(text) };
}
const alive = (pid) => identity.aliveProbe(pid);
async function gone(pid) {
  for (let i = 0; i < 200 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}
const winOnly = { skip: process.platform !== "win32" && "Windows-only: a real process tree" };

test("killWindowsTree on Windows: a proven root takes its grandchild; a wrong token kills nothing", winOnly, async () => {
  const { leader, grandchild } = await spawnFamily();
  try {
    assert.ok(grandchild > 0 && alive(grandchild), "the fixture must have a live grandchild");
    const ticks = identity.processStartTicks(leader.pid);
    assert.equal(typeof ticks, "number");
    assert.equal(tree.killWindowsTree(leader.pid, { ticks: ticks - 1 }).status, "foreign");
    assert.equal(alive(leader.pid) && alive(grandchild), true, "a token naming another process stops nothing");
    const r = tree.killWindowsTree(leader.pid, { ticks });
    assert.equal(r.status, "killed");
    // The root first; the tree also holds the console host Windows attaches.
    assert.equal(r.pids[0], leader.pid, "the root is stopped first");
    assert.ok(r.pids.includes(grandchild), "and its grandchild with it");
    assert.equal(await gone(leader.pid), true);
    assert.equal(await gone(grandchild), true);
    assert.equal(tree.killWindowsTree(leader.pid, { ticks }).status, "gone");
  } finally {
    try { leader.kill(); } catch { /* gone */ }
    try { process.kill(grandchild); } catch { /* gone */ }
  }
});

test("killWindowsTree on Windows: a dead root's orphaned grandchild is reaped by its creation window, and only inside it", winOnly, async () => {
  const since = Date.now();
  // Detached, so libuv's kill-on-close job does not take the grandchild with
  // the root: it survives as an orphan still naming the root as its parent.
  const { leader, grandchild } = await spawnFamily({ detached: true });
  try {
    const exited = new Promise((r) => leader.once("exit", r));
    leader.kill(); // the root goes; its child survives it, still naming it as parent
    await exited;
    assert.equal(alive(grandchild), true);
    const outside = tree.killWindowsTree(leader.pid, { since: since - 3600000, until: since - 1800000 });
    assert.deepEqual(outside.pids, [], "a child created outside the window is not the root's");
    assert.equal(alive(grandchild), true);
    const r = tree.killWindowsTree(leader.pid, { since, until: Date.now() });
    assert.equal(r.status, "killed");
    assert.ok(r.pids.includes(grandchild));
    assert.equal(await gone(grandchild), true);
  } finally {
    try { process.kill(grandchild); } catch { /* gone */ }
  }
});
