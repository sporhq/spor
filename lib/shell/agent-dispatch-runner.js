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
const { getHarness, declaredAdapter } = require("./dispatch-harnesses.js");
const terminal = require("./dispatch-terminal.js");
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
    // Run-scoped scratch space reserved for adapter.prepareRun (e.g. Codex's
    // isolated CODEX_HOME) — this module owns its lifecycle (removed on
    // close, on reconcile, and on prune) but never looks inside it; only the
    // owning adapter knows what it put there.
    scratch: path.join(dir, `${runId}.scratch`),
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

// A pid is not identity — pid spaces recycle, so an answering `pidAlive` can
// mean either "our supervisor" or "some unrelated process the kernel later
// handed the same number". This reads the kernel's own start-time tick count
// for a pid (Linux `/proc/<pid>/stat`, field 22), which a reused pid does not
// inherit from its predecessor: comparing it against the value recorded at
// launch is proof of continuity a bare pid check cannot give
// (issue-spor-dispatch-supervisor-identity-stale-timeout). Best-effort —
// returns null (identity unknowable) off Linux, or when the pid is gone or
// `/proc` is unreadable; callers fall back to the freshness heuristic then.
function processStartTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is parenthesized and may itself contain ")" or spaces, so
    // split after its LAST close-paren rather than assuming fixed columns.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ticks = Number(fields[19]); // field 22 (starttime): 19 fields after state (field 3)
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
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

// Locate a run's transcript — ONLY by the session it bound, whose id names the
// file exactly (issue-spor-dispatch-run-liveness-same-cwd-misattribution).
//
// The tempting fallback is "the newest transcript in this checkout that
// postdates the launch", and it is wrong: a project dir is one CHECKOUT, not
// one run, and every `--no-worktree` dispatch into the same repo shares it. That
// fallback stamps a live sibling's transcript onto a dead run as its terminal
// evidence, and a record that confidently points at the wrong transcript is
// worse than no record — the whole value here is that the record can be
// trusted. cwd and mtime cannot supply identity, so when the session is unbound
// the honest answer is "no transcript", and finalizeRun says exactly that.
function findTranscript(record, env = process.env) {
  if (!record || !record.session_id) return null;
  const dir = claudeProjectDir(record.cwd, env);
  if (!dir) return null;
  const direct = path.join(dir, `${record.session_id}.jsonl`);
  return fs.existsSync(direct) ? direct : null;
}

// Records that carry TURN state. Everything else a transcript holds is session
// bookkeeping — titles, mode and permission changes, queue operations,
// worktree/PR metadata — which the harness appends freely, INCLUDING after the
// final turn. Filtering these by an allowlist is what keeps the end-of-turn
// marker inside the trailing window checked below: a denylist of known
// bookkeeping names rots every time the harness adds another metadata type, and
// each new one silently pushes the marker out of view and reports a run that
// finished cleanly as vanished — the exact misclassification this incident is
// about. (Measured against the transcript corpus on the dev box: 52 cleanly
// finished sessions read as `vanished` before this filter.)
const TURN_RECORD_TYPES = new Set(["user", "assistant", "system", "result", "attachment"]);

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
    if (!TURN_RECORD_TYPES.has(rec.type)) continue; // bookkeeping, not turn state
    records.push(rec);
  }
  if (!records.length) {
    return { state: "vanished", termination_class: "unknown", termination_signal: "empty-transcript", termination_reason: "the transcript holds no readable session records" };
  }
  const last = records[records.length - 1];
  const at = last.timestamp || "";
  // The marker has to close the LAST turn. A long session ends EVERY turn with
  // one, so scanning the whole tail would read a session that completed six
  // turns and then died in the seventh as a clean finish. Walk backwards
  // instead: turn CONTENT (a user prompt, an assistant reply, an attachment)
  // found before a marker means another turn began and never finished — the
  // vanish signature. Ambient `system` records are skipped, because the harness
  // emits them after the marker too (an away summary trailing a finished turn
  // does not reopen it). A fixed trailing window cannot express that: it either
  // misses a marker pushed back by such records, or calls a run 'done' whose
  // final turn had genuinely just started.
  let clean = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "result" || (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "stop_hook_summary"))) { clean = true; break; }
    if (r.type === "user" || r.type === "assistant" || r.type === "attachment") break;
  }
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

