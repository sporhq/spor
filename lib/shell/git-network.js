"use strict";

// Shared unattended Git transport for availability and candidate publication.
// The caller owns its timeout/output budget; gitSpawn owns location-env scrub.
const path = require("node:path");
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
function networkGit(git, cwd, args, { transportCwd = null, ...options } = {}) {
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
  const result = transportCwd && transportCwd !== cwd
    ? git(transportCwd, [`--git-dir=${path.resolve(cwd)}`, ...args], opts)
    : git(cwd, args, opts);
  // spawnSync bounds Git itself even if an SSH descendant holds output pipes.
  // On POSIX the detached session is ours: reap that whole group on timeout or
  // output overflow, so the SSH wrapper cannot outlive the refused probe.
  // Windows retains gitSpawn's direct-process timeout; no tree-kill guarantee.
  if (process.platform !== "win32" && result?.pid > 0 && (result.error || result.signal)) {
    try { process.kill(-result.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  return result;
}
module.exports = { networkOptions, networkGit };
