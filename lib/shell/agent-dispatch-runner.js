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
// The gate-state vocabulary is the pure gate module's, so this journal and the
// worker loop that reads it back cannot drift apart (kernel/gates.js).
const gatesKernel = require("../kernel/gates.js");
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

// Kernel evidence for "is `pid` alive right now" — EPERM tolerant, unlike
// `pidAlive`. `process.kill(pid, 0)` throws ESRCH when there is no such
// process, but it also throws EPERM when the pid exists and we simply lack
// permission to signal it (e.g. it now belongs to root after a pid-space
// reuse) — a plain `pidAlive` collapses both into `false`, misreporting a
// permissions error as "not alive" (issue-spor-dispatch-supervisor-liveness-
// check-divergence). Only ESRCH, or an invalid pid, means not alive here.
function supervisorAliveProbe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

// The ONE answer to "is this still our supervisor" — shared by
// finalizeSupervisedRun (deciding whether a running record should stay open)
// and terminalOutcomeBackfill (deciding whether to hold off repairing an
// already-terminal one), which used to ask this two different, diverging ways
// (issue-spor-dispatch-supervisor-liveness-check-divergence). Kernel liveness
// alone (supervisorAliveProbe) cannot tell survival from pid reuse — a
// recycled pid answers just as readily as the process we launched — so when a
// start-time tick count was recorded at launch (`recordedTicksRaw`), this also
// demands the pid's CURRENT kernel start-time (processStartTicks) still match
// it; a mismatch means the pid has been reused by an unrelated process,
// however alive it reads. `identityKnown` tells a caller whether that match
// was actually VERIFIED, as opposed to assumed because no tick count exists to
// check (an older record, or a non-Linux host) — a caller with its own
// fallback for the unverifiable case (e.g. a silence timeout) branches on it.
// `reallyAlive` is false outright for a dead pid or a confirmed mismatch.
//
// `readTicks` defaults to the real `processStartTicks` (Linux-only, per its
// own doc comment) but is an injectable seam: it is the ONE thing about this
// predicate that is platform-dependent, so a test can override it to exercise
// the match/mismatch/unknown branches deterministically on any host, rather
// than skipping the whole assertion off Linux
// (issue-spor-dispatch-supervisor-test-tick-count-non-linux).
function isSameSupervisor(pid, recordedTicksRaw, { readTicks = processStartTicks } = {}) {
  const recordedTicks = Number.isFinite(recordedTicksRaw) ? recordedTicksRaw : null;
  const alive = supervisorAliveProbe(pid);
  const startTicks = alive ? readTicks(pid) : null;
  const identityKnown = alive && recordedTicks != null && startTicks != null;
  const identityMismatch = identityKnown && startTicks !== recordedTicks;
  return { reallyAlive: alive && !identityMismatch, identityKnown };
}

// Whether a supervised run's supervisor should still be trusted to be
// watching it RIGHT NOW — the one decision `finalizeSupervisedRun` (should
// this running record stay open) and `terminalOutcomeBackfill` (should this
// already-terminal record be held off repair) both need, and which used to
// diverge (issue-spor-dispatch-supervisor-liveness-check-divergence,
// dec-spor-dispatch-supervisor-identity-tick-count). A confirmed identity
// match (`identityKnown`) is dispositive regardless of silence — a
// long-running supervised job can legitimately go quiet for hours. When
// identity can't be verified (no recorded tick count — an older record — or
// a non-Linux host where `processStartTicks` always returns null), "alive"
// alone cannot be trusted forever, since a recycled pid answers liveness
// probes just as readily as our real supervisor; fall back to the same
// silence-past-`staleMs` heuristic finalizeSupervisedRun always used for this
// case, keyed off the record's own last sign of life (`lastActivityAt`), not
// `now` alone.
function supervisorStillWatching(record, { now = () => new Date().toISOString(), staleMs = 86400000, readTicks = processStartTicks } = {}) {
  const { reallyAlive, identityKnown } = isSameSupervisor(record.runner_pid, record.runner_started_ticks, { readTicks });
  const identityMismatch = identityKnown && !reallyAlive;
  let stale = false;
  if (reallyAlive && !identityKnown && staleMs > 0) {
    const at = Date.parse(now());
    const quiet = lastActivityAt(record);
    stale = quiet > 0 && at - quiet > staleMs;
  }
  return { reallyAlive, identityKnown, identityMismatch, stale, watching: reallyAlive && !stale };
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

// A NATIVE-background run's own final report: the last assistant text in its
// session transcript. A supervised run's report comes off the stream its
// supervisor is reading (`--output-last-message` semantics — last assistant
// text wins, runJob's `reportText`); a `--bg` run has no such stream, but it
// writes the same messages to the transcript, so the LAST one is the same
// text by the same rule. That makes the terminal-state contract's `reported`
// and `declined` arms reachable for a native run instead of every unresolved
// one filing as `failed` with the agent's own hand-back thrown away
// (task-spor-dispatch-native-bg-terminal-detection).
//
// Read backwards and stop at the first assistant record carrying text: a tail
// is bounded (`tailFile`), so its FIRST line is routinely a fragment — an
// unparseable line is skipped, exactly as `transcriptOutcome` skips it, rather
// than read as the end of the transcript.
//
// A SIDECHAIN record is a subagent's message, which the supervised stream this
// mirrors never sees at all (a Task round-trip does not reach the parent's
// `--output-last-message`). Skipping it keeps the two readings over the same
// population instead of letting a subagent's closing line stand in for the
// agent's own report. Records that carry no such flag (an older transcript
// format) are unaffected.
function transcriptFinalText(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!rec || rec.type !== "assistant" || !rec.message || rec.isSidechain === true) continue;
    const content = rec.message.content;
    const parts = Array.isArray(content)
      ? content
      : (typeof content === "string" ? [{ type: "text", text: content }] : []);
    const out = parts
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (out) return out;
  }
  return "";
}

// The same text for a RECORD — the transcript it was reconciled against, or
// the one its session id names. "" whenever there is nothing attributable
// (an unbound run has no transcript of its own, by the identity rule above).
// A final report longer than the default tail leaves that window holding only a
// FRAGMENT of its line (unparseable, so skipped) plus the bookkeeping after it,
// and the scan comes back empty — which the contract would read as "no usable
// final report" and file as `failed`, throwing away a long hand-back (and, if
// its first line was `DECLINED:`, the decline with it). An empty scan is
// therefore retried once over a much wider window before it is believed.
const REPORT_TAIL_BYTES = 65536;
const REPORT_TAIL_RETRY_BYTES = 1048576;

function nativeRunReportText(record, env = process.env) {
  const transcript = (record && record.transcript_path) || findTranscript(record, env);
  if (!transcript) return "";
  const text = transcriptFinalText(tailFile(transcript, REPORT_TAIL_BYTES));
  if (text) return text;
  return transcriptFinalText(tailFile(transcript, REPORT_TAIL_RETRY_BYTES));
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
  return matchingAgents(record, agents, graceMs).length > 0;
}