// Is this run still alive, given the harness's live background-agent list?
// Liveness requires IDENTITY, never mere co-location
// (issue-spor-dispatch-run-liveness-same-cwd-misattribution): a bound session
// matches by id; an unbound one matches by the launch NAME it was started with
// (`claude --bg --name <name>`), in the checkout it was launched in.
//
// Sharing a cwd is not evidence about THIS run — several dispatches routinely
// share one checkout (every `--no-worktree` dispatch into the same repo does),
// so a bare cwd match lets an unrelated sibling agent hold a dead run open
// forever, which is the exact failure the parent incident exists to end. A run
// with no identity to match on is reported NOT live, so it reaches a terminal
// state that says identity was unavailable rather than hanging non-terminal.
//
// A launch NAME is derived from the node id (or truncated task text,
// cmdDispatch), so it is REUSED by every re-dispatch of that node into the
// same checkout — unlike a session id it is not unique across runs
// (issue-spor-dispatch-unbound-run-identity-not-unique). An open-ended "at or
// after `created_at`" match let a MUCH LATER re-dispatch's live agent satisfy
// an earlier, dead run's identity test forever, keeping it non-terminal. The
// name+cwd fallback exists only to cover the harness's own registration lag —
// a beat after launch before `claude agents --json` lists the agent — so it
// is bounded to a `graceMs`-wide window on BOTH sides of `created_at`: an
// agent sharing the name and cwd but started well outside that window is a
// DIFFERENT run of the same name, not this one.
//
// That window is still per-record and symmetric, so on its own it cannot
// tell apart two DIFFERENT records that share a name+cwd and were both
// created within `graceMs` of each other (a quick re-dispatch) — both would
// read the same live agent as their own evidence. This function judges one
// record in isolation by design; disambiguating across sibling records is
// `reconcileRuns`'s job (`assignNameMatchOwners`), done once over the whole
// record set before this is ever called.
function isRunLive(record, agents, graceMs = 60000) {
  if (!record || !Array.isArray(agents)) return false;
  const created = Date.parse((record && record.created_at) || "") || 0;
  for (const a of agents) {
    if (!a) continue;
    if (record.session_id) {
      if (a.sessionId === record.session_id) return true;
      continue;
    }
    if (!record.name || a.name !== record.name) continue;
    if (record.cwd && a.cwd !== record.cwd) continue;
    if (!created) return true; // nothing to bound against — pre-existing behavior
    const started = Number(a.startedAt) || 0;
    if (started && Math.abs(started - created) <= graceMs) return true;
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
        // Unbound is an IDENTITY gap, not an observed cause: without a session
        // id nothing in the checkout can be proved to belong to this run, so the
        // record says so instead of borrowing a sibling's transcript
        // (issue-spor-dispatch-run-liveness-same-cwd-misattribution).
        termination_reason: record.session_id
          ? trimReason(`no transcript for session ${record.session_id} under ${claudeProjectDir(record.cwd, env)}`)
          : "the run never bound a session, so no transcript can be attributed to it — it is no longer running, but how it ended is unknown",
      };
  return { ...outcome, finished_at: now(), ...(transcript ? { transcript_path: transcript } : {}) };
}

// The terminal patch for a run whose child never started. ONE shape for both
// sides of a supervised launch: the supervisor failing to exec the harness, and
// the dispatcher failing to get the supervisor itself running — a launch that
// dies on either side must read identically afterwards.
function launchFailure(message, signal = "launch-failed", now = () => new Date().toISOString()) {
  return {
    state: "failed_launch",
    termination_class: "launch",
    termination_signal: signal,
    termination_reason: trimReason(message),
    finished_at: now(),
    error: message,
    // No agent ever ran, so nothing was verified against the graph. The
    // supervised runner re-runs the contract over this patch (releasing the
    // lease it holds) and overwrites these three; the LAUNCHER's own abort
    // path releases the lease itself and leaves them as written.
    ...terminal.unenforcedOutcome("failed_launch", "the run never started, so nothing was verified against the graph"),
  };
}

// Stamp a terminal patch onto a record the caller holds no handle for, and
// return whatever the record now IS. `fromState` is the state the caller based
// its patch on: a supervised record is owned by a detached process that can
// finalize at any instant, so a DERIVED outcome must never overwrite one the
// supervisor observed, nor a state that has moved on underneath it (a
// `launching` record now `running` invalidates a "never started" verdict).
// Re-read, compare, then write. Fail-soft, like updateRun: closing the journal
// must never turn a reported launch failure into a crash.
function closeRun(recordFile, patch, fromState = null) {
  try {
    const record = readJson(recordFile);
    if (!record || TERMINAL_STATES.has(record.state)) return record;
    if (fromState && record.state !== fromState) return record;
    const merged = { ...record, ...patch };
    atomicJson(recordFile, merged);
    return merged;
  } catch {
    return null;
  }
}

