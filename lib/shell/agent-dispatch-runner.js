#!/usr/bin/env node
"use strict";

// Supervise one foreground coding-agent CLI outside the short-lived
// `spor dispatch` process. Harness-specific event interpretation lives in the
// adapter registry; this runner only manages process, journal, and late binding.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { getHarness } = require("./dispatch-harnesses.js");
const { whichSync } = require("../../scripts/engines/util.js");

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

// --- terminal outcome (inc-spor-dispatch-session-vanished-2026-07-18) -------
// A dispatched run must never end without a retained reason. Two states are
// terminal-by-construction (the supervisor observed the exit); the rest are
// derived after the fact from the harness's own transcript, because a
// `native-background` launch detaches into the harness daemon and the launcher
// never sees the child die.
const TERMINAL_STATES = new Set(["done", "failed", "failed_launch", "vanished"]);

// Ordered, high-signal terminal reasons that are the ENVIRONMENT's fault, not
// the agent's or the product's — a credit-dead run must be re-dispatchable with
// headroom, never filed as a capability or implementation failure. Ordered
// most-specific first; the first match wins and its LINE is retained verbatim.
const TERMINAL_SIGNATURES = Object.freeze([
  { signal: "credit-exhausted", class: "environment", re: /out of usage credits|credit balance is too low|insufficient credits/i },
  { signal: "usage-limit", class: "environment", re: /usage limit reached|quota (?:has been )?exceeded/i },
  { signal: "rate-limited", class: "environment", re: /rate_limit_error|overloaded_error/i },
  { signal: "auth-rejected", class: "environment", re: /authentication_error|invalid[_ -]?api[_ -]?key|oauth token (?:has )?expired/i },
]);

const REASON_CAP = 300;

function trimReason(line) {
  const s = String(line || "").replace(/\s+/g, " ").trim();
  return s.length > REASON_CAP ? `${s.slice(0, REASON_CAP - 1)}…` : s;
}

// Classify a terminal blob (a child's log tail, or the last transcript records).
// Returns {class, signal, reason} or null when nothing is recognized — the
// caller decides what an unrecognized ending means. The retained reason is a
// window around the match, not the whole line: a transcript record serializes
// to a wall of JSON whose interesting part is the provider's own wording.
function classifyTerminalText(text) {
  if (!text) return null;
  for (const sig of TERMINAL_SIGNATURES) {
    const line = String(text).split("\n").find((l) => sig.re.test(l));
    if (line === undefined) continue;
    const m = sig.re.exec(line);
    const from = Math.max(0, m.index - 80);
    const to = Math.min(line.length, m.index + m[0].length + 120);
    const excerpt = `${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`;
    return { class: sig.class, signal: sig.signal, reason: trimReason(excerpt) };
  }
  return null;
}

// Read the last `bytes` of a file, dropping the partial leading line. Bounded on
// purpose: a long session transcript is megabytes and only its tail carries the
// terminal reason.
function tailFile(file, bytes = 65536) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

