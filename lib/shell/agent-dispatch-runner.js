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
const processIdentity = require("./process-identity.js");
const { linkOrReserve } = require("./spool.js");
// The gate-state vocabulary is the pure gate module's, so this journal and the
// worker loop that reads it back cannot drift apart (kernel/gates.js).
const gatesKernel = require("../kernel/gates.js");
const candidateKernel = require("../kernel/candidate.js");
const completionKernel = require("../kernel/completion.js");
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
    // The run's STAGE WORKFLOW JOURNALS (`<stage>.workflow.jsonl` inside it)
    // for a run with no execution-store claim to keep them under
    // (bin/spor.js stageWorkflowJournal; the replay kernel's durable step
    // log, lib/kernel/workflow.js). Pruned with the record, like `scratch`.
    workflows: path.join(dir, `${runId}.workflows`),
    // The gate pipeline's last-known infrastructure retry count (gate-deps.js
    // saveGatePools), a sidecar a review's name falls back on when the pool
    // read fails. Pruned with the record.
    retryCount: path.join(dir, `${runId}.retry-count.json`),
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

// --- the ONE versioned put for a run record (task-spor-gate-progress-
// versioned-put-and-write-lint). Every write of an EXISTING run record in this
// module goes through here, and nowhere else calls `atomicJson` on a record
// (test/record-write-lint.test.js fails the build if one appears). It stamps
// a monotonic `rev` — read from the disk copy at the moment of the write, never
// from the caller's merge, so a stale in-memory copy cannot roll it back — and
// `rev_at`, the write's own clock. `rev` is what the `expectedRev` door on the
// namespace stampers below compares against: a caller that read a record,
// decided on a patch, and hands the rev it read back gets its write refused
// (`stale: true`, record returned) when anything else landed in between.
//
// The rev is the record's, not a namespace's: two namespaces (a gate stamp and
// a supervisor's terminal write) share one counter, so an `expectedRev` caller
// yields to ANY concurrent write — the conservative direction for a patch
// whose premise was read off the whole record. Callers that only ever touch
// their own fields under the lock (the merging stampers) do not pass one.
//
// Must be called with the record lock HELD — it is a rename over the record,
// and the lock is what makes the rev read and the write one step. It is
// deliberately not exported: the lock-taking stampers are the public doors.
function putRecord(file, value, { now = () => new Date().toISOString() } = {}) {
  const onDisk = readJson(file);
  const rev = (onDisk && Number.isInteger(onDisk.rev) && onDisk.rev > 0 ? onDisk.rev : 0) + 1;
  const stamped = { ...value, rev, rev_at: now() };
  atomicJson(file, stamped);
  return stamped;
}

// Create a run record that does not exist yet (rev 1). A creation is not a
// read-modify-write, so it takes no lock — but it is still the only other
// door onto a record's bytes, so it is EXCLUSIVE (two launchers minting one
// run id cannot rename over each other: the loser reads the winner back) and
// ATOMIC (no reader ever sees an empty or half-written record — a torn native
// record would never self-heal, since nothing rewrites one whole). The shape
// is `createNodeExclusive`'s: write a finished temp file, then hard-LINK it to
// the record path (link never replaces; EEXIST is the loser's signal), and
// where link() is not available (spool.js LINK_FALLBACK_CODES)
// reserve the path with `wx` and rename the finished temp file over the
// reservation. That fallback relaxes "never empty" to a window between the
// reservation and the rename (a concurrent loser reading it sees null and
// keeps its own copy; callers ignore the return and re-read later) — and a
// rename that FAILS takes its empty reservation with it, so the failure is a
// thrown error, never a permanent zero-byte record.
function createRecord(file, value, { now = () => new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamped = { ...value, rev: 1, rev_at: now() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2) + "\n", { mode: 0o600 });
  try {
    if (!linkOrReserve(tmp, file, { mode: 0o600 })) return readJson(file) || stamped;
    return stamped;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* linked or renamed away */ }
  }
}

// The read half of the versioned put: the record as it is on disk, carrying the
// `rev` a caller hands back through `expectedRev`. Null when there is no record.
function readRecord(home, runId) {
  if (!runId) return null;
  try {
    return readJson(runPaths(home, runId).record);
  } catch {
    return null;
  }
}

// The `expectedRev` guard every namespace stamper shares: a caller-supplied
// rev that is not the disk's means the premise the patch was decided on has
// moved. `null`/`undefined` means "no premise", which is every merging writer.
function revMatches(record, expectedRev) {
  if (expectedRev == null) return true;
  return (Number.isInteger(record.rev) ? record.rev : 0) === Number(expectedRev);
}

