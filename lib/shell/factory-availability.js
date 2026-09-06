"use strict";

// Read-only runtime checks before claim/hold. Definition parsing remains the
// fatal configuration boundary; execution-side publication/landing checks stay
// authoritative because availability can change after this probe.
const fs = require("node:fs");
const publish = require("./candidate-publish.js");
const { gitSpawn } = require("./git-exec.js");
const { splitRemoteRef } = require("./integration-runner.js");
const { judgeGitEnv } = require("./gate-runner.js");
const PROBE_TIMEOUT_MS = 5000;

function networkOptions() {
  // Let Git choose the configured transport (GIT_SSH_COMMAND, core.sshCommand,
  // GIT_SSH and ssh.variant). Wrappers/Plink do not speak OpenSSH's flags.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never" };
  // Empty GIT_ASKPASS also suppresses a configured core.askPass fallback.
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  delete env.DISPLAY;
  return {
    env: judgeGitEnv(env), timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    windowsHide: true, killSignal: "SIGKILL",
  };
}
function networkGit(git, cwd, args) {
  const result = git(cwd, args, networkOptions());
  // spawnSync bounds Git itself even if an SSH descendant holds output pipes.
  // On POSIX the detached session is ours: reap that whole group on timeout or
  // output overflow, so the SSH wrapper cannot outlive the refused probe.
  // Windows retains gitSpawn's direct-process timeout; no tree-kill guarantee.
  if (process.platform !== "win32" && result?.pid > 0 && (result.error || result.signal)) {
    try { process.kill(-result.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  return result;
}
async function probeHttpStore(url, { bearer = null, fetcher = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // A missing object is expected: this probe creates no candidate or claim.
    // 404 proves reachability only; actual PUT/GET verification stays mandatory.
    const target = publish.storeLocator(url, ".spor-availability-probe");
    const options = { signal: ctrl.signal, redirect: "error", headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} };
    let res = await fetcher(target, { ...options, method: "HEAD" });
    // Some stores reject HEAD before checking credentials. GET must establish
    // reachability/authentication instead, under the same total deadline.
    if (res.status === 405) {
      await res.body?.cancel();
      res = await fetcher(target, { ...options, method: "GET", headers: { ...options.headers, Range: "bytes=0-0" } });
    }
    // Never download a probe object: even a server ignoring Range may return a
    // stream, so release it as soon as response headers have been inspected.
    await res.body?.cancel();
    return res.ok || res.status === 404
      ? { ok: true }
      : { ok: false, reason: `candidate store is unavailable (HTTP ${res.status})` };
  } catch (e) { return { ok: false, reason: `candidate store is unreachable (${e.message})` }; }
  finally { clearTimeout(timer); }
}

async function probeFactoryAvailability({ factory, repo, cwd, graphHome, mode, bearer = null }, { git = gitSpawn, httpProbe = probeHttpStore } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!factory || (!factory.implementation && !factory.integration)) return { ok: true };
  if (!cwd || !fs.existsSync(cwd)) return fail(`no available checkout for ${repo || "this item"}; configure dispatch.repos before claiming work`);
  if (factory.implementation) {
    const verdict = publish.publishSatisfiability(factory, { graphHome, mode, repoPaths: { [repo || "item"]: cwd }, git });
    if (!verdict.ok) return { ok: false, reason: verdict.errors.join("; "), configuration: verdict.configurationErrors.length > 0 };
    if (verdict.store && verdict.store.startsWith("https://")) {
      const reachable = await httpProbe(verdict.store, { bearer });
      if (!reachable.ok) return fail(reachable.reason);
    }
    if (publish.publishKinds(factory.implementation.candidate && factory.implementation.candidate.publish).includes("branch")) {
      const remote = (factory.implementation.candidate && factory.implementation.candidate.remote) || "origin";
      const result = networkGit(git, cwd, ["ls-remote", remote, "HEAD"]);
      if (!result || result.status !== 0) return fail(`candidate publication remote '${remote}' is unreachable from ${repo || cwd}`);
    }
  }
  if (factory.integration) {
    const integration = factory.integration;
    // Propose builds against the local target without fetching it first;
    // remote reachability alone cannot satisfy that execution prerequisite.
    if (integration.mode === "propose") {
      const local = networkGit(git, cwd, ["rev-parse", "--verify", `${integration.targetRef}^{commit}`]);
      if (!local || local.status !== 0) return fail(`integration target '${integration.targetRef}' does not resolve in ${repo || cwd}`);
    }
    if (integration.mode === "push" || integration.mode === "propose") {
      const { remote, branch } = splitRemoteRef(integration.targetRef);
      const args = ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`];
      const result = networkGit(git, cwd, args);
      if (!result || result.status !== 0) return fail(`integration target '${integration.targetRef}' is unavailable on remote '${remote}'`);
    } else {
      const result = git(cwd, ["rev-parse", "--verify", `${integration.targetRef}^{commit}`], { timeout: PROBE_TIMEOUT_MS });
      if (!result || result.status !== 0) return fail(`integration target '${integration.targetRef}' does not resolve in ${repo || cwd}`);
    }
  }
  return { ok: true };
}

// Cache only refusals, separately by repo + definition. A page of work sharing
// an unavailable store does not hammer it once per item. Delay doubles to a
// cap, and a recovered check resets it. Existing worker cooldown makes reasons
// durable in --status and preserves normal queue pacing.
function availabilityBackoff({ now = Date.now, baseMs = 30000, maxMs = 300000 } = {}) {
  const refused = new Map();
  return async (key, probe) => {
    const prev = refused.get(key);
    if (prev && prev.until > now()) return { ...prev.result, retryAfterMs: prev.until - now() };
    let result;
    try { result = await probe(); }
    catch (e) { result = { ok: false, reason: `runtime availability check failed (${e.message})` }; }
    if (result.ok) { refused.delete(key); return result; }
    const attempts = (prev && prev.attempts || 0) + 1;
    const delay = Math.min(Math.max(baseMs, maxMs), Math.max(1000, baseMs) * 2 ** Math.min(attempts - 1, 20));
    if (!refused.has(key) && refused.size >= 200) refused.delete(refused.keys().next().value);
    refused.set(key, { attempts, until: now() + delay, result });
    return { ...result, retryAfterMs: delay };
  };
}
module.exports = { probeFactoryAvailability, probeHttpStore, availabilityBackoff, PROBE_TIMEOUT_MS };