// Claude Code keeps one JSONL transcript per session under
// <config>/projects/<cwd with every non-alphanumeric turned into a dash>/. That
// path is the diagnostic pointer a vanished run leaves behind.
function claudeProjectDir(cwd, env = process.env) {
  if (!cwd) return null;
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects", String(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

// Locate a run's transcript: by session id when one was bound, else the newest
// transcript in the run's project dir that postdates the launch (a local-mode
// dispatch never binds a session, and one project dir is one checkout — for a
// worktree dispatch that is this run alone).
function findTranscript(record, env = process.env) {
  const dir = claudeProjectDir(record && record.cwd, env);
  if (!dir) return null;
  if (record.session_id) {
    const direct = path.join(dir, `${record.session_id}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  const created = Date.parse(record.created_at || "") || 0;
  let best = null;
  let bestAt = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, ent.name);
    let m;
    try { m = fs.statSync(full).mtimeMs; } catch { continue; }
    // A transcript that was last written BEFORE this run started belongs to an
    // earlier session in the same checkout, never to this run.
    if (created && m < created) continue;
    if (m > bestAt) { bestAt = m; best = full; }
  }
  return best;
}

// Read a harness transcript's tail and say how the run ENDED. A clean end is an
// explicit end-of-turn marker; anything else is a run that stopped mid-turn,
// which is exactly the "vanished" signature this incident is about.
function transcriptOutcome(text) {
  const records = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== "object" || !rec.type) continue;
    if (rec.type === "last-prompt" || rec.type === "summary") continue; // bookkeeping, not turn state
    records.push(rec);
  }
  if (!records.length) {
    return { state: "vanished", termination_class: "unknown", termination_signal: "empty-transcript", termination_reason: "the transcript holds no readable session records" };
  }
  const last = records[records.length - 1];
  const at = last.timestamp || "";
  // The marker has to be at the END. A long session ends EVERY turn with one,
  // so scanning the whole tail would read a session that completed six turns
  // and then died in the seventh as a clean finish. Only the trailing few
  // records say how this session stopped.
  const clean = records.slice(-3).some((r) => r.type === "result" || (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "stop_hook_summary")));
  if (clean) {
    return { state: "done", termination_class: "completed", termination_signal: "turn-complete", termination_reason: trimReason(`the session ended its turn cleanly${at ? ` at ${at}` : ""}`) };
  }
  // Only the LAST few records are evidence of how it ended — an agent that
  // merely discussed credit exhaustion earlier in its run did not die of it.
  const known = classifyTerminalText(records.slice(-5).map((r) => JSON.stringify(r)).join("\n"));
  if (known) return { state: "failed", termination_class: known.class, termination_signal: known.signal, termination_reason: known.reason };
  return {
    state: "vanished",
    termination_class: "unknown",
    termination_signal: "mid-turn",
    termination_reason: trimReason(`the transcript stops mid-turn after a '${last.type}' record${at ? ` at ${at}` : ""} with no end-of-turn marker`),
  };
}

// Is this run still alive, given the harness's live background-agent list? A
// bound session matches by id; an unbound one falls back to the checkout it was
// launched in (one dispatch worktree is one run), never older than the launch.
function isRunLive(record, agents) {
  if (!record || !Array.isArray(agents)) return false;
  const created = Date.parse((record && record.created_at) || "") || 0;
  for (const a of agents) {
    if (!a) continue;
    if (record.session_id) {
      if (a.sessionId === record.session_id) return true;
      continue;
    }
    if (record.cwd && a.cwd === record.cwd) {
      const started = Number(a.startedAt) || 0;
      if (!created || (started && started >= created - 60000)) return true;
    }
  }
  return false;
}

// Derive the terminal patch for a run the harness no longer reports as live.
// Returns null when the run is already terminal, still alive, or still inside
// its registration grace window (the harness daemon registers an agent a beat
// after launch — finalizing inside that window would invent a vanish).
function finalizeRun(record, { alive = false, env = process.env, now = () => new Date().toISOString(), graceMs = 60000 } = {}) {
  if (!record || TERMINAL_STATES.has(record.state)) return null;
  if (alive) return null;
  const created = Date.parse(record.created_at || "") || 0;
  if (created && Date.parse(now()) - created < graceMs) return null;
  const transcript = findTranscript(record, env);
  const outcome = transcript
    ? transcriptOutcome(tailFile(transcript))
    : {
        state: "vanished",
        termination_class: "unknown",
        termination_signal: record.session_id ? "no-transcript" : "session-unbound",
        termination_reason: record.session_id
          ? trimReason(`no transcript for session ${record.session_id} under ${claudeProjectDir(record.cwd, env)}`)
          : "the run never bound a session and left no transcript — it exited before the harness registered it",
      };
  return { ...outcome, finished_at: now(), ...(transcript ? { transcript_path: transcript } : {}) };
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

function readRunRecords(home) {
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
    if (r && r.run_id) out.push(r);
  }
  return out;
}

// Open the durable record for a `native-background` launch BEFORE the spawn.
// `claude --bg` hands the child to its own daemon and returns, so the launcher
// only ever observes launch and (remotely) the session bind — without a record
// written at those boundaries a completed run and a dead one are
// indistinguishable afterwards, which is how the 2026-07-18 Sonnet dispatches
// "vanished". Returns a handle for updateRun().
function beginNativeRun(home, { harness, name, nodeId, cwd, model, runId, now = () => new Date().toISOString() }) {
  const id = runId || crypto.randomUUID();
  const p = runPaths(home, id);
  const record = {
    run_id: id,
    node_id: nodeId || null,
    name: name || null,
    harness,
    launch_mode: "native-background",
    state: "launching",
    cwd,
    model: model || null,
    created_at: now(),
  };
  atomicJson(p.record, record);
  return { home, runId: id, paths: p, record };
}

// Merge a patch into an open run record. Fail-soft: instrumentation must never
// take down the dispatch it is instrumenting.
function updateRun(handle, patch) {
  if (!handle || !handle.paths) return null;
  try {
    handle.record = { ...handle.record, ...patch };
    atomicJson(handle.paths.record, handle.record);
  } catch {
    /* an unwritable journal must not fail the launch */
  }
  return handle.record;
}

// Resolve every non-terminal native run against the harness's live agent list,
// stamping each dead one with a terminal state, class, reason, and transcript
// pointer. `enumerated` is the caller's answer to "could I actually list the
// live agents?" — a harness we FAILED to query says nothing about liveness, so
// reconciliation is skipped rather than declaring every run vanished.
function reconcileRuns(home, { agents = [], enumerated = true, env = process.env, now = () => new Date().toISOString(), graceMs = 60000 } = {}) {
  const records = readRunRecords(home);
  if (!enumerated) return records;
  const out = [];
  for (const record of records) {
    if (record.launch_mode !== "native-background") { out.push(record); continue; }
    const patch = finalizeRun(record, { alive: isRunLive(record, agents), env, now, graceMs });
    if (!patch) { out.push(record); continue; }
    const merged = { ...record, ...patch };
    try {
      atomicJson(runPaths(home, record.run_id).record, merged);
    } catch {
      /* unwritable journal — report the derived outcome anyway */
    }
    out.push(merged);
  }
  return out;
}

// Newest-first run records, optionally narrowed to one node or run id.
function listRuns(home, { node = null, runId = null, limit = 0, records = null } = {}) {
  let out = records || readRunRecords(home);
  if (node) out = out.filter((r) => r.node_id === node);
  if (runId) out = out.filter((r) => r.run_id === runId || r.run_id.startsWith(runId));
  out.sort((a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0));
  return limit > 0 ? out.slice(0, limit) : out;
}

// Age-bound the run journal. Only TERMINAL runs are pruned — a record whose
// outcome is still unresolved is the very thing this incident says must not
// disappear — and each takes its log/report/prompt siblings with it.
function pruneRuns(home, { maxAgeMs = 1209600000, now = Date.now } = {}) {
  let removed = 0;
  if (!(maxAgeMs > 0)) return { removed };
  const cutoff = now() - maxAgeMs;
  for (const record of readRunRecords(home)) {
    if (!TERMINAL_STATES.has(record.state)) continue;
    const ended = Date.parse(record.finished_at || record.created_at || "") || 0;
    if (!ended || ended >= cutoff) continue;
    const p = runPaths(home, record.run_id);
    for (const f of [p.record, p.log, p.report, p.job, p.prompt]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    removed++;
  }
  return { removed };
}

function portableSpawn(cmd, args, opts, runtime = {}) {
  const platform = runtime.platform || process.platform;
  const spawnImpl = runtime.spawn || spawn;
  if (platform !== "win32") return spawnImpl(cmd, args, opts);
  // npm exposes command shims as .cmd files on Windows. Resolve through PATH +
  // PATHEXT before deciding how to launch, matching the synchronous CLI path.
  const resolved = (runtime.which || whichSync)(cmd) || cmd;
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return spawnImpl(resolved, args, opts);
  const env = (opts && opts.env) || process.env;
  return spawnImpl(env.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", resolved, ...args], opts);
}

function finishWritable(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.writableFinished || stream.destroyed) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off("finish", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("finish", done);
    stream.once("close", done);
    stream.once("error", done);
    stream.end();
  });
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
  const launchFailure = (message) => ({
    state: "failed_launch",
    termination_class: "launch",
    termination_signal: "launch-failed",
    termination_reason: trimReason(message),
    finished_at: new Date().toISOString(),
    error: message,
  });
  const update = (patch) => {
    record = { ...record, ...patch };
    atomicJson(job.record_path, record);
  };

  let prompt = "";
  try {
    prompt = fs.readFileSync(job.prompt_path, "utf8");
  } catch (e) {
    update(launchFailure(`could not read prompt: ${e.message}`));
    return 2;
  }
  for (const p of [jobFile, job.prompt_path]) {
    try { fs.unlinkSync(p); } catch {}
  }

  fs.mkdirSync(path.dirname(job.log_path), { recursive: true });
  const log = fs.createWriteStream(job.log_path, { flags: "a", mode: 0o600 });
  let logError = null;
  log.on("error", (error) => { logError = error; });
  const childEnv = { ...process.env };
  const childToken = process.env.SPOR_DISPATCH_CHILD_TOKEN || "";
  delete childEnv.SPOR_DISPATCH_CHILD_TOKEN;
  delete childEnv.SPOR_DISPATCH_BIND_TOKEN;
  delete childEnv.SPOR_DISPATCH_RENEW_TOKEN;
  if (childToken) {
    // Never leave the broader person credential available under either the
    // canonical or legacy compatibility spelling in an agent-scoped run.
    delete childEnv.SPOR_TOKEN;
    delete childEnv.SUBSTRATE_TOKEN;
    childEnv.SPOR_TOKEN = childToken;
    childEnv.SUBSTRATE_TOKEN = childToken;
  }

  let child;
  try {
    child = portableSpawn(job.command, job.args, {
      cwd: job.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    update(launchFailure(e.message));
    await finishWritable(log);
    return 2;
  }

  let launched = false;
  let childError = null;
  let stdinError = null;
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

  // A child can reject args/config/auth before reading a large prompt. Writable
  // pipe failures must be observed before end(prompt), otherwise EPIPE crashes
  // this detached supervisor and leaves a permanently-running journal record.
  child.stdin.on("error", (error) => { stdinError = error; });

  child.once("spawn", () => {
    launched = true;
    update({
      state: "running",
      runner_pid: process.pid,
      child_pid: child.pid,
      started_at: new Date().toISOString(),
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      stdinError = error;
      child.stdin.destroy();
    }
  });
  child.stdout.on("data", (buf) => {
    const text = buf.toString("utf8");
    log.write(text);
    parseLines(text);
  });
  child.stderr.on("data", (buf) => log.write(buf));

  return new Promise((resolve) => {
    child.on("error", (error) => { childError = error; });
    child.on("close", async (code, signal) => {
      if (pending) parseLines("\n");
      await bindPromise;
      // `close` follows stdout/stderr closure; now finish the journal stream so
      // every parsed event is durable before the terminal run record is visible.
      await finishWritable(log);
      const failure = childError || stdinError || logError;
      const succeeded = launched && code === 0 && !failure;
      // Even an observed exit needs its REASON retained and classified: a
      // provider that cut the run off for credits is an environment failure to
      // re-dispatch with headroom, not a failure of the work
      // (inc-spor-dispatch-session-vanished-2026-07-18).
      const known = succeeded ? null : classifyTerminalText(failure ? failure.message : "") || classifyTerminalText(tailFile(job.log_path));
      update({
        state: launched ? (succeeded ? "done" : "failed") : "failed_launch",
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        finished_at: new Date().toISOString(),
        termination_class: succeeded ? "completed" : (known ? known.class : (launched ? "failed" : "launch")),
        termination_signal: succeeded ? "supervised-exit" : (known ? known.signal : (launched ? "nonzero-exit" : "launch-failed")),
        termination_reason: succeeded
          ? "the supervised child exited 0"
          : (known ? known.reason : trimReason(failure ? failure.message : `the supervised child exited ${Number.isInteger(code) ? code : "abnormally"}${signal ? ` on ${signal}` : ""}`)),
        ...(failure ? { error: failure.message } : {}),
      });
      resolve(launched ? (succeeded ? 0 : (code || 1)) : 2);
    });
  });
}

if (require.main === module) {
  runJob(process.argv[2]).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
}

module.exports = {
  dispatchRunDir, runPaths, atomicJson, readJson, activeRuns, summarizeRun, portableSpawn, runJob,
  TERMINAL_STATES, classifyTerminalText, tailFile, claudeProjectDir, findTranscript, transcriptOutcome,
  isRunLive, finalizeRun, readRunRecords, beginNativeRun, updateRun, reconcileRuns, listRuns, pruneRuns,
};