// Run identity (pid + start ticks minted at launch) lives in ONE module,
// process-identity.js (task-spor-extract-work-loop-plan-execute-and-outcome-
// door); the names below are this store's historical spellings of it.
// `supervisorAliveProbe` is the EPERM-tolerant liveness probe, and
// `isSameSupervisor` the shared `isOurProcess` check — kept exported under
// these names so every existing caller (and test) reads the same predicate.
const processStartTicks = processIdentity.processStartTicks;
const supervisorAliveProbe = processIdentity.aliveProbe;
// Plain pid liveness is the same EPERM-tolerant probe — one answer, not two
// (dec-spor-dispatch-unify-supervisor-liveness-check).
const pidAlive = processIdentity.aliveProbe;
function isSameSupervisor(pid, recordedTicksRaw, { readTicks = processStartTicks } = {}) {
  return processIdentity.isOurProcess(pid, recordedTicksRaw, { readTicks });
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
// derived after the fact by a reconcile, for a run whose supervisor died or a
// legacy `native-background` record (the retired `claude --bg` launch) whose
// launcher never saw the child die.
const TERMINAL_STATES = new Set(["done", "failed", "failed_launch", "vanished"]);

// Ordered, high-signal terminal reasons that are the ENVIRONMENT's fault, not
// the agent's or the product's — a credit-dead run must be re-dispatchable with
// headroom, never filed as a capability or implementation failure. Ordered
// most-specific first; the first match wins and its LINE is retained verbatim.
//
// The wording is PER PROVIDER, so each row has to carry every provider's
// phrasing of the same exhaustion or the run is filed as a plain nonzero exit
// (issue-spor-codex-usage-limit-outage-read-as-a-code-failure): Codex says
// "You've hit your usage limit … purchase more credits or try again at <date>",
// which matched neither the credit row ("out of usage credits") nor the
// usage-limit row ("usage limit reached"). Kept as one alternation per row
// rather than a row per provider, because the ROW is the classification the
// pools are keyed on and a provider is only ever a new spelling of it.
//
// What a row may NOT carry is a call to ACTION (review finding F1). Every
// alternative here is an assertion about STATE — this account is out of
// credits, this key was rejected — which only the provider ever makes about
// this run. "purchase more credits" is the remedy Codex offers, and a remedy
// is text anyone may write: an assistant explaining the error, a doc, a
// billing page's UI copy checked into the repo, this comment. On an
// unclassified nonzero exit the whole log TAIL is scanned, and the log holds
// the agent's own turns — so a CTA row would let a run's own prose about
// credits launder its code failure into an environment outage, re-dispatched
// with headroom against a suite that will fail again. Match what only the
// provider can say.
const TERMINAL_SIGNATURES = Object.freeze([
  { signal: "credit-exhausted", class: "environment", re: /out of usage credits|credit balance is too low|insufficient credits/i },
  // "…usage limit reached" (Anthropic), "You've hit your usage limit" / "you have
  // reached your usage limit" (Codex, verbatim from its `turn.failed` error in
  // run 93f9ca4e), "quota exceeded" (generic), and `insufficient_quota` — the
  // OpenAI API's own error code for the same exhaustion, which the Codex
  // adapter folds into its declared failure reason. The possessive forms are
  // anchored on `your`/`the`, so a log line that merely mentions a usage limit
  // in prose does not read as this run hitting one — and this row, not a CTA in
  // the credit row above, is what carries Codex's wording: its message LEADS
  // with "You've hit your usage limit", and the classification the pools are
  // keyed on is identical either way (environment → infrastructure → the shared
  // retry pool). Without it a Codex review that died on credits was stamped a
  // plain nonzero exit and the review gate read the missing report as a
  // rejection (issue-spor-review-gate-reviewer-outage-read-as-rejection).
  { signal: "usage-limit", class: "environment", re: /usage limit reached|(?:hit|reached|exceeded) (?:your|the) (?:\w+ ){0,2}usage limit|quota (?:has been )?exceeded|insufficient_quota/i },
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
    // The outage's own stated END, lifted from the WHOLE line rather than the
    // bounded excerpt (Codex's "try again at <date>" sits ~110 characters past
    // the match and a longer URL pushes it out of the window). Only an
    // environment signal carries one — a reset is the provider's statement
    // about its own quota, never something a code failure can say.
    const hint = sig.class === "environment" ? require("../kernel/gates.js").findResetHint(line) : null;
    return { class: sig.class, signal: sig.signal, reason: trimReason(excerpt), ...(hint ? { reset_hint: hint } : {}) };
  }
  return null;
}

// The record fields a recognized reset hint rides on
// (task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-
// reviewer): the phrase, and THIS host's UTC offset at the instant of
// classification — the originating host's, since the run's harness ran here —
// which is the only zone an absolute, zone-less "Sep 7th, 2026 6:27 AM" may be
// read in (dec-spor-reviewer-reset-pause-budget-and-provenance). Empty when
// nothing was recognized, so every record without a hint is byte-identical.
function resetHintFields(known, at = Date.now()) {
  if (!known || !known.reset_hint) return {};
  return { termination_reset_hint: known.reset_hint, termination_utc_offset_min: -new Date(at).getTimezoneOffset() || 0 };
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

// --- legacy native-background records (task-spor-deprecate-native-bg-dispatch)
// The `claude --bg` launch is retired: `spor dispatch` launches every harness
// supervised, so no new `native-background` record is ever written. Records
// written before the retirement still sit in the journal, and they used to be
// reconciled by scraping `claude agents --json` (liveness, keyed on session id
// or on name+cwd+start time) and the harness's session transcript JSONL (how
// the run ended, and its final report) — both moving targets that shifted with
// every Claude Code release and were the persistent source of red
// (issue-spor-server-e2e-bg-dispatch-late-bind-null and its siblings).
//
// Nothing is scraped any more. A legacy record is judged from the RECORD
// alone: it is believed live only inside a short horizon from its launch stamp
// — long enough that an agent launched just before an upgrade still guards its
// checkout, short enough that a dead one cannot occupy it for long — and past
// that it is closed `vanished` with an honest "outcome unknown" reading. The
// same predicate backs `spor runs`, the in-flight surface and the preflight
// occupancy guard, so the three can never disagree about one record.
const NATIVE_RETIRE_MS = 3600000; // 1h

function nativeLaunchedAt(record) {
  return Date.parse((record && (record.launched_at || record.started_at || record.created_at)) || "") || 0;
}

// Is a non-terminal legacy native record still believed live at `nowMs`? A
// record with no launch stamp at all has nothing to bound it and is not.
function nativeRecordBelieved(record, { nowMs = Date.now(), horizonMs = NATIVE_RETIRE_MS } = {}) {
  if (!record || record.launch_mode !== "native-background" || TERMINAL_STATES.has(record.state)) return false;
  const at = nativeLaunchedAt(record);
  return !!at && nowMs - at <= horizonMs;
}

// The terminal patch for a legacy native record past its horizon, or null
// while it is still believed live (or already terminal).
function retireNativeRun(record, { now = () => new Date().toISOString(), horizonMs = NATIVE_RETIRE_MS } = {}) {
  if (!record || record.launch_mode !== "native-background" || TERMINAL_STATES.has(record.state)) return null;
  if (nativeRecordBelieved(record, { nowMs: Date.parse(now()) || Date.now(), horizonMs })) return null;
  return {
    state: "vanished",
    termination_class: "unknown",
    termination_signal: "native-retired",
    termination_reason: "a native-background (claude --bg) run from before that launch mode was retired; its harness listing and transcript are no longer read, so it is closed past its horizon with how it ended unknown",
    finished_at: now(),
  };
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
function closeRun(recordFile, patch, fromState = null, { lock = withRecordLock } = {}) {
  try {
    // Read-compare-write under the record lock (writeRecordCarryingGate's
    // reasoning): the re-read is only a guard if nothing lands between it and
    // the rename.
    const step = () => {
      const record = readJson(recordFile);
      if (!record || TERMINAL_STATES.has(record.state)) return record;
      if (fromState && record.state !== fromState) return record;
      return putRecord(recordFile, { ...record, ...patch });
    };
    const held = lock(recordFile, step);
    return held.ok ? held.value : null; // a write that could not take the lock did not happen (never an unlocked fallback)
  } catch {
    return null;
  }
}

// The LAST lines of a blob — the only part that is evidence of how a run ENDED
// (a harness that hit a rate limit mid-run and then recovered did not die of
// it, so an unbounded scan of a 64KB tail files an hour-old recovered error as
// the cause of death). This bounds a RAW interleaved stream — the harness's per-item
// JSONL progress events plus multi-line stderr — so the window has to survive a
// trailing stack trace and a turn summary sitting after the real signal, while
// still excluding one thousands of events back.
function lastLines(text, count = 20) {
  const lines = String(text || "").split("\n").filter((l) => l.trim());
  return lines.slice(-count).join("\n");
}

// When this run last showed a sign of life: the newest mtime of anything it
// writes — our supervisor's log — falling back to the launch itself.
// FRESHNESS, not age: a supervised run can legitimately work for a long time,
// and whatever is driving it keeps writing while it does, so only SILENCE is
// evidence against a pid that still answers.
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
// A legacy `native-background` record writes no log of ours (`log_path` is a
// supervised-only field) and its harness transcript is no longer read
// (task-spor-deprecate-native-bg-dispatch), so for it `lastActivityAt` returns
// the launch stamp forever — an idle check keyed on IT would fire on a healthy
// agent the moment the ceiling passed. Answering 0 instead makes the loop fall
// through to the watchdog, which is the honest instrument for a run nothing
// can observe.
function observedActivityAt(record, stat = fs.statSync, env = process.env) {
  if (!record) return 0;
  let at = 0;
  const touch = (file) => {
    if (!file) return;
    try { at = Math.max(at, stat(file).mtimeMs); } catch { /* not written yet, or already gone */ }
  };
  touch(record.log_path);
  return at;
}

// Derive the terminal patch for a SUPERVISED run whose supervisor is gone
// (issue-spor-dispatch-supervised-runs-never-reconciled). The supervisor
// finalizes its own record when it survives; when it does not — killed, OOM,
// the box rebooted — nothing else ever will, so the run sits at
// launching/running forever unless this closes it.
//
// The evidence is the one the adapter already declares (`activeDiscovery:
// run-records`): the supervisor's OWN pid, plus the log it was writing.
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
    ...resetHintFields(known, at),
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
      `the run wrote nothing to its log for ${quietMin}m (the idle ceiling is ${ceilingMin}m), so this worker stopped it` +
        (signalled ? "" : " — it had no process of ours left to signal")
    ),
    ...resetHintFields(known, at),
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
function settleNativeOutcome(home, record, patch, { now = () => new Date().toISOString(), maxAttempts = NATIVE_CONTRACT_ATTEMPTS, lock = withRecordLock } = {}) {
  if (!record || !record.run_id || !patch) return record;
  const file = runPaths(home, record.run_id).record;
  try {
    const held = lock(file, () => {
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
      return putRecord(file, carryGateFields(file, merged), { now });
    });
    return held.ok ? held.value : record;
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
// All whole-record writers share the settlement lock, including the read and merge.
function settleContractOutcome(home, record, patch, { lock = withRecordLock } = {}) {
  if (!record || !record.run_id || !patch) return record;
  const file = runPaths(home, record.run_id).record;
  try {
    const held = lock(file, () => {
      const onDisk = readJson(file);
      if (!onDisk || !onDisk.contract_pending) return onDisk || record;
      return putRecord(file, carryGateFields(file, { ...onDisk, ...patch, contract_pending: false }));
    });
    return held.ok ? held.value : record;
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
function stampRun(home, runId, patch, { lock = withRecordLock, expectedRev = null } = {}) {
  if (!runId || !patch) return null;
  const file = runPaths(home, runId).record;
  try {
    const held = lock(file, () => {
      const onDisk = readJson(file);
      if (!onDisk) return null;
      if (!revMatches(onDisk, expectedRev)) return { ...onDisk, stale: true };
      return putRecord(file, carryGateFields(file, { ...onDisk, ...patch }));
    });
    return held.ok ? held.value : null;
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

// Active dispatched runs for same-machine guards and queue annotation. Confirm
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
    // A legacy native-background record (the retired `claude --bg` launch)
    // has no supervisor to probe; it stays in flight only inside the same
    // horizon `spor runs` and the preflight guard believe it for.
    if (r.launch_mode === "native-background") {
      if (nativeRecordBelieved(r)) out.push(summarizeRun(r));
      continue;
    }
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
// The locked form of "carry the gate fields, then write the whole record" —
// what BOTH in-process whole-record writers (updateRun, the supervisor's
// `update`) go through. `carryGateFields` alone re-reads the disk copy, but
// its read and the rename after it were not atomic against stampGateState's
// locked compare-and-swap: a settle could land BETWEEN the two, and the
// writer then renamed its stale carry over the settled verdict, the
// attestation id, and every other evidence stamp — erasing them after the
// settler's own read-back had verified them (cross-model review, blocking
// finding 4). Under the same lock the carry reads what the settle wrote and
// the settle waits for the carry, so neither renames over the other.
//
// NEVER unlocked (cross-model review, blocking finding 3): a write that could
// not take the lock does not happen — it throws, and the caller's own
// fail-soft handling decides what a lost journal write means for it — because
// an unlocked carry is exactly the rename-over-the-settle this lock exists to
// prevent. The lock's bounded wait outlasts the stale window (withRecordLock),
// so a settler that died holding it costs a wait, not a write.
function writeRecordCarryingGate(file, next, { lock = withRecordLock } = {}) {
  const held = lock(file, () => putRecord(file, carryGateFields(file, next)));
  if (!held.ok) throw new Error(`run record ${path.basename(file)} not written: ${held.reason}`);
  return held.value;
}

function carryGateFields(file, next) {
  try {
    const onDisk = readJson(file);
    if (!onDisk) return next;
    const gate = {};
    // The `impl_` namespace rides here for exactly the same reason the `gate_`
    // one does (task-spor-factory-candidate-record): the implementation stage
    // stamps its state and its pinned candidate OUT OF BAND from the worker
    // process, after the record has gone terminal, and neither in-process
    // writer owns those keys. Without this a supervisor landing its verified
    // outcome a beat later would silently erase the candidate — the one record
    // of which tree the pipeline is judging.
    // Read through `isImplField`, not the bare prefix: the stage also carries
    // fields §6.5 spells WITHOUT it (`publish_pending`), and a guard that knew
    // only the prefix erased the record of why a candidate is unpublished the
    // first time a supervisor landed its outcome after the pin stamped one.
    for (const [k, v] of Object.entries(onDisk)) {
      if (k.startsWith("gate_") || candidateKernel.isImplField(k) || isCompletionField(k)) gate[k] = v;
    }
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
    writeRecordCarryingGate(handle.paths.record, handle.record);
  } catch {
    /* an unwritable journal must not fail the launch */
  }
  return handle.record;
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
// class and reason. Each launch mode is reconciled against the evidence its
// own adapter declares, and only that:
//
// - `supervised-jsonl` keeps a supervisor process of ours, so liveness is that
//   process (`activeDiscovery: run-records`), identity-checked by its recorded
//   start-time ticks.
// - `native-background` is the RETIRED `claude --bg` launch
//   (task-spor-deprecate-native-bg-dispatch): no new record is ever written in
//   this mode, and a legacy one is judged from the record alone — believed
//   inside `NATIVE_RETIRE_MS` of its launch, closed `vanished`/`native-
//   retired` past it (`retireNativeRun`). No harness listing and no transcript
//   is read. A legacy record a pre-retirement reconcile left owing the
//   terminal-state contract (`contract_pending`) has that debt retired too:
//   the contract's report text came from the transcript, which is no longer
//   read, so its provisional unenforced reading stands and its lease lapses at
//   its own TTL (dec-cc-task-claim-lease).
//
// A record in neither mode is passed through untouched: guessing at liveness
// with the wrong evidence is what left supervised runs non-terminal forever
// (issue-spor-dispatch-supervised-runs-never-reconciled).
function reconcileRuns(home, { now = () => new Date().toISOString(), graceMs = 60000, staleMs = 86400000, readTicks = processStartTicks, nativeHorizonMs = NATIVE_RETIRE_MS } = {}) {
  const records = readRunRecords(home);
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
    } else if (record.launch_mode === "native-background") {
      if (record.contract_pending && TERMINAL_STATES.has(record.state)) {
        // Settled with NO new verdict: the provisional reading already on the
        // record (a DECLINE read as a decline included) is the one that stands.
        out.push(settleNativeOutcome(home, record, { contract_retired: true }, { now, maxAttempts: 1 }) || record);
        continue;
      }
      patch = retireNativeRun(record, { now, horizonMs: nativeHorizonMs });
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
    if (!patch.terminal_state) {
      patch = {
        ...patch,
        ...terminal.unenforcedOutcome(
          patch.state,
          record.launch_mode === "native-background"
            ? "this native-background run predates that launch mode's retirement and nothing about how it ended is read any more, so the outcome is unknown, not verified against the graph"
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
// between writing its process outcome and running the contract. `retireNativeRun`/
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
function mergeTerminalOutcome(recordFile, patch, { lock = withRecordLock } = {}) {
  try {
    const step = () => {
      const record = readJson(recordFile);
      if (!record || record.terminal_state) return record;
      return putRecord(recordFile, { ...record, ...patch });
    };
    const held = lock(recordFile, step);
    return held.ok ? held.value : null; // a write that could not take the lock did not happen (never an unlocked fallback)
  } catch {
    return null;
  }
}

// Stamp the GATE pipeline's FINAL state onto a run record (task-spor-work-
// gate-pipeline): `gate_state` (passed | failed | blocked | parked |
// superseded | scoped | mismatch), plus who settled it and when. This is the
// run record's half of the gate verdict — the final outcome. A pipeline that
// is RUNNING is a held lease in the pipeline lease log and a journal in
// flight, one that YIELDED is a parked journal with its lease released
// (stage-projection.js; task-spor-delete-loop-resume-machinery-after-
// workflow-stages) — neither is a record stamp any more, and a worker that
// dies mid-pipeline leaves nothing here: the next gate-armed worker reads the
// journals and the lease (work-loop.js openPipelines) to know the claim is
// still un-judged.
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
//      workers can, in a narrow window, both adopt one open pipeline (the
//      lease claim under the record lock closes that for every claimant that
//      reaches it; the residual is the read-read race before either claims),
//      and without this the loser's later `passed` would overwrite the
//      winner's `failed` — a refusal silently laundered into an approval, the
//      one direction this feature must never fail in. Only a `--regate`'s own
//      reopen (claimPipeline, which clears the verdict under a new lease)
//      reopens a settled record.
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
// `force` is the ONE way past the settled-verdict guard below, and only
// `spor work --regate` uses it: a person re-judging a refused run after fixing
// what refused it. Every other writer — the loop, a resumed pipeline, a
// duplicate adopter — still cannot launder a settled verdict.
//
// `allowSettledPatch` is a NARROWER second door (task-spor-gate-escalation-
// bounded-auto-retry): it lets a patch through on a settled record only when
// the patch does not touch `gate_state` at all. The bounded escalation-retry
// writer needs exactly this — updating `gate_escalated_to`/`gate_demoted`/
// `gate_escalation_failed`/the retry bookkeeping on a run that settled
// `failed` or `blocked` LONG ago, without reopening (or being able to reopen)
// the verdict those fields sit beside. `force` still wins if both are passed.
//
// `own` is the narrower door the SETTLER itself uses for the evidence fields
// it stamps AFTER its verdict (the attestation id, a proposal's refreshed
// body): the patch lands only if the record's `gate_at` still equals the
// stamp the caller wrote when it settled — i.e. the settled verdict on the
// file is this caller's own. A duplicate pipeline that lost the settle race
// (its settle stamp yielded to another writer's) therefore cannot overwrite
// the winner's evidence with fields describing a different head or verdict
// (cross-model review, blocking finding 1); it gets the record back
// unchanged, and can tell by comparing.
// --- the record lock: settlement is a compare-and-swap, not a read-modify-
// rename. Two pipelines for ONE run (a duplicate adopter and the original, or
// two resumers of one orphan) each do "read the record, check it is not yet
// settled, rename my copy over it". Without mutual exclusion both reads see
// `running`, both pass the guard, both rename — and both return their OWN
// in-memory copy, so both believe they own the settled verdict and both go on
// to publish evidence (an attestation, a PR body) for it (cross-model review,
// blocking finding 2). The lock serializes the read-check-write per record
// file, and the stamp returns what is ON DISK after its write, never the
// in-memory merge — so a caller's "did my stamp land" is a disk fact.
//
// `<record>.lock` opened O_EXCL; zero-dep and portable (the `wx` flag is
// atomic on every filesystem Node runs on, including Windows). The bounded
// wait OUTLASTS the stale window: an ordinary record lock is released
// by its holder, or broken as a corpse once it is older than
// RECORD_LOCK_STALE_MS (a stamp is a few milliseconds, so a lock that old is
// a dead writer's) — so no caller needs an unlocked fallback, and none has one
// (cross-model review, blocking finding 3). A lock that still cannot be taken
// is a write that DID NOT LAND (`ok: false`): the resume scan re-offers the
// run; nothing is ever double-owned.
//
// Breaking a corpse is OWNERSHIP-SAFE. The naive `unlink` of a lock that
// looked stale a moment ago races: two waiters both see the corpse, the first
// unlinks it and takes a fresh lock, the second unlinks THAT (live) lock, and
// a third takes it — two holders. Here a breaker never unlinks the lock path.
// It RENAMES the corpse to a name only it knows (rename is atomic and exactly
// one breaker's succeeds; the rest see ENOENT and go round again), then judges
// the file it actually took: still stale — it is deleted and the breaker goes
// on to acquire; fresh — the breaker took a LIVE holder's lock in the window
// between its stat and its rename, and puts it back where the holder can
// release it (a hard link, which never replaces a lock somebody has taken in
// the meantime). That rename leaves the lock PATH empty for a moment, and an
// acquirer's O_EXCL open would succeed in it — a second holder beside the
// live one whose lock is off to the side, and the hand-back link fails with
// nowhere to put it (cross-model review, blocking finding 3). So the break
// runs under a BREAKER LOCK (`<lock>.break`, O_EXCL, one breaker at a time)
// that the breaker holds from before its stat until the moved lock is back
// at its path (or deleted as a corpse), and every acquirer checks for that
// breaker lock AFTER its own open succeeds: found, it does not hold — it
// releases what it just took (checked, its own token only) and goes round
// again — so a lock opened in the break window is never held, the link is
// retried until the path is free again, and no two critical sections
// overlap. Breaker locks are never removed by an observer based on age:
// checking age then unlinking a pathname can remove a live successor. A
// crashed breaker therefore causes bounded contention until the operator
// stops all writers and removes the abandoned breaker. This intentionally
// trades automatic recovery of that rare crash for exclusive ownership. Release is checked, never blind: the
// holder wrote a random token into its lock and unlinks the lock path only
// while that token is still what the path holds — a lock re-taken under the
// same name by someone else is theirs to release. All three halves are
// exercised in test/gate-pipeline.test.js.
const RECORD_LOCK_STALE_MS = 30000;
const RECORD_LOCK_WAIT_MS = 10;
const RECORD_LOCK_ATTEMPTS = Math.ceil((RECORD_LOCK_STALE_MS + 5000) / RECORD_LOCK_WAIT_MS);
// How long a breaker retries putting a live lock back while an acquirer that
// opened in the break window backs off — a few waits, never unbounded.
const RECORD_LOCK_HANDBACK_ATTEMPTS = 200;
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin: a few ms, only if Atomics is unavailable */ }
  }
}
function recordLockPath(file) {
  return `${file}.lock`;
}
function breakerLockPath(lock) {
  return `${lock}.break`;
}
function lockToken() {
  return `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
}
function readLockToken(lock) {
  try {
    return fs.readFileSync(lock, "utf8").split("\n")[0];
  } catch {
    return null;
  }
}
function fileAge(file, now) {
  try {
    return now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
// Take the breaker lock: null when another breaker holds it (a live one, or
// a dead one still inside the stale window — the caller waits either way), a
// release function otherwise. An abandoned breaker is recovered explicitly
// with all writers stopped, never by an observer using a stale pathname.
function takeBreakerLock(lock, { staleMs, now }) {
  const breaker = breakerLockPath(lock);
  const token = lockToken();
  let fd = null;
  try {
    fd = fs.openSync(breaker, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // No pathname-based stale deletion: an observed corpse may already
      // have been replaced by a live successor. Fail closed; explicit recovery
      // removes an abandoned breaker only after all record writers stop.
    }
    return null;
  }
  try { fs.writeSync(fd, `${token}\n`); } catch { /* an unwritten token only makes the release conservative */ }
  try { fs.closeSync(fd); } catch { /* already closed */ }
  return () => {
    if (readLockToken(breaker) === token) {
      try { fs.unlinkSync(breaker); } catch { /* already gone */ }
    }
  };
}
// Break a lock that looked stale: returns true when a corpse was removed (the
// caller may go on to acquire), false when there was nothing to break, another
// breaker holds the breaker lock, or what was taken turned out to be live and
// was handed back.
function breakStaleLock(lock, { staleMs, now, waitMs = RECORD_LOCK_WAIT_MS }) {
  const release = takeBreakerLock(lock, { staleMs, now });
  if (!release) return false;
  try {
    // Judge under the breaker lock first: a holder that changed since the
    // caller's stat is left alone without ever moving its lock.
    const seen = fileAge(lock, now);
    if (seen == null || seen <= staleMs) return false;
    const taken = `${lock}.stale-${lockToken().replace(/:/g, "-")}`;
    try {
      fs.renameSync(lock, taken);
    } catch {
      return false; // the holder released between the stat and the rename — retry the acquire
    }
    const age = fileAge(taken, now);
    if (age == null) return false;
    if (age > staleMs) {
      try { fs.unlinkSync(taken); } catch { /* already gone */ }
      return true;
    }
    // Live: put it back for its holder. `link` never replaces — an acquirer
    // that opened in the window sees the breaker lock and backs off, so the
    // path frees again and the link lands on a retry.
    for (let i = 0; i < RECORD_LOCK_HANDBACK_ATTEMPTS; i += 1) {
      try {
        fs.linkSync(taken, lock);
        break;
      } catch (e) {
        if (!e || e.code !== "EEXIST") break; // the moved lock is gone, or the fs cannot link — nothing more to restore
        sleepSync(waitMs);
      }
    }
    try { fs.unlinkSync(taken); } catch { /* best-effort */ }
    return false;
  } finally {
    release();
  }
}
function withRecordLock(file, fn, { attempts = RECORD_LOCK_ATTEMPTS, waitMs = RECORD_LOCK_WAIT_MS, staleMs = RECORD_LOCK_STALE_MS, now = Date.now } = {}) {
  const lock = recordLockPath(file);
  const breaker = breakerLockPath(lock);
  const token = lockToken();
  for (let i = 0; i < attempts; i += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if (!e || e.code !== "EEXIST") return { ok: false, reason: (e && e.code) || "lock open failed" };
      const age = fileAge(lock, now);
      if (age == null) continue; // the holder released between our open and stat — retry at once
      if (age > staleMs) {
        if (breakStaleLock(lock, { staleMs, now, waitMs })) continue;
      }
      sleepSync(waitMs);
      continue;
    }
    try { fs.writeSync(fd, `${token}\n`); } catch { /* an unwritten token only makes the release conservative */ }
    try { fs.closeSync(fd); } catch { /* already closed */ }
    // Opened while a breaker is mid-break: the path was empty only because a
    // lock was moved aside for judgement. This is not a hold — release ours
    // (checked) and go round again once the breaker is done.
    const breakerAge = fileAge(breaker, now);
    if (breakerAge != null) {
      if (readLockToken(lock) === token) {
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
      }
      // A stale breaker cannot safely be removed by pathname after a stat.
      // Leave it in place and report bounded contention instead.
      sleepSync(waitMs);
      continue;
    }
    try {
      return { ok: true, value: fn() };
    } finally {
      // Checked release: only the lock carrying OUR token is ours to remove.
      if (readLockToken(lock) === token) {
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
      }
    }
  }
  return { ok: false, reason: "record lock contended" };
}

// A settler's ownership token. `own` names the pipeline's lease token (the
// journaled claim in `pipeline.jsonl`, stage-projection.js pipelineLease —
// task-spor-delete-loop-resume-machinery-after-workflow-stages) when the run
// has one; for a record settled before the lease log existed, its
// `gate_settle_id` (the nonce the settle stamped) or, older still, its
// `gate_at`. The lease is the fence: a re-gate's new claim replaces the token,
// and every evidence stamp made under the old one is refused from then on.
function ownsRecord(record, own, lease = null) {
  if (own == null) return false;
  if (lease && lease.token != null) return lease.token === own;
  if (record.gate_settle_id != null) return record.gate_settle_id === own;
  return record.gate_at === own;
}

// Has anyone EVER claimed this run's pipeline? The ONE predicate every
// no-owner gate stamp is decided by (stampLoopVerdict, stampPipelineLaunch,
// appendGateProgress's unowned arm — task-spor-extract-shared-unowned-lease-check):
// a lease in the log (UNREADABLE_LEASE included, so an unreadable log counts as
// claimed), or — for a record claimed before the lease log existed — its
// settle nonce `gate_settle_id` or, older still, its `gate_at`. An unowned
// writer may write only where this is false.
function everClaimed(record, lease) {
  return lease != null || record.gate_settle_id != null || record.gate_at != null;
}

// Why `own` does NOT own this run's pipeline right now, or null when it does
// (issue-spor-pipeline-completion-writers-unfenced). The ONE ownership reading
// every pipeline durable writer goes through: the completion stamps and the
// impl stamps under the record lock (their `own` option), and
// assertPipelineOwner for the writes the record lock cannot cover (graph
// facts, escalations, the completion write's graph CAS, a land). A non-null
// token owns exactly what ownsRecord says the settle door would accept; a
// null token is an owner-less driver and may write only where nobody has ever
// claimed (everClaimed); an unreadable lease log owns nobody.
function pipelineOwnerRefusal(home, record, own) {
  let lease = null;
  try {
    lease = projectionModule().pipelineLease(home, record);
  } catch (e) {
    return `the pipeline lease log is unreadable (${(e && e.message) || e})`;
  }
  if (own == null) return everClaimed(record, lease) ? "the pipeline is claimed and this writer holds no lease token" : null;
  if (ownsRecord(record, own, lease)) return null;
  return `the pipeline lease is now held by ${lease && lease.worker ? `worker ${lease.worker}` : "another driver"}`;
}

class PipelineOwnerLost extends Error {
  constructor(runId, why) {
    super(`this driver no longer owns the gate pipeline of run ${String(runId).slice(0, 8)}: ${why} — nothing is written`);
    this.name = "PipelineOwnerLost";
    this.code = "PIPELINE_OWNER_LOST";
  }
}

function isPipelineOwnerLost(e) {
  return !!e && (e instanceof PipelineOwnerLost || e.code === "PIPELINE_OWNER_LOST");
}

// THROW unless `token` still owns run `runId`'s pipeline. The guard a
// pipeline durable writer runs immediately before a write the record lock
// does not cover — so a driver displaced by a takeover (its lease expired
// while a pass stalled, another worker claimed it) files no fact, no
// escalation and no completion over the new holder's live attempt. A run with
// no readable record has no holder to protect (the claim passed over it too),
// so it passes, as stampPipelineLaunch does — but only an ABSENT record: one
// that exists and cannot be read owns nobody, like an unreadable lease log.
// The residual is the
// check-then-write window of a graph write, bounded by the lease: a holder is
// displaced only once its lease lapsed (or its worker went away), so a live
// driver that is renewing is never refused mid-write.
function assertPipelineOwner(home, runId, token) {
  if (!runId) return true;
  let file;
  try {
    file = runPaths(home, runId).record;
  } catch {
    return true; // no run to name a record by
  }
  if (!fs.existsSync(file)) return true;
  const record = readJson(file);
  if (!record) throw new PipelineOwnerLost(runId, "the run record exists but could not be read");
  const why = pipelineOwnerRefusal(home, record, token);
  if (why) throw new PipelineOwnerLost(runId, why);
  return true;
}

// The pipeline lease log, read lazily (the projection module requires this
// one for paths and reads).
function projectionModule() {
  return require("./stage-projection.js");
}

// OWN a run's gate pipeline BEFORE running it (cross-model review, blocking
// finding 2; the journaled form of what `claimGateRecord` used to stamp onto
// the record as `gate_state: running`). The settle stamp is a compare-and-swap,
// but a pipeline mutates the graph — facts, an escalation, a demotion — on its
// way to it, so two pipelines for one run (a duplicate adopter, a resumed
// pipeline beside a live one) could both run and the loser leave graph state
// the winner's verdict contradicts. So the ownership nonce is minted HERE,
// under the record lock, and appended as a `claim` to the run's pipeline lease
// log: a record already settled, or whose lease is HELD by another worker
// (unexpired, unreleased, and that worker live on this box — `ownerLive`),
// refuses the claim and the caller runs nothing. A dead, released or expired
// lease is taken over (that is what orphan resumption is). The settle then goes
// through the `own` door with this token, so it lands only while the lease
// still carries it. The record is written only for a REOPEN that opens a new
// attempt (its settled verdict and nonce cleared); the claim itself stamps
// nothing on it, and the attempt's IDENTITY is the claim line's own `attempt`
// (stage-projection.js pipelineAttempt — the record's `gate_regate_count` is
// read only for a run that was never claimed, and never written again).
// `reopen` ({settleId, regateCount, state}) is `spor work --regate`'s
// compare-and-swap: the claim lands only on the pipeline exactly as the caller
// read it (`settleId` is the CURRENT token — the lease's, else the record's
// `gate_settle_id`; `regateCount` the attempt as pipelineAttempt read it), and
// opens a NEW attempt (that attempt + 1). With
// `resume: true` it instead continues the CURRENT, unsettled attempt — the
// door back into a re-gate that was interrupted — so the attempt count stays
// put and evidence that attempt still owes is its own to replay.
// `owesEvidence` is a FUNCTION of the fresh record, or nothing: a boolean is
// ignored (the callee reads the projection), so no caller can skip the
// owed-evidence refusal by passing `false`.
// Returns {ok, token, refused, record, lease}: `refused` is the human reason
// when the pipeline belongs to someone else; `ok:false` with `refused:null`
// means there is no record to own (the caller proceeds unowned, as before).
function claimPipeline(home, runId, { workerId = null, factory = null, ownerLive = () => false, now = () => new Date().toISOString(), nowMs = Date.now, ttlMs = null, lock = withRecordLock, reopen = null, owesEvidence = null } = {}) {
  const projection = projectionModule();
  const executionStore = require("./execution-store.js");
  const token = crypto.randomBytes(12).toString("hex");
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : projection.PIPELINE_LEASE_TTL_MS;
  if (!runId) return { ok: false, token, refused: null, record: null, lease: null, reason: "no run id" };
  let file = null;
  try {
    file = runPaths(home, runId).record;
  } catch (e) {
    return { ok: false, token, refused: null, record: null, lease: null, reason: (e && e.message) || String(e) };
  }
  if (!fs.existsSync(file)) return { ok: false, token, refused: null, record: null, lease: null, reason: "no run record" };
  const held = lock(file, () => {
    const record = readJson(file);
    if (!record) return { ok: false, refused: null, record: null, lease: null, reason: "unreadable record" };
    let lease;
    try {
      lease = projection.pipelineLease(home, record);
    } catch (e) {
      return { ok: false, refused: `the pipeline lease log is unreadable (${(e && e.message) || e})`, record, lease: null };
    }
    const current = lease ? lease.token : record.gate_settle_id != null ? record.gate_settle_id : null;
    // The attempt's identity lives on the LEASE (the last claim's `attempt`),
    // falling back to a pre-lease record's `gate_regate_count`
    // (stage-projection.js pipelineAttempt).
    const count = projection.pipelineAttempt(record, lease);
    const settled = !!(record.gate_state && gatesKernel.SETTLED_GATE_STATES.has(record.gate_state));
    // A RESUME (`reopen.resume`) continues the attempt that owes the evidence
    // rather than opening a new one over it; a NEW attempt over owed evidence
    // is refused while the attempt is unsettled (finish it by resuming), and
    // re-attached when it is settled (task-spor-gate-regate-obligation-
    // semantics: the next attempt's first progress write lifts every owed row
    // into `carried`).
    const owed = typeof owesEvidence === "function" ? !!owesEvidence(record) : projection.owesEvidence(home, record);
    if (reopen && !reopen.resume && !settled && owed) return { ok: false, refused: "flake occurrence publication is still owed for the prior judgement; resume its original attempt and graph before re-gating", record, lease };
    if (reopen && record.gate_attestation_pending) return { ok: false, refused: "attestation publication is still owed for the prior judgement; replay its evidence through the original graph before re-gating", record, lease };
    if (reopen && ((reopen.settleId || null) !== current || count !== reopen.regateCount || (record.gate_state || null) !== (reopen.state || null))) return { ok: false, refused: "the prior judgement changed before re-gate could claim it", record, lease };
    if (settled && !(reopen && ["failed", "blocked", "mismatch"].includes(record.gate_state))) {
      return { ok: false, refused: `already settled as '${record.gate_state}'${record.gate_worker ? ` by ${record.gate_worker}` : ""}`, record, lease };
    }
    // A lease is "mine" only under a NAMED worker id: a caller with none is a
    // stranger to every lease, so a live one is refused rather than taken.
    if (lease && (workerId == null || lease.worker !== workerId) && projection.leaseHeld(lease, { now: nowMs, ownerLive })) {
      return { ok: false, refused: `being gated right now by worker ${lease.worker}`, record, lease };
    }
    if (reopen && reopen.resume && settled) return { ok: false, refused: `already settled as '${record.gate_state}' — there is no unsettled attempt to resume`, record, lease };
    const at = now();
    const attempt = count + (reopen && !reopen.resume ? 1 : 0);
    const entry = { kind: "claim", at, token, worker: workerId, factory: factory || null, attempt, expires_at: new Date(nowMs() + ttl).toISOString(), reopen: !!reopen, resume: !!(reopen && reopen.resume) };
    // The claim line FIRST, then the record: a claim that could not be written
    // leaves the record exactly as it was (its settled verdict included), so
    // a failed append never reads as a reopened, unowned attempt.
    try {
      executionStore.appendJsonlLine(projection.pipelineLogPath(home, record), entry);
    } catch (e) {
      return { ok: false, refused: `the pipeline lease could not be written (${(e && e.message) || e})`, record, lease };
    }
    let after = record;
    // A NEW attempt reopens the record: the prior attempt's SETTLED verdict and
    // settle nonce are cleared — the record carries the final outcome of the
    // attempt in flight, which has none yet (and the ledger writer, the resume
    // scan and the settle all read "settled" as "nothing left to judge"; a
    // stale nonce must not stand in for the lease while the log is unreadable).
    // The attempt's IDENTITY — what `gate_regate_count`/`gate_regated_at` used
    // to carry — is the claim line's own `attempt` and `at` (task-spor-fold-
    // gate-and-integration-into-one-workflow): the lease is the attempt, so it
    // is never written onto the record again; a record carrying the legacy
    // count is read through pipelineAttempt's fallback only while it has no
    // lease. The reason and the evidence fields of the superseded attempt
    // stay until this attempt settles over them.
    if (reopen && !reopen.resume) after = putRecord(file, { ...record, gate_state: null, gate_settle_id: null }, { now });
    const taken = projection.pipelineLease(home, after);
    if (!taken || taken.token !== token) return { ok: false, refused: "the ownership claim could not be verified on disk", record: after, lease: taken };
    return { ok: true, refused: null, record: after, lease: taken };
  });
  if (!held.ok) return { ok: false, token, refused: `the run record is locked (${held.reason})`, record: null, lease: null, reason: held.reason };
  return { ...held.value, token };
}

// RENEW the lease a worker holds on a run's pipeline — per pass, while the
// pipeline is in flight in this process — so a live driver never reads as an
// orphan to another worker. Keyed by WORKER (the loop knows which worker it
// is, not each pipeline's token). A lease this worker does not hold, or one
// already released, renews nothing. Returns {ok, lease}.
// `token` (optional) renews only the lease carrying that token — the
// pipeline's own handle, used from inside its long waits (bin/spor.js
// runGateAndIntegration) where the worker id alone would also renew a lease
// a later claim by the same worker took over.
function renewPipeline(home, runId, { workerId = null, token = null, ttlMs = null, now = () => new Date().toISOString(), nowMs = Date.now, lock = withRecordLock } = {}) {
  const projection = projectionModule();
  const executionStore = require("./execution-store.js");
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : projection.PIPELINE_LEASE_TTL_MS;
  let file;
  try {
    file = runPaths(home, String(runId)).record;
  } catch {
    return { ok: false, lease: null };
  }
  if (!fs.existsSync(file)) return { ok: false, lease: null };
  const held = lock(file, () => {
    const record = readJson(file) || { run_id: runId };
    const lease = projection.pipelineLease(home, record);
    if (!lease || lease.released_at || (workerId != null && lease.worker !== workerId) || (token != null && lease.token !== token)) return { ok: false, lease };
    executionStore.appendJsonlLine(projection.pipelineLogPath(home, record), { kind: "renew", at: now(), token: lease.token, expires_at: new Date(nowMs() + ttl).toISOString() });
    return { ok: true, lease: projection.pipelineLease(home, record) };
  });
  return held.ok ? held.value : { ok: false, lease: null };
}

// RELEASE a lease when its pipeline YIELDS (reports `interrupted`): the
// journal is parked on its own durable timer, and the next worker — this one
// or another — adopts it from the resume scan when the timer is due, rather
// than waiting out a TTL on a lease nobody is driving. Only the holder's own
// token releases; a settled pipeline needs no release (its lease is history
// once the record carries the verdict).
function releasePipeline(home, runId, token, { now = () => new Date().toISOString(), lock = withRecordLock } = {}) {
  const projection = projectionModule();
  const executionStore = require("./execution-store.js");
  if (!token) return { ok: false };
  let file;
  try {
    file = runPaths(home, String(runId)).record;
  } catch {
    return { ok: false };
  }
  if (!fs.existsSync(file)) return { ok: false };
  const held = lock(file, () => {
    const record = readJson(file) || { run_id: runId };
    const lease = projection.pipelineLease(home, record);
    if (!lease || lease.token !== token || lease.released_at) return { ok: false };
    executionStore.appendJsonlLine(projection.pipelineLogPath(home, record), { kind: "release", at: now(), token });
    return { ok: true };
  });
  return held.ok ? held.value : { ok: false };
}

// What a stampGateState builder is handed for a lease log that cannot be read:
// a lease with no token, so it owns nothing, but not null, so it is never
// mistaken for "no pipeline was ever claimed".
const UNREADABLE_LEASE = Object.freeze({ token: null, unreadable: true });

function stampGateState(home, runId, patch, { verifyAttempts = 3, readBack = readJson, force = false, allowSettledPatch = false, own, lock = withRecordLock, expectedRev = null } = {}) {
  if (!runId || !patch) return null;
  // An `own` key PRESENT with a null value is a caller that meant to stamp
  // owned and lost its token (`{ own: maybeToken }`), not an unowned writer:
  // refused outright rather than read as the unowned door (the runtime half
  // of test/record-write-lint R9, issue-spor-record-write-lint-r9-own-value-
  // validation). An absent key (undefined) is the unowned door.
  if (own === null) return null;
  if (own === undefined) own = null;
  const build = typeof patch === "function" ? patch : () => patch;
  try {
    const file = runPaths(home, runId).record;
    if (!fs.existsSync(file)) return null;
    const held = lock(file, () => {
      let last = null;
      for (let attempt = 0; ; attempt += 1) {
        const record = readJson(file);
        if (!record) return null;
        // The versioned door: a caller that decided its patch off a read hands
        // that read's `rev` back, and a record that moved since refuses it.
        if (!revMatches(record, expectedRev)) return { ...record, stale: true };
        // The pipeline's lease (the journaled ownership nonce), read under the
        // same lock: the `own` door compares against it, and a builder sees it
        // beside the record (so an unowned writer can tell a claimed pipeline
        // from an unclaimed one).
        let lease = null;
        if (own != null || typeof patch === "function") {
          try {
            lease = projectionModule().pipelineLease(home, record);
          } catch (e) {
            // A lease nobody can read owns nobody: the `own` door is refused
            // (a stale record nonce must not admit a prior attempt's holder),
            // and a builder is handed UNREADABLE_LEASE — non-null, so an
            // unowned guard that writes only where no lease exists
            // (`everClaimed(fresh, lease) ? null : …`) refuses rather than reading an
            // unreadable log as an unclaimed pipeline
            // (issue-spor-settle-run-record-no-token-path-unguarded).
            if (own != null) return record;
            lease = { ...UNREADABLE_LEASE, error: (e && e.message) || String(e) };
          }
        }
        // Builders see the fresh record while the SAME lock protects their
        // check, merge and write. They must be synchronous and side-effect free.
        const proposed = build(typeof patch === "function" ? structuredClone(record) : record, lease);
        if (!proposed || typeof proposed !== "object" || typeof proposed.then === "function") return null;
        const gateOnly = {};
        for (const [k, v] of Object.entries(proposed)) if (k.startsWith("gate_")) gateOnly[k] = v;
        if (!Object.keys(gateOnly).length) return null;
        if (own != null) {
          if (!ownsRecord(record, own, lease)) return record;
        } else if (!force && record.gate_state && gatesKernel.SETTLED_GATE_STATES.has(record.gate_state) && !(allowSettledPatch && gateOnly.gate_state === undefined)) return record;
        // Bounded: a write that could not be verified after `verifyAttempts`
        // reports the disk as last seen — an unverified claim is exactly what a
        // caller deciding "did my verdict land" must never be handed.
        if (attempt >= verifyAttempts) return last;
        const merged = putRecord(file, { ...record, ...gateOnly });
        // Only a `gate_state` write is worth verifying: it is the one field a
        // later reader treats as a verdict.
        if (!gateOnly.gate_state) return merged;
        const after = readBack(file);
        if (!after) return merged;
        if (after.gate_state === gateOnly.gate_state) return after;
        last = after;
      }
    });
    return held.ok ? held.value : null;
  } catch {
    return null;
  }
}

// The gate LEDGER (each attempt's finding ledger, rescue state and pools) is
// no longer a field of the run record: it is the append-only
// `gate-progress.jsonl` beside the run's stage journals
// (lib/shell/stage-projection.js, task-spor-run-surfaces-read-stage-journal).
// This is its ONE writer, kept here because it takes the RECORD lock (the
// lock is the runner's, test/record-write-lint R7) so a settle, an owner
// change or an attempt rollover between the caller's read and this append is
// seen and refused exactly as the record writer refused it — but it writes
// NO record: the refusals are read off the record, the stamp is appended to
// the log. `mutate` returns a partial progress patch, or null to refuse (a
// capacity reservation that finds the pool spent); it runs synchronously
// against the fresh ledger under the lock. A gate row is replaced as a unit;
// other rows and unknown top-level keys are retained. A stamp keyed to
// another attempt is that attempt's state and is replaced — except what it
// still OWES the graph, which rides into this attempt as `carried`
// (gatesKernel.carriedGateObligations). Returns {ok, progress, reason}; a
// refusal appends nothing. A record that still carries a `gate_progress`
// stamp predates the log: it is read as the prior (once), never rewritten.
function appendGateProgress(home, runId, mutate, { key, attempt = 1, own = null, now = () => new Date().toISOString(), lock = withRecordLock } = {}) {
  if (!runId || !key) return { ok: false, progress: null, reason: "no run id or attempt key" };
  // Lazy: the projection module requires this one for paths and reads.
  const projection = require("./stage-projection.js");
  const executionStore = require("./execution-store.js");
  let file;
  try {
    file = runPaths(home, String(runId)).record;
  } catch (e) {
    return { ok: false, progress: null, reason: (e && e.message) || String(e) };
  }
  if (!fs.existsSync(file)) return { ok: false, progress: null, reason: "no run record" };
  const held = lock(file, () => {
    const record = readJson(file);
    if (!record) return { ok: false, progress: null, reason: "the run record is unreadable" };
    if (gatesKernel.SETTLED_GATE_STATES.has(record.gate_state)) return { ok: false, progress: null, reason: "the gate pipeline is already settled" };
    // The lease is the owner (an unowned writer may write only a pipeline
    // nobody has ever claimed); an unreadable lease log refuses the write.
    let lease;
    try {
      lease = projection.pipelineLease(home, record);
    } catch (e) {
      return { ok: false, progress: null, reason: `the pipeline lease log is unreadable: ${(e && e.message) || e}` };
    }
    if (own == null ? everClaimed(record, lease) : !ownsRecord(record, own, lease)) return { ok: false, progress: null, reason: "the gate pipeline owner changed" };
    if (projection.pipelineAttempt(record, lease) + 1 !== Math.max(1, Number(attempt) || 1)) return { ok: false, progress: null, reason: "the gate pipeline attempt changed" };
    // The SAME resolution the loaders read with (log, legacy record, journals),
    // so the prior this save continues from is the stamp the pipeline saw.
    const current = projection.latestProgress(home, record).stamp;
    const carried = current && current.key !== key ? gatesKernel.carriedGateObligations(current) : null;
    const prior = current && current.key === key ? current : { gates: {}, ...(carried ? { carried } : {}) };
    let delta;
    try {
      delta = typeof mutate === "function" ? mutate(structuredClone(prior), structuredClone(record)) : mutate;
    } catch (e) {
      return { ok: false, progress: null, reason: `the progress update threw: ${(e && e.message) || e}` };
    }
    if (!delta || typeof delta !== "object" || Array.isArray(delta) || typeof delta.then === "function") return { ok: false, progress: null, reason: "the progress update was refused" };
    const at = now();
    const stamp = JSON.parse(JSON.stringify({ ...prior, ...delta, key, at, seq: (Number.isInteger(prior.seq) ? prior.seq : 0) + 1, gates: { ...(prior.gates || {}), ...(delta.gates || {}) } }));
    const logPath = projection.progressLogPath(home, record);
    try {
      executionStore.appendJsonlLine(logPath, { kind: "progress", at, run_id: String(runId), stamp });
    } catch (e) {
      return { ok: false, progress: null, reason: `the gate progress log could not be written: ${(e && e.message) || e}` };
    }
    return { ok: true, progress: stamp, reason: null };
  });
  if (!held.ok) return { ok: false, progress: null, reason: `the run record is locked (${held.reason})` };
  return held.value;
}

// Stamp the IMPLEMENTATION stage's state onto a run record
// (task-spor-factory-candidate-record, FACTORY-IMPLEMENTATION-STAGE.md §6.5).
// The `impl_` twin of stampGateState above, and deliberately the same shape:
//
//   1. the patch is restricted to the `impl_` namespace, so a caller slip can
//      never overwrite the process or outcome dimensions everything downstream
//      reads as ground truth;
//   2. a SETTLED `impl_state` is FINAL for this run — two workers can, in a
//      narrow window, both adopt one orphaned pipeline, and without this the
//      loser's later `candidate` would overwrite the winner's `exhausted`: a
//      refusal laundered into a submission, the one direction this must never
//      fail in.
//
// The narrowing is on `impl_state` ALONE, and it drops only that key rather
// than the whole patch — the gate twin's `allowSettledPatch` door, except it
// needs no flag here because a RE-PIN deliberately never touches `impl_state`
// (§3.3 — the stage settled at the first candidate; a moved HEAD is not a new
// verdict). So a pin that arrives at a record whose stage already settled still
// records WHICH TREE was pinned; refusing the whole patch would throw the
// candidate away to protect a verdict the candidate was never going to move.
//
// The verify-and-reapply pass is the gate twin's too, and for its reason: the
// `impl_` namespace is carried across an in-process whole-record write
// (carryGateFields), which closes the ordinary case, but neither writer holds a
// lock, so a supervisor that READ before this settle and RENAMED after it
// reverts the stamp. Reading back and rewriting closes that in practice,
// bounded because an unbounded retry against a genuinely contended file is a
// spin. The settled-`impl_state` narrowing above still runs on every attempt,
// so a retry yields to another worker that legitimately settled this stage
// first rather than fighting for the last word. `readBack` is injected so the
// reapply path is testable without a real race.
//
// The `force` door is the gate twin's, for the same caller — `spor work
// --regate` (bin/spor.js cmdWorkRegate) reopens a settled stage REFUSAL
// (`exhausted`/`escalated`/`unroutable`/`mismatch`) to `running` so the
// implementation stage runner re-judges the run under the new attempt key
// (task-spor-factory-implementation-stage-runner). It never reopens a settled
// `candidate` or `declined`: those are verdicts on what the run produced, not
// on whether the stage could finish. Nothing else passes it.
//
// Fail-soft, like every other write to this journal: a stamp that could not
// land leaves the pin unrecorded, and the tree is judged regardless.
function stampImplState(home, runId, patch, { verifyAttempts = 3, readBack = readJson, force = false, lock = withRecordLock, expectedRev = null, own } = {}) {
  if (!runId || !patch) return null;
  const implOnly = {};
  for (const [k, v] of Object.entries(patch)) if (candidateKernel.isImplField(k)) implOnly[k] = v;
  if (!Object.keys(implOnly).length) return null;
  try {
    const file = runPaths(home, runId).record;
    if (!fs.existsSync(file)) return null;
    const held = lock(file, () => {
    for (let attempt = 0; ; attempt += 1) {
      const record = readJson(file);
      if (!record) return null;
      if (!revMatches(record, expectedRev)) return { ...record, stale: true };
      // The pipeline's OWNED door (issue-spor-pipeline-completion-writers-
      // unfenced), decided under the same lock as the write: an `own` key
      // present names the driver, and a driver the lease no longer carries
      // writes nothing. An absent key is the unowned door, unchanged.
      if (own !== undefined) {
        const why = pipelineOwnerRefusal(home, record, own);
        if (why) return { ...record, owner_refused: why };
      }
      const write = { ...implOnly };
      if (write.impl_state !== undefined && candidateKernel.implSettled(record.impl_state) && !force) delete write.impl_state;
      if (!Object.keys(write).length) return record;
      const merged = putRecord(file, { ...record, ...write });
      // Only an `impl_state` write is worth verifying: it is the one field a
      // later reader treats as a verdict.
      if (!write.impl_state || attempt >= verifyAttempts) return merged;
      const after = readBack(file);
      if (!after || after.impl_state === write.impl_state) return merged;
    }
    });
    return held.ok ? held.value : null;
  } catch {
    return null;
  }
}

// The controller-completion namespace (kernel/completion.js): `completion_*`
// plus the two split verdict stamps `gates_state`/`integration_state`
// (FACTORY-IMPLEMENTATION-STAGE.md §6.5). Carried across the in-process
// whole-record writes exactly as `gate_`/`impl_` are, for the same reason —
// they are stamped out of band, after the record went terminal.
function isCompletionField(k) {
  return k.startsWith(completionKernel.COMPLETION_FIELD_PREFIX) || completionKernel.SPLIT_STATE_FIELDS.includes(k);
}

// Stamp the controller completion's state onto a run record
// (task-spor-factory-controller-completion-boundary) — the third twin of
// stampGateState/stampImplState, same shape: the patch is restricted to its
// namespace (isCompletionField), the write is verified and re-applied against
// a supervisor's concurrent rename (bounded), and it is fail-soft. Unlike its
// twins there is NO settled-guard: `completion_debt` is a debt that moves in
// one overwrite per transition (owe-first, §6.5 (b)), and the split states
// are stamped once by the one runner that produces them.
function stampCompletionState(home, runId, patch, { verifyAttempts = 3, readBack = readJson, lock = withRecordLock, expectedRev = null, own } = {}) {
  if (!runId || !patch) return null;
  const only = {};
  for (const [k, v] of Object.entries(patch)) if (isCompletionField(k)) only[k] = v;
  if (!Object.keys(only).length) return null;
  try {
    const file = runPaths(home, runId).record;
    if (!fs.existsSync(file)) return null;
    const held = lock(file, () => {
    for (let attempt = 0; ; attempt += 1) {
      const record = readJson(file);
      if (!record) return null;
      if (!revMatches(record, expectedRev)) return { ...record, stale: true };
      // The pipeline's OWNED door, as stampImplState's: decided under the lock.
      if (own !== undefined) {
        const why = pipelineOwnerRefusal(home, record, own);
        if (why) return { ...record, owner_refused: why };
      }
      const merged = putRecord(file, { ...record, ...only });
      if (only.completion_debt === undefined || attempt >= verifyAttempts) return merged;
      const after = readBack(file);
      // Compared by VALUE: `completion_debt` is an object, and an identity
      // compare against the copy read back off disk never matched, so every
      // debt write re-applied itself `verifyAttempts` more times (visible now
      // that each write bumps `rev`).
      if (!after || JSON.stringify(after.completion_debt) === JSON.stringify(only.completion_debt)) return merged;
    }
    });
    return held.ok ? held.value : null;
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
    if (record.gate_attestation_pending) continue; // publication debt outlives process retention
    const ended = Date.parse(record.finished_at || record.created_at || "") || 0;
    if (!ended || ended >= cutoff) continue;
    const p = runPaths(home, record.run_id);
    for (const f of [p.record, p.log, p.report, p.job, p.prompt, p.retryCount]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    try { fs.rmSync(p.scratch, { recursive: true, force: true }); } catch { /* already gone */ }
    try { fs.rmSync(p.workflows, { recursive: true, force: true }); } catch { /* already gone */ }
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
// Secrets that belong to the judge (the worker running the gate pipeline) and
// are stripped from every dispatched harness child, whatever the harness:
// see the launch below. `SPOR_TOKEN`/`SUBSTRATE_TOKEN` are not here — an
// agent-scoped child token replaces them, and a local-mode child has none.
// Every name is stripped under BOTH spellings: the config cascade dual-reads
// the legacy `SUBSTRATE_*` prefix for every user-facing var (`home.envDual`),
// so `SUBSTRATE_ATTESTATION_KEY` is the same signing key to the judge and
// would have reached the harness child through the legacy door (cross-model
// review, blocking finding 2).
const JUDGE_ONLY_ENV = Object.freeze(
  ["ATTESTATION_KEY", "ADMIN_TOKEN", "REFRESH_TOKEN"].flatMap((suffix) => [`SPOR_${suffix}`, `SUBSTRATE_${suffix}`])
);

function judgedChildEnv(env = process.env) {
  const child = { ...env };
  for (const name of JUDGE_ONLY_ENV) delete child[name];
  return child;
}

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
    // was in flight (carryGateFields) — under the record lock, so a settle
    // landing mid-write is never renamed over (writeRecordCarryingGate). A
    // write that could not take the lock did NOT happen (never unlocked): the
    // next update carries the same in-memory truth, and the supervisor keeps
    // supervising rather than dying on its own journal.
    try {
      writeRecordCarryingGate(job.record_path, record);
    } catch (e) {
      try { process.stderr.write(`spor dispatch supervisor: ${(e && e.message) || e}\n`); } catch { /* nowhere to say it */ }
    }
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
  const childEnv = judgedChildEnv(process.env);
  const childToken = process.env.SPOR_DISPATCH_CHILD_TOKEN || "";
  delete childEnv.SPOR_DISPATCH_CHILD_TOKEN;
  delete childEnv.SPOR_DISPATCH_BIND_TOKEN;
  delete childEnv.SPOR_DISPATCH_RENEW_TOKEN;
  // Supervisor-internal plumbing to the launcher, not for the harness child
  // (which never gets fd 3 passed through portableSpawn's own explicit stdio
  // array anyway) — stripped the same way the renew/bind tokens above are.
  delete childEnv.SPOR_DISPATCH_HANDSHAKE_FD;
  // The JUDGE's secrets never reach the harness child (cross-model review,
  // blocking finding 1): the attestation signing key would let the code
  // under judgement forge the HMAC anchor of its own attestation, and the
  // refresh/admin credentials are the person's, not the run's. The graph
  // bearer is handled below (an agent-scoped child token replaces it).
  for (const name of JUDGE_ONLY_ENV) delete childEnv[name];
  if (childToken) {
    // Never leave the broader person credential available under either the
    // canonical or legacy compatibility spelling in an agent-scoped run.
    delete childEnv.SPOR_TOKEN;
    delete childEnv.SUBSTRATE_TOKEN;
    childEnv.SPOR_TOKEN = childToken;
    childEnv.SUBSTRATE_TOKEN = childToken;
    // Mark the run as agent-scoped so the child's config cascade binds a
    // `spor --org X` to this token instead of resolving the person's stored
    // tenant for X (issue-spor-agent-org-flag-resolves-person-store-tenant).
    childEnv.SPOR_AGENT_RUN = "1"; // lib/config.js AGENT_RUN_ENV
    // Defense in depth for the same rule: an org selector inherited from the
    // launcher's shell would name the PERSON's tenant, which the child's
    // cascade now refuses under SPOR_AGENT_RUN — but a refusal is a dead run,
    // and the selector was never the agent's to begin with, so drop it here
    // too (task-spor-agent-run-guard-all-org-selectors). The marker above is
    // what holds for an agent-run process this runner did not launch.
    delete childEnv.SPOR_ORG;
    delete childEnv.SUBSTRATE_ORG;
    // The token is scoped to the server this run was dispatched on, so name
    // that server beside it: the config cascade only reads an env SPOR_TOKEN
    // on its flat SPOR_SERVER path, and a launcher that resolved its own tenant
    // from the credential store (a `spor auth login` box with no SPOR_SERVER in
    // its environment) would otherwise hand the child a HOME whose store
    // default — the PERSON's credential — wins tenant selection, sending the
    // person's token with the agent's sitting ignored in the env
    // (issue-spor-agent-token-scope-escalation-via-refresh-and-store-default).
    // `job.server` is the base the launcher dispatched against; a local-mode
    // run has none and no server is set.
    if (job.server) {
      childEnv.SPOR_SERVER = job.server;
      childEnv.SUBSTRATE_SERVER = job.server;
    }
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
        ...resetHintFields(known),
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

module.exports = { judgedChildEnv,
  dispatchRunDir, runPaths, atomicJson, readJson, activeRuns, summarizeRun, portableSpawn, runJob, runReportTexts,
  TERMINAL_STATES, classifyTerminalText, resetHintFields, tailFile, lastLines, lastActivityAt,
  NATIVE_RETIRE_MS, nativeRecordBelieved, retireNativeRun,
  settleNativeOutcome, NATIVE_CONTRACT_ATTEMPTS,
  finalizeSupervisedRun, observedActivityAt, stopRun, finalizeIdleRun, stopIdleRun, settleContractOutcome, stampRun,
  readRunRecords, updateRun, reconcileRuns,
  launchFailure, closeRun, listRuns, pruneRuns, pidAlive, processStartTicks,
  supervisorAliveProbe, isSameSupervisor, supervisorStillWatching, PIPE_DRAIN_GRACE_MS, pipeDrainGraceMs,
  terminalOutcomeBackfill, mergeTerminalOutcome, stampGateState, ownsRecord, everClaimed, appendGateProgress, stampImplState, stampCompletionState, isCompletionField, pipelineOwnerRefusal, assertPipelineOwner, isPipelineOwnerLost, PipelineOwnerLost,
  claimPipeline, renewPipeline, releasePipeline, withRecordLock, breakStaleLock, recordLockPath, breakerLockPath, RECORD_LOCK_STALE_MS, RECORD_LOCK_ATTEMPTS, RECORD_LOCK_WAIT_MS, writeRecordCarryingGate,
  createRecord, readRecord,
  TERMINAL_OUTCOMES: terminal.TERMINAL_OUTCOMES, derivedTerminalOutcome: terminal.derivedTerminalOutcome,
  unenforcedOutcome: terminal.unenforcedOutcome, applyTerminalContract: terminal.applyTerminalContract,
  buildReportArtifact: terminal.buildReportArtifact, reportArtifactId: terminal.reportArtifactId,
};