// The listed agents that IDENTIFY as this record, by the rule the header above
// states. `isRunLive` is "is there at least one"; the native turn-complete
// detector below needs the agents THEMSELVES (it asks what state they are in),
// and the two must never drift apart on what counts as this run's agent.
function matchingAgents(record, agents, graceMs = 60000) {
  const out = [];
  if (!record || !Array.isArray(agents)) return out;
  const created = Date.parse((record && record.created_at) || "") || 0;
  for (const a of agents) {
    if (!a) continue;
    if (record.session_id) {
      if (a.sessionId === record.session_id) out.push(a);
      continue;
    }
    if (!record.name || a.name !== record.name) continue;
    if (record.cwd && a.cwd !== record.cwd) continue;
    if (!created) { out.push(a); continue; } // nothing to bound against — pre-existing behavior
    const started = Number(a.startedAt) || 0;
    if (started && Math.abs(started - created) <= graceMs) out.push(a);
  }
  return out;
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

// When this run last showed a sign of life: the newest mtime of anything it
// writes — our supervisor's log, or the harness's own session transcript —
// falling back to the launch itself. FRESHNESS, not age: a supervised run can
// legitimately work for a long time, and whatever is driving it keeps writing
// while it does, so only SILENCE is evidence against a pid that still answers.
//
// The transcript is here because a NATIVE-background run writes no log of ours
// at all (`log_path` is a supervised-only field), so a silence check that
// looked only there would read every native run as quiet since launch
// (task-spor-work-idle-run-detection). `findTranscript` is one `existsSync` on
// a path derived from the session id, not a scan. It can only ever make this
// answer FRESHER, which is the safe direction for the two staleness callers
// that predate it (supervisorStillWatching, finalizeSupervisedRun): a run with
// a moving transcript is alive, and reading it as such never closes a live run.
function lastActivityAt(record, stat = fs.statSync, env = process.env) {
  const launched = Date.parse((record && (record.started_at || record.created_at)) || "") || 0;
  return Math.max(launched, observedActivityAt(record, stat, env));
}

// The same reading with the LAUNCH FALLBACK removed: the newest mtime of
// something this run actually writes, or 0 when there is no such thing to read.
// The distinction matters to exactly one caller — the work loop's idle ceiling
// (task-spor-work-idle-run-detection) — and it is the difference between "this
// run has gone quiet" and "this run has no output channel we can observe".
//
// A `native-background` record only has one such channel, the harness's own
// session transcript, and it is reachable only through a bound `session_id` —
// which binding is best-effort (`captureDispatchSession` polls the agent
// listing for ~2s and then deliberately leaves the record session-less rather
// than guessing, and cannot succeed at all where that listing failed). For such
// a record `lastActivityAt` returns `created_at` forever, so an idle check keyed
// on IT would fire on a perfectly healthy agent the moment the ceiling passed,
// close its record `failed`, free the slot and re-offer the node. Answering 0
// instead makes the loop fall through to the watchdog, which is the honest
// instrument for a run nothing can observe.
function observedActivityAt(record, stat = fs.statSync, env = process.env) {
  if (!record) return 0;
  let at = 0;
  const touch = (file) => {
    if (!file) return;
    try { at = Math.max(at, stat(file).mtimeMs); } catch { /* not written yet, or already gone */ }
  };
  touch(record.log_path);
  touch(record.transcript_path || findTranscript(record, env));
  return at;
}

// --- native background: turn-complete detection -----------------------------
// (task-spor-dispatch-native-bg-terminal-detection)
//
// A finished `claude --bg` agent does NOT leave the daemon. `nativeAgentEvidence`
// already drops one reporting `state: "done"`, but a turn-complete agent
// routinely sits at `status: "idle"` with `state` still reading `"working"` —
// so `isRunLive` keeps its record open and a worker following it waits out the
// 24h watchdog on work that finished hours ago (the 2026-09-02 evidence on this
// task: two factory pipelines stalled five hours over exactly this, and a
// `claude stop` on each session released them).
//
// Idle alone is NOT that signal — an agent waiting on a tool call reads idle
// too — so this asks for three independent things at once, and every one of
// them has to say finished:
//
//   1. every listed agent that identifies as this run reads `status: "idle"`.
//      `state` is deliberately not consulted here: it is the field observed to
//      lie, and `state: "done"` is already handled upstream as its own terminal
//      signal. An agent with no `status` at all (an older CLI, another harness's
//      listing shape) never satisfies this — the fail-safe direction, since an
//      unreadable listing must leave the run live.
//   2. the transcript's LAST turn closed with an end-of-turn marker
//      (`transcriptOutcome` reading `turn-complete`). An idle agent whose
//      transcript is mid-turn is a waiting tool call, not a finished run.
//   3. nothing has been appended for `quietMs`. (1) and (2) are read at
//      different instants against a file the agent may still be writing, so the
//      quiet window is what makes them one consistent observation rather than
//      two racing ones — a marker written a beat before the next turn opens
//      would otherwise read as the end of the run.
//
// Returns the evidence (so the caller can stop the agent by its session) or
// null, which reads "still live" and leaves everything exactly as it was.
const NATIVE_QUIET_MS = 120000; // 2m

function nativeTurnComplete(record, agents, { graceMs = 60000, quietMs = NATIVE_QUIET_MS, env = process.env, stat = fs.statSync, now = () => new Date().toISOString() } = {}) {
  if (!record || record.launch_mode !== "native-background") return null;
  const matched = matchingAgents(record, agents, graceMs);
  if (!matched.length) return null; // nothing claims to be this run — not our question
  if (!matched.every((a) => String((a && a.status) || "").toLowerCase() === "idle")) return null;
  const transcript = findTranscript(record, env);
  if (!transcript) return null; // no attributable evidence — never guess a run finished
  if (transcriptOutcome(tailFile(transcript)).termination_signal !== "turn-complete") return null;
  const quietAt = observedActivityAt(record, stat, env);
  if (!quietAt) return null;
  const at = Date.parse(now()) || 0;
  if (!at || at - quietAt < quietMs) return null;
  return { agent: matched[0], quietAt, transcript };
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
function finalizeSupervisedRun(record, { now = () => new Date().toISOString(), graceMs = 60000, staleMs = 86400000, readTicks = processStartTicks } = {}) {
  if (!record || TERMINAL_STATES.has(record.state)) return null;
  const at = Date.parse(now());
  const created = Date.parse(record.created_at || "") || 0;
  const age = created ? at - created : 0;
  const quiet = lastActivityAt(record);
  const { identityMismatch, stale, watching } = supervisorStillWatching(record, { now, staleMs, readTicks });
  if (watching) return null;
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

// --- idle runs (task-spor-work-idle-run-detection) --------------------------
// A run whose supervisor is alive and whose pid is genuinely ours reads LIVE
// forever, however long it has been wedged — `supervisorStillWatching` says so
// deliberately, because a long job may legitimately go quiet. That is the right
// reading for reconciliation, which only ever asks "is this over?"; it is the
// wrong one for a WORKER holding a concurrency slot, a lease and a worktree for
// it. So idleness is judged by the work loop (work-loop.js runHarvest, keyed on
// `observedActivityAt` above) and acted on here.
//
// Stopping means the run is actually OVER, not that a signal was dispatched:
// this closes the record, after which nothing reconciles it again, so anything
// left running would sit in a worktree the loop is about to make
// re-dispatchable. Hence the process GROUP and the escalation:
//
//   - the supervisor is spawned `detached`, so it leads a process group holding
//     the harness child AND everything that child spawned (the build, the test
//     runner, a `git` left mid-flight). Signalling two recorded pids would
//     leave every grandchild behind, so the group is signalled as a group.
//     Group membership is also STRONGER evidence of ownership than a bare pid
//     — but only where the pid was PROVEN ours, so the group arm is gated on
//     `identityKnown`, not merely on `reallyAlive`. Off Linux (and on a record
//     predating `runner_started_ticks`) `processStartTicks` returns null and
//     "ours" degrades to "the pid answers"; blasting a whole group inferred
//     from an unverified pid is a far wider mistake than the single SIGTERM
//     that case used to get, so it keeps the per-pid signals and nothing more.
//     `kill(-pid)` is POSIX; a platform that refuses it degrades the same way.
//   - SIGTERM is a request. A child that traps or ignores it survives, so after
//     a bounded grace anything WE signalled and that still answers is SIGKILLed
//     — and the GROUP is SIGKILLed whether or not the two recorded pids are
//     still alive, since a surviving grandchild is precisely the case the group
//     arm exists for and it appears in neither pid. The final probe asks the
//     group too (`kill(-pgid, 0)` succeeds while any member remains), because
//     `alive` is a claim about the checkout, not about two pids: the caller
//     cools the node for the full silence window when a stop did not take,
//     instead of re-dispatching into a checkout something may still hold.
//
// One bound is inherent to any TERM-then-KILL escalation and is accepted rather
// than closed: a pid that dies and is REUSED inside the grace window would take
// the SIGKILL meant for its predecessor. Sub-2s wraparound on a pid space tens
// of thousands wide; the identity re-check that would close it buys less than
// the branch costs to keep correct.
//
// Only pids this function IDENTITY-CHECKED are ever signalled or escalated
// against directly: a child whose recorded start ticks cannot be confirmed is
// not ours to kill (the recycled-pid mistake), so it is left out of `signalled`
// at both stages. It is still covered — by the group, if it really is our
// child — because a group signal is addressed to the group, not to a pid we
// guessed at; what it must never license is a targeted kill of a pid that may
// by now belong to someone else.
function killSignal(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false; // already gone, not permitted, or no process groups on this platform
  }
}

async function stopRun(record, { graceMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readTicks = processStartTicks } = {}) {
  const stopped = { child: false, supervisor: false, group: false, alive: false };
  if (!record) return stopped;
  const pid = Number.isInteger(record.runner_pid) && record.runner_pid > 0 ? record.runner_pid : null;
  const identity = pid != null ? isSameSupervisor(pid, record.runner_started_ticks, { readTicks }) : { reallyAlive: false, identityKnown: false };
  const ours = identity.reallyAlive;
  const signalled = [];
  // The child first and on its own terms: `reapOrphanChild` carries the
  // identity check this module already settled on, and covers the case where
  // the supervisor is already gone and there is no group left to signal.
  if (reapOrphanChild(record, { readTicks })) {
    stopped.child = true;
    signalled.push(record.child_pid);
  }
  if (ours) {
    // The group only where identity was actually PROVEN — see the header. The
    // `pid &&` is structural, not redundant: `-pid` with a falsy pid is `-0`,
    // and `kill(0, …)` signals the CALLER's own process group — a worker that
    // kills itself. It cannot happen today (`stopped.group` implies `ours`
    // implies a positive pid); it is written so a later edit cannot make it.
    if (pid && identity.identityKnown) stopped.group = killSignal(-pid, "SIGTERM");
    stopped.supervisor = killSignal(pid, "SIGTERM") || stopped.group;
    signalled.push(pid);
  }
  if (!signalled.length) return stopped;
  await sleep(graceMs);
  const survivors = signalled.filter((p) => pidAlive(p));
  // NOT gated on `survivors`: the supervisor and child dying while a grandchild
  // traps SIGTERM is the whole reason the group arm is here, and that
  // grandchild is in neither recorded pid.
  if (pid && stopped.group) killSignal(-pid, "SIGKILL");
  for (const p of survivors) killSignal(p, "SIGKILL");
  if (!stopped.group && !survivors.length) return stopped;
  await sleep(Math.min(graceMs, 1000));
  // `kill(-pgid, 0)` succeeds while any member remains and throws ESRCH once
  // the group is empty. Its false answers only go one way that matters: a
  // zombie awaiting reaping reads alive, which over-cools the node — the safe
  // direction. Where identity was NOT provable there is no group to ask, so
  // `alive` is pid-scoped there and a surviving grandchild is invisible; that
  // is the accepted cost of not blasting a group inferred from a bare pid.
  stopped.alive = survivors.some((p) => pidAlive(p)) || (!!pid && stopped.group && killSignal(-pid, 0));
  return stopped;
}

// The terminal patch for a run stopped for idleness. `failed` with an `idle`
// class: the process dimension records that it was stopped mid-flight and why,
// exactly as a vanish or a crash does. A recognized ENVIRONMENT signal in the
// log still wins over the generic reading, the same way it does for an observed
// exit — an agent silent since it ran out of credits died of the credits, and
// filing that as idleness would lose a re-dispatchable cause.
//
// The OUTCOME dimension is the caller's: `outcome` carries a verdict verified
// against the graph (the work loop re-reads the target before writing this),
// because an agent that wrote its resolver and then wedged genuinely finished
// the work, and a stop is not evidence otherwise. With none, the run is
// unenforced — nothing checked anything.
function finalizeIdleRun(record, { idleMs = 0, quietAt = 0, now = () => new Date().toISOString(), stopped = null, outcome = null } = {}) {
  if (!record || TERMINAL_STATES.has(record.state)) return null;
  const at = Date.parse(now());
  const quietMin = Math.max(1, Math.round(((quietAt ? at - quietAt : idleMs) || 0) / 60000));
  const ceilingMin = Math.max(1, Math.round(idleMs / 60000));
  const signalled = !!(stopped && (stopped.child || stopped.supervisor));
  const known = classifyTerminalText(record.log_path ? lastLines(tailFile(record.log_path)) : null);
  return {
    state: "failed",
    termination_class: known ? known.class : "idle",
    termination_signal: known ? known.signal : "idle-timeout",
    termination_reason: known ? known.reason : trimReason(
      `the run wrote nothing to its log or transcript for ${quietMin}m (the idle ceiling is ${ceilingMin}m), so this worker stopped it` +
        (signalled ? "" : " — it had no process of ours left to signal")
    ),
    finished_at: now(),
    ...(stopped && stopped.child ? { child_reaped: true } : {}),
    ...(outcome || terminal.unenforcedOutcome(
      "failed",
      `the run was stopped after ${quietMin}m of silence, and the graph does not show its target resolved — this outcome was derived, not verified`
    )),
  };
}

// Stop an idle run and close its record, guarded: `closeRun` re-reads and
// refuses to overwrite a record that went terminal underneath us, so a
// supervisor that finished in the same instant keeps its own observed outcome.
//
// Returns `stopped` alongside the record because the two are a different claim
// and the caller acts on the difference: with a signal sent, this run is over;
// with nothing to signal (a native-background launch, whose agent lives in the
// harness's own daemon), all we did was stop FOLLOWING it, and something may
// well still be working in that checkout.
//
// The LEASE is not touched HERE: releasing it is the terminal-state contract's
// job, and the worker runs that leg on the contract's behalf once the record
// is closed (bin/spor.js releaseIdleLease, issue-spor-idle-stop-never-
// releases-lease) — after, never before, so a crash between the two leaves a
// closed record and a held lease that lapses at its TTL
// (dec-cc-task-claim-lease), never a released lease with no record of why.
async function stopIdleRun(home, record, { idleMs = 0, quietAt = 0, now = () => new Date().toISOString(), outcome = null, stop = stopRun } = {}) {
  if (!record || !record.run_id) return { record, stopped: { child: false, supervisor: false, group: false, alive: false } };
  const stopped = await stop(record);
  const patch = finalizeIdleRun(record, { idleMs, quietAt, now, stopped, outcome });
  if (!patch) return { record, stopped };
  return { record: closeRun(runPaths(home, record.run_id).record, patch, record.state) || { ...record, ...patch }, stopped };
}

// How many times a native record's terminal-state contract is attempted before
// its provisional reading is accepted as final. The debt has no owning process
// to retire it — a `--bg` launch keeps no supervisor — so it is retired by
// whichever caller next reconciles, and an UNREACHABLE graph must not spend it:
// clearing the flag on a 5xx or a dead socket would lose the report and the
// lease handback permanently, since nothing would ever look again. Bounded all
// the same, because "retry until a graph answers" is a per-poll pair of
// timeouts during an outage that nobody asked for; three chances, then the
// honest unenforced reading stands.
const NATIVE_CONTRACT_ATTEMPTS = 3;

// Land the terminal-state contract's verdict on a NATIVE record that owed it
// (task-spor-dispatch-native-bg-terminal-detection) — `settleContractOutcome`'s
// twin for the launch mode with no supervisor of its own, and it differs on
// exactly the two points that follow from that.
//
// 1. The DEBT is only spent when it was actually discharged. `terminal_enforced`
//    is the contract's own report of whether a graph answered, so an enforced
//    verdict clears `contract_pending` and an unenforced one leaves it set for
//    the next caller — up to `NATIVE_CONTRACT_ATTEMPTS`, counted on the record
//    so the retry cannot outlive an outage. The verdict is written either way:
//    it is never worse than the provisional reading it replaces.
// 2. A verified `resolved` may overwrite a NON-resolved verdict, even one that
//    already spent the flag. Two processes can both reconcile a native record
//    (a person's `spor runs` beside a worker's poll), and one of them may have
//    read the graph before the agent's resolver landed; a plain
//    pending-flag guard would then let that earlier, weaker reading win and
//    file a run that demonstrably resolved its target as `reported` — which
//    `shouldGate` does not gate at all. `resolved` is the strictly stronger
//    claim and the one both would agree on given the same graph, so it wins
//    regardless of order. Nothing else may overwrite a settled verdict.
function settleNativeOutcome(home, record, patch, { now = () => new Date().toISOString(), maxAttempts = NATIVE_CONTRACT_ATTEMPTS } = {}) {
  if (!record || !record.run_id || !patch) return record;
  const file = runPaths(home, record.run_id).record;
  try {
    const onDisk = readJson(file);
    if (!onDisk) return record;
    const verified = patch.terminal_state === "resolved" && patch.terminal_enforced === true;
    const upgrade = verified && onDisk.terminal_state !== "resolved";
    if (!onDisk.contract_pending && !upgrade) return onDisk;
    const attempts = (Number(onDisk.contract_attempts) || 0) + 1;
    const settled = patch.terminal_enforced === true || attempts >= maxAttempts;
    const merged = {
      ...onDisk,
      ...patch,
      contract_attempts: attempts,
      contract_pending: !settled,
      ...(settled ? { contract_settled_at: now() } : {}),
    };
    atomicJson(file, carryGateFields(file, merged));
    return merged;
  } catch {
    // The write is what makes this true; an unwritable journal means it is not
    // — hand back the honest provisional reading, exactly as its twin does.
    return record;
  }
}

// Land an outcome the WORKER verified onto a record still carrying the
// supervisor's PROVISIONAL one (task-spor-work-idle-run-detection). A
// supervised record goes terminal synchronously with an unenforced placeholder
// and `contract_pending` set, and the verified verdict merges in a beat later —
// but a supervisor killed inside that window never lands it, and the loop then
// harvests a run that RESOLVED its target as an unenforced `reported`. This is
// the same verify leg run by the only process left to run it.
//
// Guarded twice over: only a record still flagged `contract_pending` is
// touched — once the supervisor's own second write lands, that verdict is
// authoritative and this must not overwrite it — and `carryGateFields` keeps
// the out-of-band gate namespace the same way both in-process writers do.
//
// That flag is a guard, not a lock, and the residual is worth stating: a
// supervisor whose contract lands between this read and this rename has its
// write overwritten by ours. What it can cost is bounded by WHAT we write —
// only a `resolved` verdict ever reaches here, and `resolved` deliberately
// files no report and releases no lease, so the fields at risk
// (`report_node_id`, `lease_released`) belong to verdicts this path never
// produces. Both writers agree on the verdict itself, having run the same
// verify leg against the same graph.
function settleContractOutcome(home, record, patch) {
  if (!record || !record.run_id || !patch) return record;
  const file = runPaths(home, record.run_id).record;
  try {
    const onDisk = readJson(file);
    if (!onDisk || !onDisk.contract_pending) return onDisk || record;
    const merged = { ...onDisk, ...patch, contract_pending: false };
    atomicJson(file, carryGateFields(file, merged));
    return merged;
  } catch {
    // The write is what makes this true; an unwritable journal means it is not.
    // Handing the caller a verdict no other reader can see would have `spor
    // runs`, `spor work --status` and the gate resume scan disagree with what
    // the worker acted on, so keep the honest provisional reading instead.
    return record;
  }
}

// Merge a patch onto a CLOSED run record on disk — the idle stop's lease leg
// lands its `lease_released` verdict this way, a beat after `closeRun` wrote
// the terminal state. Re-read, merge, carry the out-of-band gate namespace,
// exactly as the in-process writers do; fail-soft (null), so an unwritable
// journal leaves the caller with the record it already had.
function stampRun(home, runId, patch) {
  if (!runId || !patch) return null;
  const file = runPaths(home, runId).record;
  try {
    const onDisk = readJson(file);
    if (!onDisk) return null;
    const merged = { ...onDisk, ...patch };
    atomicJson(file, carryGateFields(file, merged));
    return merged;
  } catch {
    return null;
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
// the supervisor is still the one we launched (isSameSupervisor —
// issue-spor-dispatch-supervisor-liveness-check-divergence) so a hard-killed
// runner cannot leave a false positive, and a recycled pid isn't mistaken for
// it still running.
function activeRuns(home, env = process.env, { readTicks = processStartTicks } = {}) {
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
    if (!isSameSupervisor(r.runner_pid, r.runner_started_ticks, { readTicks }).reallyAlive) continue;
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
function beginNativeRun(home, { harness, name, nodeId, cwd, model, runId, readOnly = false, releaseNode = null, project = null, localNodesDir = null, server = null, org = null, now = () => new Date().toISOString() }) {
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
    // Mirrors the supervised record: the preflight concurrency guard reads
    // records to decide who is WRITING where, and a read-only run occupies
    // nothing (task-spor-worker-preflight-validation).
    ...(readOnly ? { read_only: true } : {}),
    // What the terminal-state contract needs and cannot re-derive later
    // (task-spor-dispatch-native-bg-terminal-detection): the lease THIS
    // dispatch established and is therefore the only one entitled to hand back,
    // the project a report artifact is stamped with, and the local graph home
    // the launcher resolved — a repo `graph:` binding makes that differ from
    // the reconciling process's own cwd-resolved one. The supervised job file
    // carries the same three; a native record had nowhere to keep them. Only
    // written when set, so a record that names none is byte-identical to before.
    ...(releaseNode ? { release_node: releaseNode } : {}),
    ...(project ? { project } : {}),
    ...(localNodesDir ? { local_nodes_dir: localNodesDir } : {}),
    // …and WHICH graph this run was launched against. The supervised job file
    // carries the same key. Without it the settle would use whatever tenant the
    // reconciling process happens to resolve — and on a multi-tenant box
    // (`--org`, `SPOR_ORG`, a repo `org:` marker) that is a different graph,
    // where the same node id can exist and be released, or not exist and burn
    // the run's one contract attempt (dec-spor-client-cli-mode-tenant-resolution).
    // The ORG rides with it, because a HOSTED deployment routes every tenant
    // through ONE front door and separates them by the token's org claim — a
    // matching base URL is not on its own a matching graph.
    ...(server ? { server } : {}),
    ...(org ? { org } : {}),
    created_at: now(),
  };
  atomicJson(p.record, record);
  return { home, runId: id, paths: p, record };
}

// Any `gate_*` stamp already on disk for a record (task-spor-work-gate-
// pipeline). The gate pipeline writes that namespace OUT OF BAND
// (stampGateState) from the worker process, after the record has gone terminal
// — but the two in-process writers that own a record, `updateRun` below and the
// supervisor's own `update` in runJob, both write the WHOLE record from an
// IN-MEMORY copy that predates the stamp. Without this, a supervisor landing
// its verified terminal outcome a beat later (closeWithOutcome's second
// `update`, which can legitimately run after the loop has already harvested and
// begun gating a `contract_pending` record) silently erases the gate verdict
// this feature promises is durable.
//
// One small JSON read on a path that is not hot, and scoped to the ONE
// namespace no in-process writer owns, so it can never resurrect a stale value
// of anything either writer is authoritative for. The one thing it would
// defeat is a DELIBERATE deletion of a `gate_*` field by one of these two
// writers — it would be silently re-added — so a future writer that needs to
// clear one must do it through stampGateState (or explicitly here), not by
// dropping the key from its patch.
function carryGateFields(file, next) {
  try {
    const onDisk = readJson(file);
    if (!onDisk) return next;
    const gate = {};
    for (const [k, v] of Object.entries(onDisk)) if (k.startsWith("gate_")) gate[k] = v;
    return Object.keys(gate).length ? { ...next, ...gate } : next;
  } catch {
    return next; // an unreadable record is the caller's problem, not this guard's
  }
}

// Merge a patch into an open run record. Fail-soft: instrumentation must never
// take down the dispatch it is instrumenting.
function updateRun(handle, patch) {
  if (!handle || !handle.paths) return null;
  try {
    handle.record = { ...handle.record, ...patch };
    atomicJson(handle.paths.record, carryGateFields(handle.paths.record, handle.record));
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
function reapOrphanChild(record, { readTicks = processStartTicks } = {}) {
  const pid = Number.isInteger(record.child_pid) && record.child_pid > 0 ? record.child_pid : null;
  if (!pid || !pidAlive(pid)) return false;
  const recordedTicks = Number.isFinite(record.child_started_ticks) ? record.child_started_ticks : null;
  if (recordedTicks != null) {
    const nowTicks = readTicks(pid);
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
// - `native-background` — the `spor dispatch --bg` opt-in, or a record from
//   before the supervised default (task-spor-claude-adapter-headless-
//   supervised) — detaches into the harness daemon, so liveness is the
//   harness's live-agent list. `enumerated` is the caller's answer to "could I
//   actually list the live agents?" — a harness we FAILED to query says nothing
//   about liveness, so those runs are skipped rather than declared vanished
//   (a parser break on a new CLI version must not read as every `--bg` run
//   vanishing at once). Callers take that listing only when a non-terminal
//   native record exists to spend it on (bin/spor.js nativeAgentEvidence);
//   with none, `enumerated: false` and a successful empty listing are the same
//   outcome, so the skip is the `--bg` path's rule alone and never holds a
//   supervised-only worker's slot (task-spor-retire-native-bg-enumerated-
//   skip-after-supervised-default). Being LISTED is not the same as working: a
//   finished `--bg` agent stays registered in the daemon, so a listed one whose
//   three turn-complete signals all agree is closed anyway
//   (`nativeTurnComplete`), stopped through the injected `stopAgent`, and left
//   owing the terminal-state contract (`contract_pending`) for the caller that
//   holds a graph door.
// - `supervised-jsonl` keeps a supervisor process of ours, so liveness is that
//   process (`activeDiscovery: run-records`). It needs no harness listing, and
//   therefore reconciles even when the native listing failed — a Codex-only box
//   has no `claude` to enumerate.
//
// A record in neither mode is passed through untouched: guessing at liveness
// with the wrong evidence is what left supervised runs non-terminal forever
// (issue-spor-dispatch-supervised-runs-never-reconciled).
function reconcileRuns(home, { agents = [], enumerated = true, env = process.env, now = () => new Date().toISOString(), graceMs = 60000, staleMs = 86400000, readTicks = processStartTicks, quietMs = NATIVE_QUIET_MS, stopAgent = null } = {}) {
  const records = readRunRecords(home);
  const nameOwners = assignNameMatchOwners(records, agents, graceMs);
  const out = [];
  for (const record of records) {
    let patch = null;
    if (record.launch_mode === "supervised-jsonl") {
      patch = finalizeSupervisedRun(record, { now, graceMs, staleMs, readTicks });
      // Only once the supervised run is actually being closed (for whatever
      // reason — dead, stale-silent, or a reused pid) is its child evidence of
      // anything: while the supervisor is genuinely alive `patch` is null and
      // the child is exactly as supervised as ever.
      if (patch && reapOrphanChild(record, { readTicks })) patch = { ...patch, child_reaped: true };
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
      const live = isRunLive(record, scoped, graceMs);
      // A LISTED agent is not necessarily a working one: a turn-complete agent
      // sits idle in the daemon forever (nativeTurnComplete's header). When all
      // three of its signals agree, this run is over — and the daemon slot it
      // still holds is freed here, since nothing reconciles the record again.
      const finished = live ? nativeTurnComplete(record, scoped, { graceMs, quietMs, env, now }) : null;
      patch = finalizeRun(record, { alive: live && !finished, env, now, graceMs });
      if (patch && finished) {
        // `stopAgent` is injected: WHAT a machine runs to stop a background
        // agent is the harness adapter's to declare and the CLI's to resolve,
        // never this store's. A caller that passes none simply closes the
        // record and leaves the idle agent registered.
        //
        // It runs BEFORE the guarded write below, which is the deliberate
        // order: the stop narrows the window in which the agent could still
        // touch the graph between the contract's verify leg and the report it
        // files. A write refused underneath us therefore leaves a stopped agent
        // with an open record — self-healing rather than wrong, since stopping
        // appends nothing to the transcript, so the next reconcile reads the
        // same `turn-complete` and closes it the same way; only `stopped_for`
        // and `agent_stopped` are lost.
        let stopped = false;
        try {
          stopped = typeof stopAgent === "function" ? !!stopAgent(record, finished.agent) : false;
        } catch {
          stopped = false; // reaping is a courtesy; it must never cost the record its outcome
        }
        patch = { ...patch, stopped_for: "turn-complete", agent_stopped: stopped };
      }
    }
    if (!patch) {
      const backfill = terminalOutcomeBackfill(record, { now, staleMs, readTicks });
      out.push(backfill
        ? (mergeTerminalOutcome(runPaths(home, record.run_id).record, backfill) || { ...record, ...backfill })
        : record);
      continue;
    }
    // A DERIVED ending never verified anything by ITSELF, so the record is
    // never left outcome-less: stamp the best-effort reading here, and say so —
    // `terminal_enforced: false` is the difference between "we checked" and "we
    // assumed", and an unenforced run can never read `resolved`
    // (task-spor-dispatch-terminal-states-contract).
    //
    // For a NATIVE-background run with a target node that stamp is now
    // PROVISIONAL rather than final (task-spor-dispatch-native-bg-terminal-
    // detection). This store is synchronous and holds no server credential, so
    // it closes the record first — carrying an honest unenforced reading, so
    // there is no beat in which the record is terminal without an outcome —
    // and flags `contract_pending` for the caller that does hold `cfg` to run
    // the terminal-state contract and merge the verified verdict in
    // (`settleContractOutcome`, the same two-write shape the supervised
    // finalizer already uses). A crash in between leaves the provisional
    // reading and the flag, which the next reconcile's caller settles.
    //
    // The remaining native records keep the old permanent stamp, and for the
    // reasons the decision gave. With no target node there is nothing to
    // verify, report against, or release (a free-text `--bg` dispatch). And
    // with no ATTRIBUTABLE TRANSCRIPT — an unbound run, or a bound one whose
    // transcript is gone — this box knows literally nothing about how the run
    // went: the contract's not-done arm would then file an EMPTY report as a
    // VERIFIED `failed` and hand the lease back on the strength of "no agent is
    // listed", which is not evidence about the work. Such a record keeps its
    // unenforced reading and its lease (which lapses at its own TTL), exactly
    // as before.
    if (!patch.terminal_state) {
      const owesContract = record.launch_mode === "native-background" && !!record.node_id && !!patch.transcript_path;
      patch = {
        ...patch,
        ...terminal.unenforcedOutcome(
          patch.state,
          owesContract
            ? "the terminal-state contract had not finished running when this was written — the reading is process-level only, classified from the harness's own transcript"
            : record.launch_mode === "native-background"
            ? (record.node_id
              ? "no transcript can be attributed to this native-background run, so there is nothing to judge it by — the outcome is classified after the fact, not verified against the graph"
              : "this native-background run named no target node, so there is nothing to verify against the graph — the outcome is classified after the fact from the harness's own transcript")
            : "the supervisor died before it could run the terminal-state contract, so this outcome was derived, not verified",
          // The provisional beat has to read a DECLINE as a decline, or a
          // caller that never settles is left with exactly the gateable
          // unenforced `reported` that outcome exists to prevent (the same
          // reason the supervised finalizer threads its report text here).
          owesContract ? nativeRunReportText({ ...record, ...patch }, env) : ""
        ),
        ...(owesContract ? { contract_pending: true } : {}),
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
// Held off while a SUPERVISED run's supervisor is still trusted to be
// watching (`supervisorStillWatching` — the same shared check
// `finalizeSupervisedRun` uses, not a bare pid probe, so a pid the kernel has
// since recycled to an unrelated process cannot hold this open forever, and
// an identity-unverifiable record falls back to the same silence-past-
// `staleMs` heuristic instead of trusting a bare "alive" read indefinitely —
// dec-spor-dispatch-supervisor-identity-tick-count): that process may be
// mid-contract right now, and its verified outcome is the one that should
// land. Once it is gone — or the pid demonstrably belongs to someone else, or
// an unverifiable identity has gone quiet past the staleness ceiling — the
// record is repaired on the next read.
function terminalOutcomeBackfill(record, { now = () => new Date().toISOString(), staleMs = 86400000, readTicks = processStartTicks } = {}) {
  if (!record || !TERMINAL_STATES.has(record.state) || record.terminal_state) return null;
  if (record.launch_mode === "supervised-jsonl" && supervisorStillWatching(record, { now, staleMs, readTicks }).watching) return null;
  return terminal.unenforcedOutcome(
    record.state,
    record.launch_mode === "native-background"
      ? "this native-background record was closed without a terminal-state outcome (a launch that never left an agent behind), so this outcome is classified after the fact, not verified against the graph"
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

// Stamp the GATE pipeline's state onto a run record (task-spor-work-gate-
// pipeline): `gate_state` (running | interrupted | passed | failed | blocked),
// plus who was running it and when. This is the run journal's durable half of
// the gate verdict — a worker that dies mid-pipeline leaves `running` behind,
// and the next gate-armed worker on this box reads exactly that back
// (work-loop.js orphanedGateRuns) to know the claim is still un-judged.
//
// Only ever called on a record that is already TERMINAL — the pipeline runs
// after the terminal-state contract. That does NOT make it race-free: a
// supervised record goes terminal synchronously carrying a provisional
// `contract_pending` outcome, and the loop deliberately harvests it once
// `contractGraceMs` elapses even while the supervisor is alive, so the
// supervisor's second `update()` can land after the first gate stamp. That
// direction is handled where the clobber would happen — `carryGateFields`
// above, on both in-process writers — not here.
//
// Two narrowings here, both because this is the one writer that touches an
// already-settled record:
//
//   1. The patch is restricted to the `gate_` namespace, so a caller slip can
//      never overwrite the process or outcome dimensions (§8) that everything
//      downstream reads as ground truth.
//   2. A SETTLED verdict is FINAL for this run (gates.SETTLED_GATE_STATES). Two
//      workers can, in a narrow window, both adopt one orphaned pipeline
//      (orphanedGateRuns shrinks that window but cannot close it without a
//      cross-process lock), and without this the loser's later `passed` would
//      overwrite the winner's `failed` — a refusal silently laundered into an
//      approval, the one direction this feature must never fail in. A stop's
//      `interrupted` is refused over a settled verdict for the same reason. A
//      genuine re-gate after a person acts is a NEW dispatch with a NEW run id,
//      so nothing legitimate needs to reopen a settled record.
//
// THE REMAINING RACE, and why it is written this way. `carryGateFields` closes
// the ordinary case — a supervisor whose whole-record write happens after a
// stamp — but neither writer holds a lock, so a supervisor that READ before
// this settle and RENAMED after it reverts a settled `failed`/`blocked` back to
// `running`. Two things bound that:
//
//   - the consequence is DUPLICATED WORK, never a laundered verdict. Every gate
//     FACT is written to the graph before the pipeline settles, and fact ids are
//     deterministic, so a reverted record makes a later worker re-run the
//     pipeline and re-record the same nodes. The refusal's durable half — the
//     `blocks` edge and the status rollback (WORKERS.md §10.7) — has already
//     landed on the graph and is not touched by any run-record write. What a
//     revert costs is a re-run (a suite, a review dispatch), not correctness.
//   - a VERIFY-AND-REAPPLY pass closes it in practice: after writing a
//     `gate_state`, read the record back, and if the value is not the one just
//     written, some other whole-record write clobbered it — write again.
//     Bounded (`verifyAttempts`), because an unbounded retry against a
//     genuinely contended file is a spin, and the safe direction on giving up
//     is the resume scan re-offering the run.
//
// The settled-verdict guard above still runs on every attempt, so if the
// clobber came from ANOTHER worker legitimately settling this run first, the
// retry yields to it rather than fighting for the last word.
//
// `readBack` is injected so the reapply path is testable without a real race.
//
// Fail-soft, like every other write to this journal: a stamp that could not
// land re-offers the run to the resume scan, which is the safe direction.
// `force` is the ONE way to change `gate_state` itself past the settled-
// verdict guard below, and only `spor work --regate` uses it: a person
// re-judging a refused run after fixing what refused it. Every other writer —
// the loop, a resumed pipeline, a duplicate adopter — still cannot launder a
// settled verdict that way.
//
// `allowSettledPatch` is a NARROWER second door (task-spor-gate-escalation-
// bounded-auto-retry): it lets a patch through on a settled record only when
// the patch does not touch `gate_state` at all. The bounded escalation-retry
// writer needs exactly this — updating `gate_escalated_to`/`gate_demoted`/
// `gate_escalation_failed`/the retry bookkeeping on a run that settled
// `failed` or `blocked` LONG ago, without reopening (or being able to reopen)
// the verdict those fields sit beside. `force` still wins if both are passed.
function stampGateState(home, runId, patch, { verifyAttempts = 3, readBack = readJson, force = false, allowSettledPatch = false } = {}) {
  if (!runId || !patch) return null;
  const gateOnly = {};
  for (const [k, v] of Object.entries(patch)) if (k.startsWith("gate_")) gateOnly[k] = v;
  if (!Object.keys(gateOnly).length) return null;
  try {
    const file = runPaths(home, runId).record;
    for (let attempt = 0; ; attempt += 1) {
      const record = readJson(file);
      if (!record) return null;
      const settled = record.gate_state && gatesKernel.SETTLED_GATE_STATES.has(record.gate_state);
      if (settled && !force && !(allowSettledPatch && gateOnly.gate_state === undefined)) return record;
      const merged = { ...record, ...gateOnly };
      atomicJson(file, merged);
      // Only a `gate_state` write is worth verifying: it is the one field a
      // later reader treats as a verdict.
      if (!gateOnly.gate_state || attempt >= verifyAttempts) return merged;
      const after = readBack(file);
      if (!after || after.gate_state === gateOnly.gate_state) return merged;
    }
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

// The launch-handshake fd (task-spor-dispatch-launch-handshake): the launcher
// wires SPOR_DISPATCH_HANDSHAKE_FD when it wants a signal rather than to infer
// launch success from silence. Absent — an old launcher, a direct in-process
// call (the test suite calls runJob() itself, where fd 3 is whatever the TEST
// process happens to have open, not a channel to write handshake data into),
// or a test-seam launcher override that doesn't know the protocol — this is a
// pure no-op, byte-identical to before the handshake existed.
function launchHandshakeFd(env = process.env) {
  const raw = env.SPOR_DISPATCH_HANDSHAKE_FD;
  if (!raw) return null;
  const fd = Number(raw);
  return Number.isInteger(fd) && fd >= 0 ? fd : null;
}

async function runJob(jobFile) {
  const handshakeFd = launchHandshakeFd();
  let handshakeSent = false;
  // Best-effort and idempotent: a launcher not listening on this fd (or one
  // that already gave up and closed its end) must never take the supervisor
  // down with it.
  const sendLaunchHandshake = (payload) => {
    if (handshakeSent || handshakeFd === null) return;
    handshakeSent = true;
    try { fs.writeSync(handshakeFd, `${JSON.stringify(payload)}\n`); } catch { /* launcher gone */ }
    try { fs.closeSync(handshakeFd); } catch { /* already closed */ }
  };

  const job = readJson(jobFile);
  if (!job || !job.record_path || !job.prompt_path) {
    sendLaunchHandshake({ ok: false, error: "invalid dispatch job file" });
    return 2;
  }
  // A DECLARED harness has no entry in the in-code registry, so its adapter is
  // rebuilt here from the declaration the LAUNCHER resolved and wrote into the
  // job file (task-spor-dispatch-declarative-custom-harness) — not re-read from
  // config. The job file is the record of what this run was launched as; a
  // config edit between launch and exit must not change how this supervisor
  // reads the stream it is already following.
  const adapter = getHarness(job.harness) || declaredAdapter(job.harness_declaration);
  if (!adapter || adapter.launchMode !== "supervised-jsonl") {
    sendLaunchHandshake({ ok: false, error: `no supervised-jsonl harness adapter for ${job.harness || "(unknown)"}` });
    return 2;
  }
  let record = readJson(job.record_path) || {};
  const update = (patch) => {
    record = { ...record, ...patch };
    // The in-memory `record` stays this supervisor's own truth; only the DISK
    // write carries across a gate stamp written out of band while the contract
    // was in flight (carryGateFields).
    atomicJson(job.record_path, carryGateFields(job.record_path, record));
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
    // launch failure) keeps it. `reportText` is already in hand at this call
    // site (read from disk above before closeWithOutcome was invoked), so it
    // is threaded through here too: a DECLINE report must read as an
    // unenforced `declined` even in this narrow beat, or a supervisor that
    // dies mid-contract right after this write leaves behind exactly the
    // gateable unenforced `reported` this whole outcome exists to prevent.
    update({
      ...terminal.unenforcedOutcome(patch.state, "the terminal-state contract had not finished running when this was written — the reading is process-level only", reportText),
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
        // Local-mode's server-free verification path (task-spor-work-local-
        // mode-resolver-check): the launcher's own resolved graph home,
        // carried through the job file rather than re-derived here.
        nodesDir: job.local_nodes_dir || null,
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
    sendLaunchHandshake({ ok: false, error: `could not read prompt: ${e.message}` });
    await closeWithOutcome(launchFailure(`could not read prompt: ${e.message}`));
    return 2;
  }
  // A DECLARED harness's declaration lives only in the job file — which is
  // deleted just below, so any later reader of this run (runReportTexts
  // replaying the log for a rescue's early diagnosis block) would have
  // nothing to rebuild the adapter from and read []. Carry it onto the
  // persistent run record FIRST; readers prefer the record's copy
  // (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-background-job,
  // F2: built-in harnesses recovered the block, declared ones did not). A
  // built-in harness stamps nothing — byte-identical.
  if (job.harness_declaration) update({ harness_declaration: job.harness_declaration });
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
  // Supervisor-internal plumbing to the launcher, not for the harness child
  // (which never gets fd 3 passed through portableSpawn's own explicit stdio
  // array anyway) — stripped the same way the renew/bind tokens above are.
  delete childEnv.SPOR_DISPATCH_HANDSHAKE_FD;
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
      // `readOnly` is the adapter's own posture, handed over only when the
      // LAUNCHER recorded the run as read-only (`spor dispatch --read-only`,
      // the review gate's launch) — so an adapter whose posture needs the
      // environment as well as argv (OpenCode's bash denial) can complete it
      // here, and a plain dispatch's environment stays byte-identical.
      prepared = adapter.prepareRun({ env: childEnv, scratchDir: job.scratch_path, cwd: job.cwd, readOnly: job.read_only ? adapter.readOnly || null : null });
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
    sendLaunchHandshake({ ok: false, error: e.message });
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
  // The harness's own declaration that the run FAILED (Claude Code's `result`
  // event with `is_error: true`), read off the same stream through the
  // adapter's optional `failureFromEvent`. It outranks the exit code AND the
  // report: the terminal-state contract reads any report text as a clean
  // `reported` outcome (report presence is its discriminator, WORKERS.md §6),
  // so an errored session that still wrote a report would enter the gate
  // pipeline as if it had finished. A declared failure writes NO report and
  // keeps the error text as the termination reason instead
  // (issue-spor-claude-supervised-error-result-read-as-report). An adapter
  // declaring no hook leaves this null — byte-identical.
  let streamFailure = null;

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
        const declared = typeof adapter.failureFromEvent === "function" ? adapter.failureFromEvent(event) : null;
        if (declared && typeof declared.reason === "string" && declared.reason) streamFailure = declared;
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
    // The handshake goes out only AFTER the record write above lands: both are
    // synchronous local I/O, so ordering them this way guarantees the record
    // is already on disk by the time the launcher — in a different process —
    // gets scheduled to read the (unavoidably async, cross-process) pipe
    // message and re-reads it.
    sendLaunchHandshake({ ok: true });
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
    child.on("error", (error) => {
      childError = error;
      // `error` before `spawn` means the child never started (e.g. ENOENT) —
      // signal the failure now rather than waiting for `close`.
      if (!launched) sendLaunchHandshake({ ok: false, error: error.message });
    });
    // The run is over when the CHILD EXITS, not when its pipes close. The two
    // coincide for a harness that leaves nothing behind, but a child can hand
    // its stdout/stderr to a process that outlives it — Claude Code 2.x keeps
    // a persistent background daemon, and a `--mcp-config` server is a child
    // of the run too (test/helpers/claude-e2e.js resolves on `exit` and
    // redirects to files for exactly this reason) — and a supervisor that
    // waited for `close` would then never finalize: a run that finished in
    // seconds would read `running` forever, holding its work-loop slot and
    // its lease until the 24h watchdog. So `exit` arms a bounded drain: the
    // ordinary `close` (pipes shut, everything read) still finalizes first
    // when it comes — byte-identical for codex/opencode/copilot, whose pipes
    // close with the process — and if it has not arrived within
    // PIPE_DRAIN_GRACE_MS of the exit, the run is finalized from what has
    // been read (the adapter's session and report are already captured off
    // the stream by then) and our ends of the pipes are destroyed, so the
    // inherited fds cannot keep this detached supervisor alive either.
    // Whichever fires first wins; the other is a no-op.
    let finalized = false;
    let drainTimer = null;
    const finalize = async (code, signal) => {
      if (finalized) return;
      finalized = true;
      if (drainTimer) clearTimeout(drainTimer);
      // A safety net for an exit with neither `spawn` nor `error` observed
      // (platform quirk) — sendLaunchHandshake is idempotent, so this never
      // double-signals the ordinary paths above.
      if (!launched) sendLaunchHandshake({ ok: false, error: childError ? childError.message : `the process exited before starting (code ${code}${signal ? `, signal ${signal}` : ""})` });
      if (pending) parseLines("\n");
      await bindPromise;
      // Everything read is in the journal; now finish the stream so every
      // parsed event is durable before the terminal run record is visible.
      await finishWritable(log);
      // Same ordering rule for an adapter-derived report: it must be on disk
      // before the record reports a terminal state, or a reader that reacts to
      // `done` can beat the file it points at. Best-effort — an unwritable
      // report is not worth failing an otherwise-complete run over. A stream
      // that DECLARED its failure writes none: the report file is the
      // contract's `reported` channel, and this run did not finish.
      if (reportText !== null && !streamFailure && job.report_path) {
        try {
          fs.writeFileSync(job.report_path, reportText.endsWith("\n") ? reportText : `${reportText}\n`, { mode: 0o600 });
        } catch { /* the log still holds the whole stream */ }
      }
      const failure = childError || stdinError || logError;
      const succeeded = launched && code === 0 && !failure && !streamFailure;
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
      // When the harness DECLARED the failure, its declaration is the evidence,
      // not the log tail: the tail also holds the assistant turns that came
      // before the error result, and a session that merely DISCUSSED a credit
      // balance or a rate limit in prose (the prompt asked it to, or it read
      // the phrase in a file) would otherwise have that prose override the real
      // `is_error` reason and file the run as an environment failure to
      // re-dispatch with headroom. An environment signal in the error text
      // itself still wins over the generic reading (review finding F1).
      const known = succeeded
        ? null
        : classifyTerminalText(failure ? failure.message : "")
          || (streamFailure ? classifyTerminalText(streamFailure.reason) : classifyTerminalText(lastLines(tailFile(job.log_path))));
      // A declared failure with no recognized environment signal in its own
      // text is the run's own failure: the harness's wording is the reason.
      const declaredFailure = !succeeded && !known && streamFailure && !failure
        ? { class: "failed", signal: "error-result", reason: trimReason(`the harness reported an error result: ${streamFailure.reason}`) }
        : null;
      // The run's final report, whoever wrote it: an adapter that derives one
      // from the event stream (above), or a harness that writes the file
      // itself (`--output-last-message`). It is the terminal-state contract's
      // `reported`-vs-`failed` discriminator, so read it back from disk when
      // the adapter supplied nothing.
      let finalReport = streamFailure ? "" : reportText;
      if (finalReport === null && job.report_path) {
        try { finalReport = fs.readFileSync(job.report_path, "utf8"); } catch { /* no report written */ }
      }
      await closeWithOutcome({
        state: launched ? (succeeded ? "done" : "failed") : "failed_launch",
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        finished_at: new Date().toISOString(),
        termination_class: succeeded ? "completed" : (known ? known.class : (declaredFailure ? declaredFailure.class : (launched ? "failed" : "launch"))),
        termination_signal: succeeded ? "supervised-exit" : (known ? known.signal : (declaredFailure ? declaredFailure.signal : (launched ? "nonzero-exit" : "launch-failed"))),
        termination_reason: succeeded
          ? "the supervised child exited 0"
          : (known ? known.reason : (declaredFailure ? declaredFailure.reason : trimReason(failure ? failure.message : `the supervised child exited ${Number.isInteger(code) ? code : "abnormally"}${signal ? ` on ${signal}` : ""}`))),
        ...(failure ? { error: failure.message } : {}),
      }, finalReport || "");
      // The child is gone one way or another — success, failure, or a signal
      // — so whatever the adapter provisioned for it (an isolated CODEX_HOME)
      // is done being needed. reconcileRuns/pruneRuns are the backstops for
      // when this process itself never gets to run this line.
      cleanupPrepared();
      resolve(launched ? (succeeded ? 0 : (code || 1)) : 2);
    };
    child.on("close", (code, signal) => { finalize(code, signal); });
    child.on("exit", (code, signal) => {
      if (finalized) return;
      drainTimer = setTimeout(() => {
        if (finalized) return;
        for (const stream of [child.stdout, child.stderr]) {
          try { stream.destroy(); } catch { /* already closed */ }
        }
        finalize(code, signal);
      }, pipeDrainGraceMs(process.env));
      // Never the thing that keeps this process alive on its own: once the
      // pipes do close, `close` finalizes and clears it.
      if (typeof drainTimer.unref === "function") drainTimer.unref();
    });
  });
}

// How long after the child's `exit` the supervisor waits for its pipes to
// close before finalizing from what it has read. Long enough that a child
// whose last events are still in flight when it exits is never cut short
// (`close` normally follows `exit` within milliseconds), short enough that a
// pipe held open by an inherited fd costs seconds, not a watchdog window.
// SPOR_DISPATCH_PIPE_DRAIN_MS overrides it (tests, or a box whose harness is
// known to hand fds around).
const PIPE_DRAIN_GRACE_MS = 3000;
function pipeDrainGraceMs(env = process.env) {
  const n = Number(env && env.SPOR_DISPATCH_PIPE_DRAIN_MS);
  return Number.isFinite(n) && n >= 0 ? n : PIPE_DRAIN_GRACE_MS;
}

if (require.main === module) {
  runJob(process.argv[2]).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
}

// Every final-message candidate a supervised run's stream carried, in stream
// order — the texts the supervisor's report hook saw, of which it KEPT only
// the last (`reportText` in runJob: last one wins, the `--output-last-message`
// semantics). Read back off the run's own log (`log_path` — the verbatim
// JSONL stream) through the same adapter hook, so a reader that needs an
// EARLIER message — a rescue's early diagnosis block, emitted before a long
// verification and then overwritten by "I'll commit once the suite notifies
// me" — can find it without the supervisor changing what a report IS. A
// declared harness has no registry entry, so its declaration is read from
// the run record (the supervisor stamps it there before it deletes the job
// file — the job file is gone for every finished run) or, for a record
// written before that stamp existed, from the job file under `home` when the
// caller names one. A harness that writes
// its report ITSELF (`--output-last-message`) declares no report hook — the
// supervisor must not overwrite its file — so it may declare the read-only
// `messageFromEvent` instead (Codex: each `agent_message` item), and that is
// what a reader prefers when present: the two hooks answer the same question
// ("is this event an assistant message, and what does it say?"), only one of
// them is also the supervisor's report discriminator. Fail-soft: no log, no
// adapter, no hook, an unreadable file → []; a non-JSON line (stderr
// interleaved into the log) is skipped, never fatal.
function runReportTexts(record, { home = null } = {}) {
  if (!record || !record.log_path) return [];
  let adapter = getHarness(record.harness) || null;
  if (!adapter) {
    let declaration = record.harness_declaration || null;
    if (!declaration && home && record.run_id) {
      const job = readJson(runPaths(home, record.run_id).job);
      declaration = job && job.harness_declaration ? job.harness_declaration : null;
    }
    adapter = declaredAdapter(declaration);
  }
  const hook = adapter && typeof adapter.messageFromEvent === "function"
    ? adapter.messageFromEvent
    : (adapter && typeof adapter.reportFromEvent === "function" ? adapter.reportFromEvent : null);
  if (!hook) return [];
  let raw;
  try {
    raw = fs.readFileSync(record.log_path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let text = null;
    try {
      text = hook(JSON.parse(line));
    } catch {
      continue;
    }
    if (typeof text === "string" && text) out.push(text);
  }
  return out;
}

module.exports = {
  dispatchRunDir, runPaths, atomicJson, readJson, activeRuns, summarizeRun, portableSpawn, runJob, runReportTexts,
  TERMINAL_STATES, TURN_RECORD_TYPES, classifyTerminalText, tailFile, lastLines, lastActivityAt, claudeProjectDir, findTranscript, transcriptOutcome,
  isRunLive, matchingAgents, nativeTurnComplete, transcriptFinalText, nativeRunReportText, NATIVE_QUIET_MS,
  settleNativeOutcome, NATIVE_CONTRACT_ATTEMPTS,
  finalizeRun, finalizeSupervisedRun, observedActivityAt, stopRun, finalizeIdleRun, stopIdleRun, settleContractOutcome, stampRun,
  readRunRecords, beginNativeRun, updateRun, reconcileRuns,
  launchFailure, closeRun, listRuns, pruneRuns, pidAlive, processStartTicks,
  supervisorAliveProbe, isSameSupervisor, supervisorStillWatching, PIPE_DRAIN_GRACE_MS, pipeDrainGraceMs,
  terminalOutcomeBackfill, mergeTerminalOutcome, stampGateState,
  TERMINAL_OUTCOMES: terminal.TERMINAL_OUTCOMES, derivedTerminalOutcome: terminal.derivedTerminalOutcome,
  unenforcedOutcome: terminal.unenforcedOutcome, applyTerminalContract: terminal.applyTerminalContract,
  buildReportArtifact: terminal.buildReportArtifact, reportArtifactId: terminal.reportArtifactId,
};
