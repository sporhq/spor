// The shared half of every STAGE workflow driver
// (task-spor-shared-stage-workflow-helper): what integration-workflow.js,
// implementation-workflow.js and gate-workflow.js each had their own copy of
// — the JSON-plain round-trip, the definition-mismatch throw, the LIVE-STEP
// binding guard, the readings of a kernel failure (unresumable / tombstoned /
// replay fault), the drive loop with its bounded poisoned-journal re-open, the
// refusal RECORD a tombstone carries and the tags a settled refusal reports,
// and the tombstone-then-settle policy. The stages keep what is theirs: the
// workflow function, the activities table, the settle writes, and how a
// suspension is answered (a timer the integration stage hands up, the
// implementation stage sleeps through, the gate list slices).
//
// Rules this module holds for every stage:
//   - the definition binding is enforced ONLY before a LIVE kernel step
//     (dec-spor-implementation-stage-workflow-function-live-step-binding-
//     guard): a journal that already holds the attempt's whole story replays
//     to its settled result whatever the live definition reads, and the guard
//     fires exactly when the next activity, clock read, timer or signal wait
//     would be EXECUTED rather than replayed — before it is journaled, so the
//     workflow appends nothing under a mixed definition;
//   - a refusal is TERMINAL for its journal: tombstone FIRST (persisted, or
//     the Execution is poisoned and the refusal settles nothing), settle
//     second, and a tombstoned journal is RE-SETTLED from its record — same
//     ids, same detail — never continued;
//   - every refusal the driver settles is tagged the same way, so the run
//     record and `spor work --status` read one vocabulary for every stage:
//     `definition_mismatch` / `journal_version_mismatch`, `refusal_tombstoned`,
//     `refusal_replayed` (`refusalTags`, `refusalSurface`).
"use strict";

const { NonDeterminism, WorkflowVersionMismatch, WorkflowTombstoned } = require("../kernel/workflow.js");

const MAX_REOPEN = 3;

// JSON-plain: what the journal will hold, so a live result and its replay
// are the same value (an `undefined` field is absent either way).
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// The fail-closed throw: a NonDeterminism (the kernel's own vocabulary for
// "this journal cannot be continued by this code"), tagged so a driver can
// tell it from a genuine key-sequence fault and settle the attempt. `stage`
// names the stage ("integration", "implementation", "gate"); `what` is the
// human reading of the bound inputs; `subject` is the stage's own noun for
// the in-flight thing ("integration attempt", "gate pipeline").
function definitionMismatchError({ stage, what = null, subject = null, nodeId, runId, journaled, live }) {
  const e = new NonDeterminism(
    `the factory's ${stage} definition${what ? ` (${what})` : ""} changed while ${nodeId}'s ${subject || `${stage} attempt`} was in flight — ` +
      `the attempt opened under ${journaled} and the factory now reads ${live}; the attempt is not resumed under a mixed definition`
  );
  e.definitionMismatch = { runId, journaled, live };
  return e;
}

// The LIVE-STEP binding guard over the kernel's ctx. `journaled` is the digest
// the `open` entry recorded, `live` the one the live factory reads;
// `mismatch()` builds the throw. Returns a ctx-shaped object whose
// `run`/`now`/`sleepUntil`/`awaitSignal` check the binding before the kernel
// takes a step that would EXECUTE (`ctx.isReplaying()` false), and pass
// straight through while the journal is still being replayed.
function guardedKernel(ctx, { journaled, live, mismatch }) {
  const guard = () => {
    if (!ctx.isReplaying() && journaled !== live) throw mismatch();
  };
  return {
    guard,
    isReplaying: () => ctx.isReplaying(),
    run(key, name, args) {
      guard();
      return ctx.run(key, name, args);
    },
    now(key) {
      guard();
      return ctx.now(key);
    },
    sleepUntil(key, at) {
      guard();
      return ctx.sleepUntil(key, at);
    },
    awaitSignal(key, name, opts) {
      guard();
      return ctx.awaitSignal(key, name, opts);
    },
  };
}

// --- readings of a kernel failure ---

function isTombstoned(error) {
  return !!error && (error instanceof WorkflowTombstoned || error.name === "WorkflowTombstoned");
}

function isVersionMismatch(error) {
  return !!error && (error instanceof WorkflowVersionMismatch || error.name === "WorkflowVersionMismatch");
}

// "This attempt's journal is not this worker's to continue": the workflow's
// own definition-mismatch throw, or the kernel refusing a journal recorded
// under another workflow version. A tombstone is read separately
// (`isTombstoned`): it is re-settled, not refused afresh.
function unresumable(error) {
  return !!error && (!!error.definitionMismatch || isVersionMismatch(error));
}

