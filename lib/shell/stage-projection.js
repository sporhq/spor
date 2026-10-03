// The READ MODEL over a gated run's stage journals
// (task-spor-run-surfaces-read-stage-journal, slice 4b of
// task-spor-delete-loop-resume-machinery-after-workflow-stages).
//
// Every gated run has a durable stage journal per stage and attempt
// (bin/spor.js stageWorkflowJournal: `implementation-a<n>`, `gates-a<n>`,
// `gates-regate-<head>-a<n>`, `integration-a<n>`), beside the execution
// record when the claim opened one, else beside the run record under
// `runPaths().workflows`. Those journals ARE the pipeline's story — the
// binding it opened under, every activity's result, the yields, the
// tombstone — so nothing a reader can derive from them is kept on the run
// record any more. The record keeps ONLY what is not derivable: identity, the
// ownership nonce (`gate_settle_id`, the settle's compare-and-swap), the
// timestamps, and the FINAL outcome (`gate_state` and the verdict fields the
// settle stamps). `spor runs`, `spor work --status`, `spor work --regate`
// and the flake-evidence debt read everything else through `projectRun`.
//
// The gate LEDGER — each gate's finding ledger, fix count, attempt history,
// the rescue state, the shared infrastructure pool, the carried flake
// obligations — used to be the `gate_progress` stamp on the run record,
// rewritten under the record lock after every step. It is now an
// APPEND-ONLY LOG beside the stage journals (`gate-progress.jsonl`): one
// fsynced line per save, the last line the current stamp, written by
// `writeGateProgress` under the same record lock and the same refusals
// (settled, owner changed, attempt changed) the record writer enforced, so a
// stale owner's save still lands nowhere. The gate workflow journals the same
// stamp as the save activity's RESULT, so a journal alone can answer the
// ledger question too (`latestProgress` reads the log, then the journals,
// then — read-only, for a record that predates both — the record's own
// `gate_progress`). Nothing here writes a record.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const dispatchRuns = require("./agent-dispatch-runner.js");
const executionStore = require("./execution-store.js");
const gatesKernel = require("../kernel/gates.js");