// The LAST lines of a blob — the only part that is evidence of how a run ENDED.
// `transcriptOutcome` bounds itself for the same reason (a harness that hit a
// rate limit mid-run and then recovered did not die of it, so an unbounded scan
// of a 64KB tail files an hour-old recovered error as the cause of death), but
// its window can be far tighter: it counts 5 records AFTER an allowlist drops
// bookkeeping. This bounds a RAW interleaved stream — the harness's per-item
// JSONL progress events plus multi-line stderr — so the window has to survive a
// trailing stack trace and a turn summary sitting after the real signal, while
// still excluding one thousands of events back.
function lastLines(text, count = 20) {
  const lines = String(text || "").split("\n").filter((l) => l.trim());
  return lines.slice(-count).join("\n");
}

// When this run last showed a sign of life: its log's mtime, or failing that the
// launch itself. FRESHNESS, not age — a supervised run can legitimately work for
// a long time, and a live supervisor keeps writing to the log while it does, so
// only SILENCE is evidence against a pid that still answers.
function lastActivityAt(record, stat = fs.statSync) {
  let at = Date.parse((record && (record.started_at || record.created_at)) || "") || 0;
  if (record && record.log_path) {
    try { at = Math.max(at, stat(record.log_path).mtimeMs); } catch { /* no log written yet */ }
  }
  return at;
}

