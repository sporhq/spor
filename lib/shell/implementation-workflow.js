// shell/implementation-workflow.js — the IMPLEMENTATION STAGE as ONE
// deterministic workflow function over the replay kernel
// (lib/kernel/workflow.js; task-spor-implementation-stage-as-workflow-function,
// the third per-stage slice of task-spor-gate-pipeline-as-workflow-kernel
// under dec-spor-gate-pipeline-durable-workflow-model-zero-dep-kernel-first,
// following the integration stage's pattern in integration-workflow.js).
//
// What changed and what did not. implementation-stage.js's
// runImplementationStage used to BE the control flow: a loop over deps calls
// whose memory (the ledger, the pool counts, which attempt is in flight) lived
// in local variables a crash threw away, so a killed worker's resume re-read
// the ledger from the run record and leaned on each dep's own idempotency
// (adopt-by-name for a re-dispatch, a settle refused twice, a deterministic
// escalation id) to not double anything. Every rule the runner enforced is
// kept — the existing stage suite in test/gate-pipeline.test.js drives this
// function unchanged — but it is now a function of (input, journal):
//
//   - every deps call is `ctx.run(key, activity, args)`, journaled under a
//     key derived from the ids the stage already mints (the run id, the
//     segment's attempt key, the entry's index), so a resumed worker replays
//     the recorded RESULT and never re-executes a step that landed;
//   - the re-dispatch's run-terminal wait is a SIGNAL (`run:<id>`) when the
//     deps wire the two halves (`dispatchImplement` + `awaitRun`; the one-shot
//     `implement` is their composition, gate-deps.js tags it): the launch is
//     journaled with the run it started, the run id is stamped on the ledger's
//     reservation, and the workflow suspends on the run's terminal state — a
//     worker that died mid-attempt resumes awaiting the SAME run, never
//     dispatching a second implementer into one checkout (the journal holds
//     the run id before the await, and the dispatch door is adopt-by-name
//     underneath, dec-spor-adopt-by-name-returns-existing);
//   - the retry pool's backoff is a DURABLE TIMER (`sleepUntil`): the wake
//     time is journaled once, and the driver waits it out in-process, sliced
//     so a stop is answered inside the wait exactly as the runner's
//     waitBackoff did — a worker stopped mid-wait hands up the journaled
//     `interrupted` result, and the re-driven workflow continues from the
//     timer (the reservation it paid for is launched, the pool is not charged
//     again) instead of starting over;
//   - a STOP is a journaled read plus a durable YIELD: the `stopping` verdict
//     is an activity (so live and replayed runs branch alike), and a `true`
//     journals the interrupted result and suspends on a short timer. The
//     driver hands that result up exactly as before, so the work loop's
//     bounded re-offer is still the scheduler; what the journal adds is that
//     the re-driven workflow re-asks under a NEW key and goes on, never
//     replaying the stop verdict forever;
//   - the clock is journaled (`ctx.now`): a replayed ledger entry carries the
//     timestamps it was first settled under, and a rebuilt result is
//     byte-identical.
//
// What stays bespoke is the ACTIVITIES table at the bottom: each is a side
// effect on the run record, the graph or a harness, and each must be
// idempotent under its key, because the kernel records a result once but the
// effect is at-least-once (a crash between executing and journaling re-runs
// it): a ledger stamp re-applied is the same ledger, a settle is refused
// twice by the kernel, a dispatch is adopted by name, an escalation is a
// deterministic id written if_exists: skip.
//
// Determinism rules this file holds to, so that live and replayed runs take
// the same branch:
//   - every decision reads journaled data only — the activities' results, the
//     journaled clock, and the journaled INPUT (`open`: the harvested run
//     record, the deps the caller wired, the implementation block judged
//     under), never `Date.now()`, a live `typeof deps.x`, or the live factory;
//   - every activity result is JSON-plain (the binding round-trips it), so a
//     live result and its replay are the same value — the run RECORD is
//     journaled as a VIEW (`recordView`: the fields the classifier, the
//     no-code claim and the stage read), not the whole file, since the
//     pipeline's own record carries the gate ledger and would bloat every
//     journal;
//   - a log line is a NON-journaled side effect held to the live portion of a
//     run (`ctx.isReplaying()`), never re-emitted on resume;
//   - a kernel control throw (a suspend, a replay fault) passes through every
//     try/catch UNTOUCHED (`isControlFlow`): a journaled step taken on the
//     way out of a suspend would land out of order and poison the next resume.
//
// The DEFINITION this attempt judges under is BOUND, and a change to it fails
// CLOSED, exactly as the integration stage's is: the `open` activity journals
// a digest of the factory's `implementation` block and its `trustedRef` — the
// two inputs the activities behind this workflow read LIVE (the lane's
// profile and instructions, the record's budget stamp, the escalation's cap
// text, the tree read's base) — and a resume whose live digest differs throws
// `NonDeterminism` (tagged `definitionMismatch`) before the first step this
// execution would EXECUTE rather than replay — a journal that already holds
// the attempt's settled result replays to it whatever the live definition
// reads, since the stage is re-entered at the front of the pipeline on every
// orphan resume.
// The driver then TOMBSTONES the journal and settles the attempt as
// `escalated` outside it (the ledger stamped, the `requires:[human]` item
// filed under the ids the attempt would have minted), never a dispatch or a
// candidate under a mixed definition; a journal recorded by another
// WORKFLOW_VERSION is settled the same way, and a resume of a tombstoned
// journal re-settles the same refusal from the recorded detail. The door back
// is a fresh attempt (`spor work --regate <run>`), which opens its own journal
// under the current definition.
"use strict";

const gates = require("../kernel/gates.js");
const candidateKernel = require("../kernel/candidate.js");
const { Execution, isControlFlow } = require("../kernel/workflow.js");
const { shortRunAttempt } = require("./gate-runner.js");
const stageWorkflow = require("./stage-workflow.js");
const { plain } = stageWorkflow;

const WORKFLOW_NAME = "implementation";
const WORKFLOW_VERSION = "1";

// A hard ceiling on loop iterations, independent of the declared pools: the
// pools bound the DISPATCHES (≤ 3 code + 3 retry), and this only guarantees
// that a ledger no client wrote — a hand-edited record, a newer client's
// vocabulary — cannot spin.
const STAGE_ITERATION_CAP = 8;

