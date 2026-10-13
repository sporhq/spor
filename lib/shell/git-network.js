"use strict";

// Shared unattended Git transport for availability and candidate publication.
// The caller owns its timeout/output budget; gitSpawn owns location-env scrub.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { judgeGitEnv } = require("./gate-runner.js");

function networkOptions({ timeout, maxBuffer, env: inherited = process.env } = {}) {
  // Let Git choose the configured transport (GIT_SSH_COMMAND, core.sshCommand,
  // GIT_SSH and ssh.variant). Wrappers/Plink do not speak OpenSSH's flags.
  const env = { ...inherited, GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never" };
  // Empty GIT_ASKPASS also suppresses a configured core.askPass fallback.
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  delete env.DISPLAY;
  return {
    env: judgeGitEnv(env), timeout, ...(maxBuffer == null ? {} : { maxBuffer }),
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    windowsHide: true, killSignal: "SIGKILL",
  };
}
function networkGit(git, cwd, args, { transportCwd = null, platform = process.platform, reapWindows = reapWindowsTree, ...options } = {}) {
  const opts = networkOptions(options);
  const started = Date.now();
  // Verification runs in a fresh repository. Read the producer's effective
  // SSH settings through Git (including global/includeIf configuration), while
  // preserving the environment precedence Git itself applies. Do not parse
  // command strings or append flags belonging to another SSH implementation.
  if (transportCwd && transportCwd !== cwd) {
    for (const [key, envKey] of [["core.sshCommand", "GIT_SSH_COMMAND"], ["ssh.variant", "GIT_SSH_VARIANT"]]) {
      if (opts.env[envKey] !== undefined) continue;
      const read = git(transportCwd, ["config", "--get", key], opts);
      if (!read || (read.status !== 0 && read.status !== 1)) return read || { status: 1, stderr: `cannot read ${key}` };
      if (read.status === 0) opts.env[envKey] = String(read.stdout || "").replace(/\r?\n$/, "");
    }
  }
  // Keep relative wrapper/identity paths anchored to the producer, while Git
  // writes only the explicitly selected verification object database. This
  // avoids parsing or rewriting the configured SSH command itself.
  const result = transportCwd && transportCwd !== cwd
    ? git(transportCwd, [`--git-dir=${path.resolve(cwd)}`, ...args], opts)
    : git(cwd, args, opts);
  // spawnSync bounds Git itself even if an SSH descendant holds output pipes.
  // On timeout or output overflow the SSH wrapper must not outlive the refused
  // probe. On POSIX the detached session is ours: reap that whole group. On
  // Windows spawnSync already terminated the direct git process, and its
  // descendants (Git for Windows' launcher child, sh, the wrapper) survive it
  // with no group to signal, so reap them by parentage instead.
  if (result?.pid > 0 && (result.error || result.signal)) {
    if (platform === "win32") reapWindows(result.pid, { since: started, until: Date.now() });
    else try { process.kill(-result.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  return result;
}

// Every process descended from `rootPid`, given a process snapshot of
// {pid, ppid, created} rows (created = epoch ms). Windows never reparents an
// orphan, so a dead root's children still name it as their parent — but a
// recycled pid can too, so a child is only accepted if it was created while
// its parent could have been the one we know: the root's children inside the
// run's [since, until] window, a deeper child no earlier than its parent.
const CREATION_SLACK_MS = 1000;
function descendantsOf(rows, rootPid, { since, until }) {
  const found = [];
  const queue = [{ pid: rootPid, created: null }];
  const seen = new Set([rootPid]);
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || !Number.isFinite(row.created)) continue;
      const ok = parent.created == null
        ? row.created >= since - CREATION_SLACK_MS && row.created <= until + CREATION_SLACK_MS
        : row.created >= parent.created - CREATION_SLACK_MS;
      if (!ok) continue;
      seen.add(row.pid);
      found.push(row.pid);
      queue.push(row);
    }
  }
  return found;
}

// Parse the snapshot PROCESS_SNAPSHOT prints: one "pid ppid createdMs" line
// per process (a process with no readable creation time is omitted).
function parseSnapshot(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]) });
  }
  return rows;
}
const PROCESS_SNAPSHOT = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "
  + "'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }";

// End the surviving descendants of a Windows process that spawnSync already
// terminated: snapshot the process table (PowerShell's CIM, shipped with every
// supported Windows — wmic is not), then `taskkill /F` every descendant found.
// Each is named explicitly and WITHOUT /T: taskkill's own tree walk follows
// bare parent pids, which would re-admit the recycled-pid lookalikes
// descendantsOf refused. Best-effort and bounded: a failed snapshot or an
// already-exited process is tolerated, never thrown. Returns the pids it
// asked to end.
function reapWindowsTree(rootPid, { since, until, env = process.env, run = spawnSync } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  const snap = run(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SNAPSHOT],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
  // A non-zero exit can still carry a full snapshot (a non-terminating error in
  // the pipeline); parseSnapshot keeps only well-formed rows.
  if (!snap || snap.error) return [];
  const pids = descendantsOf(parseSnapshot(snap.stdout), rootPid, { since, until });
  if (!pids.length) return [];
  run(path.join(root, "System32", "taskkill.exe"), ["/F", ...pids.flatMap(p => ["/PID", String(p)])],
    { windowsHide: true, stdio: "ignore", timeout: 10000 });
  return pids;
}
module.exports = { networkOptions, networkGit, reapWindowsTree, descendantsOf, parseSnapshot };
