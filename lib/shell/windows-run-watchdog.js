"use strict";
// The Windows crash reaper for a supervised dispatch run
// (issue-spor-windows-crashed-supervisor-agent-grandchild-survives).
//
// The supervisor's harness child sits in libuv's kill-on-close job, so a
// supervisor that dies abruptly (a hard kill, a crash) takes that child with
// it. But libuv's job is SILENT_BREAKAWAY_OK: nothing the child spawns joins
// it, and on Windows the child is commonly `cmd.exe` running a `.cmd` shim, so
// the real agent — the shim's child — survives, orphaned, holding the
// worktree, with no record naming it for a later reconcile to re-prove.
//
// The job object the issue proposed (one per run, KILL_ON_JOB_CLOSE, no
// breakaway) has no zero-dep spelling: node exposes no job API, no OS binary
// creates one, and the PowerShell route (Add-Type / reflection P/Invoke) is
// refused under Constrained Language Mode, where every other Windows path here
// still runs (dec-spor-client-zero-dep-admits-os-binaries). So the same
// observable contract — the run's whole tree dies with its supervisor — comes
// from a WATCHDOG instead: a detached node process, outside libuv's job, whose
// stdin is a pipe only the supervisor holds. The OS closes that pipe however
// the supervisor dies, so EOF on it IS the supervisor's death (no pid polling,
// no pid reuse to guard against). On EOF the watchdog ends the harness's
// descendants through the ONE Windows tree kill, the dead-root way
// (`reapWindowsTree`: the root's children only inside the run's creation
// window, deeper ones only if no older than their parent, retried once). Once
// the harness child exits on its own the supervisor DISARMS it (a line on
// that pipe), so a finished run's leftovers — Claude Code's persistent daemon
// — are left exactly as before; only a supervisor that died while its harness
// was still running is reaped. The window between the child's spawn and the
// watchdog's own is uncovered.

const os = require("node:os");
const { spawn } = require("node:child_process");

const DISARM = "disarm";
// What the watchdog keeps of the supervisor's environment: enough for
// PowerShell + CIM to boot, none of the run's credentials.
const ENV_KEEP = ["SystemRoot", "SYSTEMROOT", "windir", "SystemDrive", "ComSpec", "PATH", "Path", "PATHEXT", "PSModulePath", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "USERDOMAIN", "COMPUTERNAME"];

function watchdogEnv(env = process.env) {
  const out = {};
  for (const k of ENV_KEEP) if (env[k] != null) out[k] = env[k];
  return out;
}

// Arm a watchdog for `child` (the harness this supervisor just spawned at
// `since`, epoch ms). Windows only; anywhere else, or when the watchdog cannot
// be started, null — arming is best-effort and never fails the run. Returns
// `{ pid, disarm }`.
function armRunWatchdog(child, { since, platform = process.platform, env = process.env, spawnImpl = spawn, execPath = process.execPath } = {}) {
  if (platform !== "win32") return null;
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || !Number.isFinite(since)) return null;
  let wd;
  try {
    wd = spawnImpl(execPath, [__filename, String(child.pid), String(Math.trunc(since))], {
      // Outside libuv's job (a detached child is never assigned to it), so the
      // supervisor's death does not take the watchdog along.
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      // Never the run's worktree: a Windows cwd pins its directory.
      cwd: os.tmpdir(),
      env: watchdogEnv(env),
    });
  } catch {
    return null;
  }
  if (!wd || !wd.stdin) return null;
  wd.on("error", () => {});
  wd.stdin.on("error", () => {});
  // Neither the process nor its pipe may keep the supervisor alive.
  try { wd.unref(); } catch { /* best-effort */ }
  try { if (typeof wd.stdin.unref === "function") wd.stdin.unref(); } catch { /* best-effort */ }
  let disarmed = false;
  return {
    pid: wd.pid,
    disarm() {
      if (disarmed) return;
      disarmed = true;
      try { wd.stdin.end(`${DISARM}\n`); } catch { /* the watchdog is gone: nothing to disarm */ }
    },
  };
}

// The watchdog's side: wait on `input` (the supervisor's pipe). A DISARM line
// stands it down; the pipe's end, close or error without one reaps the tree
// rooted at `childPid` (dead-root proof: its children inside [since, now]).
// Resolves `{ action: "disarmed" }` or `{ action: "reaped", pids }`.
function watchSupervisor(input, { childPid, since, reap, now = Date.now } = {}) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const onEnd = () => {
      if (settled) return;
      let pids = [];
      try { pids = reap(childPid, { since, until: now() }) || []; } catch { pids = []; }
      settle({ action: "reaped", pids });
    };
    input.on("data", (chunk) => {
      buf += String(chunk);
      if (buf.split(/\r?\n/).some((l) => l.trim() === DISARM)) settle({ action: "disarmed" });
      else if (buf.length > 4096) buf = buf.slice(-64);
    });
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onEnd);
  });
}

if (require.main === module) {
  const childPid = Number(process.argv[2]);
  const since = Number(process.argv[3]);
  if (!Number.isInteger(childPid) || childPid <= 0 || !Number.isFinite(since)) process.exit(2);
  const { reapWindowsTree } = require("./git-network.js");
  watchSupervisor(process.stdin, { childPid, since, reap: (pid, opts) => reapWindowsTree(pid, opts) })
    .then(() => process.exit(0), () => process.exit(1));
}

module.exports = { armRunWatchdog, watchSupervisor, watchdogEnv, DISARM };