// How finely the driver slices the backoff timer's in-process wait, so a
// worker asked to stop is answered inside it — the same shape
// gate-runner.js's spendOutage uses.
const BACKOFF_SLICE_MS = 1000;

// The one cap on a refusal's reason (the ledger's `stop_reason`, the
// escalation body, the retry payload) — the same bound a gate escalation's
// evidence keeps.
const STOP_REASON_CAP = 3000;

// A stop yield's timer. The yield exists to hand the slot back — the
// interrupted result is reported and the work loop re-offers the pipeline on
// its own retry window — so the timer only has to be past by the time any
// re-drive arrives, never to pace it (integration-workflow.js's YIELD_MS).
const YIELD_MS = 1000;

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

// The run-record fields this stage reads — through the shared classifier
// (kernel/gates.js classifyExecutionOutcome + infrastructureReading +
// recordResetAt), the no-code claim (bin/spor.js gateRunReportText reads
// `report_path`), and the stage's own settled-state readback. A record is
// journaled as this VIEW, never whole: the pipeline's own record (attempt 1)
// carries the gate ledger and the candidate chain, which nothing here reads.
const RECORD_VIEW_FIELDS = Object.freeze([
  "run_id", "node_id", "state", "terminal_state", "termination_class", "termination_signal", "termination_reason",
  "termination_reset_hint", "termination_utc_offset_min", "terminal_unreachable", "terminal_enforced", "terminal_note",
  "declined_reason", "started_at", "finished_at", "report_path",
  "impl_state", "impl_attempt", "impl_stop_reason",
]);

function recordView(record) {
  if (!isPlainObject(record)) return null;
  const out = {};
  for (const k of RECORD_VIEW_FIELDS) if (record[k] !== undefined) out[k] = record[k];
  return plain(out);
}

// The definition binding: what a resumed attempt must still be judging under
// — the implementation block (budget, retry, candidate, profile,
// instructions, author checks) and the trusted ref the tree read judges
// against. Hashed over the canonical JSON (gates.definitionDigest), so key
// order and an absent-vs-null field never read as an edit.
function definitionBindingDigest(factory) {
  const f = factory || {};
  return gates.definitionDigest({ implementation: f.implementation || null, trustedRef: f.trustedRef || null });
}

// The fail-closed throw (stage-workflow.js definitionMismatchError): a
// NonDeterminism tagged so the driver can tell it from a genuine key-sequence
// fault and settle the attempt.
const STAGE_WHAT = "its implementation block or trusted ref";
function definitionMismatchError({ nodeId, runId, journaled, live }) {
  return stageWorkflow.definitionMismatchError({ stage: "implementation", what: STAGE_WHAT, nodeId, runId, journaled, live });
}

// Which of the optional deps the caller wired — journaled as part of the
// input so a replay branches exactly as the live run did, whatever the deps
// object looks like on the resuming worker.
function depsShape(deps) {
  const fn = (k) => typeof deps[k] === "function";
  return {
    loadGatePools: fn("loadGatePools"),
    saveGatePools: fn("saveGatePools"),
    commitsLanded: fn("commitsLanded"),
    noCodeClaim: fn("noCodeClaim"),
    escalateStage: fn("escalateStage"),
    // The re-dispatch as launch + signal needs both halves: a launcher that
    // returns the run it started (or adopted) and a driver-side wait that
    // delivers the run's terminal state. A one-shot `implement` WINS over
    // them unless it is their own composition (gate-deps tags it
    // `composedOfSignals`): a caller that overrides `implement` on the real
    // deps means that launcher, not the halves it did not touch.
    implementSignals: fn("dispatchImplement") && fn("awaitRun") && (!fn("implement") || deps.implement.composedOfSignals === true),
  };
}

// The workflow function. `input` is {item, factory, record, deps, log,
// driver}: `record` is the implementer's run record as the loop harvested it,
// `log` the caller's logger (held to the live portion of a run), `driver` a
// side channel the driver reads a yielded result and the timer's MODE from
// (set on every run, live or replayed, from journaled data — so a resumed
// driver that lands on the same timer finds both again).
async function implementationWorkflow(ctx, input) {
  const result = await implementationPass(ctx, input);
  // The journal's CLOSING entry (the settled state), as the gate list and the
  // integration stage write: with it a full replay stays inside the recorded
  // past to its last line, and the projection reads the stage as settled off
  // the journal alone (stage-projection.js projectJournal). A yield never
  // reaches here (the kernel suspends out of the pass).
  await ctx.run([input.item.run_id, "implementation", "settled"].join("/"), "settled", { state: (result && result.state) || null });
  return result;
}

