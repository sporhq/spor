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
//   record  — the run record's own `gate_progress` (a run that predates the
//             log), READ-ONLY: nothing writes it back. Before the log, every
//             save — the inner ones too — rewrote this stamp, so for such a
//             run it is a superset of anything a journal holds.
//   journal — the last save activity's journaled RESULT in a gate journal:
//             the last resort for a post-log run whose log was lost. Only the
//             saves the workflow journals as their own step are here, so it
//             can trail the stamp that was live; it never outranks the two
//             above.
//   null    — no ledger yet
// ONE resolution, shared by every reader and by the writer's prior
// (agent-dispatch-runner.js appendGateProgress), so the stamp a loader reads
// is the stamp the next save continues from. `recordOrRunId` is the run
// record (preferred — the execution-keyed journals and the legacy stamp need
// it) or a bare run id.
function latestProgress(home, recordOrRunId) {
  const record = recordOrRunId && typeof recordOrRunId === "object" ? recordOrRunId : null;
  const runId = record ? record.run_id : recordOrRunId;
  if (!runId) return { stamp: null, source: null };
  const fromLog = lastLogStamp(home, record || runId);
  if (fromLog) return { stamp: fromLog, source: "log" };
  if (record && record.gate_progress && typeof record.gate_progress === "object") return { stamp: record.gate_progress, source: "record" };
  let latest = null;
  for (const j of stageJournals(home, record || { run_id: runId })) {
    if (j.kind !== "gates" && j.kind !== "gates-regate") continue;
    let entries;
    try { entries = readJournal(j.path); } catch { continue; }
    const p = projectJournal(entries, j).progress;
    if (p && (!latest || stampAfter(p, latest))) latest = p;
  }
  if (latest) return { stamp: latest, source: "journal" };
  return { stamp: null, source: null };
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
      out.push({ ...parsed, path: abs, source, mtimeMs });
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
  // of one attempt, which share both — the journal's own age (its last
  // append), so the LAST re-gate's verdict is the one a per-gate fold keeps;
  // the head is only the tiebreak.
  out.sort((a, b) => a.attempt - b.attempt || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.mtimeMs - b.mtimeMs || String(a.head || "").localeCompare(String(b.head || "")));
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
function projectJournal(entries, meta = {}) {
  const out = { ...meta, version: null, open: null, status: "empty", state: null, parked: null, tombstone: null, head: null, gates: [], progress: null, effects: 0, landed: null, proposed: null };
  if (!Array.isArray(entries) || !entries.length) return out;
  let lastEffect = null;
  let head = null;
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
    if (e.kind !== "effect" || typeof e.key !== "string") continue;
    out.effects += 1;
    lastEffect = e;
    if (e.threw) continue;
    const r = e.result;
    if (/\/open(#\d+)?$/.test(e.key) && r && typeof r === "object" && !out.open) {
      out.open = r;
      if (r.pinHead) head = String(r.pinHead);
      continue;
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
    if (/\/settled\/settled#\d+$/.test(e.key) && r && typeof r === "object") {
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
    } else if (out.landed || out.proposed) {
      out.status = "settled";
      out.state = out.landed ? "landed" : "proposed";
    } else out.status = out.effects ? "running" : "empty";
  }
  return out;
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
      stages.push(projectJournal(readJournal(j.path), j));
    } catch (e) {
      unreadable.push({ path: j.path, stage: j.stage, error: String((e && e.message) || e) });
    }
  }
  const open = stages.filter((s) => s.status === "running" || s.status === "parked");
  const current = open.length ? open[open.length - 1] : stages.length ? stages[stages.length - 1] : null;
  const gateStages = stages.filter((s) => s.kind === "gates" || s.kind === "gates-regate");
  const gates = new Map();
  for (const s of gateStages) for (const g of s.gates) gates.set(g.gate, { ...g, stage: s.stage, attempt: s.attempt });
  const progress = latestProgress(home, rec);
  // The ATTEMPT's own view of its debt (its rows plus what it carried).
  const owed = progress.stamp ? gatesKernel.owedGateObligations(progress.stamp, progress.stamp.key) : [];
  return {
    run_id: rec.run_id || null,
    stages,
    current: current ? { stage: current.stage, kind: current.kind, attempt: current.attempt, status: current.status, state: current.state, head: current.head } : null,
    gates: [...gates.values()],
    progress,
    owed: owed.map((o) => ({ row: o.row, carryKey: o.carryKey, rescue: o.rescue, attempt: o.attempt })),
    state: rec.gate_state || null,
    settle_id: rec.gate_settle_id || null,
    refusal: rec.gate_refusal || null,
    worker: rec.gate_worker || null,
    at: rec.gate_at || null,
    unreadable,
  };
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
  JOURNAL_SUFFIX,
  progressLogPath,
  readProgressLog,
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
