"use strict";

// Shared unattended Git transport for availability and candidate publication.
// The caller owns its timeout/output budget; gitSpawn owns location-env scrub.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { judgeGitEnv } = require("./gate-runner.js");
const { killWindowsTree } = require("./windows-process-tree.js");

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
  // The reap window opens at THIS spawn, not before the config reads above,
  // so a pid recycled during those reads cannot vouch for an older orphan.
  const started = Date.now();
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

// End the surviving descendants of a Windows process that spawnSync already
// terminated, through the ONE Windows tree kill (windows-process-tree.js). The
// root is gone, so it cannot be proven by its start time; instead its direct
// children are accepted only if created inside the run's [since, until]
// window, and a deeper child only if created no earlier than its parent — a
// recycled-pid lookalike (Windows never reparents an orphan) fails both. Each
// is stopped by pid, never through `taskkill /T`, whose own walk follows bare
// parent pids. Best-effort and bounded: a failed snapshot or an
// already-exited process is tolerated, never thrown. Returns the pids it
// stopped.
function reapWindowsTree(rootPid, { since, until, env = process.env, run = spawnSync } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  return killWindowsTree(rootPid, { since, until, killRoot: false, env, run }).pids;
}
module.exports = { networkOptions, networkGit, reapWindowsTree };