async function implementationPass(ctx, input) {
  const { item } = input;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const K = (...parts) => [runId, "implementation", ...parts].join("/");
  const log = (line) => {
    if (!ctx.isReplaying() && typeof input.log === "function") input.log(line);
  };
  // The journaled INPUT: the harvested record, the deps the caller wired, the
  // pipeline attempt, and the DEFINITION this execution judges under (the
  // implementation block, the trusted ref, and the BINDING digest over the
  // two). Every branch below reads these journaled copies, never the live
  // factory, so the key sequence is a function of the journal — and the
  // binding digest is what makes that honest: a factory edited between a
  // crash and the resume is REFUSED below rather than judged under a journaled
  // block whose activities would run the live one.
  const live = input.factory || {};
  const liveDigest = definitionBindingDigest(live);
  const opened = await ctx.run(K("open"), "open", {
    record: recordView(input.record),
    has: depsShape(input.deps || {}),
    attempt: Math.max(0, Number(item.attempt) || 0),
    implementation: live.implementation || null,
    trustedRef: live.trustedRef || null,
    digest: liveDigest,
  });
  // FAIL CLOSED on a definition edited between attempts — but only at the
  // moment this execution would take a LIVE step. A journal that already
  // holds the attempt's whole story (a settled `candidate` the gates went on
  // from, a refusal) replays to its settled result whatever the live
  // definition reads: the stage sits at the FRONT of the pipeline and is
  // re-entered on every orphan resume, so a check made unconditionally on
  // `open` would turn a prompt-text tweak after the stage settled into a
  // refusal of work that was never in flight. `ctx.isReplaying()` is the
  // kernel's own "still inside the recorded past", so the guard fires exactly
  // when the next activity, clock read, timer or signal would be executed
  // rather than replayed — before the step is journaled, so the WORKFLOW
  // appends nothing under a mixed definition. What the DRIVER then does is
  // terminal: it tombstones the journal and settles the attempt as refused.
  // The shared guard of every stage (stage-workflow.js guardedKernel).
  ctx = stageWorkflow.guardedKernel(ctx, { journaled: opened.digest, live: liveDigest, mismatch: () => definitionMismatchError({ nodeId, runId, journaled: opened.digest, live: liveDigest }) });
  const run = (key, name, args) => ctx.run(key, name, args);
  const now = (key) => ctx.now(key);
  const sleepUntil = (key, at, meta) => {
    ctx.sleepUntil(key, at, meta);
  };
  const awaitSignal = (key, name) => ctx.awaitSignal(key, name);
  const iso = (key) => new Date(now(key)).toISOString();
  // A journaled activity whose failure is the workflow's to handle: the
  // kernel journals a throw and replays it, so a live failure and its replay
  // take the same branch here; a kernel control throw passes through.
  const act = async (key, name, args) => {
    try {
      return { ok: true, value: await run(key, name, args) };
    } catch (e) {
      if (isControlFlow(e)) throw e;
      return { ok: false, error: e, message: `${(e && e.message) || e}` };
    }
  };
  const impl = opened.implementation;
  const has = opened.has || {};
  const trustedRef = opened.trustedRef;
  if (!impl) return { state: "candidate", attempts: [], reason: "no implementation stage is declared", skipped: true };
  let key = opened.attempt;

  // The ledger, read FRESH: the loop's harvested copy predates every stamp a
  // killed worker made before it died.
  let attempts = [];
  let current = opened.record || {};
  const loaded = await act(K("ledger"), "loadImplAttempts", {});
  if (loaded.ok) {
    const l = loaded.value || {};
    attempts = Array.isArray(l.attempts) ? l.attempts : [];
    if (l.record) current = l.record;
  } else {
    log(`work: ${nodeId} — the implementation ledger could not be read (${loaded.message}); starting from the run record`);
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
  const seg = `a${key}`;

  // The shared infrastructure pool (gate-runner.js loads it the same way).
  let pools = { retry: { spent: 0 } };
  if (has.loadGatePools) {
    const p = await act(K("pools"), "loadGatePools", {});
    if (p.ok) {
      const spent = p.value && p.value.retry && Number(p.value.retry.spent);
      if (Number.isFinite(spent) && spent > 0) pools = { retry: { spent: Math.floor(spent) } };
    } else {
      log(`work: the infrastructure retry pool could not be read (${p.message}) — no infrastructure retry will be spent on ${nodeId}`);
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

  // A ledger stamp, journaled under the site that makes it. A copy of the
  // ledger rides the args so the activity reads nothing from this closure.
  const save = (siteKey, patch = {}) => act(siteKey, "saveImplAttempts", { attempts: attempts.map((e) => ({ ...e })), patch });

  // File the `requires: [human]` escalation that `blocks` the item (§4.2 I8,
  // I11, M1). Idempotent by deterministic id (the dep's), so a resumed or
  // re-entered stage re-files the same node and never a second one. A write
  // that fails leaves `escalation_failed` on the result, plus the replayable
  // payload the bounded escalation auto-retry re-files from — the caller
  // reports it exactly as a gate refusal whose escalation did not land.
  const escalate = async (state, atts, reason) => {
    const payload = { stage: "implementation", state, attempt: item.attempt, attempts: (atts || []).map((e) => ({ ...e })), reason: String(reason || "").slice(0, STOP_REASON_CAP) };
    if (!has.escalateStage) return { escalated_to: null, escalation_failed: true, escalation_retry: payload };
    const r = await act(K("escalate", state), "escalateStage", { state, attempts: payload.attempts, reason: payload.reason });
    if (r.ok && r.value && r.value.ok && r.value.id) {
      log(`work: ${nodeId} — implementation stage ${state} (${reason}); escalated to ${r.value.id}`);
      return { escalated_to: r.value.id };
    }
    log(`work: ${nodeId} — implementation stage ${state}, but the escalation could not be filed (${r.ok ? (r.value && r.value.reason) || "no response" : r.message})`);
    return { escalated_to: null, escalation_failed: true, escalation_retry: payload };
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
    // With no entry to carry it (an empty segment), the reason rides the
    // record instead, so a resume re-files the byte-identical body.
    const s = await save(K("stop", state), { impl_state: state, ...(last ? {} : { impl_stop_reason: reason }) });
    if (!s.ok) log(`work: ${nodeId} — the ${state} stage could not be stamped (${s.message})`);
    const esc = await escalate(state, mine(), reason);
    return { state, attempts: mine(), reason, ...esc };
  };

  // A STOP, asked and answered through the journal. The verdict is an
  // activity, so a replay branches as the live run did; a `true` hands the
  // interrupted result up (journaled, so a driver re-landing on the unfired
  // timer finds it) and SUSPENDS on a short timer. The re-driven workflow
  // lands past the timer and asks again under the next key — so a stop is
  // never replayed as a verdict, and a worker that is no longer stopping
  // goes on from exactly here.
  const pauseIfStopping = async (site, reason) => {
    for (let n = 0; ; n += 1) {
      const s = await run(K(...site, "stop", n), "stopping", {});
      if (!s || !s.stopping) return;
      // The parked result and the wait's MODE ride the Suspend's `meta` (the
      // kernel's channel for live driver data), not a side slot on the input.
      const parked = await run(K(...site, "yield", n), "yield", { state: "interrupted", attempts: mine(), reason });
      const at = now(K(...site, "pause", n));
      sleepUntil(K(...site, "sleep", n), at + YIELD_MS, { parked, mode: "stop" });
    }
  };

  // Charge one retry on the SHARED infrastructure pool. Returns the new pool
  // counts, or the REASON the charge may not be taken — which is not
  // decoration: "the pool is spent", "no pool is declared" and "the charge
  // could not land" end the stage identically and send a person to three
  // different places.
  const chargeRetry = async (nextIndex) => {
    const cap = gates.executionPoolCap(impl, "retry");
    if (cap <= 0 || !has.saveGatePools) return { ok: false, reason: "this factory declares no infrastructure retry pool (`implementation.retry.attempts`), so the outage was not waited out" };
    if (gates.executionPoolHeadroom(impl, "retry", pools.retry.spent) <= 0) return { ok: false, reason: `the pipeline's shared infrastructure retry pool is spent (${pools.retry.spent}/${cap})` };
    await pauseIfStopping([seg, `i${nextIndex}`, "charge"], "the worker was asked to stop before the retry was taken — the pool still has headroom");
    const next = { retry: { spent: pools.retry.spent + 1 } };
    const charged = await act(K(seg, `i${nextIndex}`, "charge"), "saveGatePools", { pools: next });
    if (!charged.ok) {
      log(`work: the infrastructure retry could not be charged (${charged.message}) — the implementation stage stops on ${nodeId} rather than retrying uncharged`);
      return { ok: false, reason: "the retry could not be charged durably, and an uncounted retry is an unbounded one" };
    }
    return { ok: true, pools: next, cap };
  };

  // What a run that ended CLEANLY produced (§4.2 I3-I5): read the tree the
  // same way the gates will (`changedPaths` — merge-base..HEAD in the run's
  // own checkout, tracked-dirty refused). Returns the attempt OUTCOME, or a
  // `handoff` — a reading this stage does not settle itself but leaves to the
  // pipeline's own deterministic routes, which run before any gate and can
  // only ever remove a wrong refusal:
  //   - an empty diff whose item's recorded commits already LANDED on the
  //     trusted ref (the stale-premise route, WORKERS.md §10.11's sibling);
  //   - an empty diff the run DECLARED as a no-code outcome (`SCOPED:`, §10.11)
  //     — verified there against the graph, whichever way it comes out. The
  //     claim is read from THIS attempt's run (`record`), not the pipeline's
  //     first: a re-dispatched implementer may be the one that scoped it;
  //   - a dirty tree the factory tolerates (`require_clean: false`): the
  //     pipeline's commit-or-discard round-trip is the declared remedy;
  //   - a checkout that is GONE (superseded by hand while nobody watched — the
  //     pipeline's own check) or a tree that could not be read at all (the
  //     gates fail closed on it; re-dispatching an implementer into a checkout
  //     this box cannot read would only spend an attempt at the same
  //     unreadable tree).
  const judgeProduct = async (A, record) => {
    const read = await act(A("tree"), "changedPaths", { trustedRef });
    const r = read.ok ? read.value : { ok: false, reason: `the change under judgement could not be read: ${read.message}` };
    if (r && r.ok) {
      const paths = Array.isArray(r.paths) ? r.paths : [];
      if (paths.length) return { outcome: "candidate", reason: `${paths.length} path(s) changed past ${trustedRef} at ${String(r.head || "").slice(0, 12)}` };
      // An EMPTY diff. Before it is read as "no candidate", the two readings
      // the pipeline settles deterministically get their chance — both are
      // evidence that predates or accompanies the run, and both are cheap.
      if (has.commitsLanded) {
        const landed = await act(A("landed"), "commitsLanded", { trustedRef });
        if (!landed.ok) log(`work: ${nodeId} — its recorded commits could not be checked against ${trustedRef} (${landed.message})`);
        const verdict = gates.verifyStalePremise({ nodeId, commitsLanded: landed.ok ? landed.value : null });
        if (verdict.ok) return { outcome: "candidate", handoff: `the item's recorded commits already land on ${trustedRef} — the pipeline's stale-premise route settles it` };
      }
      if (has.noCodeClaim) {
        const claim = await act(A("claim"), "noCodeClaim", { record });
        if (!claim.ok) log(`work: ${nodeId} — its final report could not be read for a no-code outcome (${claim.message})`);
        if (claim.ok && claim.value) return { outcome: "candidate", handoff: "the run declared a no-code outcome — the pipeline verifies the claim against the graph" };
      }
      return { outcome: "no-candidate", reason: `the run ended cleanly but committed nothing past ${trustedRef} in its checkout` };
    }
    const reason = (r && r.reason) || "the change under judgement could not be read";
    if (r && r.dirty) {
      if (impl.candidate && impl.candidate.requireClean === false) {
        return { outcome: "candidate", handoff: `the tree is dirty and the factory tolerates it (require_clean: false) — the pipeline's commit-or-discard round-trip judges it` };
      }
      // The dirty-tree round-trip under `require_clean` (I4): a code outcome,
      // re-dispatched at the same run.
      return { outcome: "failed", dirty: true, reason };
    }
    if (r && r.gone) return { outcome: "candidate", handoff: `${reason} — the pipeline's superseded check reads it` };
    return { outcome: "candidate", handoff: `${reason} — the gates fail closed on it` };
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
    const reason = mine().length && lastOf(mine()).stop_reason
      ? lastOf(mine()).stop_reason
      : !mine().length && current.impl_stop_reason
      ? String(current.impl_stop_reason).slice(0, STOP_REASON_CAP)
      : spentReason(settledState).slice(0, STOP_REASON_CAP);
    const esc = await escalate(settledState, mine(), reason);
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
    attempts = gates.reserveImplAttempt(attempts, { index: 1, attempt: key, runId: runId, startedAt: current.started_at || null });
    if (key) {
      const s = await save(K(seg, "i1", "reserve"), { impl_attempt: 1, impl_state: "running" });
      if (!s.ok) return stop("escalated", `the implementation ledger could not be stamped for the re-gate (${s.message})`);
    }
  }

  for (let iteration = 0; iteration < STAGE_ITERATION_CAP; iteration += 1) {
    const entry = lastOf(mine());
    // No stop was asked for, so this is not an interruption a resume could
    // pick up: the segment reserved above is gone, and re-offering the
    // pipeline would find the same empty ledger every time
    // (task-spor-work-loop-parked-reoffer-cap). Settle it as a refusal.
    if (!entry) return stop("escalated", "the implementation ledger holds no attempt for this segment, so there is nothing to classify or re-dispatch");
    const idx = Number(entry.index);
    const A = (...parts) => K(seg, `i${idx}`, ...parts);

    // 1. A PENDING entry is a launch owed a classification: attempt 1 is the
    //    record the loop harvested (already terminal — that is why we are
    //    here); any later one is adopted by name if it launched, else launched.
    if (!gates.implAttemptSettled(entry)) {
      let runRecord = null;
      let unfollowable = null;
      if (idx === 1) {
        runRecord = current;
      } else {
        await pauseIfStopping([seg, `i${idx}`, "dispatch"], `the worker was asked to stop before implementation attempt ${idx} was dispatched`);
        const prior = mine().filter((e) => Number(e.index) < idx);
        const name = implRunName(runId, key, idx);
        const launchArgs = {
          attempt: idx,
          of: gates.executionPoolCap(impl, "implementation"),
          name,
          prior: prior.map((e) => ({ index: e.index, run_id: e.run_id, outcome: e.outcome, reason: e.reason || null })),
          dirty: !!(prior.length && prior[prior.length - 1].dirty),
        };
        // Charged at LAUNCH, not merely decided on: the run id lands on the
        // reservation the moment the launcher knows it, so a worker killed
        // during the long wait leaves a record that names the run.
        const startedAt = iso(A("launch-at"));
        const stampLaunch = (launchedRunId) => {
          attempts = attempts.map((e) => (Number(e.index) === idx && gates.implAttemptKey(e) === key ? { ...e, run_id: launchedRunId || e.run_id, started_at: e.started_at || startedAt } : e));
        };
        let launched = null;
        if (has.implementSignals) {
          // The launch half: journaled with the run it started (or adopted),
          // the run id stamped on the reservation, then the terminal state
          // awaited as a SIGNAL — a worker that dies here resumes awaiting
          // the SAME run.
          const d = await act(A("dispatch"), "dispatchImplement", launchArgs);
          launched = d.ok ? d.value : { ok: false, reason: `the implementer could not be dispatched: ${d.message}` };
          if (launched && launched.ok && launched.runId) {
            stampLaunch(launched.runId);
            const s = await save(A("launched"), { impl_attempt: idx, impl_state: "running" });
            if (!s.ok) log(`warning: implementation attempt ${idx}'s launch could not be recorded on the ledger (${s.message})`);
            const ended = awaitSignal(A("ended"), `run:${launched.runId}`);
            const p = (ended && ended.payload) || {};
            launched = {
              ok: true, runId: launched.runId, adopted: !!launched.adopted, record: p.record || null,
              ...(!p.ok || p.unfollowable ? { unfollowable: true, reason: p.reason || null } : {}),
              ...(p.classification ? { classification: p.classification } : {}),
            };
          }
        } else {
          // The one-shot launcher: dispatch, stamp the run id through its own
          // `onLaunch` (the binding builds it from the ledger copy in the
          // args), await the run — one journaled result.
          const d = await act(A("implement"), "implement", { ...launchArgs, attempts: attempts.map((e) => ({ ...e })), reservation: { index: idx, attempt: key }, startedAt, patch: { impl_attempt: idx, impl_state: "running" } });
          launched = d.ok ? d.value : { ok: false, reason: `the implementer could not be dispatched: ${d.message}` };
          if (launched && launched.ok && launched.runId) stampLaunch(launched.runId);
        }
        if (!launched || !launched.ok) {
          // Refused before any run record (§4.2 I2, §5.3): a refusal is not
          // an attempt. The reservation is withdrawn — it spent nothing — and
          // the stage reports `unroutable`; the caller clears the hold (T1:
          // nothing is judging the item) and the loop cools it.
          const reason = (launched && launched.reason) || "the implementer could not be dispatched";
          attempts = attempts.filter((e) => !(Number(e.index) === idx && gates.implAttemptKey(e) === key));
          const s = await save(A("unroutable"), { impl_state: "unroutable" });
          if (!s.ok) log(`work: ${nodeId} — the withdrawn reservation could not be stamped (${s.message})`);
          log(`work: ${nodeId} — implementation attempt ${idx} could not be dispatched (${reason}); unroutable, nothing spent`);
          return { state: "unroutable", attempts: mine(), reason, classification: launched && launched.classification ? launched.classification : gates.classifyExecutionOutcome(null, reason) };
        }
        if (launched.adopted) log(`work: implementation attempt ${idx} on ${nodeId} was already launched as run ${String(launched.runId).slice(0, 8)} — adopting it, not dispatching again`);
        runRecord = launched.record || null;
        // A run this box could not FOLLOW to its end — the launcher's own
        // deadline, or the poll's watchdog giving up on it — is not evidence
        // it stopped: an agent may still hold the checkout, and re-dispatching
        // another into it is the one thing a pull worker must not do. It is
        // settled `cancelled` (the attempt is used) and the stage stops for a
        // person, never re-dispatches (the same rule the loop's watchdog
        // cooldown keeps).
        if (!runRecord || launched.unfollowable) {
          unfollowable = launched.reason || (runRecord && runRecord.terminal_note) || `implementation attempt ${idx} did not reach a terminal state while this worker followed it`;
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
        const product = await judgeProduct(A, runRecord);
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
        index: idx, attempt: key, runId: (runRecord && runRecord.run_id) || entry.run_id || null, outcome, reason, finishedAt: iso(A("finished")),
        extra: { ...(dirty ? { dirty: true } : {}), ...(handoff ? { handoff } : {}), ...(unfollowable ? { unfollowed: true } : {}) },
      });
      if (!settled.settled) {
        log(`work: ${nodeId} — implementation attempt ${idx} was not re-settled (${settled.reason})`);
      } else {
        attempts = settled.attempts;
        const s = await save(A("settle"), { impl_attempt: idx });
        if (!s.ok) {
          // (a): the settle did not land. On disk the entry reads `pending`
          // and the caps read it as unspent — and on a live worker nothing
          // comes back for it. So: no dispatch on a charge nobody recorded,
          // and a person is told rather than the item parked.
          log(`work: ${nodeId} — implementation attempt ${idx} settled ${outcome} but the ledger could not be stamped (${s.message})`);
          return stop("escalated", `the implementation ledger could not be stamped after attempt ${idx} settled ${outcome} (${s.message}) — the stage stops rather than act on a charge nobody recorded`);
        }
        log(`work: ${nodeId} — implementation attempt ${idx} ${outcome}${cls.outcome !== "completed" && cls.pool ? ` (${cls.pool} pool)` : ""}: ${reason || "no reason"}`);
      }
      if (unfollowable) return stop("escalated", `implementation attempt ${idx} (run ${String((runRecord && runRecord.run_id) || "?").slice(0, 8)}) could not be followed to its end — ${unfollowable}; something may still be running in its checkout, so no further attempt is dispatched`);
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
      const s = await save(A("declined"), { impl_state: "declined" });
      if (!s.ok) log(`work: ${nodeId} — the declined stage could not be stamped (${s.message})`);
      return { state: "declined", attempts: mine(), reason: settledEntry.reason || "the implementer declined the item" };
    }
    if (decision.action === "mismatch") return stop("mismatch", settledEntry.reason || "the candidate's evidence did not verify");
    if (decision.action === "retry") {
      const nextIndex = idx + 1;
      const N = (...parts) => K(seg, `i${nextIndex}`, ...parts);
      let backoffMs = 0;
      if (decision.pool === "retry") {
        // OWE BEFORE YOU CLEAR, in this order: the charge (so an uncounted
        // retry is never taken), then the RESERVATION (so a stop or a crash
        // during the wait leaves a pending entry the resume launches rather
        // than a charge with nothing behind it), then the wait.
        const charged = await chargeRetry(nextIndex);
        if (!charged.ok) return stop("escalated", charged.reason);
        pools = charged.pools;
        backoffMs = Math.max(0, Number(impl.retry && impl.retry.backoffMs) || 0);
        log(
          `work: implementation attempt ${idx} on ${nodeId} hit an outage (${settledEntry.reason || "no reason"}) — infrastructure retry ${pools.retry.spent}/${charged.cap}` +
            `${backoffMs ? ` after ${Math.round(backoffMs / 1000)}s` : ""}, no implementation attempt charged`
        );
      } else {
        await pauseIfStopping([seg, `i${nextIndex}`, "next"], "the worker was asked to stop before the next implementation attempt was dispatched — the budget still has headroom");
      }
      attempts = gates.reserveImplAttempt(attempts, { index: nextIndex, attempt: key, startedAt: iso(N("reserved-at")) });
      const s = await save(N("reserve"), { impl_attempt: nextIndex, impl_state: "running" });
      if (!s.ok) {
        attempts = attempts.filter((e2) => !(Number(e2.index) === nextIndex && gates.implAttemptKey(e2) === key));
        log(`work: ${nodeId} — implementation attempt ${nextIndex} could not be reserved on the ledger (${s.message}); not dispatching an unrecorded attempt`);
        return stop("escalated", `the implementation ledger could not be stamped before attempt ${nextIndex} (${s.message}) — the stage stops rather than dispatch an unrecorded attempt`);
      }
      if (backoffMs > 0) {
        // The backoff as a DURABLE TIMER: the wake time is journaled once;
        // the driver waits it out in-process (sliced, so a stop is answered
        // inside it) and hands up the journaled interrupted result on a
        // stop. A re-drive lands past the timer and continues to the launch
        // — the reservation it paid for, never a second charge.
        const stopReason = `the worker was asked to stop during the retry backoff — attempt ${nextIndex} is reserved and a resume launches it`;
        const parked = await run(N("backoff-parked"), "yield", { state: "interrupted", attempts: mine(), reason: stopReason });
        const at = now(N("backoff-at"));
        sleepUntil(N("backoff"), at + backoffMs, { parked, mode: "backoff" });
        await pauseIfStopping([seg, `i${nextIndex}`, "backoff"], stopReason);
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

// Bind the stage's deps to the kernel's activities table. Every result is
// JSON-plain; the run record comes back as its VIEW. `item` rides into the
// deps calls that take it (the ledger and pool stamps, the no-code claim),
// as the runner passed it.
function bindImplementationActivities(deps, { item } = {}) {
  const activities = {
    // The journaled input and the journaled yield result: identity activities.
    // The journal's creation stamp rides the open RESULT (journaled once,
    // replayed thereafter), so a reader orders two re-gate children of one
    // attempt by when they were opened, never by a file's mtime
    // (stage-projection.js stageJournals).
    open: (args) => ({ ...plain(args), opened_at: new Date().toISOString() }),
    yield: (args) => plain(args),
    settled: (args) => plain(args),
    stopping: () => ({ stopping: !!(deps.stopping && deps.stopping()) }),
    loadImplAttempts: async () => {
      const r = (await deps.loadImplAttempts({ item })) || {};
      return plain({ attempts: Array.isArray(r.attempts) ? r.attempts : [], record: recordView(r.record) });
    },
    saveImplAttempts: async ({ attempts, patch }) => {
      await deps.saveImplAttempts({ item, attempts, patch });
      return { ok: true };
    },
    loadGatePools: async () => plain(await deps.loadGatePools({ item })),
    saveGatePools: async ({ pools }) => {
      await deps.saveGatePools({ item, pools });
      return { ok: true };
    },
    changedPaths: async ({ trustedRef }) => plain(await deps.changedPaths({ trustedRef })),
    commitsLanded: async ({ trustedRef }) => plain(await deps.commitsLanded({ trustedRef })),
    noCodeClaim: async ({ record }) => plain(await deps.noCodeClaim({ item, record })),
    // The one-shot launcher. Its `onLaunch` is rebuilt HERE from the ledger
    // copy and the reservation the workflow passes in the args (a callback
    // cannot be journaled), stamping the run id onto the reservation the
    // moment the launcher knows it — exactly what the runner's closure did.
    implement: async ({ attempts, reservation, startedAt, patch, ...rest }) => {
      const onLaunch = async ({ runId }) => {
        const stamped = (attempts || []).map((e) => (reservation && Number(e.index) === Number(reservation.index) && gates.implAttemptKey(e) === reservation.attempt ? { ...e, run_id: runId || e.run_id, started_at: e.started_at || startedAt } : e));
        await deps.saveImplAttempts({ item, attempts: stamped, patch });
      };
      const r = (await deps.implement({ ...rest, onLaunch })) || {};
      const { record, ...out } = r;
      return plain({ ...out, record: recordView(record) });
    },
    // The launch half of `implement`: {ok, runId, adopted, reason?,
    // classification?}; the run's terminal state arrives as signal run:<id>.
    dispatchImplement: async (args) => {
      const r = (await deps.dispatchImplement(args)) || {};
      const { record, ...rest } = r;
      return plain(rest);
    },
    escalateStage: async (args) => plain(await deps.escalateStage(args)),
  };
  return { activities };
}

// The ACTIVITIES — what stays bespoke under the kernel. Each is a side effect
// on the run record, the graph or a harness; the kernel journals its RESULT
// once, and the activity makes the EFFECT idempotent under its key.
// Documentation and the test's checklist, in one table.
const IMPLEMENTATION_ACTIVITIES = Object.freeze([
  ["open", "identity: the journaled input (the harvested record's view, wired deps, attempt, the implementation block judged under and its binding digest — a resume whose live digest differs fails closed)"],
  ["yield", "identity: the journaled interrupted result handed up before a durable yield (a stop, or the backoff timer)"],
  ["settled", "identity: the journaled closing entry (the settled state), so a full replay stays inside the recorded past to its last line"],
  ["stopping", "the worker's stop flag, read once per ask so live and replayed runs branch alike"],
  ["loadImplAttempts", "the run record's impl_attempts[] ledger (+ the record's view), read fresh; a read"],
  ["saveImplAttempts", "stamp the ledger (+ impl_state/impl_attempt) onto the run record; the same ledger re-stamped is the same record"],
  ["loadGatePools", "the pipeline's shared gate_progress.pools; a read"],
  ["saveGatePools", "charge the shared infrastructure retry pool; re-applied under its key it writes the same count"],
  ["changedPaths", "git: merge-base..HEAD in the run's own checkout, tracked-dirty refused; a read"],
  ["commitsLanded", "git: are the item's recorded commits reachable from the trusted ref; a read"],
  ["noCodeClaim", "the run's final report parsed for a SCOPED: claim; a read"],
  ["implement", "the one-shot launcher: spor dispatch --force --no-worktree into the run's checkout, ADOPTED BY NAME, run id stamped on the reservation, then await the run's terminal state"],
  ["dispatchImplement", "the launch half of `implement`: returns the run it started or adopted; the terminal state arrives as signal run:<id>"],
  ["escalateStage", "the requires:[human] item that blocks the work item under a deterministic id; if_exists: skip"],
  // signals and timers, not activities — what the workflow awaits:
  ["signal run:<id>", "a re-dispatched implementer's terminal state (its record's view), delivered by the driver"],
  ["timer backoff", "the retry pool's declared backoff, waited out in-process by the driver (sliced for a stop)"],
  ["timer stop", "the durable yield behind a stop: the interrupted result is handed up and the re-drive asks again"],
]);

// The DRIVER: runImplementationStage's contract over the workflow. Builds the
// Execution over the caller's journal handle (`deps.workflowJournal`, a
// function returning {journal, persist} — lib/shell/execution-store.js's
// openWorkflowJournal — or absent, which runs the stage over an in-memory
// journal exactly as before the kernel existed), drives it to a settled
// state, and maps the kernel's outcomes back to the stage's results:
//   completed              -> the workflow's result, as the runner returned it
//   suspended on the       -> wait it out in-process, sliced on deps.sleep and
//     backoff timer           answered by deps.stopping — a stop hands up the
//                             journaled `interrupted` result
//   suspended on a stop    -> the journaled `interrupted` result (the yield)
//   suspended on run:<id>  -> deliver the run's terminal state (deps.awaitRun)
//                             and run again — in-process, so the slot is held
//                             exactly as the one-shot launcher held it
//   failed                 -> rethrown, as a thrown dep threw out of the runner
// A journal whose persist poisoned the Execution is re-opened and re-driven
// (bounded): the kernel's own contract is that memory never runs ahead of
// disk, and a fresh handle holds whatever truly landed.
async function driveImplementationStage({ item, factory, record, deps, log = () => {} }) {
  // A factory that declares no `implementation:` block never enters the
  // workflow — the caller gates on it — so the shipped pipeline is
  // byte-identical (no journal is opened, nothing is read).
  if (!factory || !factory.implementation) return { state: "candidate", attempts: [], reason: "no implementation stage is declared", skipped: true };
  const { activities } = bindImplementationActivities(deps, { item });
  const input = { item, factory, record, deps, log };
  const clock = { now: typeof deps.now === "function" ? deps.now : () => Date.now() };
  const stopping = () => !!(deps.stopping && deps.stopping());
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const openHandle = typeof deps.workflowJournal === "function" ? deps.workflowJournal : null;
  const exec = () => {
    const handle = openHandle ? openHandle() : null;
    return new Execution(implementationWorkflow, input, {
      journal: handle && Array.isArray(handle.journal) ? handle.journal : [],
      persist: handle && typeof handle.persist === "function" ? handle.persist : null,
      clock,
      activities,
      workflow: WORKFLOW_NAME,
      version: WORKFLOW_VERSION,
    });
  };
  const build = (error) => refusalRecord({ item, error, clock });
  const settle = (refusal, { replayed }) => settleRefusal({ item, deps, log, refusal, replayed });
  return stageWorkflow.driveStage({
    label: "implementation",
    nodeId: item.node_id,
    log,
    open: exec,
    reopenable: !!openHandle,
    // The journal was already closed by a refusal (this worker's or a
    // predecessor's): re-settled from the recorded tombstone. The attempt
    // cannot be continued by this worker (the definition it opened under
    // changed, or the journal was recorded by another version): tombstoned,
    // then settled as refused, outside it. Anything else rethrows.
    onFailed: (error, e) => stageWorkflow.settleOrRefuse(error, e, { item, build, settle }),
    onSuspended: async (r, e) => {
      if (r.kind === "timer") {
        const meta = (r.detail && r.detail.meta) || {};
        if (meta.mode === "backoff") {
          // Wait out the declared backoff, sliced so a stop is answered inside
          // it. A stop hands up the journaled interrupted result; the timer
          // stays journaled, and the re-drive continues from it.
          const fireAt = Number(r.detail && r.detail.fireAt) || 0;
          let stopped = false;
          while (clock.now() < fireAt) {
            if (stopping()) {
              stopped = true;
              break;
            }
            await sleep(Math.min(BACKOFF_SLICE_MS, fireAt - clock.now()));
          }
          if (stopped || stopping()) return { result: meta.parked || interruptedAt(item, r.detail.fireAt) };
          return undefined;
        }
        return { result: meta.parked || interruptedAt(item, r.detail.fireAt) };
      }
      const m = /^run:(.+)$/.exec(String(r.detail && r.detail.name));
      if (!m || typeof deps.awaitRun !== "function") throw new Error(`the implementation workflow suspended on signal '${r.detail && r.detail.name}' with no way to deliver it`);
      let done = null;
      try {
        done = await deps.awaitRun({ runId: m[1], lane: "implement" });
      } catch (err) {
        done = { ok: false, reason: `${(err && err.message) || err}` };
      }
      e.signal(r.detail.name, {
        ok: !!(done && done.ok),
        record: recordView(done && done.record),
        reason: (done && done.reason) || null,
        ...(done && done.unfollowable ? { unfollowable: true } : {}),
      });
      return undefined;
    },
  });
}

function interruptedAt(item, fireAt) {
  const at = new Date(Number(fireAt) || 0).toISOString();
  return { state: "interrupted", attempts: [], reason: `the implementation stage on ${item.node_id} is yielded until ${at} and resumes on the next pass`, paused_until: at };
}

// The refusal RECORD a tombstone carries and a settle reads: WHY (the
// mismatch, or the version), the clock, and the pipeline attempt — nothing
// the settle needs is read from the live factory.
function refusalRecord({ item, error, clock }) {
  return stageWorkflow.refusalRecord({ stage: "implementation", what: STAGE_WHAT, verb: "dispatched", item, error, clock });
}

// A tombstone with NO record on it (the driver always writes one; only a
// hand-written tombstone lacks it): rebuilt from the item, honestly tagged by
// the tombstone's own `reason`, with the detail saying the record was missing.
function recordlessRefusal({ item, entry, clock }) {
  return refusalRecord({ item, error: stageWorkflow.recordlessError({ item, entry }), clock });
}

// Settle an unresumable attempt as REFUSED, outside the journal: the stage's
// `escalated` door — the segment's last entry carries the reason (or the
// record does, for an empty segment), `impl_state: escalated` is stamped, and
// the `requires:[human]` item is filed under the deterministic id the attempt
// would have minted — reading only the refusal record and the ledger as it
// stands on disk. Every write is idempotent and best-effort, so a crash
// between the tombstone and this settle is re-settled on the next attempt
// (`replayed`), and a factory reverted after the refusal can never continue
// the attempt. The door back is a fresh attempt (`spor work --regate <run>`).
async function settleRefusal({ item, deps, log, refusal, replayed = false }) {
  const nodeId = item.node_id;
  const key = Math.max(0, Number(refusal.attempt) || 0);
  const reason = String(refusal.detail || "").slice(0, STOP_REASON_CAP);
  const fn = (k) => typeof deps[k] === "function";
  let attempts = [];
  try {
    const loaded = fn("loadImplAttempts") ? await deps.loadImplAttempts({ item }) : null;
    attempts = loaded && Array.isArray(loaded.attempts) ? loaded.attempts.map((e) => ({ ...e })) : [];
  } catch (e) {
    log(`work: ${nodeId} — the implementation ledger could not be read while settling the refusal (${(e && e.message) || e})`);
  }
  const mine = () => gates.implAttemptsFor(attempts, key);
  const last = lastOf(mine());
  if (last) attempts = attempts.map((e) => (e === last ? { ...e, stop_reason: reason } : e));
  if (fn("saveImplAttempts")) {
    try {
      await deps.saveImplAttempts({ item, attempts: attempts.map((e) => ({ ...e })), patch: { impl_state: "escalated", ...(last ? {} : { impl_stop_reason: reason }) } });
    } catch (e) {
      log(`work: ${nodeId} — the escalated stage could not be stamped (${(e && e.message) || e})`);
    }
  }
  const payload = { stage: "implementation", state: "escalated", attempt: item.attempt, attempts: mine().map((e) => ({ ...e })), reason };
  let esc = { escalated_to: null, escalation_failed: true, escalation_retry: payload };
  if (fn("escalateStage")) {
    try {
      const r = await deps.escalateStage({ state: "escalated", attempts: payload.attempts, reason });
      if (r && r.ok && r.id) esc = { escalated_to: r.id };
      else log(`work: ${nodeId} — implementation stage escalated, but the escalation could not be filed (${(r && r.reason) || "no response"})`);
    } catch (e) {
      log(`work: ${nodeId} — implementation stage escalated, but the escalation could not be filed (${(e && e.message) || e})`);
    }
  }
  log(`work: ${nodeId} — implementation stage escalated (${reason})${esc.escalated_to ? `; escalated to ${esc.escalated_to}` : ""}${replayed ? " (re-settled from the attempt's refusal tombstone)" : ""}`);
  return {
    state: "escalated", attempts: mine(), reason, ...esc,
    ...stageWorkflow.refusalTags(refusal, { replayed }),
  };
}

// The one-shot composition the driver runs on a fresh refusal: record,
// tombstone, settle. The tombstone is the kernel's own append — persisted
// before it returns, and a persist failure poisons the Execution and THROWS
// here, so a refusal that could not be made durable settles nothing: no
// stamp, no escalation lands over a journal that is still resumable.
async function refuseUnresumable({ item, deps, log, error, clock, exec }) {
  const out = await stageWorkflow.settleOrRefuse(error, exec, {
    item,
    build: (e) => refusalRecord({ item, error: e, clock }),
    settle: (refusal, { replayed }) => settleRefusal({ item, deps, log, refusal, replayed }),
  });
  if (!out) throw error;
  return out.result;
}

module.exports = {
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  STAGE_ITERATION_CAP,
  BACKOFF_SLICE_MS,
  STOP_REASON_CAP,
  YIELD_MS,
  RECORD_VIEW_FIELDS,
  IMPLEMENTATION_ACTIVITIES,
  recordView,
  depsShape,
  definitionBindingDigest,
  implRunName,
  implementationWorkflow,
  bindImplementationActivities,
  driveImplementationStage,
  refusalRecord,
  recordlessRefusal,
  refuseUnresumable,
  settleRefusal,
};