// A REPLAY FAULT: the recorded key sequence no longer matches the code path,
// which — once every input the workflow branches on is journaled — is a bug
// in the workflow function, never an operator's situation.
function replayFault(error) {
  return !!error && !error.definitionMismatch && (error instanceof NonDeterminism || error.name === "NonDeterminism");
}

// --- the drive loop ---

// Drive an Execution to a settled result. `open(handle)` builds a fresh
// Execution (over the caller's journal handle when `reopenable`); a persist
// that POISONED the Execution re-opens it (bounded by `maxReopen`) — the
// kernel's own contract is that memory never runs ahead of disk, and a fresh
// handle holds whatever truly landed — on a failed run AND on a poisoned
// signal delivery. Everything else is the stage's:
//   onFailed(error, exec)   -> {result} to return, {exec} to continue with a
//                              new Execution, undefined to rethrow
//   onSuspended(r, exec)    -> {result} to return, {exec} to continue with a
//                              new Execution, undefined to run again
// `reopenable` may be a boolean or a function (the gate driver stops
// re-opening once it judges over a fresh in-memory journal).
async function driveStage({ label, nodeId, log = () => {}, open, reopenable = false, maxReopen = MAX_REOPEN, onFailed = () => undefined, onSuspended = () => undefined }) {
  const canReopen = () => (typeof reopenable === "function" ? !!reopenable() : !!reopenable);
  let e = open();
  let reopened = 0;
  const reopen = (why) => {
    reopened += 1;
    log(`work: the ${label} workflow journal for ${nodeId} could not be written (${why}) — re-opening it (${reopened}/${maxReopen})`);
    e = open();
  };
  for (;;) {
    const r = await e.run();
    if (r.status === "completed") return r.result;
    if (r.status === "failed") {
      if (r.error && r.error.poisoned && canReopen() && reopened < maxReopen) {
        reopen(r.error.message);
        continue;
      }
      const next = await onFailed(r.error, e);
      if (next && "result" in next) return next.result;
      if (next && next.exec) {
        e = next.exec;
        continue;
      }
      throw r.error;
    }
    if (r.status === "crashed") throw new Error(`the ${label} workflow crashed ${r.where}`); // the test seam only; never planned here
    let next;
    try {
      next = await onSuspended(r, e);
    } catch (err) {
      // The delivery could not be persisted: same bounded re-open as a failed
      // run, and the re-driven Execution re-awaits (the run is terminal, so
      // the wait answers at once).
      if (err && err.poisoned && canReopen() && reopened < maxReopen) {
        reopen(err.message);
        continue;
      }
      throw err;
    }
    if (next && "result" in next) return next.result;
    if (next && next.exec) e = next.exec;
  }
}

// --- the refusal record and its settle ---

// The refusal RECORD a tombstone carries and a settle reads: WHY (the
// mismatch, or the version), the clock, and the pipeline attempt. A stage
// merges its own id-bearing fields onto this (the integration stage's gated
// head and factory fields; the implementation stage needs nothing more).
// `stage` names the stage; `what` is the human reading of the bound inputs;
// `verb` is what the stage would otherwise have done ("landed",
// "dispatched", "judged").
function refusalRecord({ stage, what, verb, item, error, clock }) {
  const versionMismatch = !error.definitionMismatch;
  const detail = versionMismatch
    ? `this attempt's ${stage} workflow journal was recorded by another version of the workflow (${error.message}); it is not resumed by this worker`
    : `the factory's ${stage} definition (${what}) was edited while this attempt was in flight (opened under ${error.definitionMismatch.journaled}, now ${error.definitionMismatch.live}); nothing is judged or ${verb} under a mixed definition`;
  return {
    reason: versionMismatch ? "journal_version_mismatch" : "definition_mismatch",
    detail,
    at: clock.now(),
    ...(versionMismatch ? { journal_version_mismatch: true } : { definition_mismatch: { ...error.definitionMismatch } }),
    attempt: Math.max(0, Number(item.attempt) || 0),
  };
}

// A tombstone with NO record on it (the driver always writes one; only a
// hand-written tombstone lacks it): the ERROR the record is rebuilt from —
// honestly tagged by the tombstone's own `reason`, with the message saying
// the record was missing. The stage's own `refusalRecord` turns it into the
// record it needs.
function recordlessError({ item, entry }) {
  const error = new Error(`the attempt's refusal tombstone carries no record (reason: ${entry.reason || "refused"})`);
  if (entry.reason === "definition_mismatch") error.definitionMismatch = { runId: item.run_id, journaled: null, live: null };
  return error;
}