const PROGRESS_LOG = "gate-progress.jsonl";
// The pipeline LEASE log beside the stage journals (task-spor-delete-loop-
// resume-machinery-after-workflow-stages): one `claim` line per pipeline the
// box starts on a run (the ownership nonce `gate_settle_id` used to be minted
// onto the record as `gate_state: running`; it is now this journaled entry,
// and the settle's compare-and-swap reads it from here), `renew` lines while
// the owning worker is driving it, a `release` line when the pipeline yields.
// A lease that is released, expired, or whose worker is not live on this box
// is an OPEN pipeline any gate-armed worker may adopt (work-loop.js
// openPipelines); the record keeps only the FINAL outcome.
const PIPELINE_LOG = "pipeline.jsonl";
const PIPELINE_LEASE_TTL_MS = 30 * 60 * 1000;
const JOURNAL_SUFFIX = ".workflow.jsonl";
const STAGE_RE = /^(implementation|integration|gates)(?:-regate-([0-9a-f]+))?-a(\d+)$/;
// The order the stages run in, for the projection's listing.
const KIND_ORDER = { implementation: 0, gates: 1, "gates-regate": 2, integration: 3 };
const PROGRESS_SAVE_RE = /\/(saveGateProgress|saveCarriedProgress|saveRescueState|saveGatePools)#\d+$/;
const JUDGE_RE = /\/judge\/r(\d+)\/([^/]+)\/c(\d+)\/judge#\d+$/;
// A yield's journaled result: the gate list's `…/yield/yield#n`, the
// integration stage's `…/yield/<epoch>/parked`, the implementation stage's
// `…/yield/<n>` and `…/backoff-parked`.
const YIELD_RE = /\/yield(?:\/[^/]+)*(?:#\d+)?$|backoff-parked(?:#\d+)?$/;

function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// ---------------- the gate-progress log ----------------

// The execution a record's claim opened, when it is one the journals key on
// (bin/spor.js stageWorkflowJournal's rule), else null.
function claimedExecution(record) {
  const claim = record && typeof record === "object" ? record.impl_claim : null;
  if (!claim || !claim.store || !claim.tenant || !claim.execution_id) return null;
  if (!executionStore.validSegment(String(claim.tenant)) || !executionStore.validSegment(String(claim.execution_id))) return null;
  return { tenant: String(claim.tenant), id: String(claim.execution_id) };
}

// Where the log lives: BESIDE the run's stage journals, by the same rule —
// `<execution>.gate-progress.jsonl` next to the execution record when the
// claim opened one, else `gate-progress.jsonl` under `runPaths().workflows`.
// `recordOrRunId` is the run record (needed to see the claim) or a bare run
// id (run-keyed).
function progressLogPath(home, recordOrRunId) {
  const record = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId : null;
  const exec = claimedExecution(record);
  if (exec) return path.join(path.dirname(executionStore.workflowJournalPath(home, exec.tenant, exec.id)), `${exec.id}.${PROGRESS_LOG}`);
  const runId = record ? record.run_id : recordOrRunId;
  return path.join(dispatchRuns.runPaths(home, String(runId)).workflows, PROGRESS_LOG);
}

// The pipeline lease log lives beside the gate-progress log, by the same rule.
function pipelineLogPath(home, recordOrRunId) {
  const record = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId : null;
  const exec = claimedExecution(record);
  if (exec) return path.join(path.dirname(executionStore.workflowJournalPath(home, exec.tenant, exec.id)), `${exec.id}.${PIPELINE_LOG}`);
  const runId = record ? record.run_id : recordOrRunId;
  return path.join(dispatchRuns.runPaths(home, String(runId)).workflows, PIPELINE_LOG);
}

function readPipelineLog(home, recordOrRunId) {
  const runId = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId.run_id : recordOrRunId;
  if (!runId || !executionStore.validSegment(String(runId))) return [];
  return executionStore.readJsonl(pipelineLogPath(home, recordOrRunId), `pipeline lease log for run ${runId}`, { framed: true });
}

// The CURRENT lease on a run's pipeline, folded from the log: the last claim,
// with every later renewal and release of that token applied. Null when no
// pipeline was ever claimed (a record that predates the log, or one no worker
// started). An unreadable log THROWS — a lease a reader cannot judge must not
// read as "nobody holds it".
function pipelineLease(home, recordOrRunId) {
  let lease = null;
  for (const e of readPipelineLog(home, recordOrRunId)) {
    if (!e || typeof e !== "object") continue;
    if (e.kind === "claim" && e.token) {
      lease = { token: String(e.token), worker: e.worker || null, factory: e.factory || null, attempt: Number.isInteger(e.attempt) ? e.attempt : null, at: e.at || null, expires_at: e.expires_at || null, renewed_at: null, released_at: null, reopen: !!e.reopen, resume: !!e.resume };
      continue;
    }
    if (!lease || e.token !== lease.token) continue;
    if (e.kind === "renew") { lease.expires_at = e.expires_at || lease.expires_at; lease.renewed_at = e.at || null; }
    else if (e.kind === "release") lease.released_at = e.at || "released";
  }
  return lease;
}

// Is a lease HELD — by a worker still driving the pipeline? Released,
// expired, or held by a worker that is not live on this box (`ownerLive`,
// the worker status files) all read as open. `now` is epoch ms.
function leaseHeld(lease, { now = Date.now, ownerLive = null } = {}) {
  if (!lease || !lease.token) return false;
  if (lease.released_at) return false;
  const exp = Date.parse(lease.expires_at || "") || 0;
  if (exp && now() >= exp) return false;
  if (typeof ownerLive === "function" && !ownerLive(lease.worker)) return false;
  return true;
}

// The log's entries, oldest first. Framed: a torn final line is a crash
// mid-append and is dropped; a corrupt interior line THROWS — a ledger with a
// hole in it must not be read as a shorter one (a resumed pipeline would
// re-dispatch fix cycles it already spent).
function readProgressLog(home, recordOrRunId) {
  const runId = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId.run_id : recordOrRunId;
  if (!runId || !executionStore.validSegment(String(runId))) return [];
  return executionStore.readJsonl(progressLogPath(home, recordOrRunId), `gate progress log for run ${runId}`, { framed: true });
}

function lastLogStamp(home, recordOrRunId) {
  const entries = readProgressLog(home, recordOrRunId);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e && e.kind === "progress" && e.stamp && typeof e.stamp === "object") return e.stamp;
  }
  return null;
}

