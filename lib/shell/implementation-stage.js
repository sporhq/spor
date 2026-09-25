// shell/implementation-stage.js — the IMPLEMENTATION STAGE runner: the loop
// that spends the attempt budget and the infrastructure retry pool
// (task-spor-factory-implementation-stage-runner, FACTORY-IMPLEMENTATION-
// STAGE.md §4.2 rows I2-I11, §5.3, §6.5; WORKERS.md §10.16).
//
// `spor work` dispatches an implementer (bin/spor.js dispatchWorkItem) and,
// under `completion.by: controller`, gates every terminal run it produces. This
// stage sits BETWEEN that harvest and the gate list: it reads what the
// implementer's run produced — through the one shared classifier
// (kernel/gates.js classifyExecutionOutcome) and then, for a run that ended
// cleanly, the tree itself — settles the attempt's entry on the run record's
// `impl_attempts[]` ledger, and either hands a CANDIDATE to the gates or
// re-dispatches the implementer into the run's own checkout while the budget
// allows: the CODE pool (`implementation.budget.attempts`) for a failed,
// cancelled or no-candidate attempt, the shared INFRASTRUCTURE pool
// (`implementation.retry.attempts`, the same count the gate runner's
// spendOutage reads) for an outage. When the pool an outcome names is spent
// the stage settles `exhausted` (I11) or `escalated` (I8) and files the
// `requires: [human]` escalation that `blocks` the item — the hold stays (T1),
// nothing completes.
//
// Dependency-injected like gate-runner.js and integration-runner.js: every
// side effect — the dispatch, the run-record stamps, the graph writes, the
// clock — comes in through `deps`, so test/gate-pipeline.test.js drives every
// row with a fake dispatcher and no harness. The re-dispatch is a run NAMED
// `impl-<short>-<attempt>` (shortRunAttempt's key, the convention the fix
// cycle and the rescue lane already adopt by) so a worker killed between the
// launch and its durable record ADOPTS the run on resume instead of
// dispatching a second implementer into one checkout.
//
// The ledger is SEGMENTED by pipeline attempt (kernel/gates.js
// implAttemptKey): a `spor work --regate` is a new attempt of the whole
// pipeline — fresh gate progress, a fresh infrastructure pool, a new run-name
// key — and it starts a fresh segment here too, re-judging the run under the
// new key; the earlier segment stays as history and the caps read only the
// current one. cmdWorkRegate reopens a settled stage REFUSAL to `running`
// for exactly that.
//
// Durable-flag discipline (§6.5, the four rows), answered on the ledger:
//   (a) the settle stamp fails — the entry stays `pending` on disk, the caps
//       read it as unspent, and a LATER pass re-classifies the same record
//       (the classifier is pure over it). But on a LIVE worker there is no
//       later pass — the loop settles the slot and never re-offers it — so
//       the stage does not park the item on a promise: it stops and
//       ESCALATES (state `escalated`, the reason naming the stamp), the same
//       rule the gate runner keeps for a pool charge that could not land — an
//       uncounted attempt is an unbounded one.
//   (b) outcome and pool are ONE stamp; a `pending` entry never has a pool and
//       a settled one always does. A re-dispatch is RESERVED (pending) before
//       it is launched — and, on the retry pool, before the backoff is waited
//       out — so a stop or a crash in between resumes INTO the launch
//       (adopting it by name if it did land), never past it and never at a
//       charge with no reservation behind it.
//   (c) the settle is keyed on the entry's index and refused when the entry is
//       already settled, so a resumed worker beside a not-quite-dead one
//       charges once.
//   (d) a settled stage (`impl_state` in the settled set) is read back, never
//       re-run: `exhausted`/`escalated` re-file their idempotent escalation
//       and stop; `candidate` hands straight to the gates.
//
// A factory that declares no `implementation:` block never enters this file —
// the caller gates on it — so the shipped pipeline is byte-identical.
"use strict";