// The tags a settled refusal reports — one vocabulary for every stage, read
// by the run record and `--status` (`refusalSurface`).
function refusalTags(refusal, { replayed = false } = {}) {
  return {
    ...(refusal.definition_mismatch ? { definition_mismatch: { ...refusal.definition_mismatch } } : { journal_version_mismatch: true }),
    refusal_tombstoned: true,
    ...(replayed ? { refusal_replayed: true } : {}),
  };
}

// The driver's answer to a kernel failure that is a REFUSAL of the attempt:
//   - a tombstoned journal (this worker's or a predecessor's) is RE-SETTLED
//     from the recorded tombstone — same detail, same ids — never resumed, so
//     a factory reverted after the refusal cannot land it, and a crash
//     between the tombstone and the settle is made whole here;
//   - an unresumable journal (the definition it opened under changed, or it
//     was recorded by another version) is tombstoned FIRST, then settled as
//     refused outside it. The tombstone is the kernel's own append —
//     persisted before it returns, and a persist failure poisons the
//     Execution and THROWS here, so a refusal that could not be made durable
//     settles nothing over a journal that is still resumable.
// `build(error)` is the stage's refusalRecord; `settle(refusal, {replayed})`
// its settle. Returns `{result}` for the drive loop, or undefined when the
// failure is neither.
async function settleOrRefuse(error, exec, { item, build, settle }) {
  if (isTombstoned(error)) {
    const entry = error.tombstone || {};
    return { result: await settle(entry.detail || build(recordlessError({ item, entry })), { replayed: true }) };
  }
  if (unresumable(error)) {
    const refusal = build(error);
    const recorded = exec.tombstone(refusal.reason, refusal);
    return { result: await settle(recorded.detail || refusal, { replayed: false }) };
  }
  return undefined;
}

// The refusal tags a stage result carries, as they stand, for a caller that
// folds a stage's result into the pipeline's (bin/spor.js runGateAndIntegration
// over the implementation stage) — nothing when the result is not a refusal.
function carryRefusalTags(res) {
  if (!res || typeof res !== "object") return {};
  return {
    ...(res.definition_mismatch ? { definition_mismatch: { ...res.definition_mismatch } } : {}),
    ...(res.journal_version_mismatch ? { journal_version_mismatch: true } : {}),
    ...(res.refusal_tombstoned ? { refusal_tombstoned: true } : {}),
    ...(res.refusal_replayed ? { refusal_replayed: true } : {}),
  };
}

// What a pipeline result says about a refused attempt, for the run record
// (`gate_refusal`) and the status surface — null for a result that carries no
// refusal tags. Stage-agnostic: any stage whose result rides the tags above
// surfaces through this one reading.
function refusalSurface(res) {
  if (!res || typeof res !== "object") return null;
  if (!res.refusal_tombstoned && !res.definition_mismatch && !res.journal_version_mismatch) return null;
  const mismatch = res.definition_mismatch && typeof res.definition_mismatch === "object" ? res.definition_mismatch : null;
  return {
    reason: mismatch ? "definition_mismatch" : "journal_version_mismatch",
    ...(mismatch ? { journaled: mismatch.journaled == null ? null : String(mismatch.journaled), live: mismatch.live == null ? null : String(mismatch.live) } : {}),
    tombstoned: res.refusal_tombstoned === true,
    replayed: res.refusal_replayed === true,
    ...(res.stage ? { stage: String(res.stage).slice(0, 40) } : {}),
  };
}

// One line for a person, from `refusalSurface`'s reading.
function describeRefusal(refusal) {
  if (!refusal) return null;
  const why = refusal.reason === "definition_mismatch"
    ? `the factory definition was edited while the attempt was in flight${refusal.journaled || refusal.live ? ` (opened under ${refusal.journaled || "?"}, now ${refusal.live || "?"})` : ""}`
    : "the attempt's journal was recorded by another version of the workflow";
  return `refused: ${why}${refusal.tombstoned ? "; the attempt's journal is tombstoned" : ""}${refusal.replayed ? " (re-settled from the tombstone)" : ""} — a fresh attempt is 'spor work --regate <run>'`;
}

module.exports = {
  MAX_REOPEN,
  plain,
  definitionMismatchError,
  guardedKernel,
  isTombstoned,
  isVersionMismatch,
  unresumable,
  replayFault,
  driveStage,
  refusalRecord,
  recordlessError,
  refusalTags,
  carryRefusalTags,
  settleOrRefuse,
  refusalSurface,
  describeRefusal,
};