// The current ledger stamp for a run, and where it came from, in this order:
//   log     — the last line of `gate-progress.jsonl` (every save since 4b,
//             the saves made INSIDE another activity included — a flake
//             filing intent from `judge`, a fix's launch from `fix`)
//   journal — the last save activity's journaled RESULT in a gate journal:
//             for a post-log run whose log was lost. Only the saves the
//             workflow journals as their own step are here, so it can trail
//             the stamp that was live; it never outranks the log, and a
//             legacy record stamp that is strictly later outranks it.
//   record  — the run record's own `gate_progress` (a run that predates both),
//             READ-ONLY: nothing writes it back; it is the last resort unless
//             it is later than the journals' stamp.
//   null    — no ledger yet
// ONE resolution, shared by every reader and by the writer's prior
// (agent-dispatch-runner.js appendGateProgress), so the stamp a loader reads
// is the stamp the next save continues from. `recordOrRunId` is the run
// record (preferred — the execution-keyed journals and the legacy stamp need
// it) or a bare run id.
function latestProgress(home, recordOrRunId) {
  const record = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId : null;
  const runId = record ? record.run_id : recordOrRunId;
  if (!runId) return { stamp: null, source: null, unreadable: [] };
  const fromLog = lastLogStamp(home, record || runId);
  if (fromLog) return { stamp: fromLog, source: "log", unreadable: [] };
  let latest = null;
  // A gate journal that cannot be read is REPORTED, never skipped in silence:
  // a corrupt journal may hold the latest ledger, so a stamp read past it is a
  // stamp that may be stale (`unreadable`, rendered by describeRun and carried
  // on the projection).
  const unreadable = [];
  for (const j of stageJournals(home, record || { run_id: runId })) {
    if (j.kind !== "gates" && j.kind !== "gates-regate") continue;
    let entries;
    try { entries = j.entries || readJournal(j.path); } catch (e) { unreadable.push({ path: j.path, stage: j.stage, error: String((e && e.message) || e) }); continue; }
    const p = projectJournal(entries, j).progress;
    if (p && (!latest || stampAfter(p, latest))) latest = p;
  }
  const legacy = record && record.gate_progress && typeof record.gate_progress === "object" ? record.gate_progress : null;
  // A journal outranks the legacy record copy, unless that copy is strictly
  // LATER: before the log, inner saves rewrote the record stamp without ever
  // being journaled, so a journal can trail it, and reading the older stamp
  // would drop an owed flake row.
  if (latest && !(legacy && stampAfter(legacy, latest))) return { stamp: latest, source: "journal", unreadable };
  if (legacy) return { stamp: legacy, source: "record", unreadable };
  return { stamp: null, source: null, unreadable };
}

// Is stamp `a` later than `b`? By `seq` within one attempt key, else by `at`.
function stampAfter(a, b) {
  if (a.key === b.key && Number.isInteger(a.seq) && Number.isInteger(b.seq)) return a.seq > b.seq;
  return String(a.at || "") > String(b.at || "");
}

// The sole writer of the gate ledger: agent-dispatch-runner.js
// appendGateProgress, which takes the RECORD lock (the lock is the runner's —
// test/record-write-lint R7) so a settle, an owner change (`own` is the
// claim's `gate_settle_id`) or an attempt rollover between the caller's read
// and the append is refused exactly as the record writer refused it — and
// appends the merged stamp to `gate-progress.jsonl` here, writing no record.
// Returns {ok, progress, reason}; a refusal writes nothing.
function writeGateProgress(home, runId, mutate, opts = {}) {
  return dispatchRuns.appendGateProgress(home, runId, mutate, opts);
}

