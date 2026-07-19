#!/usr/bin/env node
"use strict";

// Supervise one foreground coding-agent CLI outside the short-lived
// `spor dispatch` process. Harness-specific event interpretation lives in the
// adapter registry; this runner only manages process, journal, and late binding.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getHarness } = require("./dispatch-harnesses.js");

function dispatchRunDir(home) {
  return path.join(home, "journal", "dispatch");
}

function runPaths(home, runId) {
  const dir = dispatchRunDir(home);
  return {
    dir,
    record: path.join(dir, `${runId}.run.json`),
    job: path.join(dir, `${runId}.job.json`),
    prompt: path.join(dir, `${runId}.prompt`),
    log: path.join(dir, `${runId}.log`),
    report: path.join(dir, `${runId}.report.md`),
  };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function summarizeRun(r) {
  return {
    id: r.run_id,
    run_id: r.run_id,
    name: r.name,
    node: r.node_id || null,
    harness: r.harness,
    state: r.state,
    status: r.state === "running" || r.state === "launching" ? "busy" : r.state,
    cwd: r.cwd,
    pid: r.child_pid || r.runner_pid || null,
    sessionId: r.session_id || null,
    startedAt: r.started_at ? Date.parse(r.started_at) : null,
    log_path: r.log_path,
    report_path: r.report_path,
  };
}

// Active supervised runs for same-machine guards and queue annotation. Confirm
// the supervisor PID so a hard-killed runner cannot leave a false positive.
function activeRuns(home, env = process.env) {
  if (env.SPOR_FAKE_DISPATCH_RUNS_JSON != null) {
    try {
      const xs = JSON.parse(env.SPOR_FAKE_DISPATCH_RUNS_JSON);
      return Array.isArray(xs) ? xs : [];
    } catch {
      return [];
    }
  }
  const dir = dispatchRunDir(home);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".run.json"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const r = readJson(path.join(dir, file));
    if (!r || !["launching", "running"].includes(r.state)) continue;
    if (!pidAlive(r.runner_pid)) continue;
    out.push(summarizeRun(r));
  }
  return out;
}

function portableSpawn(cmd, args, opts) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(cmd)) return spawn(cmd, args, opts);
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmd, ...args], opts);
}

async function post(url, token, body) {
  if (!url || !token) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runJob(jobFile) {
  const job = readJson(jobFile);
  if (!job || !job.record_path || !job.prompt_path) return 2;
  const adapter = getHarness(job.harness);
  if (!adapter || adapter.launchMode !== "supervised-jsonl") return 2;
  let record = readJson(job.record_path) || {};
  const update = (patch) => {
    record = { ...record, ...patch };
    atomicJson(job.record_path, record);
  };

  let prompt = "";
  try {
    prompt = fs.readFileSync(job.prompt_path, "utf8");
  } catch (e) {
    update({ state: "failed_launch", finished_at: new Date().toISOString(), error: `could not read prompt: ${e.message}` });
    return 2;
  }
  for (const p of [jobFile, job.prompt_path]) {
    try { fs.unlinkSync(p); } catch {}
  }

  fs.mkdirSync(path.dirname(job.log_path), { recursive: true });
  const log = fs.createWriteStream(job.log_path, { flags: "a", mode: 0o600 });
  const childEnv = { ...process.env };
  const childToken = process.env.SPOR_DISPATCH_CHILD_TOKEN || "";
  delete childEnv.SPOR_DISPATCH_CHILD_TOKEN;
  delete childEnv.SPOR_DISPATCH_BIND_TOKEN;
  delete childEnv.SPOR_DISPATCH_RENEW_TOKEN;
  if (childToken) childEnv.SPOR_TOKEN = childToken;

  let child;
  try {
    child = portableSpawn(job.command, job.args, {
      cwd: job.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    update({ state: "failed_launch", finished_at: new Date().toISOString(), error: e.message });
    log.end();
    return 2;
  }

  let launched = false;
  let settled = false;
  let pending = "";
  let bindPromise = Promise.resolve();
  let sawSession = false;

  const bindSession = (session) => {
    if (sawSession || !session) return;
    sawSession = true;
    update({ session_id: session });
    bindPromise = (async () => {
      const base = String(job.server || "").replace(/\/+$/, "");
      const bindToken = process.env.SPOR_DISPATCH_BIND_TOKEN || "";
      const renewToken = process.env.SPOR_DISPATCH_RENEW_TOKEN || bindToken;
      if (bindToken) await post(`${base}/v1/agents/session`, bindToken, { session });
      if (job.renew_node && renewToken) {
        await post(`${base}/v1/nodes/${encodeURIComponent(job.renew_node)}/renew`, renewToken, { session });
      }
    })();
  };

  const parseLines = (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const session = typeof adapter.sessionFromEvent === "function" ? adapter.sessionFromEvent(event) : null;
        if (session) bindSession(session);
      } catch {
        // JSONL is preserved verbatim even when an adapter does not recognize it.
      }
    }
  };

  child.once("spawn", () => {
    launched = true;
    update({
      state: "running",
      runner_pid: process.pid,
      child_pid: child.pid,
      started_at: new Date().toISOString(),
    });
    child.stdin.end(prompt);
  });
  child.stdout.on("data", (buf) => {
    const text = buf.toString("utf8");
    log.write(text);
    parseLines(text);
  });
  child.stderr.on("data", (buf) => log.write(buf));

  return new Promise((resolve) => {
    const finish = async (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (pending) parseLines("\n");
      await bindPromise;
      update({
        state: launched ? (code === 0 ? "done" : "failed") : "failed_launch",
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        finished_at: new Date().toISOString(),
        ...(error ? { error } : {}),
      });
      log.end();
      resolve(launched ? (code || 0) : 2);
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("exit", (code, signal) => finish(code, signal, null));
  });
}

if (require.main === module) {
  runJob(process.argv[2]).then((code) => process.exit(code)).catch(() => process.exit(2));
}

module.exports = { dispatchRunDir, runPaths, atomicJson, readJson, activeRuns, summarizeRun, runJob };