// Derive the terminal patch for a SUPERVISED run whose supervisor is gone
// (issue-spor-dispatch-supervised-runs-never-reconciled). The supervisor
// finalizes its own record when it survives; when it does not — killed, OOM,
// the box rebooted — nothing else ever will, so the run sits at
// launching/running forever unless this closes it.
//
// The evidence is the one the adapter already declares (`activeDiscovery:
// run-records`): the supervisor's OWN pid, plus the log it was writing. The
// native path's transcript machinery does not apply — a supervised harness
// writes JSONL to our log, not a Claude Code session transcript — and neither
// does the native live-agent list, which knows nothing about supervised runs.
//
// `launching` means the supervisor never reported its child starting, which is
// a failed LAUNCH; `running` means it started and then stopped being observed,
// which is the vanish signature. A recognized environment signal in the log
// wins over both generic readings, exactly as it does for an observed exit.
//
// A bare pid is not permanent identity: pid spaces recycle (32768 wide in many
// containers), and a recycled pid would otherwise hold a record `running`
// FOREVER — pruneRuns only ages out terminal records, so nothing else would
// ever close it. The settled evidence is supervisor IDENTITY, not silence
// (issue-spor-dispatch-supervisor-identity-stale-timeout): `record.runner_started_ticks`
// pins the kernel start-time tick count observed at launch, and `startTicks`
// is that same read taken now — when both are known, an exact match is proof
// this is still our supervisor, however long it has gone quiet
// (`lastActivityAt`), and the freshness ceiling never applies; a mismatch is
// proof of reuse and closes the run immediately, no silence required. Only
// when identity is unknowable (older records with no recorded tick count, or
// a non-Linux host where `processStartTicks` always returns null) does the
// old silence-past-`staleMs` heuristic still apply, as a documented
// best-effort fallback.
function finalizeSupervisedRun(record, { alive = false, startTicks = null, now = () => new Date().toISOString(), graceMs = 60000, staleMs = 86400000 } = {}) {
  if (!record || TERMINAL_STATES.has(record.state)) return null;
  const at = Date.parse(now());
  const created = Date.parse(record.created_at || "") || 0;
  const age = created ? at - created : 0;
  const quiet = lastActivityAt(record);
  const recordedTicks = Number.isFinite(record.runner_started_ticks) ? record.runner_started_ticks : null;
  const identityKnown = alive && recordedTicks != null && startTicks != null;
  const identityMismatch = identityKnown && startTicks !== recordedTicks;
  const reallyAlive = alive && !identityMismatch;
  const stale = reallyAlive && !identityKnown && staleMs > 0 && quiet > 0 && at - quiet > staleMs;
  if (reallyAlive && !stale) return null;
  if (created && age < graceMs) return null;
  const launched = record.state === "running";
  const known = classifyTerminalText(record.log_path ? lastLines(tailFile(record.log_path)) : null);
  const pid = Number.isInteger(record.runner_pid) && record.runner_pid > 0 ? record.runner_pid : null;
  const gone = launched
    ? `the supervisor${pid ? ` (pid ${pid})` : ""} is gone and never recorded an outcome, so the run stopped mid-flight`
    : `the supervisor${pid ? ` (pid ${pid})` : ""} is gone and never reported its child starting`;
  return {
    state: launched ? (known ? "failed" : "vanished") : "failed_launch",
    termination_class: known ? known.class : (launched ? "unknown" : "launch"),
    termination_signal: known ? known.signal : (identityMismatch ? "supervisor-pid-reused" : (stale ? "supervisor-stale" : (launched ? "supervisor-gone" : "supervisor-never-started"))),
    termination_reason: known ? known.reason : trimReason(identityMismatch
      ? `pid ${pid} answers, but its kernel start-time no longer matches the supervisor we launched — that pid has been reused by an unrelated process`
      : stale
      ? `pid ${pid} still answers, but this run has written nothing for ${Math.floor((at - quiet) / 3600000)}h — either that pid has been reused or the run is wedged; either way its supervisor is not reporting`
      : gone),
    finished_at: now(),
  };
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

// `isRunLive`'s name+cwd fallback is bounded to a `graceMs` window around ONE
// record's own `created_at`, but that window is symmetric and per-record, so
// two DIFFERENT unbound records sharing a name+cwd (a quick re-dispatch of
// the same node, seconds apart — issue-spor-dispatch-unbound-run-identity-
// not-unique) can BOTH fall within `graceMs` of the very same live agent's
// `startedAt`. Judged against each record in isolation, both would read
// alive from that one agent — and unlike the original unbounded bug, that
// misattribution would not even self-correct with time: `created_at` and
// `startedAt` are both fixed historical timestamps, so the older record
// would stay wrongly non-terminal for as long as the newer one's agent keeps
// running, however long that is.
//
// Disambiguate up front, once, over the WHOLE record set: an agent can only
// ever be evidence for the run it actually IS, so of every unbound record
// whose name+cwd matches and whose `created_at` falls within `graceMs` of the
// agent's `startedAt`, only the one launched MOST RECENTLY (the run a
// re-dispatch is, definitionally) is allowed to read it as live. Every other
// same-named candidate is denied that agent, so it falls through to its own
// terminal reconciliation on the evidence it actually has.
//
// The candidate pool is further restricted to currently-non-terminal
// native-background records: those are the only records `reconcileRuns` ever
// consults this map FOR (a supervised-jsonl record reconciles off its own pid,
// never off `agents`; an already-terminal record's `finalizeRun` short-circuits
// before ever looking at `scoped`). Letting either kind win a tie-break costs
// them nothing but can wrongly deny the agent to a live native record that
// actually needs it — a strictly worse outcome than the residual ambiguity
// between two GENUINELY concurrent non-terminal native dispatches of the same
// name+cwd, which this function does not (and cannot, from timestamps alone)
// fully resolve (the known `--force` re-dispatch ambiguity).
function assignNameMatchOwners(records, agents, graceMs) {
  const owner = new Map(); // agent -> the run_id allowed to read it as evidence
  for (const a of agents) {
    if (!a || !a.name) continue;
    const started = Number(a.startedAt) || 0;
    let best = null;
    for (const r of records) {
      if (!r || r.session_id) continue; // a bound record matches by session id, never this path
      // Only a currently-non-terminal native-background record ever CONSUMES
      // this ownership map (via `scoped` in reconcileRuns) — a supervised-jsonl
      // record reconciles off its own pid, never off `agents`, and a
      // terminal record's own `finalizeRun` short-circuits before ever
      // looking at `scoped`. Letting either kind win the tie-break has no
      // benefit to itself and only harm to whichever live native record it
      // outranks, so both are excluded from the candidate pool entirely.
      if (r.launch_mode !== "native-background" || TERMINAL_STATES.has(r.state)) continue;
      if (r.name !== a.name) continue;
      if (r.cwd && a.cwd !== r.cwd) continue;
      const created = Date.parse(r.created_at || "") || 0;
      if (!created) continue; // no timestamp to rank by — isRunLive's own `!created` fallback covers it unconditionally
      if (started && Math.abs(started - created) > graceMs) continue;
      if (!best || created > (Date.parse(best.created_at || "") || 0)) best = r;
    }
    if (best) owner.set(a, best.run_id);
  }
  return owner;
}

// The harness child a supervised run launches is spawned WITHOUT `detached`
// (it shares the supervisor's stdio pipes), so it does not die on its own when
// only the supervisor's pid is killed — a pid-targeted kill leaves it running,
// orphaned, with no supervisor left to ever observe or record its exit
// (issue-spor-dispatch-vanished-supervisor-orphan-child). The moment
// reconciliation decides the supervised run itself is over, this checks the
// recorded `child_pid` too and terminates it if it is still alive, so a
// vanished-run record never leaves a live process behind. Identity-checked the
// same way the supervisor pid is: a bare pid can have been recycled by an
// unrelated process since the child exited, and killing THAT would be an
// unrelated, real mistake, not cleanup — an older record with no recorded tick
// count (or a non-Linux host) falls back to trusting the bare pid, same as the
// supervisor's own stale-silence fallback.
function reapOrphanChild(record) {
  const pid = Number.isInteger(record.child_pid) && record.child_pid > 0 ? record.child_pid : null;
  if (!pid || !pidAlive(pid)) return false;
  const recordedTicks = Number.isFinite(record.child_started_ticks) ? record.child_started_ticks : null;
  if (recordedTicks != null) {
    const nowTicks = processStartTicks(pid);
    // We DID capture ticks at spawn, so we intended to gate on identity — if we
    // can't read them now (a transient /proc read failure, permission edge
    // case), that is "identity unverifiable", not "identity confirmed": treat
    // it the same as a mismatch rather than falling back to the bare pid.
    if (nowTicks == null || nowTicks !== recordedTicks) return false; // reused pid, or identity unconfirmable
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false; // already gone between the aliveness check and the signal
  }
}

// Resolve every non-terminal run, stamping each dead one with a terminal state,
// class, reason, and (natively) transcript pointer. Each launch mode is
// reconciled against the evidence its own adapter declares, and only that:
//
// - `native-background` detaches into the harness daemon, so liveness is the
//   harness's live-agent list. `enumerated` is the caller's answer to "could I
//   actually list the live agents?" — a harness we FAILED to query says nothing
//   about liveness, so those runs are skipped rather than declared vanished.
// - `supervised-jsonl` keeps a supervisor process of ours, so liveness is that
//   process (`activeDiscovery: run-records`). It needs no harness listing, and
//   therefore reconciles even when the native listing failed — a Codex-only box
//   has no `claude` to enumerate.
//
// A record in neither mode is passed through untouched: guessing at liveness
// with the wrong evidence is what left supervised runs non-terminal forever
// (issue-spor-dispatch-supervised-runs-never-reconciled).
function reconcileRuns(home, { agents = [], enumerated = true, env = process.env, now = () => new Date().toISOString(), graceMs = 60000, staleMs = 86400000 } = {}) {
  const records = readRunRecords(home);
  const nameOwners = assignNameMatchOwners(records, agents, graceMs);
  const out = [];
  for (const record of records) {
    let patch = null;
    if (record.launch_mode === "supervised-jsonl") {
      const alive = pidAlive(record.runner_pid);
      patch = finalizeSupervisedRun(record, { alive, startTicks: alive ? processStartTicks(record.runner_pid) : null, now, graceMs, staleMs });
      // Only once the supervised run is actually being closed (for whatever
      // reason — dead, stale-silent, or a reused pid) is its child evidence of
      // anything: while the supervisor is genuinely alive `patch` is null and
      // the child is exactly as supervised as ever.
      if (patch && reapOrphanChild(record)) patch = { ...patch, child_reaped: true };
      // The run is being closed for good right now — this may be the ONLY
      // chance to remove its scratch dir (e.g. an isolated CODEX_HOME): the
      // supervisor that would otherwise have cleaned it up on exit is exactly
      // what just died. `pruneRuns` is the long-term backstop; this is the
      // immediate one, so a crashed nested dispatch doesn't sit on a leaked
      // CODEX_HOME until the retention window ages it out.
      //
      // Skip it when a child was JUST reaped: `reapOrphanChild` only sends
      // SIGTERM and returns — it does not wait for the process to actually
      // exit — so the child may still be alive and reading/writing under
      // that scratch dir (its CODEX_HOME) for a beat after this. Ripping the
      // directory out from under a process that hasn't died yet is a race
      // this cleanup must not create; `pruneRuns`'s age-based sweep is the
      // backstop for exactly this case instead.
      if (patch && !patch.child_reaped) {
        try { fs.rmSync(runPaths(home, record.run_id).scratch, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    } else if (record.launch_mode === "native-background" && enumerated) {
      // Name-matched (unbound) agents are scoped to whichever record owns
      // them; a bound record still sees every agent (isRunLive matches those
      // by session id only, so an unowned name-match is harmless noise to it).
      const scoped = record.session_id
        ? agents
        : agents.filter((a) => {
            if (!a || !a.name || a.name !== record.name) return true;
            if (record.cwd && a.cwd !== record.cwd) return true;
            const owned = nameOwners.get(a);
            return owned === undefined || owned === record.run_id;
          });
      patch = finalizeRun(record, { alive: isRunLive(record, scoped, graceMs), env, now, graceMs });
    }
    if (!patch) {
      const backfill = terminalOutcomeBackfill(record);
      out.push(backfill
        ? (mergeTerminalOutcome(runPaths(home, record.run_id).record, backfill) || { ...record, ...backfill })
        : record);
      continue;
    }
    // A DERIVED ending never verified anything: the supervisor that would have
    // run the terminal-state contract is exactly what is missing here, and a
    // native-background run is out of the contract's v1 scope by decision
    // (dec-spor-dispatch-terminal-states-supervised-first). Stamp the outcome
    // best-effort and say so — `terminal_enforced: false` is the difference
    // between "we checked" and "we assumed", and an unenforced run can never
    // read `resolved` (task-spor-dispatch-terminal-states-contract).
    if (!patch.terminal_state) {
      patch = {
        ...patch,
        ...terminal.unenforcedOutcome(
          patch.state,
          record.launch_mode === "native-background"
            ? "native-background runs are outside the terminal-state contract — this outcome is classified after the fact from the harness's own transcript, not verified against the graph"
            : "the supervisor died before it could run the terminal-state contract, so this outcome was derived, not verified"
        ),
      };
    }
    // Guarded write: a supervised supervisor can finalize between the read above
    // and this write, and its OBSERVED outcome (with the exit code and session
    // it alone saw) must win over a derived one. On an unwritable journal, report
    // the derived outcome anyway.
    out.push(closeRun(runPaths(home, record.run_id).record, patch, record.state) || { ...record, ...patch });
  }
  return out;
}

// An ALREADY-terminal record that carries no terminal_state — a native launch
// failure closed by the launcher, or a supervised run whose supervisor died
// between writing its process outcome and running the contract. `finalizeRun`/
// `finalizeSupervisedRun` both refuse a terminal record, so nothing else would
// ever repair these and the contract's "every run ends in exactly one of
// resolved/reported/failed" would have holes in it. Backfilled best-effort and
// marked unenforced — never `resolved`.
//
// Held off while a SUPERVISED run's supervisor still answers: that process may
// be mid-contract right now, and its verified outcome is the one that should
// land. Once it is gone the record is repaired on the next read.
function terminalOutcomeBackfill(record) {
  if (!record || !TERMINAL_STATES.has(record.state) || record.terminal_state) return null;
  if (record.launch_mode === "supervised-jsonl" && pidAlive(record.runner_pid)) return null;
  return terminal.unenforcedOutcome(
    record.state,
    record.launch_mode === "native-background"
      ? "native-background runs are outside the terminal-state contract — this outcome is classified after the fact, not verified against the graph"
      : "the run was closed without a terminal-state outcome (its supervisor did not survive to run the contract), so this outcome was derived, not verified"
  );
}

// Additively merge an outcome into a record that is already terminal. Unlike
// `closeRun` this is ALLOWED to touch a terminal record — it only ever adds the
// outcome fields — but it re-reads and yields to whoever wrote one first, so a
// backfill can never overwrite the supervisor's verified verdict.
function mergeTerminalOutcome(recordFile, patch) {
  try {
    const record = readJson(recordFile);
    if (!record || record.terminal_state) return record;
    const merged = { ...record, ...patch };
    atomicJson(recordFile, merged);
    return merged;
  } catch {
    return null;
  }
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
    try { fs.rmSync(p.scratch, { recursive: true, force: true }); } catch { /* already gone */ }
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
  // A DECLARED harness has no entry in the in-code registry, so its adapter is
  // rebuilt here from the declaration the LAUNCHER resolved and wrote into the
  // job file (task-spor-dispatch-declarative-custom-harness) — not re-read from
  // config. The job file is the record of what this run was launched as; a
  // config edit between launch and exit must not change how this supervisor
  // reads the stream it is already following.
  const adapter = getHarness(job.harness) || declaredAdapter(job.harness_declaration);
  if (!adapter || adapter.launchMode !== "supervised-jsonl") return 2;
  let record = readJson(job.record_path) || {};
  const update = (patch) => {
    record = { ...record, ...patch };
    atomicJson(job.record_path, record);
  };

  // Close the record, then stamp its terminal state
  // (task-spor-dispatch-terminal-states-contract) — in that order, and NOT in
  // one write. The process-level patch has to land SYNCHRONOUSLY: the launcher
  // polls this record for a `failed_launch` for one second before deciding a
  // dispatch got off the ground, and the contract is up to three bounded HTTP
  // round-trips. Gating the terminal write behind them let a launch failure
  // miss that window entirely — `spor dispatch` reported success, exited 0, and
  // skipped the claim release for a harness binary that does not exist. So the
  // record goes terminal first — carrying a provisional unenforced outcome, so
  // it is never outcome-less — and the verified verdict merges in a beat later.
  const closeWithOutcome = async (patch, reportText = "") => {
    // The synchronous write carries a PROVISIONAL outcome so the record is
    // never terminal-without-one, not even for the beat the contract is in
    // flight. It is unenforced and says exactly that, so a supervisor that dies
    // mid-contract leaves an honest reading rather than a hole; the verified
    // verdict overwrites it below. A patch that brought its own outcome (a
    // launch failure) keeps it.
    update({
      ...terminal.unenforcedOutcome(patch.state, "the terminal-state contract had not finished running when this was written — the reading is process-level only"),
      ...patch,
      // The flag a reader needs to tell this PROVISIONAL outcome from the
      // verified one that overwrites it a beat later: the record is terminal,
      // but its outcome dimension is not settled yet. A poller that harvests
      // on `state` alone would otherwise read a run that resolved its target
      // as an unenforced `reported` (task-spor-work-loop). Internal
      // bookkeeping, like runner_pid — it is cleared below, and a supervisor
      // that dies mid-contract leaves it set, which is the honest reading.
      contract_pending: true,
    });
    let contract = null;
    try {
      contract = await terminal.applyTerminalContract({
        base: job.server,
        token: process.env.SPOR_DISPATCH_RENEW_TOKEN || process.env.SPOR_DISPATCH_BIND_TOKEN || "",
        nodeId: job.node_id || record.node_id || null,
        // Only the lease THIS dispatch established is ours to hand back — a
        // `--force` re-dispatch renews a lease that may belong to an agent
        // still running, and releasing that would strand it (the same
        // discipline as the launcher's abort-time release).
        releaseNode: job.release_node || null,
        project: job.project || null,
        runId: job.run_id || record.run_id,
        harness: job.harness,
        state: patch.state,
        reportText,
      });
    } catch (e) {
      contract = terminal.unenforcedOutcome(patch.state, `the terminal-state contract failed to run: ${e.message}`);
    }
    update({ ...contract, contract_pending: false });
  };

  let prompt = "";
  try {
    prompt = fs.readFileSync(job.prompt_path, "utf8");
  } catch (e) {
    await closeWithOutcome(launchFailure(`could not read prompt: ${e.message}`));
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

  // Adapter-owned environment preparation (dec-spor-dispatch-harness-adapter-
  // contract): Codex uses this to swap in an isolated CODEX_HOME when the
  // real one would be read-only (nested-dispatch sandbox isolation); most
  // adapters declare no `prepareRun` at all and this is a no-op for them —
  // byte-identical to before it existed. `job.scratch_path` is reserved by
  // the launcher for whatever the adapter puts there; this runner never looks
  // inside it. `cwd` is the directory the child is about to be spawned in —
  // an adapter needs it to pin any env var that has to agree with it (a spawn
  // `cwd` does NOT update the inherited `PWD`, and a CLI reading that shell
  // convention would otherwise work in the LAUNCHER's checkout).
  let prepared = null;
  if (typeof adapter.prepareRun === "function") {
    try {
      prepared = adapter.prepareRun({ env: childEnv, scratchDir: job.scratch_path, cwd: job.cwd });
    } catch {
      prepared = null; // an adapter's own prep failing must not take the dispatch down with it
    }
  }
  if (prepared && prepared.env) Object.assign(childEnv, prepared.env);
  const cleanupPrepared = () => {
    if (!prepared || typeof prepared.cleanup !== "function") return;
    try { prepared.cleanup(); } catch { /* best-effort — pruneRuns is the backstop */ }
  };

  let child;
  try {
    child = portableSpawn(job.command, job.args, {
      cwd: job.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    await finishWritable(log);
    await closeWithOutcome(launchFailure(e.message));
    cleanupPrepared();
    return 2;
  }

  let launched = false;
  let childError = null;
  let stdinError = null;
  let pending = "";
  let bindPromise = Promise.resolve();
  let sawSession = false;
  // The run's final report, for a harness that has no Codex-style
  // `--output-last-message` flag to write one itself. The adapter says which
  // events carry a final message; LAST one wins, matching that flag's
  // semantics. An adapter declaring no `reportFromEvent` leaves this null and
  // nothing is written — byte-identical to before the hook existed.
  let reportText = null;

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
        const report = typeof adapter.reportFromEvent === "function" ? adapter.reportFromEvent(event) : null;
        if (typeof report === "string" && report) reportText = report;
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
    // Recorded so a later reconcile can tell "still our child" apart from a
    // recycled pid before ever sending it a signal (see reapOrphanChild).
    const childTicks = processStartTicks(child.pid);
    update({
      state: "running",
      runner_pid: process.pid,
      child_pid: child.pid,
      started_at: new Date().toISOString(),
      ...(childTicks != null ? { child_started_ticks: childTicks } : {}),
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
      // Same ordering rule for an adapter-derived report: it must be on disk
      // before the record reports a terminal state, or a reader that reacts to
      // `done` can beat the file it points at. Best-effort — an unwritable
      // report is not worth failing an otherwise-complete run over.
      if (reportText !== null && job.report_path) {
        try {
          fs.writeFileSync(job.report_path, reportText.endsWith("\n") ? reportText : `${reportText}\n`, { mode: 0o600 });
        } catch { /* the log still holds the whole stream */ }
      }
      const failure = childError || stdinError || logError;
      const succeeded = launched && code === 0 && !failure;
      // Even an observed exit needs its REASON retained and classified: a
      // provider that cut the run off for credits is an environment failure to
      // re-dispatch with headroom, not a failure of the work
      // (inc-spor-dispatch-session-vanished-2026-07-18). The log excerpt is
      // bounded to the same trailing window as the derived (supervisor-gone)
      // path's finalizeSupervisedRun, via the same lastLines helper: an
      // observed exit and a derived one must read identical evidence the same
      // way, or a rate limit the run recovered from an hour earlier gets filed
      // as this run's cause of death only on the path that happened to close it
      // (issue-spor-dispatch-observed-exit-unbounded-tail-classification).
      const known = succeeded ? null : classifyTerminalText(failure ? failure.message : "") || classifyTerminalText(lastLines(tailFile(job.log_path)));
      // The run's final report, whoever wrote it: an adapter that derives one
      // from the event stream (above), or a harness that writes the file
      // itself (`--output-last-message`). It is the terminal-state contract's
      // `reported`-vs-`failed` discriminator, so read it back from disk when
      // the adapter supplied nothing.
      let finalReport = reportText;
      if (finalReport === null && job.report_path) {
        try { finalReport = fs.readFileSync(job.report_path, "utf8"); } catch { /* no report written */ }
      }
      await closeWithOutcome({
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
      }, finalReport || "");
      // The child is gone one way or another — success, failure, or a signal
      // — so whatever the adapter provisioned for it (an isolated CODEX_HOME)
      // is done being needed. reconcileRuns/pruneRuns are the backstops for
      // when this process itself never gets to run this line.
      cleanupPrepared();
      resolve(launched ? (succeeded ? 0 : (code || 1)) : 2);
    });
  });
}

if (require.main === module) {
  runJob(process.argv[2]).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
}

module.exports = {
  dispatchRunDir, runPaths, atomicJson, readJson, activeRuns, summarizeRun, portableSpawn, runJob,
  TERMINAL_STATES, TURN_RECORD_TYPES, classifyTerminalText, tailFile, lastLines, lastActivityAt, claudeProjectDir, findTranscript, transcriptOutcome,
  isRunLive, finalizeRun, finalizeSupervisedRun, readRunRecords, beginNativeRun, updateRun, reconcileRuns,
  launchFailure, closeRun, listRuns, pruneRuns, pidAlive, processStartTicks,
  terminalOutcomeBackfill, mergeTerminalOutcome,
  TERMINAL_OUTCOMES: terminal.TERMINAL_OUTCOMES, derivedTerminalOutcome: terminal.derivedTerminalOutcome,
  unenforcedOutcome: terminal.unenforcedOutcome, applyTerminalContract: terminal.applyTerminalContract,
  buildReportArtifact: terminal.buildReportArtifact, reportArtifactId: terminal.reportArtifactId,
};