// ---------------- the stage journals ----------------

function parseStageName(stage) {
  const m = STAGE_RE.exec(String(stage || ""));
  if (!m) return null;
  return { stage: String(stage), kind: m[2] ? "gates-regate" : m[1], head: m[2] || null, attempt: Number(m[3]) };
}

// Every stage journal file a run has, oldest stage first: the run-keyed dir
// (`runPaths().workflows`) and, when the record's claim opened an execution,
// the execution-keyed files beside the execution record. Each:
// {stage, kind, head, attempt, path, source}.
function stageJournals(home, record) {
  const out = [];
  const runId = record && record.run_id;
  const seen = new Set();
  const take = (dir, prefix, source) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(JOURNAL_SUFFIX)) continue;
      const parsed = parseStageName(name.slice(prefix.length, -JOURNAL_SUFFIX.length));
      if (!parsed) continue;
      const abs = path.join(dir, name);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(abs).mtimeMs || 0; } catch { /* listed a moment ago; read below reports it */ }
      // The journal's own creation stamp (`opened_at` on its `open` entry,
      // written by the open activity), so two re-gate children of one attempt
      // order by when they were opened, not by a file's mtime (which a later
      // append or a copy moves). The entries are kept for projectRun, so a
      // journal is parsed once; an unreadable one is left for projectRun to
      // report.
      let entries = null;
      let openedAtMs = 0;
      try {
        entries = readJournal(abs);
        for (const e of entries) {
          if (e && e.kind === "effect" && typeof e.key === "string" && /\/open(#\d+)?$/.test(e.key) && e.result && typeof e.result === "object") {
            openedAtMs = Date.parse(e.result.opened_at || "") || 0;
            break;
          }
        }
      } catch { entries = null; }
      out.push({ ...parsed, path: abs, source, mtimeMs, openedAtMs, ...(entries ? { entries } : {}) });
    }
  };
  if (runId && executionStore.validSegment(String(runId))) {
    try {
      take(dispatchRuns.runPaths(home, String(runId)).workflows, "", "run");
    } catch { /* an unusable run id has no run-keyed journals */ }
  }
  const exec = claimedExecution(record);
  if (exec) take(path.dirname(executionStore.workflowJournalPath(home, exec.tenant, exec.id)), `${exec.id}.`, "execution");
  // Oldest first: attempt, then stage order, then — for the re-gate children
  // of one attempt, which share both — the journal's own creation stamp
  // (`opened_at`; the file's mtime only for a journal that predates it), so
  // the LAST re-gate's verdict is the one a per-gate fold keeps; the head is
  // only the tiebreak.
  const age = (j) => j.openedAtMs || j.mtimeMs;
  out.sort((a, b) => a.attempt - b.attempt || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || age(a) - age(b) || String(a.head || "").localeCompare(String(b.head || "")));
  return out;
}

// A stage journal's entries, framed (execution-store.js readJsonl: a torn tail
// dropped, an interior hole thrown).
function readJournal(abs) {
  return executionStore.readJsonl(abs, `stage workflow journal at ${abs}`, { framed: true });
}