const gates = require("../kernel/gates.js");
const candidateKernel = require("../kernel/candidate.js");
const { shortRunAttempt } = require("./gate-runner.js");

// A hard ceiling on loop iterations, independent of the declared pools: the
// pools bound the DISPATCHES (≤ 3 code + 3 retry), and this only guarantees
// that a ledger no client wrote — a hand-edited record, a newer client's
// vocabulary — cannot spin.
const STAGE_ITERATION_CAP = 8;

// How finely the retry backoff is sliced, so a worker asked to stop is
// answered inside the wait — the same shape gate-runner.js's spendOutage uses.
const BACKOFF_SLICE_MS = 1000;

// The one cap on a refusal's reason (the ledger's `stop_reason`, the
// escalation body, the retry payload) — the same bound a gate escalation's
// evidence keeps.
const STOP_REASON_CAP = 3000;

// The unique run name a re-dispatch is launched under — and adopted by, on
// resume. Attempt 1 is the pipeline's own run (dispatched by the loop, named by
// it), so only attempts ≥ 2 are ever launched here.
function implRunName(runId, attempt, index) {
  return `impl-${shortRunAttempt(runId, attempt)}-${index}`;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function lastOf(list) {
  return list.length ? list[list.length - 1] : null;
}

// What a run that ended CLEANLY produced (§4.2 I3-I5): read the tree the same
// way the gates will (`deps.changedPaths` — merge-base..HEAD in the run's own
// checkout, tracked-dirty refused). Returns the attempt OUTCOME, or a
// `handoff` — a reading this stage does not settle itself but leaves to the
// pipeline's own deterministic routes, which run before any gate and can only
// ever remove a wrong refusal:
//   - an empty diff whose item's recorded commits already LANDED on the
//     trusted ref (the stale-premise route, WORKERS.md §10.11's sibling);
//   - an empty diff the run DECLARED as a no-code outcome (`SCOPED:`, §10.11)
//     — verified there against the graph, whichever way it comes out. The
//     claim is read from THIS attempt's run (`record`), not the pipeline's
//     first: a re-dispatched implementer may be the one that scoped it;
//   - a dirty tree the factory tolerates (`require_clean: false`): the
//     pipeline's commit-or-discard round-trip is the declared remedy;
//   - a checkout that is GONE (superseded by hand while nobody watched — the
//     pipeline's own check) or a tree that could not be read at all (the gates
//     fail closed on it; re-dispatching an implementer into a checkout this
//     box cannot read would only spend an attempt at the same unreadable tree).
async function judgeProduct({ item, factory, record, deps, log }) {
  const impl = factory.implementation;
  let r = null;
  try {
    r = await deps.changedPaths({ trustedRef: factory.trustedRef });
  } catch (e) {
    r = { ok: false, reason: `the change under judgement could not be read: ${(e && e.message) || e}` };
  }
  if (r && r.ok) {
    const paths = Array.isArray(r.paths) ? r.paths : [];
    if (paths.length) return { outcome: "candidate", reason: `${paths.length} path(s) changed past ${factory.trustedRef} at ${String(r.head || "").slice(0, 12)}` };
    // An EMPTY diff. Before it is read as "no candidate", the two readings
    // the pipeline settles deterministically get their chance — both are
    // evidence that predates or accompanies the run, and both are cheap.
    if (deps.commitsLanded) {
      let landed = null;
      try {
        landed = await deps.commitsLanded({ trustedRef: factory.trustedRef });
      } catch (e) {
        log(`work: ${item.node_id} — its recorded commits could not be checked against ${factory.trustedRef} (${(e && e.message) || e})`);
      }
      const verdict = gates.verifyStalePremise({ nodeId: item.node_id, commitsLanded: landed });
      if (verdict.ok) return { outcome: "candidate", handoff: `the item's recorded commits already land on ${factory.trustedRef} — the pipeline's stale-premise route settles it` };
    }
    if (deps.noCodeClaim) {
      let claim = null;
      try {
        claim = await deps.noCodeClaim({ item, record });
      } catch (e) {
        log(`work: ${item.node_id} — its final report could not be read for a no-code outcome (${(e && e.message) || e})`);
      }
      if (claim) return { outcome: "candidate", handoff: "the run declared a no-code outcome — the pipeline verifies the claim against the graph" };
    }
    return { outcome: "no-candidate", reason: `the run ended cleanly but committed nothing past ${factory.trustedRef} in its checkout` };
  }
  const reason = (r && r.reason) || "the change under judgement could not be read";
  if (r && r.dirty) {
    if (impl && impl.candidate && impl.candidate.requireClean === false) {
      return { outcome: "candidate", handoff: `the tree is dirty and the factory tolerates it (require_clean: false) — the pipeline's commit-or-discard round-trip judges it` };
    }
    // The dirty-tree round-trip under `require_clean` (I4): a code outcome,
    // re-dispatched at the same run.
    return { outcome: "failed", dirty: true, reason };
  }
  if (r && r.gone) return { outcome: "candidate", handoff: `${reason} — the pipeline's superseded check reads it` };
  return { outcome: "candidate", handoff: `${reason} — the gates fail closed on it` };
}

// Charge one retry on the SHARED infrastructure pool. Returns the new pool
// counts, or the REASON the charge may not be taken — which is not
// decoration: "the pool is spent", "no pool is declared" and "the charge
// could not land" end the stage identically and send a person to three
// different places.
async function chargeRetry({ item, factory, deps, log, pools }) {
  const impl = factory.implementation;
  const cap = gates.executionPoolCap(impl, "retry");
  if (cap <= 0 || !deps.saveGatePools) return { ok: false, reason: "this factory declares no infrastructure retry pool (`implementation.retry.attempts`), so the outage was not waited out" };
  if (gates.executionPoolHeadroom(impl, "retry", pools.retry.spent) <= 0) return { ok: false, reason: `the pipeline's shared infrastructure retry pool is spent (${pools.retry.spent}/${cap})` };
  if (deps.stopping && deps.stopping()) return { ok: false, stop: true, reason: "the worker was asked to stop before the retry was taken — the pool still has headroom" };
  const next = { retry: { spent: pools.retry.spent + 1 } };
  try {
    await deps.saveGatePools({ item, pools: next });
  } catch (e) {
    log(`work: the infrastructure retry could not be charged (${(e && e.message) || e}) — the implementation stage stops on ${item.node_id} rather than retrying uncharged`);
    return { ok: false, reason: "the retry could not be charged durably, and an uncounted retry is an unbounded one" };
  }
  return { ok: true, pools: next, cap };
}

// Wait out the declared backoff, sliced so a stop is answered inside it.
// Returns `true` when the wait completed, `false` on a stop.
async function waitBackoff({ deps, backoffMs }) {
  const now = deps.now || (() => Date.now());
  const deadline = now() + backoffMs;
  while (backoffMs > 0) {
    const at = now();
    if (at >= deadline) break;
    if (deps.stopping && deps.stopping()) return false;
    await deps.sleep(Math.min(BACKOFF_SLICE_MS, deadline - at));
  }
  return !(deps.stopping && deps.stopping());
}

// The stage. `item` is the pipeline entry (`run_id`, `node_id`, `attempt`),
// `record` the implementer's run record as the loop harvested it, `factory`
// the parsed definition (its `implementation` block must be non-null — the
// caller gates on it). Returns one of:
//   {state: "candidate"}   — hand to the gates (the segment's last entry is
//                            settled `candidate`); `handoff` names the reading
//                            the pipeline settles itself, when there is one
//   {state: "declined"}    — I6: triage, no gate, no escalation
//   {state: "exhausted"}   — I11: the code pool is spent; escalated
//   {state: "escalated"}   — I8: the retry pool is spent — or the stage could
//                            not go on for a reason that is not the code's (a
//                            run this box could not follow to its end, a
//                            ledger it could not stamp); escalated, the reason
//                            naming which
//   {state: "unroutable"}  — I2 on a re-dispatch: refused before any run
//                            record; nothing judged, the caller clears the hold
//   {state: "interrupted"} — the worker was asked to stop; the ledger is left
//                            for a resume to pick up
// every one carrying `attempts` (the current segment) and `reason`.
async function runImplementationStage({ item, factory, record, deps, log = () => {} }) {
  const nodeId = item.node_id;
  const impl = factory && factory.implementation;
  if (!impl) return { state: "candidate", attempts: [], reason: "no implementation stage is declared", skipped: true };
  const now = deps.now || (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const stopping = () => !!(deps.stopping && deps.stopping());
  let key = Math.max(0, Number(item.attempt) || 0);

  // The ledger, read FRESH: the loop's harvested copy predates every stamp a
  // killed worker made before it died.
  let attempts = [];
  let current = record || {};
  try {
    const loaded = await deps.loadImplAttempts({ item });
    attempts = Array.isArray(loaded && loaded.attempts) ? loaded.attempts : [];
    if (loaded && loaded.record) current = loaded.record;
  } catch (e) {
    log(`work: ${nodeId} — the implementation ledger could not be read (${(e && e.message) || e}); starting from the run record`);
  }
  const mine = () => gates.implAttemptsFor(attempts, key);

  // A re-gate (`key > 0`) opens a FRESH segment — unless an earlier segment
  // still OWES a launched attempt its classification: a worker killed while
  // following `impl-<short>-2` leaves that entry pending with its run id,
  // and the agent behind it may still be editing the checkout. Opening a new
  // segment there would re-judge the tree under it and dispatch a second
  // implementer into the same cwd. So the owed attempt is ADOPTED instead:
  // this pass continues that segment — its key, its run names — exactly as
  // a resume would, and only a later regate finds nothing owed.
  if (key > 0 && !mine().length) {
    const owed = attempts.filter((e) => isPlainObject(e) && gates.implAttemptKey(e) < key && !gates.implAttemptSettled(e) && e.run_id);
    if (owed.length) {
      const adopt = gates.implAttemptKey(owed[owed.length - 1]);
      log(`work: ${nodeId} — implementation attempt ${owed[owed.length - 1].index} (run ${String(owed[owed.length - 1].run_id).slice(0, 8)}) is still owed a classification; following it before any new attempt`);
      key = adopt;
    }
  }

  // The shared infrastructure pool (gate-runner.js loads it the same way).
  let pools = { retry: { spent: 0 } };
  if (deps.loadGatePools) {
    try {
      const p = await deps.loadGatePools({ item });
      const spent = p && p.retry && Number(p.retry.spent);
      if (Number.isFinite(spent) && spent > 0) pools = { retry: { spent: Math.floor(spent) } };
    } catch (e) {
      log(`work: the infrastructure retry pool could not be read (${(e && e.message) || e}) — no infrastructure retry will be spent on ${nodeId}`);
      pools = { retry: { spent: gates.executionPoolCap(impl, "retry") } };
    }
  }

  // Why a spent pool stopped the stage — derived from the LEDGER and the pool
  // counts, never from this pass's own path, so a resumed stage re-filing
  // its escalation composes the identical body (the escalation write is
  // idempotent by id AND content: a different body under the same id is a
  // refused collision, not a re-file).
  const spentReason = (state) => {
    const last = lastOf(mine()) || {};
    if (state === "escalated") {
      const cap = gates.executionPoolCap(impl, "retry");
      if (cap <= 0) return "this factory declares no infrastructure retry pool (`implementation.retry.attempts`), so the outage was not waited out";
      return `the pipeline's shared infrastructure retry pool is spent (${pools.retry.spent}/${cap}) and the last attempt ended on an outage: ${last.reason || "no reason recorded"}`;
    }
    const cap = gates.executionPoolCap(impl, "implementation");
    return `the implementation budget is spent (${gates.implAttemptsSpent(attempts, "implementation", { attempt: key })}/${cap} attempts) without a candidate; the last attempt ${last.outcome || "ended"}: ${last.reason || "no reason recorded"}`;
  };

  const save = async (patch = {}) => {
    await deps.saveImplAttempts({ item, attempts: attempts.map((e) => ({ ...e })), patch });
  };
  // Settle the stage on a refusal that is nobody's code: escalate with the
  // reason, stamp the state (best-effort — the escalation is the graph's
  // record, the stamp this box's), report.
  const stop = async (state, rawReason) => {
    // ONE canonical reason string — capped once, here — rides the segment's
    // last entry (`stop_reason`), goes into the escalation body, and rides
    // the retry payload, so a resumed settled stage (which reads it back off
    // the ledger) re-files the escalation with the byte-identical body. Two
    // different caps on one string is how a re-file becomes a collision.
    const reason = String(rawReason || "").slice(0, STOP_REASON_CAP);
    const last = lastOf(mine());
    if (last) attempts = attempts.map((e) => (e === last ? { ...e, stop_reason: reason } : e));
    try {
      await save({ impl_state: state });
    } catch (e) {
      log(`work: ${nodeId} — the ${state} stage could not be stamped (${(e && e.message) || e})`);
    }
    const esc = await escalate({ item, factory, deps, log, state, attempts: mine(), reason });
    return { state, attempts: mine(), reason, ...esc };
  };

  // A settled stage is read back, never re-run (§6.5 (d)). A settled
  // `candidate` hands to the gates; a settled refusal re-files its
  // (idempotent, deterministic-id) escalation and reports itself. A re-gate
  // reopens a refusal to `running` BEFORE it reaches here (cmdWorkRegate), so
  // a settled refusal seen here is a resume of the attempt that settled it.
  const settledState = candidateKernel.implSettled(current.impl_state) ? String(current.impl_state) : null;
  if (settledState === "candidate") return { state: "candidate", attempts: mine(), reason: "the stage already settled a candidate", resumed: true };
  if (settledState === "declined") return { state: "declined", attempts: mine(), reason: current.declined_reason || "the stage already settled declined", resumed: true };
  if (settledState === "exhausted" || settledState === "escalated") {
    const reason = mine().length && lastOf(mine()).stop_reason ? lastOf(mine()).stop_reason : spentReason(settledState).slice(0, STOP_REASON_CAP);
    const esc = await escalate({ item, factory, deps, log, state: settledState, attempts: mine(), reason });
    return { state: settledState, attempts: mine(), reason, resumed: true, ...esc };
  }
  if (settledState) return { state: settledState, attempts: mine(), reason: `the stage already settled ${settledState}`, resumed: true };

  // Attempt 1 of this segment is the run the loop dispatched: reserved on the
  // record's creation write (bin/spor.js claimExecutionHold) for the original
  // pipeline, or — on a record whose claim predates the ledger, and for every
  // re-gate — reserved here, exactly as if it had been. A re-gate re-judges
  // that same run under its new key (the tree may have been fixed by hand).
  if (!mine().length) {
    // A fresh segment supersedes reservations that never launched. Retain
    // settled history and every run still owed a classification; the adoption
    // guard above already prevents abandoning a launched attempt.
    if (key) attempts = attempts.filter((e) => gates.implAttemptKey(e) >= key || gates.implAttemptSettled(e) || e.run_id);
    attempts = gates.reserveImplAttempt(attempts, { index: 1, attempt: key, runId: item.run_id, startedAt: current.started_at || null });
    if (key) {
      try {
        await save({ impl_attempt: 1, impl_state: "running" });
      } catch (e) {
        return stop("escalated", `the implementation ledger could not be stamped for the re-gate (${(e && e.message) || e})`);
      }
    }
  }

  for (let iteration = 0; iteration < STAGE_ITERATION_CAP; iteration += 1) {
    const entry = lastOf(mine());
    if (!entry) return { state: "interrupted", attempts: mine(), reason: "the implementation ledger is empty" };

    // 1. A PENDING entry is a launch owed a classification: attempt 1 is the
    //    record the loop harvested (already terminal — that is why we are
    //    here); any later one is adopted by name if it launched, else launched.
    if (!gates.implAttemptSettled(entry)) {
      let runRecord = null;
      let unfollowable = null;
      if (Number(entry.index) === 1) {
        runRecord = current;
      } else {
        if (stopping()) return { state: "interrupted", attempts: mine(), reason: `the worker was asked to stop before implementation attempt ${entry.index} was dispatched` };
        const prior = mine().filter((e) => Number(e.index) < Number(entry.index));
        const name = implRunName(item.run_id, key, entry.index);
        let launched = null;
        try {
          launched = await deps.implement({
            item,
            attempt: entry.index,
            of: gates.executionPoolCap(impl, "implementation"),
            name,
            prior: prior.map((e) => ({ index: e.index, run_id: e.run_id, outcome: e.outcome, reason: e.reason || null })),
            dirty: !!(prior.length && prior[prior.length - 1].dirty),
            // Charged at LAUNCH, not merely decided on: the run id lands on
            // the reservation the moment the launcher knows it, so a worker
            // killed during the long wait leaves a record that names the run.
            onLaunch: async ({ runId }) => {
              attempts = attempts.map((e) => (Number(e.index) === Number(entry.index) && gates.implAttemptKey(e) === key ? { ...e, run_id: runId || e.run_id, started_at: e.started_at || iso() } : e));
              await save({ impl_attempt: entry.index, impl_state: "running" });
            },
          });
        } catch (e) {
          launched = { ok: false, reason: `the implementer could not be dispatched: ${(e && e.message) || e}` };
        }
        if (!launched || !launched.ok) {
          // Refused before any run record (§4.2 I2, §5.3): a refusal is not
          // an attempt. The reservation is withdrawn — it spent nothing — and
          // the stage reports `unroutable`; the caller clears the hold (T1:
          // nothing is judging the item) and the loop cools it.
          const reason = (launched && launched.reason) || "the implementer could not be dispatched";
          attempts = attempts.filter((e) => !(Number(e.index) === Number(entry.index) && gates.implAttemptKey(e) === key));
          try {
            await save({ impl_state: "unroutable" });
          } catch (e) {
            log(`work: ${nodeId} — the withdrawn reservation could not be stamped (${(e && e.message) || e})`);
          }
          log(`work: ${nodeId} — implementation attempt ${entry.index} could not be dispatched (${reason}); unroutable, nothing spent`);
          return { state: "unroutable", attempts: mine(), reason, classification: launched && launched.classification ? launched.classification : gates.classifyExecutionOutcome(null, reason) };
        }
        if (launched.adopted) log(`work: implementation attempt ${entry.index} on ${nodeId} was already launched as run ${String(launched.runId).slice(0, 8)} — adopting it, not dispatching again`);
        runRecord = launched.record || null;
        // A run this box could not FOLLOW to its end — the launcher's own
        // deadline, or the poll's watchdog giving up on it — is not evidence
        // it stopped: an agent may still hold the checkout, and re-dispatching
        // another into it is the one thing a pull worker must not do. It is
        // settled `cancelled` (the attempt is used) and the stage stops for a
        // person, never re-dispatches (the same rule the loop's watchdog
        // cooldown keeps).
        if (!runRecord || launched.unfollowable) {
          unfollowable = launched.reason || (runRecord && runRecord.terminal_note) || `implementation attempt ${entry.index} did not reach a terminal state while this worker followed it`;
          runRecord = runRecord || { run_id: launched.runId, state: "unknown", termination_class: "idle", termination_signal: "unfollowed" };
        }
      }

      // 2. CLASSIFY (§5.3): the one shared classifier first; a run that ended
      //    cleanly is then judged on what it produced.
      const cls = unfollowable ? { outcome: "cancelled", pool: "implementation", reason: unfollowable } : gates.classifyExecutionOutcome(runRecord);
      let outcome;
      let reason = cls.reason;
      let handoff = null;
      let dirty = false;
      if (cls.outcome === "completed") {
        const product = await judgeProduct({ item, factory, record: runRecord, deps, log });
        outcome = product.outcome;
        reason = product.handoff || product.reason || cls.reason;
        handoff = product.handoff || null;
        dirty = !!product.dirty;
      } else if (cls.outcome === "unroutable") {
        // Cannot happen with a record present, but never let an unknown word
        // charge the unbounded pool.
        outcome = "failed";
      } else {
        outcome = cls.outcome;
      }
      // 3. SETTLE: outcome and pool in one stamp, refused if already settled.
      const settled = gates.settleImplAttempt(attempts, {
        index: entry.index, attempt: key, runId: (runRecord && runRecord.run_id) || entry.run_id || null, outcome, reason, finishedAt: iso(),
        extra: { ...(dirty ? { dirty: true } : {}), ...(handoff ? { handoff } : {}), ...(unfollowable ? { unfollowed: true } : {}) },
      });
      if (!settled.settled) {
        log(`work: ${nodeId} — implementation attempt ${entry.index} was not re-settled (${settled.reason})`);
      } else {
        attempts = settled.attempts;
        try {
          await save({ impl_attempt: entry.index });
        } catch (e) {
          // (a): the settle did not land. On disk the entry reads `pending`
          // and the caps read it as unspent — and on a live worker nothing
          // comes back for it. So: no dispatch on a charge nobody recorded,
          // and a person is told rather than the item parked.
          log(`work: ${nodeId} — implementation attempt ${entry.index} settled ${outcome} but the ledger could not be stamped (${(e && e.message) || e})`);
          return stop("escalated", `the implementation ledger could not be stamped after attempt ${entry.index} settled ${outcome} (${(e && e.message) || e}) — the stage stops rather than act on a charge nobody recorded`);
        }
        log(`work: ${nodeId} — implementation attempt ${entry.index} ${outcome}${cls.outcome !== "completed" && cls.pool ? ` (${cls.pool} pool)` : ""}: ${reason || "no reason"}`);
      }
      if (unfollowable) return stop("escalated", `implementation attempt ${entry.index} (run ${String((runRecord && runRecord.run_id) || "?").slice(0, 8)}) could not be followed to its end — ${unfollowable}; something may still be running in its checkout, so no further attempt is dispatched`);
    }

    // 4. DECIDE on the settled entry (§4.2 I3-I11).
    const settledEntry = lastOf(mine());
    const decision = gates.implAttemptDecision(impl, settledEntry.outcome, {
      implementationSpent: gates.implAttemptsSpent(attempts, "implementation", { attempt: key }),
      retrySpent: pools.retry.spent,
    });
    if (decision.action === "candidate") {
      return { state: "candidate", attempts: mine(), reason: settledEntry.reason || "a candidate was produced", ...(settledEntry.handoff ? { handoff: settledEntry.handoff } : {}) };
    }
    if (decision.action === "declined") {
      try {
        await save({ impl_state: "declined" });
      } catch (e) {
        log(`work: ${nodeId} — the declined stage could not be stamped (${(e && e.message) || e})`);
      }
      return { state: "declined", attempts: mine(), reason: settledEntry.reason || "the implementer declined the item" };
    }
    if (decision.action === "mismatch") return stop("mismatch", settledEntry.reason || "the candidate's evidence did not verify");
    if (decision.action === "retry") {
      const nextIndex = Number(settledEntry.index) + 1;
      let backoffMs = 0;
      if (decision.pool === "retry") {
        // OWE BEFORE YOU CLEAR, in this order: the charge (so an uncounted
        // retry is never taken), then the RESERVATION (so a stop or a crash
        // during the wait leaves a pending entry the resume launches rather
        // than a charge with nothing behind it), then the wait.
        const charged = await chargeRetry({ item, factory, deps, log, pools });
        if (!charged.ok) {
          if (charged.stop) return { state: "interrupted", attempts: mine(), reason: charged.reason };
          return stop("escalated", charged.reason);
        }
        pools = charged.pools;
        backoffMs = Math.max(0, Number(impl.retry && impl.retry.backoffMs) || 0);
        log(
          `work: implementation attempt ${settledEntry.index} on ${nodeId} hit an outage (${settledEntry.reason || "no reason"}) — infrastructure retry ${pools.retry.spent}/${charged.cap}` +
            `${backoffMs ? ` after ${Math.round(backoffMs / 1000)}s` : ""}, no implementation attempt charged`
        );
      } else if (stopping()) {
        return { state: "interrupted", attempts: mine(), reason: "the worker was asked to stop before the next implementation attempt was dispatched — the budget still has headroom" };
      }
      attempts = gates.reserveImplAttempt(attempts, { index: nextIndex, attempt: key, startedAt: iso() });
      try {
        await save({ impl_attempt: nextIndex, impl_state: "running" });
      } catch (e) {
        attempts = attempts.filter((e2) => !(Number(e2.index) === nextIndex && gates.implAttemptKey(e2) === key));
        log(`work: ${nodeId} — implementation attempt ${nextIndex} could not be reserved on the ledger (${(e && e.message) || e}); not dispatching an unrecorded attempt`);
        return stop("escalated", `the implementation ledger could not be stamped before attempt ${nextIndex} (${(e && e.message) || e}) — the stage stops rather than dispatch an unrecorded attempt`);
      }
      if (backoffMs > 0 && !(await waitBackoff({ deps, backoffMs }))) {
        return { state: "interrupted", attempts: mine(), reason: `the worker was asked to stop during the retry backoff — attempt ${nextIndex} is reserved and a resume launches it` };
      }
      log(`work: ${nodeId} — re-dispatching the implementer (attempt ${nextIndex} of ${gates.executionPoolCap(impl, "implementation")}${decision.pool === "retry" ? ", on the infrastructure retry pool" : ""})`);
      continue;
    }
    // exhausted / escalated: the pool the outcome names is spent.
    const state = decision.action === "escalated" ? "escalated" : "exhausted";
    return stop(state, spentReason(state));
  }
  return stop("escalated", `the implementation stage on ${nodeId} exceeded ${STAGE_ITERATION_CAP} iterations without settling — its ledger is left as it stands`);
}

// File the `requires: [human]` escalation that `blocks` the item (§4.2 I8,
// I11, M1). Idempotent by deterministic id (the dep's), so a resumed or
// re-entered stage re-files the same node and never a second one. A write
// that fails leaves `escalation_failed` on the result, plus the replayable
// payload the bounded escalation auto-retry re-files from — the caller
// reports it exactly as a gate refusal whose escalation did not land.
async function escalate({ item, factory, deps, log, state, attempts, reason }) {
  const payload = { stage: "implementation", state, attempt: item.attempt, attempts: (attempts || []).map((e) => ({ ...e })), reason: String(reason || "").slice(0, STOP_REASON_CAP) };
  if (!deps.escalateStage) return { escalated_to: null, escalation_failed: true, escalation_retry: payload };
  try {
    const r = await deps.escalateStage({ item, factory, state, attempts: payload.attempts, reason: payload.reason });
    if (r && r.ok && r.id) {
      log(`work: ${item.node_id} — implementation stage ${state} (${reason}); escalated to ${r.id}`);
      return { escalated_to: r.id };
    }
    log(`work: ${item.node_id} — implementation stage ${state}, but the escalation could not be filed (${(r && r.reason) || "no response"})`);
  } catch (e) {
    log(`work: ${item.node_id} — implementation stage ${state}, but the escalation could not be filed (${(e && e.message) || e})`);
  }
  return { escalated_to: null, escalation_failed: true, escalation_retry: payload };
}

module.exports = {
  runImplementationStage,
  judgeProduct,
  implRunName,
  STAGE_ITERATION_CAP,
};