// What ONE stage journal says, read from its entries alone:
//   version   — the kernel's version header ({workflow, version})
//   open      — the `open` activity's journaled input (the binding)
//   status    — tombstoned | settled | parked | running | empty
//   state     — the gate list's settled state (its `settled` entry), or the
//               parked (yielded) result's state
//   parked    — the last yielded result, when the journal ends on a yield
//   tombstone — {reason, detail} when the attempt was refused
//   head      — the last head the journal read (changedPaths / pinHead)
//   gates     — [{gate, cycle, rescue, verdict, head}] per judged attempt
//   progress  — the last ledger stamp a save activity journaled
//   effects   — how many activity results the journal holds
//   landed / proposed — the integration stage's landing (its `land` /
//               `propose` activity result), when it has one
//   opened_at — the journal's creation stamp (the open activity's clock)
//   yields    — every yielded result, oldest first: {key, reason, at,
//               paused_until, fallback_route}; `at` is the journaled clock
//               read after the yield, when the workflow made one
//   due       — when the last yield's durable timer fires (epoch ms), 0 when
//               the journal ends on a yield with no timer behind it; null when
//               the journal is not parked. The work loop re-offers a parked
//               pipeline at `due`, never on a cadence of its own.
//   reoffers  — how many CONSECUTIVE yields, counting back from the last,
//               carry the SAME reason (task-spor-work-loop-parked-reoffer-cap):
//               a pause inside its bound (`paused_until` past the yield's own
//               clock) neither counts nor breaks the run, a fallback hand-off
//               (`fallback_route`) starts it again at 0
function projectJournal(entries, meta = {}) {
  const { entries: _dropped, ...rest } = meta;
  const out = { ...rest, version: null, open: null, status: "empty", state: null, parked: null, tombstone: null, head: null, gates: [], progress: null, effects: 0, landed: null, proposed: null, opened_at: null, yields: [], due: null, reoffers: 0 };
  if (!Array.isArray(entries) || !entries.length) return out;
  let lastEffect = null;
  let head = null;
  let lastYield = null;
  let timerAfterYield = null;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.kind === "version") {
      out.version = { workflow: e.workflow || null, version: e.version == null ? null : e.version };
      continue;
    }
    if (e.kind === "tombstone") {
      out.tombstone = { reason: e.reason || "refused", detail: e.detail == null ? null : e.detail };
      continue;
    }
    if (e.kind === "now" && lastYield && lastYield.at == null && typeof e.at === "number") {
      lastYield.at = e.at;
      continue;
    }
    if (e.kind === "timer" && lastYield && timerAfterYield == null) {
      timerAfterYield = Number(e.fireAt) || 0;
      continue;
    }
    if (e.kind !== "effect" || typeof e.key !== "string") continue;
    out.effects += 1;
    lastEffect = e;
    if (e.threw) continue;
    const r = e.result;
    if (/\/open(#\d+)?$/.test(e.key) && r && typeof r === "object" && !out.open) {
      out.open = r;
      out.opened_at = r.opened_at || null;
      if (r.pinHead) head = String(r.pinHead);
      continue;
    }
    if (YIELD_RE.test(e.key) && r && typeof r === "object") {
      const pausedUntil = r.paused_until == null ? null : typeof r.paused_until === "number" ? r.paused_until : Date.parse(r.paused_until) || null;
      lastYield = { key: e.key, reason: r.reason == null ? null : String(r.reason), at: null, paused_until: pausedUntil, fallback_route: !!r.fallback_route };
      timerAfterYield = null;
      out.yields.push(lastYield);
    }
    if (/\/changedPaths#\d+$/.test(e.key) && r && typeof r === "object" && r.head) {
      head = String(r.head);
      continue;
    }
    const judged = JUDGE_RE.exec(e.key);
    if (judged && r && typeof r === "object") {
      const outcome = r.outcome && typeof r.outcome === "object" ? r.outcome : null;
      const verdict = outcome ? (outcome.verdict || (outcome.passed === true ? "passed" : outcome.passed === false ? "failed" : null)) : null;
      out.gates.push({ gate: judged[2], cycle: Number(judged[3]), rescue: Number(judged[1]) || 0, verdict, head: (outcome && outcome.head) || head || null });
      continue;
    }
    if (PROGRESS_SAVE_RE.test(e.key) && r && typeof r === "object" && r.key) {
      out.progress = r;
      continue;
    }
    // The closing entry: the gate list's `…/settled/settled#n`, the
    // integration and implementation stages' `…/settled`.
    if (/\/settled(?:\/settled)?(?:#\d+)?$/.test(e.key) && r && typeof r === "object") {
      out.state = r.state || null;
      out.status = "settled";
      continue;
    }
    if (/\/land#\d+$/.test(e.key) && r && typeof r === "object" && r.ok) out.landed = { sha: r.sha || null, detail: r.detail || null };
    if (/\/propose#\d+$/.test(e.key) && r && typeof r === "object" && r.ok) out.proposed = { number: r.number == null ? null : r.number, url: r.url || null };
  }
  out.head = head;
  if (out.tombstone) out.status = "tombstoned";
  else if (out.status !== "settled") {
    if (lastEffect && YIELD_RE.test(lastEffect.key) && !lastEffect.threw && lastEffect.result && typeof lastEffect.result === "object") {
      out.status = "parked";
      out.parked = lastEffect.result;
      out.state = lastEffect.result.state || "interrupted";
      out.due = timerAfterYield == null ? 0 : timerAfterYield;
    } else if (out.landed || out.proposed) {
      out.status = "settled";
      out.state = out.landed ? "landed" : "proposed";
    } else out.status = out.effects ? "running" : "empty";
  }
  out.reoffers = consecutiveYields(out.yields);
  return out;
}

// The re-offer count over a journal's yields (see projectJournal): back from
// the last yield while the reason holds. A pause still inside its bound at
// the time it was journaled is a known, time-boxed outage — skipped, neither
// counted nor a break; a fallback hand-off is a fresh attempt under another
// lane — the run ends there.
function consecutiveYields(yields) {
  if (!Array.isArray(yields) || !yields.length) return 0;
  let reason;
  let count = 0;
  for (let i = yields.length - 1; i >= 0; i -= 1) {
    const y = yields[i];
    if (y.fallback_route) break;
    const paused = y.paused_until != null && (y.at == null || y.paused_until > y.at);
    if (paused) continue;
    if (reason === undefined) reason = y.reason;
    else if (y.reason !== reason) break;
    count += 1;
  }
  return count;
}

// ---------------- the run projection ----------------

// Everything a reader wants to know about a gated run that the journals can
// answer, plus the record's own final word beside it:
//   stages   — one entry per stage journal (projectJournal), oldest first
//   current  — the latest stage still open (running/parked), else the last
//   gates    — the last judged attempt per gate id in the latest gate stage
//   progress — {stamp, source} (latestProgress)
//   owed     — the flake obligations the ledger still owes the graph
//   state / settle_id / refusal / worker / at — the record's final outcome
//   unreadable — journals that could not be read, by path, never silently
//                dropped
function projectRun(home, record) {
  const rec = record && typeof record === "object" ? record : { run_id: record };
  const stages = [];
  const unreadable = [];
  for (const j of stageJournals(home, rec)) {
    try {
      stages.push(projectJournal(j.entries || readJournal(j.path), j));
    } catch (e) {
      unreadable.push({ path: j.path, stage: j.stage, error: String((e && e.message) || e) });
    }
  }
  const open = stages.filter((s) => s.status === "running" || s.status === "parked");
  const current = open.length ? open[open.length - 1] : stages.length ? stages[stages.length - 1] : null;
  // The pipeline lease (the ownership nonce, journaled): an unreadable log is
  // reported beside the journals, never read as "unheld".
  let lease = null;
  try {
    lease = pipelineLease(home, rec);
  } catch (e) {
    unreadable.push({ path: pipelineLogPath(home, rec), stage: "pipeline", error: String((e && e.message) || e) });
  }
  const gateStages = stages.filter((s) => s.kind === "gates" || s.kind === "gates-regate");
  const gates = new Map();
  // Only the LATEST judging attempt's gate set (a just-opened, still-empty
  // journal has judged nothing to replace it): a gate an earlier attempt judged and a
  // later one dropped (an edited factory, a re-gate) is not part of the run's
  // current verdicts.
  const latestAttempt = gateStages.reduce((m, s) => (s.gates.length ? Math.max(m, s.attempt) : m), -Infinity);
  for (const s of gateStages) if (s.attempt === latestAttempt) for (const g of s.gates) gates.set(g.gate, { ...g, stage: s.stage, attempt: s.attempt });
  const progress = latestProgress(home, rec);
  // The ATTEMPT's own view of its debt (its rows plus what it carried).
  const owed = progress.stamp ? gatesKernel.owedGateObligations(progress.stamp, progress.stamp.key) : [];
  return {
    run_id: rec.run_id || null,
    stages,
    current: current ? { stage: current.stage, kind: current.kind, attempt: current.attempt, status: current.status, state: current.state, head: current.head, due: current.due, reoffers: current.reoffers, parked: current.parked } : null,
    // The latest OPEN stage (running or parked), when the pipeline has one —
    // what the work loop's resume scan reads (work-loop.js openPipelines).
    open: open.length ? open[open.length - 1].stage : null,
    gates: [...gates.values()],
    progress,
    owed: owed.map((o) => ({ row: o.row, carryKey: o.carryKey, rescue: o.rescue, attempt: o.attempt })),
    lease,
    state: rec.gate_state || null,
    settle_id: rec.gate_settle_id || null,
    refusal: rec.gate_refusal || null,
    worker: rec.gate_worker || null,
    at: rec.gate_at || null,
    unreadable: [...unreadable, ...progress.unreadable.filter((u) => !unreadable.some((x) => x.path === u.path))],
  };
}

// The resume scan's INPUT (task-spor-delete-loop-resume-machinery-after-
// workflow-stages): for every run record a gate-armed worker might owe a
// verdict, its projection and its lease — the IO half of work-loop.js
// `openPipelines`, which decides. A record is a candidate only when
// SOMETHING says a pipeline was owed: a lease was claimed, a stage journal
// exists, or the record was dispatched by a gate-armed worker (`gate_factory`,
// stamped at launch; a controller claim's `impl_claim.factory`). A hand-run
// `spor dispatch` has none and is never a candidate. `records` is the
// caller's (pre-filtered) list; the projection reads only those.
// `owedBy` (optional): run id -> factory id for runs some OTHER evidence says a
// gate-armed worker owed a gate — the slots a dead worker's published status
// file still lists (work.js reads them), which is what a run dispatched by a
// worker from before the `gate_factory` stamp existed has when that worker is
// replaced mid-flight. Such a record is a candidate too, under that factory.
function openPipelineCandidates(home, records, { owedBy = null } = {}) {
  const out = [];
  for (const record of records || []) {
    if (!record || !record.run_id || !record.node_id) continue;
    if (!executionStore.validSegment(String(record.run_id))) continue;
    let lease = null;
    let leaseError = null;
    try {
      lease = pipelineLease(home, record);
    } catch (e) {
      leaseError = String((e && e.message) || e);
    }
    const owed = owedBy && typeof owedBy.get === "function" && owedBy.has(record.run_id) ? owedBy.get(record.run_id) || null : undefined;
    const factory = (lease && lease.factory) || record.gate_factory || (record.impl_claim && record.impl_claim.factory && record.impl_claim.factory.node_id) || owed || null;
    let journals = [];
    try {
      journals = stageJournals(home, record);
    } catch { journals = []; }
    if (!lease && !leaseError && !journals.length && !factory && owed === undefined) continue;
    out.push({ record, projection: projectRun(home, record), lease, leaseError, factory });
  }
  return out;
}

// Does the run's ledger still owe flake occurrence evidence to the graph
// (gatesKernel.owedGateObligations over the current stamp)? The claim's and
// `--regate`'s question, answered off the log — never off the record.
function owesEvidence(home, record) {
  const { stamp } = latestProgress(home, record);
  return !!stamp && gatesKernel.owedGateObligations(stamp, null).length > 0;
}

// The projection, one line per fact, for `spor runs <id>` and `--status`.
// Indented to the run listing's column. Nothing when the run has no journal.
function describeRun(p, { indent = "  " } = {}) {
  if (!p || (!p.stages.length && !p.unreadable.length && !p.progress.stamp)) return [];
  const lines = [];
  const col = (label) => `${indent}${label.length >= 12 ? `${label} ` : label.padEnd(12)}`;
  for (const s of p.stages) {
    const what = s.kind === "gates-regate" ? `re-gate of ${String(s.head || "").slice(0, 12)}` : s.kind;
    const word = s.status === "settled" ? (s.state || "settled") : s.status === "parked" ? `parked${s.state && s.state !== "interrupted" ? ` (${s.state})` : ""}${s.parked && s.parked.reason ? ` — ${String(s.parked.reason).slice(0, 120)}` : ""}` : s.status === "tombstoned" ? `refused (${s.tombstone.reason})` : s.status;
    lines.push(`${col("journal:")}${what} a${s.attempt} — ${word}${s.landed && s.landed.sha ? ` (landed ${String(s.landed.sha).slice(0, 12)})` : ""}${s.proposed && s.proposed.number != null ? ` (PR #${s.proposed.number})` : ""}`);
    // A parked stage says when it is due back and how many times it has
    // yielded the same way (the re-offer cap's count).
    if (s.status === "parked") {
      const pausedUntil = s.parked && s.parked.paused_until ? new Date(typeof s.parked.paused_until === "number" ? s.parked.paused_until : Date.parse(s.parked.paused_until)) : null;
      const due = pausedUntil && !Number.isNaN(pausedUntil.getTime()) ? pausedUntil.toISOString() : s.due ? new Date(s.due).toISOString() : "now";
      lines.push(`${col("")}due ${due}${s.parked && s.parked.paused_profile ? ` (review lane ${s.parked.paused_profile})` : ""}; yielded ${s.reoffers} time(s) in a row for this reason`);
    }
  }
  if (p.lease) {
    const held = p.lease.released_at ? "released" : `held by ${p.lease.worker || "?"}${p.lease.expires_at ? ` until ${p.lease.expires_at}` : ""}`;
    lines.push(`${col("lease:")}${held}${p.lease.factory ? ` (factory ${p.lease.factory})` : ""}`);
  }
  for (const g of p.gates) {
    lines.push(`${col(`gate ${g.gate}:`)}${g.verdict || "no verdict"}${g.cycle ? ` (fix cycle ${g.cycle})` : ""}${g.rescue ? ` (rescue ${g.rescue})` : ""}${g.head ? ` @ ${String(g.head).slice(0, 12)}` : ""}`);
  }
  if (p.progress.stamp) {
    const rows = Object.entries(p.progress.stamp.gates || {});
    const fixes = rows.filter(([, r]) => r && Number.isInteger(r.fixes) && r.fixes > 0).map(([k, r]) => `${k} ${r.fixes} fix${r.fixes === 1 ? "" : "es"}`);
    const pools = p.progress.stamp.pools && p.progress.stamp.pools.retry && Number.isInteger(p.progress.stamp.pools.retry.spent) ? `retry pool ${p.progress.stamp.pools.retry.spent} spent` : null;
    lines.push(`${col("ledger:")}${p.progress.source === "record" ? "legacy record copy" : `from the ${p.progress.source}`} — attempt key ${p.progress.stamp.key || "?"}${fixes.length ? `; ${fixes.join(", ")}` : ""}${pools ? `; ${pools}` : ""}${p.owed.length ? `; ${p.owed.length} flake obligation(s) still owed` : ""}`);
  }
  for (const u of p.unreadable) lines.push(`${col("journal:")}${u.stage} — UNREADABLE (${u.error})`);
  return lines;
}

module.exports = {
  PROGRESS_LOG,
  PIPELINE_LOG,
  PIPELINE_LEASE_TTL_MS,
  JOURNAL_SUFFIX,
  progressLogPath,
  readProgressLog,
  pipelineLogPath,
  readPipelineLog,
  pipelineLease,
  leaseHeld,
  consecutiveYields,
  openPipelineCandidates,
  latestProgress,
  writeGateProgress,
  parseStageName,
  stageJournals,
  readJournal,
  projectJournal,
  projectRun,
  owesEvidence,
  describeRun,
};
