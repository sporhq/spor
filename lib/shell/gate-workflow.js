// shell/gate-workflow.js — the GATE LIST as ONE deterministic workflow function
// over the replay kernel (lib/kernel/workflow.js;
// task-spor-gate-list-as-workflow-function, the second per-stage slice of
// task-spor-gate-pipeline-as-workflow-kernel, following the integration
// stage's pattern — dec-spor-integration-stage-workflow-function-driver-keeps-
// contract).
//
// gate-runner.js's runGatePipeline used to BE the control flow: the candidate
// read, the preflight over owed evidence, the superseded/scoped/no-code
// routes, the dirty-tree round-trip, the gate list with its fix cycles and
// the stateful review ledger, the shared infrastructure pool with its outage
// backoffs and reviewer pauses, the rescue lane, and the escalation — all in
// local variables a crash threw away, so a resumed pipeline re-ran from
// nothing and leaned on `gate_progress`, the rescue state and each dep's own
// idempotency (adopt-by-name, if_exists: skip) to pick up where it stopped.
// The control flow is the SAME here — every rule the runner enforced is kept
// line for line, and the existing gate-pipeline suite drives it unchanged —
// but it is now a function of (input, journal):
//
//   - every deps call is `ctx.run(key, activity, args)`, journaled under a key
//     built from the ids the pipeline already mints (the run id, the attempt,
//     the pass, the gate id, the cycle) plus a per-key sequence, so a resumed
//     worker replays the recorded RESULT and never re-executes a step that
//     landed;
//   - ONE GATE ATTEMPT is one activity (`judge`, gate-runner.js's runOneGate):
//     the suite run, the review dispatch-and-await, the human approval poll
//     are the side effect, and its outcome is what the journal holds;
//   - the fix cycle's and the rescue's run-terminal waits are SIGNALS
//     (`run:<id>`, `rescue-run:<id>`) when the deps wire the dispatch halves
//     (gate-deps.js's `dispatchFix`/`dispatchRescue` + `awaitRun`; the
//     one-shot `fix`/`rescue` are their tagged compositions): the launch is
//     journaled with the run it started, the workflow suspends on the run's
//     terminal state, and a worker that died mid-fix resumes awaiting the
//     SAME run — never dispatching a second (dec-spor-adopt-by-name-returns-
//     existing underneath, as a belt);
//   - the outage backoff and the in-process reviewer wait are DURABLE TIMERS
//     (`sleepUntil`), sliced exactly as the runner sliced them so a stop is
//     still answered inside the wait, and every `interrupted` hand-up — a
//     stop, a reviewer PAUSE (its timer is the pause itself), pending
//     evidence, an unverifiable evidence origin — is a durable YIELD: the
//     result is journaled, the workflow suspends, the driver hands the result
//     up exactly as before (the work loop's re-offer is still the scheduler),
//     and the re-driven workflow continues into a NEW PASS over the same
//     journal instead of replaying the interrupted verdict forever;
//   - the clock is journaled (`ctx.now`): a replayed fact carries the date it
//     was first written under, and a rebuilt result is byte-identical;
//   - a stop request (`deps.stopping`) is a journaled READ: live and replayed
//     runs take the same branch.
//
// What stays bespoke is the ACTIVITIES table at the bottom: each is a side
// effect on git, the graph or a harness, and each must be idempotent under its
// key, because the kernel records a result once but the effect is
// at-least-once (a crash between executing and journaling re-runs it).
//
// Determinism rules this file holds to, so that live and replayed runs take
// the same branch:
//   - every decision reads journaled data only — the activities' results, the
//     journaled clock, and the journaled INPUT (`open`: which deps the caller
//     wired), never `Date.now()`, a live `typeof deps.x` or a live git call;
//   - every activity result is JSON-plain (the binding round-trips it), so a
//     live result and its replay are the same value;
//   - a log line is a NON-journaled side effect held to the live portion of a
//     run (`ctx.isReplaying()`), never re-emitted on resume;
//   - a kernel control throw (a suspend, a replay fault) passes through every
//     try/catch UNTOUCHED (`isControlFlow`): a journaled step taken on the
//     way out of a suspend would land out of order and poison the next resume.
//
// The loop-level resume machinery — `gate_progress`, the rescue state,
// `orphanedGateRuns`, `claimGateRecord`, the parked re-offer — is UNCHANGED
// by this slice (it goes with slice 4): the saves and loads it rides on are
// activities here like every other dep, so a pipeline resumed through the
// journal and one resumed through the record agree.
//
// The DEFINITION this attempt judges under is bound (`open` journals a digest
// over the whole factory), but a change to it is not a refusal here the way it
// is for the integration stage: the gate list's own rules already re-judge a
// moved definition (every fact is definition-bound, a resumed gate whose saved
// definition differs re-runs), so the driver falls back to a FRESH in-memory
// journal — exactly today's resume, through the record — and says so.
"use strict";

const gates = require("../kernel/gates.js");
const candidate = require("../kernel/candidate.js");
const { Execution, isControlFlow } = require("../kernel/workflow.js");
const gateRunner = require("./gate-runner.js");
const stageWorkflow = require("./stage-workflow.js");
const { plain } = stageWorkflow;

const WORKFLOW_NAME = "gates";
const WORKFLOW_VERSION = "1";

// A yield's timer when the interrupted result names no wake of its own: the
// yield exists to hand the slot back — the work loop re-offers the pipeline on
// its own retry window — so the timer only has to be past by the time any
// re-drive arrives, never to pace it. A reviewer PAUSE names its wake
// (`paused_until`), and that IS the timer.
const YIELD_MS = 1000;

const { OUTAGE_BACKOFF_SLICE_MS, REVIEWER_PAUSE_PARK_MS, EMPTY_DIFF_NO_RESCUE_WHY, FLAKE_EDGE } = gateRunner;
// Why an unfollowable fix cycle is never rescued (the `noRescueWhy` the
// escalation line prints): the rescue lane dispatches into the run's own
// checkout, which the unfollowed fixer may still hold.
const UNFOLLOWABLE_FIX_NO_RESCUE_WHY = "after a fix run this worker could not follow to its end — the fixer may still hold the checkout a rescue would be dispatched into";

function definitionBindingDigest(factory) {
  return gates.definitionDigest(factory || null);
}

// The fail-closed throw (stage-workflow.js definitionMismatchError): the whole
// factory definition is the gate list's binding.
function definitionMismatchError({ nodeId, runId, journaled, live }) {
  return stageWorkflow.definitionMismatchError({ stage: "gate", subject: "gate pipeline", nodeId, runId, journaled, live });
}

// Which of the optional deps the caller wired — journaled as part of the input
// so a replay branches exactly as the live run did, whatever the deps object
// looks like on the resuming worker.
function depsShape(deps) {
  const fn = (k) => typeof deps[k] === "function";
  return {
    checkEvidenceOrigins: fn("checkEvidenceOrigins"),
    pinCandidate: fn("pinCandidate"),
    demote: fn("demote"),
    readFact: fn("readFact"),
    linkFact: fn("linkFact"),
    evidenceOrigin: fn("evidenceOrigin"),
    gateEvidenceRecorded: fn("gateEvidenceRecorded"),
    acceptsEvidenceOrigin: fn("acceptsEvidenceOrigin"),
    saveCarriedProgress: fn("saveCarriedProgress"),
    saveGateProgress: fn("saveGateProgress"),
    loadGateProgress: fn("loadGateProgress"),
    loadGatePools: fn("loadGatePools"),
    saveGatePools: fn("saveGatePools"),
    stampReviewerCooldown: fn("stampReviewerCooldown"),
    reviewerIndependence: fn("reviewerIndependence"),
    stopping: fn("stopping"),
    retainedHeadIsAncestor: fn("retainedHeadIsAncestor"),
    loadRescueState: fn("loadRescueState"),
    saveRescueState: fn("saveRescueState"),
    premature: fn("premature"),
    resolved: fn("resolved"),
    landed: fn("landed"),
    commitsLanded: fn("commitsLanded"),
    noCodeClaim: fn("noCodeClaim"),
    node: fn("node"),
    fix: fn("fix"),
    rescue: fn("rescue"),
    // The fix cycle as dispatch + signal needs both halves: a launcher that
    // returns the run it started (or adopted) and a driver-side wait that
    // delivers the run's terminal state. A one-shot `fix` WINS over them
    // unless it is their own composition (gate-deps tags it
    // `composedOfSignals`): a caller that overrides `fix` on the real deps
    // means that fix, not the halves it did not touch. Same for the rescue.
    fixSignals: fn("dispatchFix") && fn("awaitRun") && (!fn("fix") || deps.fix.composedOfSignals === true),
    rescueSignals: fn("dispatchRescue") && fn("awaitRun") && fn("rescueReport") && (!fn("rescue") || deps.rescue.composedOfSignals === true),
  };
}

// The workflow function. `input` is {item, factory, deps, log, driver}: `log`
// is the caller's logger (held to the live portion of a run), `driver` a side
// channel the driver reads a yielded result from.
async function gateWorkflow(ctx, input) {
  const { item, factory } = input;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const attempt = item.attempt || 0;
  // One PASS over the pipeline per epoch: a yield ends an epoch, and the
  // re-driven workflow runs the next one over fresh keys.
  let epoch = 0;
  const seq = new Map();
  const K = (...parts) => {
    const base = [runId, "gates", `a${attempt}`, `e${epoch}`, ...parts.filter((p) => p != null && p !== "")].join("/");
    const n = (seq.get(base) || 0) + 1;
    seq.set(base, n);
    return `${base}#${n}`;
  };
  const act = (name, args, ...scope) => ctx.run(K(...scope, name), name, args);
  const now = (...scope) => ctx.now(K(...scope, "now"));
  const log = (line) => {
    if (!ctx.isReplaying() && typeof input.log === "function") input.log(line);
  };

  const liveDigest = definitionBindingDigest(factory);
  const opened = await ctx.run(K("open"), "open", { has: depsShape(input.deps || {}), attempt, digest: liveDigest, factoryId: factory.id || null });
  // The definition binding, enforced only before a LIVE kernel step — the
  // shared rule of every stage (stage-workflow.js guardedKernel): a journal
  // that already holds the pipeline's whole story replays to its result
  // whatever the live factory reads; one parked mid-pipeline refuses before
  // its next activity, clock read, timer or signal wait is journaled. The
  // driver then judges afresh (see `driveGatePipeline`). `act`/`now` above
  // close over `ctx`, so rebinding it here guards them too.
  ctx = stageWorkflow.guardedKernel(ctx, { journaled: opened.digest, live: liveDigest, mismatch: () => definitionMismatchError({ nodeId, runId, journaled: opened.digest, live: liveDigest }) });
  const has = opened.has;

  for (;; epoch += 1) {
    input.driver.parked = null;
    const result = await gatePass({ ctx, input, has, K, act, now, log });
    if (result.state !== "interrupted") return result;
    // The durable YIELD: the result is journaled, the driver hands it up, and
    // the re-drive continues into the next pass once the timer is past — a
    // reviewer pause's own wake, else the short yield.
    const parked = await act("yield", result, "yield");
    input.driver.parked = parked;
    const at = now("yield");
    const pausedUntil = parked && parked.paused_until ? (typeof parked.paused_until === "number" ? parked.paused_until : Date.parse(parked.paused_until)) : NaN;
    ctx.sleepUntil(K("yield", "timer"), Number.isFinite(pausedUntil) && pausedUntil > at + YIELD_MS ? pausedUntil : at + YIELD_MS);
  }
}

// ONE pass over the whole pipeline — runGatePipeline's body, deps calls
// journaled. Returns the pipeline's result (an `interrupted` one is yielded by
// the caller).
async function gatePass({ ctx, input, has, K, act, now, log }) {
  const { item, factory } = input;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const results = [];
  const facts = [];
  // A deps call that may throw: the failure is journaled and rethrown by the
  // kernel, and the pipeline's own try/catch takes it as it always did — but a
  // kernel control throw must pass through untouched.
  const rethrowControl = (e) => {
    if (isControlFlow(e)) throw e;
  };
  // `deps.acceptsEvidenceOrigin(origin)` as a journaled read; `true` when the
  // caller wired none (the original `deps.x && !deps.x(origin)` reading).
  const accepts = async (origin) => !has.acceptsEvidenceOrigin || !!(await act("acceptsEvidenceOrigin", { origin }, "origin"));
  // `deps.stopping()` as a journaled read.
  const stopping = async () => has.stopping && !!(await act("stopping", {}, "stop"));
  // The PASS's own journaled input: whether this drive is a resumed one (the
  // loop marks an adopted orphan and a parked re-offer `resumed`; the
  // supersession check below keys on it). Journaled per pass, so a pass a
  // later worker CONTINUES keeps the reading its first drive made, and a pass
  // that starts fresh after a yield reads the live flag.
  const pass = await act("pass", { resumed: !!item.resumed }, "pass");
  const resumedDrive = !!(pass && pass.resumed);

  // Enumerate debt and refuse an unrelated graph before any ordinary work.
  let evidencePreflight = null;
  if (has.checkEvidenceOrigins) {
    let origin;
    try { origin = await act("checkEvidenceOrigins", {}, "preflight"); } catch (e) { rethrowControl(e); origin = { ok: false, reason: e.message || String(e) }; }
    if (!origin || !origin.ok) return { state: "interrupted", gates: results, facts, reason: origin && origin.reason || "pending flake evidence origin could not be verified" };
    evidencePreflight = origin;
  }
  let changed = null;
  let changedReason = null;
  let changedHead = null;
  let changedCwd = null;
  let changedDirty = false;
  let changedGone = false;
  let noCodeRefusal = null;

  // RE-PIN the candidate (task-spor-factory-candidate-record, §3.3) — see
  // gate-runner.js for the full account; the pin is fail-soft, except that the
  // SUBMISSION pin is checked against `candidateSubmitted` before gate 0.
  let pinnedCandidate = null;
  let pinFailureReason = null;
  let pinIgnorable = false;
  const pin = async (submittedBy, { runId = null } = {}) => {
    if (!factory.implementation || !has.pinCandidate) return;
    try {
      const r = await act("pinCandidate", { submittedBy, runId }, "pin");
      if (r && r.ok) {
        if (r.change === "refused-settled") {
          pinIgnorable = true;
          return;
        }
        pinnedCandidate = r.candidate || pinnedCandidate;
        pinFailureReason = (r.publish_pending && r.publish_pending.reason) || null;
        if (r.change === "created" || r.change === "superseded") {
          log(`work: pinned candidate ${r.candidate.candidate_id} for ${nodeId} (tree ${String(r.candidate.tree).slice(0, 12)}, ${submittedBy.stage})`);
        }
      } else if (r && r.reason) {
        pinFailureReason = r.reason;
        log(`work: no candidate could be pinned for ${nodeId} (${r.reason}) — the tree is judged regardless`);
      }
    } catch (e) {
      rethrowControl(e);
      pinFailureReason = (e && e.message) || String(e);
      log(`work: no candidate could be pinned for ${nodeId} (${(e && e.message) || e}) — the tree is judged regardless`);
    }
  };
  let change = null;

  // The diff under judgement, read once and refreshed after every fix cycle.
  const readChanged = async (submittedBy = { stage: "implementation", cycle: 0, rescue: 0 }, pinOpts = {}) => {
    changedDirty = false;
    changedGone = false;
    try {
      const r = await act("changedPaths", { trustedRef: factory.trustedRef }, "changed");
      if (r && r.ok) {
        changed = r.paths || [];
        changedHead = r.head || null;
        changedCwd = r.cwd || null;
        change = { head: r.head || null, base: r.base || null, trustedRef: r.trustedRef || factory.trustedRef, trustedSha: r.trustedSha || null, branch: r.branch || null };
        changedReason = null;
        await pin(submittedBy, pinOpts);
        return true;
      }
      changedReason = (r && r.reason) || "the change under judgement could not be read";
      changedDirty = !!(r && r.dirty);
      changedGone = !!(r && r.gone);
    } catch (e) {
      rethrowControl(e);
      changedReason = `the change under judgement could not be read: ${(e && e.message) || e}`;
    }
    changed = null;
    changedCwd = null;
    change = null;
    return false;
  };
  // The graph-state half of a refusal (§10.7): only ever with a blocker id.
  const demote = async (gate, { state, blockerId }) => {
    if (!has.demote) return { demoted: false, note: null, reason: null };
    let r = null;
    try {
      r = await act("demote", { item, gate, state, blockerId: blockerId || null }, "demote", gate.id);
    } catch (e) {
      rethrowControl(e);
      r = { ok: false, reason: `${(e && e.message) || e}` };
    }
    if (r && r.ok) return { demoted: !!r.demoted, note: r.note || null, reason: null };
    const reason = (r && r.reason) || "no response";
    log(`work: gate ${gate.id} refused ${nodeId}, but the item could not be demoted on the graph (${reason}) — the verdict still stands`);
    return { demoted: false, note: null, reason };
  };

  // An `existing` fact the write door cannot vouch for is reconciled by a READ
  // (F10): is the occupant this record, and which owed occurrence edges are on it.
  const reconcileExisting = async (gate, id, markdown, owed, origin) => {
    let seen = null;
    try {
      seen = has.readFact ? await act("readFact", { id, markdown, nodeId, gate, flakeIssues: owed, origin }, "readFact") : { ok: false, reason: "this worker has no door to read it back through" };
    } catch (e) {
      rethrowControl(e);
      seen = { ok: false, reason: `${(e && e.message) || e}` };
    }
    if (!seen || !seen.ok) {
      log(
        `work: gate ${gate.id}'s fact ${id} was already on the graph and could not be read back (${(seen && seen.reason) || "no response"}) — ` +
          `this verdict is not reported as recorded${owed.length ? `, and the occurrence of ${owed.join(", ")} stays owed rather than assumed recorded` : ""}`
      );
      return { id: null, linked: [] };
    }
    if (!seen.same) {
      log(
        `work: gate ${gate.id}'s fact id ${id} is occupied by a different record — this markdown did not land, so the verdict stands but is not on the graph` +
          (owed.length ? `; the occurrence of ${owed.join(", ")} stays owed` : "")
      );
      return { id: null, linked: [] };
    }
    const edges = Array.isArray(seen.edges) ? seen.edges : [];
    const family = (id) => String(id).replace(/-r[2-4]$/, "");
    const hasEdge = (issue) => edges.some((e) => e && family(e.to) === family(issue) && String((e && e.type) || "") === FLAKE_EDGE);
    const paid = owed.filter(hasEdge);
    if (paid.length < owed.length) {
      log(
        `work: gate ${gate.id}'s fact ${id} was already on the graph without ${owed.filter((i) => !hasEdge(i)).join(", ")} on it — ` +
          "that occurrence is still owed an edge"
      );
    }
    return { id, linked: paid };
  };

  // Pay what the fact could not carry (F13), through the idempotent add_edge door.
  const payFlakeEdges = async (gate, id, unpaid, flake, origin) => {
    if (!has.linkFact) return [];
    const paid = [];
    for (const issue of unpaid) {
      let r = null;
      try {
        r = await act("linkFact", { id, type: FLAKE_EDGE, to: issue, nodeId, gate, file: (flake.files || [])[gateRunner.flakeIssues(flake).indexOf(issue)], files: flake.files || [], origin }, "linkFact");
      } catch (e) {
        rethrowControl(e);
        r = { ok: false, reason: `${(e && e.message) || e}` };
      }
      if (r && r.ok) {
        paid.push(issue);
        log(`work: the occurrence of ${issue} was linked onto ${id} directly — the fact's own write had found the id already taken`);
      } else {
        log(`work: the occurrence of ${issue} could not be linked onto ${id} (${(r && r.reason) || "no response"}) — it stays owed, for the next fact of this refusal to pay`);
      }
    }
    return paid;
  };

  let pipelineEvidenceOrigin = null;
  try { pipelineEvidenceOrigin = has.evidenceOrigin ? await act("evidenceOrigin", {}, "origin") : null; } catch (e) { rethrowControl(e); /* a filing refuses below if its origin cannot be verified */ }
  const reportedEvidence = new Set();
  const reportEvidence = async (gate, outcome, { fact, candidate_id = null, head = null, rescue = 0 } = {}) => {
    if (!fact || !has.gateEvidenceRecorded) return;
    const key = JSON.stringify([gate.id, rescue, fact, candidate_id, head]);
    if (reportedEvidence.has(key)) return;
    try {
      const reported = await act("gateEvidenceRecorded", { gate, verdict: outcome.verdict, fact, candidate_id, head, rescue }, "evidence", gate.id);
      if (reported && (reported.ok || reported.deferred)) reportedEvidence.add(key);
    } catch (e) { rethrowControl(e); log(`work: gate ${gate.id} completed evidence could not be reported (${e.message || e})`); }
  };
  const restoreResult = (result) => {
    const matches = (r) => r.gate === result.gate && (r.rescue || 0) === (result.rescue || 0);
    const index = results.findIndex(matches);
    if (index < 0) { results.push({ ...result }); return; }
    results[index] = { ...result };
    for (let i = results.length - 1; i > index; i--) if (matches(results[i])) results.splice(i, 1);
  };

  // The gate's durable memory across fix cycles AND worker processes
  // (gate_progress) — optional deps, fail-soft.
  const loadProgress = async (gate, rescue = 0) => {
    if (!has.loadGateProgress) return null;
    try {
      const p = await act("loadGateProgress", { gate, item, ...(rescue ? { rescue } : {}) }, "progress", gate.id);
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      rethrowControl(e);
      log(`work: gate ${gate.id} progress could not be read (${(e && e.message) || e}) — starting the gate from cycle 0`);
      return null;
    }
  };
  const passProgress = new Map();
  const preAttempts = new Map();
  const preAttemptsOf = (rescue = 0) => preAttempts.get(Number(rescue) || 0) || [];
  const shownAttempts = (gate, attempts, rescue = 0) => (preAttemptsOf(rescue).length && gate.id === factory.gates[0].id ? [...preAttemptsOf(rescue), ...attempts] : attempts);
  // The first gate's saves carry the dirty-tree round-trip so a later save of
  // the ledger never drops the record that it was spent.
  const withPre = (gate, progress, rescue = 0) => {
    const pre = preAttemptsOf(rescue);
    return pre.length && gate.id === factory.gates[0].id && !progress.preAttempts ? { ...progress, preAttempts: pre } : progress;
  };
  const saveProgress = async (gate, progress, rescue = 0) => {
    passProgress.set(`${rescue}:${gate.id}`, JSON.parse(JSON.stringify(progress)));
    if (!has.saveGateProgress) return;
    try {
      await act("saveGateProgress", { gate, item, progress: withPre(gate, progress, rescue), ...(rescue ? { rescue } : {}) }, "progress", gate.id);
    } catch (e) {
      rethrowControl(e);
      log(`work: gate ${gate.id} progress could not be saved (${(e && e.message) || e}) — a resumed pipeline would restart this gate`);
    }
  };

  // Takes the gate's OUTCOME object whole and the per-site extras — see
  // gate-runner.js `gateFactFields`. `carried` replays an obligation an EARLIER
  // attempt owes (task-spor-gate-regate-obligation-semantics).
  const record = async (gate, outcome, extras = {}, evidenceChange = change, evidenceDefinition = factory.definition || null, origin = pipelineEvidenceOrigin, evidenceCandidateId = pinnedCandidate && pinnedCandidate.candidate_id || null, continuation = null, carried = null) => {
    const fields = gateRunner.gateFactFields(outcome, extras);
    const { verdict, detail, escalatedTo, rescue, flake } = fields;
    let factId = null;
    let linked = [];
    const owed = gateRunner.flakeEdges(flake);
    if (gateRunner.flakeIssues(flake).length && !(await accepts(origin))) return { id: null, linked: [], pending: true };
    // Write the obligation BEFORE attempting graph publication.
    const persistEvidence = async (paid, receipt = null) => {
      if (!flake && !gateRunner.flakeIssues(flake).length) return true;
      const key = carried ? `carried:${carried.carryKey}` : `${rescue || 0}:${gate.id}`;
      const previous = passProgress.get(key) || (carried ? null : await loadProgress(gate, rescue || 0)) || {};
      const { filingIntent: consumedIntent, ...rest } = previous;
      const progress = { ...rest, evidence: { outcome: fields, payment_receipts: paid, change: evidenceChange, definition: evidenceDefinition, gate, origin, candidate_id: evidenceCandidateId, ...(continuation ? { continuation } : {}), ...(receipt || {}) } };
      try {
        if (carried) {
          if (!has.saveCarriedProgress) throw new Error("this pipeline cannot write a carried obligation's receipt");
          await act("saveCarriedProgress", { carryKey: carried.carryKey, progress }, "carried");
        } else if (has.saveGateProgress) await act("saveGateProgress", { gate, item, progress, ...(rescue ? { rescue } : {}) }, "progress", gate.id);
        passProgress.set(key, JSON.parse(JSON.stringify(progress)));
        return true;
      } catch (e) {
        rethrowControl(e);
        log(`work: gate ${gate.id} occurrence evidence could not be saved (${e.message || e}) — publication waits for a resumable record`);
        return false;
      }
    };
    if (!await persistEvidence(flake)) return { id: null, linked: [], pending: true };
    try {
      const fact = gateRunner.buildGateFact({
        ...fields,
        gate, nodeId, runId, project: item.project || null,
        date: new Date(now("record", gate.id)).toISOString().slice(0, 10),
        factory: factory.id,
        attempt: carried ? carried.attempt : item.attempt || 0,
        change: evidenceChange,
        definition: evidenceDefinition,
      });
      const wrote = await act("recordFact", { id: fact.id, markdown: fact.markdown, nodeId, gate, verdict, flakeIssues: owed, origin, candidate_id: evidenceCandidateId, head: evidenceChange && evidenceChange.head || null, ...(rescue ? { rescue } : {}) }, "fact", gate.id);
      if (wrote && (wrote.ok || wrote.existing)) {
        if (wrote.ok && (!wrote.existing || wrote.identical)) {
          factId = fact.id;
          linked = Array.isArray(wrote.linked) ? wrote.linked.filter((id) => owed.includes(id)) : owed;
        } else {
          const seen = await reconcileExisting(gate, fact.id, fact.markdown, owed, origin);
          factId = seen.id;
          linked = seen.linked;
        }
        const unpaid = owed.filter((i) => !linked.includes(i));
        if (factId && unpaid.length) linked = [...linked, ...(await payFlakeEdges(gate, factId, unpaid, flake, origin))];
      } else log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      rethrowControl(e);
      log(`work: gate ${gate.id} outcome could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
    if (factId) facts.push(factId);
    const defGate = evidenceDefinition && Array.isArray(evidenceDefinition.gates) ? evidenceDefinition.gates.find((g) => g.id === gate.id) : null;
    const finishedAt = now("record", gate.id);
    results.push({ gate: gate.id, kind: gate.kind, verdict, detail: detail || null, fact: factId, escalated_to: escalatedTo || null, ...(rescue ? { rescue } : {}),
      ...(fields.reviewer && fields.reviewer.profile ? { reviewer: { ...fields.reviewer } } : {}),
      source: gate.source || "inline", digest: defGate && defGate.digest || null, revision: defGate && defGate.revision || null,
      head: evidenceChange && evidenceChange.head || null, base: evidenceChange && evidenceChange.base || null,
      ...(evidenceCandidateId ? { candidate_id: evidenceCandidateId } : {}),
      cycles: fields.attempts ? fields.attempts.length : 1,
      started_at: fields.startedAt == null ? null : new Date(fields.startedAt).toISOString(), finished_at: new Date(finishedAt).toISOString(),
      duration_ms: fields.startedAt == null ? null : Math.max(0, finishedAt - fields.startedAt),
    });
    const paid = gateRunner.flakePaidBy(flake, { id: factId, linked });
    const persisted = await persistEvidence(paid, { complete: gateRunner.flakeEdges(paid).length === 0, fact: factId, result: results[results.length - 1] });
    const pending = !persisted || gateRunner.flakeEdges(paid).length > 0;
    if (!pending && !carried) await reportEvidence(gate, fields, { fact: factId, candidate_id: evidenceCandidateId, head: evidenceChange && evidenceChange.head || null, rescue: rescue || 0 });
    return { id: factId, linked, pending };
  };

  // --- the shared INFRASTRUCTURE pool (§5.3) — see gate-runner.js ---
  let pools = { retry: { spent: 0 } };
  let routes = {};
  let noVerdicts = {};
  const loadPools = async () => {
    if (!has.loadGatePools) return;
    try {
      const p = await act("loadGatePools", { item }, "pools");
      const spent = p && p.retry && Number(p.retry.spent);
      if (Number.isFinite(spent) && spent > 0) pools = { retry: { spent: Math.floor(spent) } };
      const dueAt = p && p.retry && Number(p.retry.due_at);
      if (pools.retry.spent > 0 && Number.isFinite(dueAt) && dueAt > 0) pools.retry.due_at = dueAt;
      const pausedUntil = p && p.retry && Number(p.retry.paused_until);
      if (Number.isFinite(pausedUntil) && pausedUntil > 0) pools.retry.paused_until = pausedUntil;
      if (p && p.routes && typeof p.routes === "object") routes = { ...p.routes };
      if (p && p.no_verdicts && typeof p.no_verdicts === "object") noVerdicts = { ...p.no_verdicts };
    } catch (e) {
      rethrowControl(e);
      log(`work: the infrastructure retry pool could not be read (${(e && e.message) || e}) — no infrastructure retry will be spent on ${nodeId}`);
      pools = { retry: { spent: gates.executionPoolCap(factory.implementation, "retry"), unreadable: true } };
    }
  };
  await loadPools();

  // Wait until `deadline` as DURABLE TIMERS, sliced so a stop is answered
  // inside the wait rather than at the end of it. `true` once it passes,
  // `{interrupted: reason}` on a stop. Each slice is its own journaled timer:
  // the driver sleeps the slice and re-drives, exactly as the runner slept it.
  const waitUntil = async (deadline, stoppedWhy) => {
    for (;;) {
      if (await stopping()) return { interrupted: stoppedWhy };
      const at = now("wait");
      if (at >= deadline) return true;
      ctx.sleepUntil(K("wait", "timer"), Math.min(at + OUTAGE_BACKOFF_SLICE_MS, deadline));
    }
  };

  // Spend one charge of the infrastructure pool on an OUTAGE — see gate-runner.js.
  const spendOutage = async (gate, outage) => {
    if (!outage || outage.outcome !== "infrastructure") return "waiting cannot help a dispatch this box refused before it started";
    const at = now("outage", gate.id);
    const cap = gates.executionPoolCap(factory.implementation, "retry");
    const review = gate.kind === "agent-review";
    const route = review ? routes[gate.id] || null : null;
    const lane = (route && route.profile) || gate.profile;
    const resetAt = Number(outage.resetAt) > at ? Number(outage.resetAt) : null;
    const pauseMax = Number.isFinite(Number(gate.pauseMaxMs)) ? Number(gate.pauseMaxMs) : gates.GATE_DEFAULTS.reviewerPauseMaxMs;
    const iso = (ms) => new Date(ms).toISOString();
    const dispatched = !outage.cooldown;
    if (review && dispatched && resetAt && has.stampReviewerCooldown) {
      try {
        await act("stampReviewerCooldown", { profile: lane, until: resetAt, at: Number(outage.observedAt) || at, reason: outage.reason || "", run_id: outage.runId || null }, "cooldown", gate.id);
      } catch (e) {
        rethrowControl(e);
        log(`work: the cooldown for ${lane} could not be recorded (${(e && e.message) || e}) — other items will find the outage for themselves`);
      }
    }
    const savePools = async (next, why) => {
      if (!has.saveGatePools) return why;
      try {
        await act("saveGatePools", { item, pools: next }, "pools");
      } catch (e) {
        rethrowControl(e);
        log(`work: the infrastructure retry could not be charged (${(e && e.message) || e}) — ${gate.id} refuses on ${nodeId} rather than retrying uncharged`);
        return why;
      }
      return true;
    };
    if (review && gate.fallbackProfile && lane === gate.profile) {
      noVerdicts = { ...noVerdicts, [gate.id]: (Number(noVerdicts[gate.id]) || 0) + 1 };
      const after = Number(gate.fallbackAfter) || gates.GATE_DEFAULTS.fallbackAfter;
      if (noVerdicts[gate.id] >= after) {
        let independence = null;
        try {
          independence = has.reviewerIndependence
            ? await act("reviewerIndependence", { gate, item, profile: gate.fallbackProfile }, "independence", gate.id)
            : { ok: false, reason: "this worker has no way to read the fallback's model family" };
        } catch (e) {
          rethrowControl(e);
          independence = { ok: false, reason: `its model family could not be read (${(e && e.message) || e})` };
        }
        const headroom = !dispatched || gates.executionPoolHeadroom(factory.implementation, "retry", pools.retry.spent) > 0;
        if (!independence || !independence.ok) {
          log(`work: gate ${gate.id} will not fall back to ${gate.fallbackProfile} on ${nodeId} — ${(independence && independence.reason) || "its independence could not be established"}`);
        } else if (!headroom || (dispatched && cap <= 0)) {
          log(`work: gate ${gate.id} will not fall back to ${gate.fallbackProfile} on ${nodeId} — the shared infrastructure retry pool has no charge left for another reviewer dispatch (${pools.retry.spent}/${cap})`);
        } else {
          const nextRoute = { profile: gate.fallbackProfile, fallback_for: gate.profile, after: noVerdicts[gate.id], ...(independence.family ? { family: independence.family } : {}) };
          const next = {
            retry: dispatched ? { spent: pools.retry.spent + 1, due_at: at, paused_until: 0 } : { paused_until: 0 },
            routes: { ...routes, [gate.id]: nextRoute },
            no_verdicts: noVerdicts,
          };
          const saved = await savePools(next, "the fallback reviewer could not be charged durably, and an uncounted dispatch is an unbounded one");
          if (saved !== true) return saved;
          pools = { retry: { ...pools.retry, ...next.retry } };
          routes = next.routes;
          if (await stopping()) {
            return { interrupted: `the worker was asked to stop as gate ${gate.id} routed its review to the fallback ${gate.fallbackProfile}; the route${dispatched ? ` and infrastructure retry ${pools.retry.spent}/${cap}` : ""} are recorded and the resume takes them`, fallbackRoute: true };
          }
          log(`work: gate ${gate.id} on ${nodeId} — no verdict from ${gate.profile} (${outage.reason || "no reason"}); routing the review to its declared fallback ${gate.fallbackProfile}` +
            `${dispatched ? ` — infrastructure retry ${pools.retry.spent}/${cap}` : ""}, no fix cycle charged`);
          return true;
        }
      }
    }
    if (review && resetAt) {
      const backoffMs = dispatched ? Math.max(0, Number(factory.implementation && factory.implementation.retry && factory.implementation.retry.backoffMs) || 0) : 0;
      const wake = Math.max(at + backoffMs, resetAt);
      if (wake - at > pauseMax) {
        return `the review lane ${lane} says it is out until ${iso(resetAt)}, ${Math.round((wake - at) / 3600000)}h away — past this gate's pause cap of ${Math.round(pauseMax / 3600000)}h, so a person is asked instead of parking the item`;
      }
      if (dispatched) {
        if (cap <= 0 || !has.saveGatePools) return `the review lane ${lane} says it is out until ${iso(resetAt)}, but this factory declares no infrastructure retry pool (\`implementation.retry.attempts\`) to pay for the review after it, so the pause would buy nothing`;
        if (gates.executionPoolHeadroom(factory.implementation, "retry", pools.retry.spent) <= 0) {
          return `the review lane ${lane} says it is out until ${iso(resetAt)}, and the pipeline's shared infrastructure retry pool is spent (${pools.retry.spent}/${cap}), so no review may follow the pause`;
        }
      }
      const next = dispatched
        ? { retry: { spent: pools.retry.spent + 1, due_at: wake, paused_until: wake }, no_verdicts: noVerdicts }
        : { retry: { paused_until: wake }, no_verdicts: noVerdicts };
      const saved = await savePools(next, "the pause could not be recorded durably, and a pause nobody recorded is one a resume would not honor");
      if (saved !== true) return saved;
      pools = { retry: { ...pools.retry, ...next.retry } };
      const charged = dispatched ? `; infrastructure retry ${pools.retry.spent}/${cap} is charged for the review after it` : "; nothing is charged — no review was dispatched";
      if (wake - at > REVIEWER_PAUSE_PARK_MS || (await stopping())) {
        log(`work: gate ${gate.id} on ${nodeId} — ${lane} is out until ${iso(wake)} (${outage.reason || "no reason"}); the pipeline is paused and its slot freed${charged}, no fix cycle charged`);
        return { interrupted: `the review lane ${lane} is out until ${iso(wake)} (${outage.reason || "no reason"}) — paused until then${charged}`, pausedUntil: wake, profile: lane };
      }
      log(`work: gate ${gate.id} on ${nodeId} — ${lane} is out until ${iso(wake)}; waiting it out${charged}`);
      return waitUntil(wake, `the worker was asked to stop while gate ${gate.id} waited out ${lane}'s stated reset${charged}`);
    }
    if (cap <= 0 || !has.saveGatePools) return "this factory declares no infrastructure retry pool (`implementation.retry.attempts`), so the outage was not waited out";
    if (gates.executionPoolHeadroom(factory.implementation, "retry", pools.retry.spent) <= 0) {
      return `the pipeline's shared infrastructure retry pool is spent (${pools.retry.spent}/${cap})`;
    }
    const backoffMs = Math.max(0, Number(factory.implementation && factory.implementation.retry && factory.implementation.retry.backoffMs) || 0);
    const deadline = now("outage", gate.id) + backoffMs;
    const next = { retry: { spent: pools.retry.spent + 1, due_at: deadline }, ...(review && gate.fallbackProfile ? { no_verdicts: noVerdicts } : {}) };
    try {
      await act("saveGatePools", { item, pools: next }, "pools");
    } catch (e) {
      rethrowControl(e);
      log(`work: the infrastructure retry could not be charged (${(e && e.message) || e}) — ${gate.id} refuses on ${nodeId} rather than retrying uncharged`);
      return "the retry could not be charged durably, and an uncounted retry is an unbounded one";
    }
    pools = { retry: next.retry };
    if (await stopping()) {
      return { interrupted: `the worker was asked to stop while gate ${gate.id} was waiting out an outage (${outage.reason || "no reason"}); infrastructure retry ${pools.retry.spent}/${cap} is charged and the resume takes it` };
    }
    log(
      `work: gate ${gate.id} hit an outage on ${nodeId} (${outage.reason || "no reason"}) — infrastructure retry ${pools.retry.spent}/${cap}` +
        `${backoffMs ? ` after ${Math.round(backoffMs / 1000)}s` : ""}, no fix cycle charged`
    );
    return waitUntil(deadline, `the worker was asked to stop during gate ${gate.id}'s outage backoff (${outage.reason || "no reason"}); infrastructure retry ${pools.retry.spent}/${cap} is charged and the resume takes it`);
  };

  // The rescue lane's durable state (task-spor-factory-rescue-lane).
  const loadRescues = async () => {
    if (!has.loadRescueState) return [];
    try {
      const s = await act("loadRescueState", { item }, "rescues");
      return Array.isArray(s) ? s.filter((e) => e && typeof e === "object" && Number.isInteger(e.n) && e.gate).map((e) => ({ ...e })) : [];
    } catch (e) {
      rethrowControl(e);
      log(`work: the rescue state of ${item.node_id} could not be read (${(e && e.message) || e}) — judging from the original pass`);
      return [];
    }
  };
  const saveRescues = async (rescues) => {
    if (!has.saveRescueState) return;
    try {
      await act("saveRescueState", { item, rescues: rescues.map((e) => ({ ...e })) }, "rescues");
    } catch (e) {
      rethrowControl(e);
      log(`work: the rescue state of ${item.node_id} could not be saved (${(e && e.message) || e}) — a resumed pipeline would restart from the original pass`);
    }
  };
  // A flake filing resumed from a saved intent (gate-runner.js finishFlakeFiling).
  const finishFiling = (draft, filingOrigin) => act("finishFlakeFiling", { draft, filingOrigin }, "flake");

  // THE FIX CYCLE as dispatch + signal when the deps wire the halves, else
  // the one-shot `fix`. `onLaunch` is the runner's own durable record of the
  // launch (the gate's progress), run as a journaled step between the two
  // halves; under the one-shot form the binding saves it from inside the
  // activity (`onLaunchSave`) and reports the launch back.
  const fixCycle = async (args, { scope, onLaunchSave = null, onLaunched = null }) => {
    if (has.fixSignals) {
      const launched = await act("dispatchFix", args, ...scope);
      if (!launched || !launched.ok) return launched;
      if (onLaunched) await onLaunched({ runId: launched.runId || null });
      const sig = ctx.awaitSignal(K(...scope, "await-fix"), `run:${launched.runId}`);
      const done = (sig && sig.payload) || {};
      // `unfollowable` rides the refusal: a fix this worker stopped following
      // (an idle stop that did not take, the age watchdog) may still hold the
      // checkout, and the caller must not dispatch a rescue into it.
      if (!done.ok) return { ok: false, reason: done.reason || "the fix run did not reach a terminal state", ...(done.unfollowable ? { unfollowable: true } : {}) };
      return { ok: true, runId: launched.runId, ...(done.classification ? { classification: done.classification } : {}) };
    }
    const r = await act("fix", { ...args, ...(onLaunchSave ? { onLaunchSave } : {}) }, ...scope);
    if (r && r.launched && onLaunched) await onLaunched(r.launched, { saved: true });
    return r ? r.result : r;
  };

  // Every durable obligation is settled before inspecting/pinning a tree or
  // executing any gate.
  const rescues = await loadRescues();
  const evidenceEntries = Array.isArray(evidencePreflight && evidencePreflight.pending) ? evidencePreflight.pending.slice() : [];
  const inspected = new Set();
  if (!Array.isArray(evidencePreflight && evidencePreflight.pending)) {
    const passes = [...new Set([0, ...rescues.map((r) => Number(r.n) || 0)])];
    for (const rescue of passes) for (const gate of factory.gates || []) {
      let progress;
      try { progress = has.loadGateProgress ? await act("loadGateProgress", { gate, item, ...(rescue ? { rescue } : {}) }, "preflight", gate.id) : null; }
      catch (e) { rethrowControl(e); return { state: "interrupted", gates: results, facts, reason: `pending gate evidence could not be inspected: ${e.message || e}` }; }
      if (progress && (progress.filingIntent || progress.evidence && !progress.evidence.complete)) evidenceEntries.push({ gate, rescue, progress });
    }
  }
  for (const entry of evidenceEntries) {
    const saved = entry.progress || {};
    const debt = saved.filingIntent || saved.evidence;
    if (!debt || (!saved.filingIntent && debt.complete)) continue;
    const gate = debt.gate || entry.gate;
    const rescue = Number(entry.rescue) || 0;
    const carried = entry.carryKey ? { carryKey: entry.carryKey, attempt: Number(entry.attempt) || 0 } : null;
    const key = carried ? `carried:${carried.carryKey}` : `${rescue}:${gate && gate.id}`;
    if (inspected.has(key)) continue;
    inspected.add(key);
    if (!gate || !(factory.gates || []).some((g) => g.id === gate.id) || !(await accepts(debt.origin))) {
      return { state: "interrupted", gates: results, facts, reason: "pending gate evidence requires its original gate and graph before new work" };
    }
    passProgress.set(key, JSON.parse(JSON.stringify(saved)));
    let outcome = debt.outcome;
    if (saved.filingIntent && !outcome && debt.draft) outcome = await finishFiling(debt.draft, debt.origin);
    if (!outcome) return { state: "interrupted", gates: results, facts, reason: "pending gate evidence has no recoverable stored outcome" };
    const beforeFacts = facts.length, beforeResults = results.length;
    const replay = await record(gate, outcome, saved.filingIntent ? { rescue, attempts: saved.attempts || [], ledger: saved.ledger || [] } : {}, debt.change, debt.definition || null, debt.origin, debt.candidate_id || null, saved.filingIntent ? { phase: "judge", cycle: debt.cycle } : debt.continuation || null, carried);
    if (replay.pending) return { state: "interrupted", gates: results, facts, reason: "flake occurrence evidence is pending graph publication; resume this attempt to retry it" };
    facts.length = beforeFacts;
    results.length = beforeResults;
  }

  await readChanged();

  // PREMATURE RESOLUTION at submission (§4.5 "When").
  if (has.premature && factory.completion && factory.completion.by === "controller") {
    try {
      const p = await act("premature", { item }, "premature");
      if (p && Array.isArray(p.retyped) && p.retyped.length) log(`work: ${nodeId} — ${p.retyped.length} premature resolving edge(s) retyped before the gates ran (${p.retyped.join(", ")})`);
      else if (p && p.ok === false && p.reason) log(`work: ${nodeId} — premature-resolution check deferred (${p.reason})`);
    } catch (e) {
      rethrowControl(e);
      log(`work: ${nodeId} — premature-resolution check threw (${(e && e.message) || e}); the poll-time pass retries it`);
    }
  }

  // SUPERSEDED (issue-spor-work-adopts-orphaned-pipeline-of-hand-landed-run).
  if ((changedGone || resumedDrive) && has.resolved && has.landed) {
    let resolved = null;
    let landed = null;
    try {
      resolved = await act("resolved", { item }, "superseded");
    } catch (e) {
      rethrowControl(e);
      log(`work: ${nodeId} — could not read its resolution from the graph (${(e && e.message) || e}); judging the run as before`);
    }
    if (resolved && resolved.terminal_state === "resolved") {
      try {
        landed = await act("landed", { item, trustedRef: factory.trustedRef }, "superseded");
      } catch (e) {
        rethrowControl(e);
        log(`work: ${nodeId} — could not read whether its head is on ${factory.trustedRef} (${(e && e.message) || e}); judging the run as before`);
      }
    }
    if (resolved && resolved.terminal_state === "resolved" && landed && landed.known && landed.landed) {
      const head = landed.head ? String(landed.head).slice(0, 8) : "its head";
      const reason = `superseded: ${nodeId} is already resolved on the graph${resolved.resolved_by ? ` (by ${resolved.resolved_by})` : ""} and ${head} is already contained in ${factory.trustedRef}${changedGone ? " — its checkout is gone" : ""}; nothing left to judge`;
      log(`work: ${nodeId} — ${reason}`);
      return { state: "superseded", gates: [], facts: [], reason, ...(resolved.resolved_by ? { resolved_by: resolved.resolved_by } : {}), ...(landed.head ? { head: landed.head } : {}) };
    }
  }

  // ONE commit-or-discard round-trip for a DIRTY tree (task-spor-worker-
  // declined-outcome), per pass.
  const roundTrip = async (rescue = 0, seed = null) => {
    if (!factory.gates.length) return;
    const gate = factory.gates[0];
    const prior = await loadProgress(gate, rescue);
    const pre = [];
    preAttempts.set(Number(rescue) || 0, pre);
    const pass = rescue ? ` (rescue pass ${rescue})` : "";
    if (Array.isArray(prior && prior.preAttempts) && prior.preAttempts.length) {
      pre.push(...prior.preAttempts.map((a) => ({ ...a })));
      if (changed === null && changedDirty) log(`work: ${nodeId} is still dirty and its commit-or-discard round-trip was already spent before this pipeline was resumed${pass} — gate ${gate.id} judges the tree as it is`);
      return;
    }
    if (!(changed === null && changedDirty && (has.fix || has.fixSignals))) return;
    pre.push({ verdict: "dirty-tree", detail: changedReason });
    const seeded = rescue && !prior && seed && seed[gate.id] ? { base: seed[gate.id].base, ledger: (seed[gate.id].ledger || []).map((e) => ({ ...e })) } : {};
    await saveProgress(gate, { ...seeded, ...(prior || {}), preAttempts: pre }, rescue);
    log(`work: ${nodeId} left uncommitted changes${pass} — one commit-or-discard round-trip before gate ${gate.id} judges it`);
    const base = Math.max(0, Number((prior && prior.base) ?? seeded.base ?? 0) || 0);
    let fixed = null;
    try {
      fixed = await fixCycle({
        gate,
        cycle: "tree",
        item,
        findings: [],
        evidence: "",
        ledger: [],
        kind: "commit-or-discard",
        detail:
          `${changedReason}. Commit what belongs to ${nodeId} (a clear message), discard what does not (\`git restore\`),` +
          ` and leave the working tree CLEAN — this is the one round-trip before the '${gate.id}' gate escalates to a person.`,
        ...(rescue ? { rescue, base } : {}),
      }, { scope: ["roundtrip", `r${rescue}`] });
    } catch (e) {
      rethrowControl(e);
      fixed = { ok: false, reason: `the fix cycle could not be dispatched: ${(e && e.message) || e}` };
    }
    if (fixed && fixed.ok) await readChanged({ stage: rescue ? "rescue" : "implementation", cycle: 0, rescue: rescue || 0 }, { runId: (fixed && fixed.runId) || null });
    else log(`work: the commit-or-discard round-trip for ${nodeId}${pass} could not run (${(fixed && fixed.reason) || "no response"}) — the gate judges the tree as it is`);
    if (changed !== null) log(`work: ${nodeId} is clean after the round-trip${pass} — judging the committed change`);
  };

  // STALE PREMISE (task-spor-factory-skip-resolved-items-with-empty-diff).
  if (changed && changed.length === 0 && has.commitsLanded) {
    let commitsLanded = null;
    try {
      commitsLanded = await act("commitsLanded", { trustedRef: factory.trustedRef }, "stale");
    } catch (e) {
      rethrowControl(e);
      log(`work: ${nodeId} — its recorded commits could not be checked against ${factory.trustedRef} (${(e && e.message) || e}); judging the run as before`);
    }
    const verdict = gates.verifyStalePremise({ nodeId, commitsLanded });
    if (verdict.ok) {
      const scopingGate = { id: gates.NO_CODE_GATE_ID, kind: "scoping" };
      const reason = `scoped: ${verdict.detail}`;
      await record(scopingGate, { verdict: "scoped", detail: verdict.detail, passed: false });
      log(`work: ${nodeId} — ${reason}; no code gate ran and nothing is integrated`);
      return { state: "scoped", gates: results, facts, reason, outcome: verdict.outcome };
    }
  }

  // NO-CODE OUTCOME (task-spor-factory-no-code-outcome-convention).
  if (changed && changed.length === 0 && has.noCodeClaim) {
    let claim = null;
    try {
      claim = await act("noCodeClaim", { item }, "nocode");
    } catch (e) {
      rethrowControl(e);
      log(`work: ${nodeId} — its final report could not be read for a no-code outcome (${(e && e.message) || e}); judging the run as before`);
      claim = null;
    }
    if (claim) {
      const nodes = Object.create(null);
      const read = async (id) => {
        if (!id || !has.node || id in nodes) return;
        nodes[id] = null;
        try {
          const r = await act("node", { id, item }, "nocode");
          if (r && r.ok && r.node) nodes[id] = r.node;
          else if (r && r.reason) log(`work: ${nodeId} — \`${id}\` could not be read from the graph (${r.reason})`);
        } catch (e) {
          rethrowControl(e);
          log(`work: ${nodeId} — \`${id}\` could not be read from the graph (${(e && e.message) || e})`);
        }
      };
      if (claim.ok) {
        await read(claim.resolver);
        await read(nodeId);
      }
      const resolver = claim.ok ? nodes[claim.resolver] : null;
      if (resolver && (claim.outcome === "premise-stale" || claim.outcome === "duplicate")) {
        for (const cand of gates.noCodeFoundCandidates({ nodeId, resolver })) await read(cand);
      }
      const verdict = gates.verifyNoCodeOutcome({ nodeId, claim, nodes, claimedRepo: item.project || null });
      const scopingGate = { id: gates.NO_CODE_GATE_ID, kind: "scoping" };
      if (verdict.ok) {
        const reason = `scoped: ${verdict.detail}`;
        await record(scopingGate, { verdict: "scoped", detail: verdict.detail, passed: false });
        log(`work: ${nodeId} — ${reason}; no code gate ran and nothing is integrated`);
        return { state: "scoped", gates: results, facts, reason, outcome: verdict.outcome, resolver: verdict.resolver, ...(verdict.found ? { found: verdict.found } : {}) };
      }
      noCodeRefusal = verdict.reason;
      log(`work: ${nodeId} declared a no-code outcome, but it does not check out (${verdict.reason}) — judging the run as before`);
    }
  }

  if (!rescues.length) await roundTrip(0);

  // CANDIDATE SUBMISSION (§3.4, §4.2 I3/I3a).
  if (!rescues.length && factory.implementation && has.pinCandidate && changed !== null && !pinIgnorable && !candidate.candidateSubmitted(pinnedCandidate)) {
    const reason = pinFailureReason || "the candidate's publish has not verified yet — no reader could obtain it";
    const gate = { id: gates.CANDIDATE_GATE_ID, kind: gates.CANDIDATE_GATE_ID };
    const outcome = { passed: false, verdict: "failed", detail: `no candidate could be submitted for ${nodeId}: ${reason}`, evidence: "", findings: [] };
    const attempts = [{ verdict: outcome.verdict, detail: outcome.detail, passed: false }];
    let escalatedTo = null;
    try {
      const esc = await act("escalate", { gate, item, factory, attempts, detail: outcome.detail, evidence: "", findings: [], ledger: [] }, "escalate", gate.id);
      if (esc && esc.ok) escalatedTo = esc.id;
      else log(`work: gate ${gate.id} escalation could not be filed (${(esc && esc.reason) || "no response"})`);
    } catch (e) {
      rethrowControl(e);
      log(`work: gate ${gate.id} escalation could not be filed (${(e && e.message) || e})`);
    }
    const demoted = escalatedTo ? await demote(gate, { state: "failed", blockerId: escalatedTo }) : { demoted: false, note: null, reason: null };
    await record(gate, outcome, {
      attempts, ledger: [], escalatedTo,
      demotion:
        demoted.note ||
        (demoted.reason
          ? `the item could not be demoted on the graph (${demoted.reason})`
          : escalatedTo
          ? null
          : `not attempted — no escalation could be filed to block ${nodeId}, so its status is left as the run left it`),
    });
    log(
      `work: ${nodeId} — no candidate could be submitted (${reason}) — no gate ran${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}` +
        (escalatedTo ? "" : `; re-run this judgement with 'spor work --regate ${runId}'`)
    );
    const escalationRetry = !escalatedTo
      ? {
          gateId: gate.id, stage: gates.CANDIDATE_GATE_ID, attempt: item.attempt,
          attempts, detail: outcome.detail, evidence: "", findings: [], ledger: [],
          factId: gateRunner.gateFactId(gate.id, nodeId, runId, item.attempt || 0, 0),
        }
      : null;
    return {
      state: "failed",
      gates: results,
      facts,
      reason: outcome.detail,
      escalated_to: escalatedTo,
      demoted: demoted.demoted,
      demote_reason: demoted.reason,
      ...(escalatedTo ? {} : { escalation_failed: true }),
      ...(escalationRetry ? { escalation_retry: escalationRetry } : {}),
    };
  }

  const chain = () => ({ head: change && change.head || null, base: change && change.base || null,
    trusted_ref: factory.trustedRef, trusted_sha: change && change.trustedSha || null,
    branch: change && change.branch || null, definition: factory.definition || null });
  const stateByGate = new Map();

  const seedFromState = () => {
    const seed = {};
    for (const [id, st] of stateByGate) seed[id] = { ledger: (st.ledger || []).map((e) => ({ ...e })), base: st.base };
    return seed;
  };

  // ONE pass over the declared gates, in order (see gate-runner.js `judge`).
  const judge = async (rescue, seed) => {
    const judged = new Map();
    const declarations = new Map();
    const mayRetain = (gate) => factory.completion && factory.completion.by === "controller" && gate.kind === "command" && gate.rejudgeOnRepin === false;
    const declaration = (gate) => JSON.stringify({ gate, definition: factory.definition || null, completion: factory.completion || null });
    // A git read (or the caller's `retainedHeadIsAncestor`) — journaled.
    const ancestorOfTip = async (head) => {
      const tip = change && change.head;
      if (!head || !tip) return false;
      if (head === tip) return true;
      return (await act("ancestorOfTip", { head, tip, cwd: changedCwd }, "ancestor")) === true;
    };
    const reusable = async (gate, head) => {
      if (declarations.get(gate.id) !== declaration(gate)) return false;
      if ((head || null) === (change && change.head || null)) return true;
      if (!mayRetain(gate)) return false;
      if (!(await ancestorOfTip(head))) return false;
      return results.some((r) => r.gate === gate.id && (r.rescue || 0) === rescue && r.head === head && r.verdict === "passed" && r.candidate_id);
    };
    const remember = (gate, head) => { judged.set(gate.id, head); declarations.set(gate.id, declaration(gate)); };
    const retainResult = (gate) => {
      const result = results.find((r) => r.gate === gate.id && (r.rescue || 0) === rescue);
      if (result && result.head && change && change.head && result.head !== change.head) Object.assign(result, { retained: true, rejudge_on_repin: false, retained_for: change.head, ancestry_verified: true });
    };
    const cacheScope = { run: runId, attempt: item.attempt || 0, rescue };
    for (let gi = 0; gi < factory.gates.length; gi += 1) {
      const gate = factory.gates[gi];
      if (change && change.head && (await reusable(gate, judged.get(gate.id)))) {
        retainResult(gate);
        const retained = results.find((r) => r.gate === gate.id && (r.rescue || 0) === rescue);
        if (retained) await reportEvidence(gate, retained, { fact: retained.fact, candidate_id: retained.candidate_id, head: retained.head, rescue });
        continue;
      }
      const startedAt = now("gate", gate.id);
      let outcome = null;
      const saved = passProgress.get(`${rescue}:${gate.id}`) || await loadProgress(gate, rescue);
      let resumedFilingOutcome = null;
      if (saved && saved.filingIntent) {
        const intent = saved.filingIntent;
        if (!(await accepts(intent.origin))) return { evidencePending: true };
        const recovered = intent.outcome || await finishFiling(intent.draft, intent.origin);
        const replay = await record(intent.gate || gate, recovered, { rescue, attempts: saved.attempts || [], ledger: saved.ledger || [] }, intent.change, intent.definition, intent.origin, intent.candidate_id, { phase: "judge", cycle: intent.cycle });
        if (replay.pending) return { evidencePending: true };
        if ((intent.change && intent.change.head || null) === (change && change.head || null) && JSON.stringify(intent.definition || null) === JSON.stringify(factory.definition || null)) {
          if (recovered.passed) { remember(gate, change && change.head || null); continue; }
          resumedFilingOutcome = { ...recovered, flake: gateRunner.flakePaidBy(recovered.flake, replay) };
        }
      }
      if (saved && saved.evidence && saved.evidence.outcome) {
        const prior = saved.evidence;
        if (!(await accepts(prior.origin))) {
          log(`work: gate ${gate.id} pending flake evidence belongs to a different or unknown graph — resume it against its original graph`);
          return { evidencePending: true };
        }
        let replay;
        if (prior.complete) {
          if (prior.fact && !facts.includes(prior.fact)) facts.push(prior.fact);
          if (prior.result) restoreResult(prior.result);
          await reportEvidence(prior.gate || gate, prior.outcome, { fact: prior.fact, candidate_id: prior.candidate_id || null, head: prior.change && prior.change.head || null, rescue });
          replay = { id: prior.fact, linked: gateRunner.flakeLinked(prior.payment_receipts || prior.outcome.flake), pending: false };
        } else replay = await record(prior.gate || gate, prior.outcome, {}, prior.change, prior.definition || null, prior.origin, prior.candidate_id || null, prior.continuation || null);
        if (replay.pending) return { evidencePending: true };
        if ((prior.change && prior.change.head || null) === (change && change.head || null) && JSON.stringify(prior.definition || null) === JSON.stringify(factory.definition || null)) {
          if (prior.outcome.passed) {
            remember(gate, change && change.head || null);
            continue;
          }
          const recovered = { ...prior.outcome, flake: gateRunner.flakePaidBy(prior.outcome.flake, replay) };
          if (prior.continuation && prior.continuation.phase === "judge") resumedFilingOutcome = recovered;
          else return { gate, outcome: recovered, attempts: prior.outcome.attempts || [], ledger: prior.outcome.ledger || [], recordedEvidence: { ...replay, outcome: prior.outcome } };
        }
      }
      const cached = saved && saved.retainedPass;
      if (mayRetain(gate) && cached && cached.result && cached.result.candidate_id && (await ancestorOfTip(cached.result.head)) && cached.result.verdict === "passed"
        && cached.declaration === declaration(gate) && JSON.stringify(cached.scope) === JSON.stringify(cacheScope)
        && (await accepts(cached.origin))
        && !(saved.filingIntent || (saved.evidence && !saved.evidence.complete))) {
        const result = { ...cached.result };
        restoreResult(result);
        await reportEvidence(gate, result, { fact: result.fact, candidate_id: result.candidate_id, head: result.head, rescue });
        if (result.fact && !facts.includes(result.fact)) facts.push(result.fact);
        remember(gate, result.head);
        retainResult(gate);
        continue;
      }
      const seeded = rescue && !saved && seed && seed[gate.id] ? seed[gate.id] : null;
      const base = rescue ? Math.max(0, Number((saved && saved.base) ?? (seeded && seeded.base) ?? 0) || 0) : 0;
      const attempts = Array.isArray(saved && saved.attempts) ? saved.attempts.map((a) => ({ ...a })) : [];
      let ledger = Array.isArray(saved && saved.ledger) ? saved.ledger.map((e) => ({ ...e })) : seeded ? seeded.ledger.map((e) => ({ ...e })) : [];
      let lastFix = saved && saved.lastFix && typeof saved.lastFix === "object" ? { ...saved.lastFix } : null;
      const startCycle = Math.max(base, Math.min(base + gates.cycleCap(gate), Number.isInteger(saved && saved.fixes) ? saved.fixes : base));
      let pendingFix = null;
      if (saved && saved.lastFix && saved.lastFix.dispatched === false && saved.lastFix.cycle === startCycle && attempts.length === startCycle - base + 1) {
        pendingFix = { ...saved.lastFix };
      } else if (attempts.length > startCycle - base) {
        attempts.length = startCycle - base;
        ledger = gates.rollbackCycle(ledger, startCycle);
      }
      if (saved && (startCycle > base || ledger.length || attempts.length || pendingFix)) {
        if (lastFix && lastFix.dispatched !== false && !lastFix.toHead) lastFix.toHead = changedHead;
        log(`work: gate ${gate.id} resumed on ${nodeId} at fix cycle ${startCycle - base}/${gate.cycles}${rescue ? ` (rescue pass ${rescue})` : ""} — ${ledger.length} ledger finding(s) carried${pendingFix ? `; the fix for cycle ${startCycle - base} never launched, dispatching it first` : ""}`);
      }
      let filingIntent = null;
      const progress = (fixes) => ({ ...(rescue ? { base } : {}), fixes, attempts, ledger, lastFix, ...(filingIntent ? { filingIntent } : {}) });
      const routedGate = () => (gate.kind === "agent-review" && routes[gate.id] ? { ...gate, profile: routes[gate.id].profile } : gate);
      const withReviewer = (o) => (o && gate.kind === "agent-review" && routes[gate.id] && !o.reviewer ? { ...o, reviewer: { ...routes[gate.id] } } : o);
      // ONE gate attempt as ONE activity (gate-runner.js runOneGate). A flake
      // filing INTENT the attempt saves mid-way (`saveFlakeIntent`) is saved
      // from inside the activity under the progress the workflow hands it,
      // and reported back so the workflow's own memory matches.
      const judgeOnce = async (cycle) => {
        const r = await act("judge", {
          gate: routedGate(), cycle, head: change && change.head, changed, changedReason, noCodeRefusal, ledger, lastFix, rescue, base,
          retry: pools.retry.unreadable ? 0 : pools.retry.spent,
          filingOrigin: pipelineEvidenceOrigin,
          intent: { gate, progress: progress(cycle), filingIntent: { gate, cycle, change, definition: factory.definition || null, origin: pipelineEvidenceOrigin, candidate_id: pinnedCandidate && pinnedCandidate.candidate_id || null } },
        }, "judge", `r${rescue}`, gate.id, `c${cycle}`);
        if (r && r.intent) {
          filingIntent = r.intent.filingIntent;
          passProgress.set(`${rescue}:${gate.id}`, JSON.parse(JSON.stringify(r.intent.progress)));
        }
        return withReviewer(r ? r.outcome : r);
      };
      for (let cycle = startCycle; ; cycle += 1) {
        if (pendingFix) {
          outcome = withReviewer({ passed: false, verdict: attempts[cycle - base].verdict, detail: attempts[cycle - base].detail, evidence: pendingFix.evidence || "", findings: pendingFix.findings || [] });
          lastFix = pendingFix;
          pendingFix = null;
        } else {
          if (resumedFilingOutcome) { outcome = resumedFilingOutcome; resumedFilingOutcome = null; }
          else outcome = await judgeOnce(cycle);
          if (outcome.evidencePending) return { evidencePending: true };
          while (outcome.outage) {
            const again = await spendOutage(gate, outcome.outage);
            if (again && again.interrupted) return { outageInterrupted: again.interrupted, ...(again.pausedUntil ? { pausedUntil: again.pausedUntil, pausedProfile: again.profile || null } : {}), ...(again.fallbackRoute ? { fallbackRoute: true } : {}) };
            if (again !== true) {
              outcome = { ...outcome, outage: { ...outcome.outage, notRetried: again } };
              break;
            }
            outcome = await judgeOnce(cycle);
          }
          if (filingIntent) {
            filingIntent.outcome = outcome;
            const p = progress(cycle);
            try {
              if (has.saveGateProgress) await act("saveGateProgress", { gate, item, progress: p, ...(rescue ? { rescue } : {}) }, "progress", gate.id);
              passProgress.set(`${rescue}:${gate.id}`, JSON.parse(JSON.stringify(p)));
            } catch (e) { rethrowControl(e); return { evidencePending: true }; }
          }
          if (outcome.ledger) ledger = outcome.ledger;
          attempts.push({ verdict: outcome.verdict, detail: outcome.detail, passed: !!outcome.passed });
          const retry = !outcome.passed && !outcome.noRetry && gates.cycleDecision(gate, cycle - base) === "retry";
          if (retry && filingIntent) {
            const rec = await record(gate, outcome, { attempts: shownAttempts(gate, attempts, rescue), ledger, rescue, startedAt }, change, factory.definition || null, pipelineEvidenceOrigin, pinnedCandidate && pinnedCandidate.candidate_id || null, { phase: "judge", cycle });
            if (rec.pending) return { evidencePending: true };
            filingIntent = null;
          }
          if (retry) lastFix = { cycle, runId: null, dispatched: false, fromHead: changedHead, toHead: null, findings: outcome.findings || [], detail: outcome.detail || "", evidence: String(outcome.evidence || "").slice(0, 8000) };
          await saveProgress(gate, progress(cycle), rescue);
          if (!retry) break;
        }
        log(`work: gate ${gate.id} failed on ${nodeId} — fix cycle ${cycle - base + 1}/${gate.cycles}${rescue ? ` (rescue pass ${rescue})` : ""}`);
        // Charged the moment the launch is known — not before and not only
        // after. Under the signal form the save is the workflow's own
        // journaled step between the dispatch and the await; under the
        // one-shot form the binding saves it from inside the activity.
        const launchProgress = () => withPre(gate, progress(cycle + 1), rescue);
        const onLaunched = async (l, { saved = false } = {}) => {
          lastFix = { ...lastFix, dispatched: true, runId: (l && (l.runId || l.run_id)) || lastFix.runId || null };
          if (saved) passProgress.set(`${rescue}:${gate.id}`, JSON.parse(JSON.stringify(progress(cycle + 1))));
          else await saveProgress(gate, progress(cycle + 1), rescue);
        };
        let fixed = null;
        try {
          fixed = await fixCycle(
            { gate, cycle, item, findings: outcome.findings || [], evidence: outcome.evidence || "", detail: outcome.detail, ledger, ...(rescue ? { rescue, base } : {}) },
            { scope: ["fix", `r${rescue}`, gate.id, `c${cycle}`], onLaunched, onLaunchSave: { gate, item, rescue, progress: { ...launchProgress(), lastFix: { ...lastFix, dispatched: true } } } }
          );
        } catch (e) {
          rethrowControl(e);
          fixed = { ok: false, reason: `the fix cycle could not be dispatched: ${(e && e.message) || e}` };
        }
        if (!fixed || !fixed.ok) {
          const outage = gateRunner.outageOf(fixed);
          // An UNFOLLOWABLE fix (issue-spor-unfollowable-fix-may-still-
          // dispatch-rescue): the fixer may still be writing in the run's own
          // checkout, so no rescue — which dispatches `--no-worktree --force`
          // into that same checkout — may follow it. The refusal escalates
          // straight to a person instead.
          const unfollowable = !!(fixed && fixed.unfollowable);
          outcome = {
            ...(outcome.reviewer ? { reviewer: outcome.reviewer } : {}),
            passed: false,
            verdict: "failed",
            detail: unfollowable
              ? `${outcome.detail || "gate failed"}; the fix cycle could not be followed to its end (${(fixed && fixed.reason) || "no response"}) and may still hold the checkout`
              : `${outcome.detail || "gate failed"}; the fix cycle could not run (${(fixed && fixed.reason) || "no response"})`,
            evidence: outcome.evidence,
            findings: outcome.findings,
            noRetry: true,
            ...(unfollowable ? { noRescue: true, unfollowable: true, noRescueWhy: UNFOLLOWABLE_FIX_NO_RESCUE_WHY } : {}),
            ...(outage ? { outage } : {}),
          };
          attempts.push({ verdict: outcome.verdict, detail: outcome.detail, passed: false });
          break;
        }
        const fixFromHead = lastFix && lastFix.fromHead;
        await readChanged({ stage: "fix", cycle: cycle + 1, rescue: rescue || 0 }, { runId: (fixed && fixed.runId) || null });
        lastFix = { ...lastFix, dispatched: true, runId: (fixed && fixed.runId) || lastFix.runId || null, toHead: changedHead };
        await saveProgress(gate, progress(cycle + 1), rescue);
        const fixOutage = gateRunner.outageOf(fixed);
        if (fixOutage && changedHead && fixFromHead && changedHead === fixFromHead) {
          outcome = {
            ...(outcome.reviewer ? { reviewer: outcome.reviewer } : {}),
            passed: false,
            verdict: fixOutage.outcome,
            noRetry: true,
            outage: { ...fixOutage, notRetried: "the fixer's own dispatch hit it, and re-dispatching a fixer is not something this pipeline can charge to the pool" },
            detail:
              `${outcome.detail || "gate failed"}; the fix cycle's own dispatch never finished — ${fixOutage.reason || "no reason recorded"}` +
              `, and it left ${factory.trustedRef ? "the branch" : "the tree"} exactly where it was, so there is nothing new to review`,
            evidence: outcome.evidence,
            findings: outcome.findings,
          };
          attempts.push({ verdict: outcome.verdict, detail: outcome.detail, passed: false });
          break;
        }
      }
      stateByGate.set(gate.id, { ledger, base: base + attempts.length });

      if (outcome.passed) {
        const recorded = await record(gate, outcome, { attempts: shownAttempts(gate, attempts, rescue), ledger, rescue, startedAt });
        if (recorded.pending) return { evidencePending: true };
        const current = results.pop();
        restoreResult(current);
        remember(gate, change && change.head || null);
        if (mayRetain(gate)) {
          const p = passProgress.get(`${rescue}:${gate.id}`) || await loadProgress(gate, rescue) || {};
          await saveProgress(gate, { ...p, retainedPass: { scope: cacheScope, declaration: declaration(gate), origin: pipelineEvidenceOrigin, result: { ...current } } }, rescue);
        }
        for (const g of factory.gates) if (await reusable(g, judged.get(g.id))) retainResult(g);
        let moved = false;
        for (const g of factory.gates) if (judged.has(g.id) && !(await reusable(g, judged.get(g.id)))) { moved = true; break; }
        if (moved) gi = -1;
        log(`work: gate ${gate.id} ${outcome.verdict} on ${nodeId}${rescue ? ` (rescue pass ${rescue})` : ""}`);
        continue;
      }
      return { gate, outcome, attempts: shownAttempts(gate, attempts, rescue), ledger };
    }
    return null;
  };

  // --- the rescue lane (task-spor-factory-rescue-lane, WORKERS.md §10.10) ---
  const rescuable = (refusal) => refusal && !changedGone && !refusal.outcome.noRescue && !refusal.outcome.escalatedTo && refusal.outcome.verdict !== "blocked" && !refusal.outcome.outage;
  const outageInterrupted = (reason, pause = null) => ({
    state: "interrupted", outage_interrupted: true, gates: results, facts, ...chain(), reason,
    ...(pause && pause.pausedUntil ? { paused_until: pause.pausedUntil, paused_profile: pause.pausedProfile || null } : {}),
    ...(pause && pause.fallbackRoute ? { fallback_route: true } : {}),
  });
  // A pipeline resumed inside a reviewer PAUSE honors it.
  {
    const at = now("pause");
    const pausedUntil = Number(pools.retry.paused_until) || 0;
    if (pausedUntil - at > REVIEWER_PAUSE_PARK_MS) {
      log(`work: ${nodeId} resumes inside a reviewer pause — still paused until ${new Date(pausedUntil).toISOString()}, nothing dispatched`);
      return outageInterrupted(`a review lane this pipeline depends on is out until ${new Date(pausedUntil).toISOString()} — still paused, nothing dispatched and nothing charged`, { pausedUntil });
    }
    if (pausedUntil > at && !(pools.retry.due_at > pausedUntil)) pools.retry.due_at = pausedUntil;
  }
  if (pools.retry.due_at && now("due") < pools.retry.due_at) {
    log(`work: ${nodeId} resumes inside an infrastructure backoff — waiting out the retry already charged (${pools.retry.spent}) before any dispatch`);
    const waited = await waitUntil(pools.retry.due_at, "the worker was asked to stop while a resumed pipeline waited out the outage backoff it was charged for; the resume after this takes it");
    if (waited !== true) return outageInterrupted(waited.interrupted);
  }
  let refusal = null;
  let resumed = null;
  if (rescues.length) {
    resumed = rescues[rescues.length - 1];
    refusal = gateRunner.refusalFromEntry(factory, resumed);
    for (const e of rescues) {
      for (const f of [e.fact, e.rescueFact]) if (f && !facts.includes(f)) facts.push(f);
    }
    for (const [id, st] of Object.entries(resumed.seed || {})) stateByGate.set(id, { ledger: (st.ledger || []).map((e) => ({ ...e })), base: Number(st.base) || 0 });
    log(`work: rescue attempt ${resumed.n} on ${nodeId} resumed${resumed.done ? " after its dispatch — re-judging the gates" : resumed.dispatched ? ` — its run ${resumed.runId ? String(resumed.runId).slice(0, 8) : "?"} is adopted` : " — dispatching it"}`);
  } else {
    refusal = await judge(0, null);
  }
  const evidenceWaiting = () => ({ state: "interrupted", gates: results, facts, ...chain(), reason: "flake occurrence evidence is pending graph publication; resume this attempt to retry it" });
  if (refusal && refusal.evidencePending) return evidenceWaiting();
  if (refusal && refusal.outageInterrupted) return outageInterrupted(refusal.outageInterrupted, refusal);

  // The rescue fact: `wrote.existing` is reconciled by a read like a gate fact's.
  const recordRescue = async (entry) => {
    try {
      const fact = gateRunner.buildRescueFact({ nodeId, runId, project: item.project || null, attempt: item.attempt || 0, entry, factory: factory.id, date: new Date(now("rescue", `n${entry.n}`)).toISOString().slice(0, 10) });
      const gate = { id: `rescue-${entry.n}`, kind: "rescue" };
      const wrote = await act("recordFact", { id: fact.id, markdown: fact.markdown, nodeId, gate, verdict: entry.error ? "unrun" : entry.category || "unknown", rescue: entry.n }, "fact", gate.id);
      if (wrote && wrote.ok) {
        const landed = !wrote.existing || wrote.identical ? fact.id : (await reconcileExisting(gate, fact.id, fact.markdown, [])).id;
        if (landed) {
          if (!facts.includes(landed)) facts.push(landed);
          entry.rescueFact = landed;
          await reportEvidence(gate, { verdict: entry.error ? "unrun" : entry.category || "unknown" }, { fact: landed, rescue: entry.n });
        }
      } else log(`work: rescue attempt ${entry.n} could not be recorded on the graph (${(wrote && wrote.reason) || "no response"})`);
    } catch (e) {
      rethrowControl(e);
      log(`work: rescue attempt ${entry.n} could not be recorded on the graph (${(e && e.message) || e})`);
    }
  };

  // THE RESCUE DISPATCH as dispatch + signal + report when the deps wire the
  // halves, else the one-shot `rescue`. The entry's launch record
  // (`dispatched`, `runId`, saved rescue state) is the workflow's own
  // journaled step under the signal form; the binding saves it from inside
  // the activity under the one-shot form.
  const rescueCycle = async (entry, args) => {
    const scope = ["rescue", `n${entry.n}`];
    const onLaunched = async (l) => {
      entry.dispatched = true;
      entry.runId = (l && (l.runId || l.run_id)) || entry.runId || null;
    };
    if (has.rescueSignals) {
      const launched = await act("dispatchRescue", args, ...scope);
      if (!launched || !launched.ok) return launched;
      await onLaunched({ runId: launched.runId || null });
      await saveRescues(rescues);
      const sig = ctx.awaitSignal(K(...scope, "await-rescue"), `rescue-run:${launched.runId}`);
      const done = (sig && sig.payload) || {};
      if (!done.ok) return { ok: false, reason: done.reason || "the rescue run did not reach a terminal state" };
      const report = await act("rescueReport", { runId: launched.runId, attempt: entry.n, gate: args.gate }, ...scope);
      return { ok: true, runId: launched.runId, ...(report || {}) };
    }
    const r = await act("rescue", { ...args, onLaunchSave: { item, rescues: rescues.map((e) => ({ ...e })), n: entry.n } }, ...scope);
    if (r && r.launched) await onLaunched(r.launched);
    return r ? r.result : r;
  };

  if (refusal && factory.rescue && (has.rescue || has.rescueSignals)) {
    for (;;) {
      let entry = null;
      if (resumed) {
        entry = resumed;
        resumed = null;
        if (entry.done && entry.error) break;
        if (!entry.done && !entry.dispatched && changedGone) {
          entry.done = true;
          entry.error = `the run's checkout is gone, so no rescue can work in it${changedReason ? ` (${changedReason})` : ""}`;
          await saveRescues(rescues);
          await recordRescue(entry);
          if (entry.rescueFact) await saveRescues(rescues);
          log(`work: rescue attempt ${entry.n} on ${nodeId} was never launched and the run's checkout is gone — no rescue can work in it; escalating the refusal it was handed`);
          break;
        }
      } else {
        if (refusal && changedGone && !refusal.outcome.escalatedTo && refusal.outcome.verdict !== "blocked" && rescues.length < factory.rescue.attempts) {
          log(`work: gate ${refusal.gate.id} refused ${nodeId} and the run's checkout is gone — no rescue can work in it; escalating the refusal it was handed`);
        } else if (refusal && refusal.outcome.noRescue && !refusal.outcome.escalatedTo && rescues.length < factory.rescue.attempts) {
          log(`work: gate ${refusal.gate.id} refused ${nodeId} ${refusal.outcome.noRescueWhy || EMPTY_DIFF_NO_RESCUE_WHY}; escalating straight to a person`);
        }
        if (!rescuable(refusal) || rescues.length >= factory.rescue.attempts) break;
        const n = rescues.length + 1;
        const { gate, outcome, attempts, ledger } = refusal;
        const rec = refusal.recordedEvidence && refusal.recordedEvidence.outcome.rescueNext ? refusal.recordedEvidence : await record(gate, outcome, {
          attempts, ledger,
          rescue: n - 1,
          rescueNext: { n, attempts: factory.rescue.attempts, profile: factory.rescue.profile },
          flake: outcome.flake || null,
        });
        if (rec.pending) return evidenceWaiting();
        if (outcome.flake) outcome.flake = gateRunner.flakePaidBy(outcome.flake, rec);
        entry = {
          n, gate: gate.id, verdict: outcome.verdict, detail: outcome.detail || "",
          evidence: String(outcome.evidence || "").slice(0, 8000),
          ...(outcome.failing_tests ? { failing_tests: [...outcome.failing_tests] } : {}),
          findings: (outcome.findings || []).map((f) => ({ ...f })),
          attempts: attempts.map((a) => ({ ...a })),
          ledger: (ledger || []).map((e) => ({ ...e })),
          flake: outcome.flake || null,
          fact: rec.id, seed: seedFromState(),
          dispatched: false, runId: null, done: false, diagnosis: null, category: null, fixed: null, filed: [], error: null,
        };
        rescues.push(entry);
        await saveRescues(rescues);
        log(`work: gate ${gate.id} refused ${nodeId} — rescue attempt ${n}/${factory.rescue.attempts} under ${factory.rescue.profile} before any escalation`);
      }
      if (!entry.done) {
        const gate = factory.gates.find((g) => g.id === entry.gate) || { id: entry.gate, kind: "gate" };
        let r = null;
        try {
          r = await rescueCycle(entry, {
            item, factory, gate, attempt: entry.n,
            detail: entry.detail, evidence: entry.evidence, findings: entry.findings, attempts: entry.attempts, ledger: entry.ledger,
            fact: entry.fact, facts: [...facts],
            previous: rescues.slice(0, entry.n - 1).map((e) => ({ n: e.n, gate: e.gate, category: e.category, diagnosis: e.diagnosis, filed: e.filed, runId: e.runId, error: e.error })),
          });
        } catch (e) {
          rethrowControl(e);
          r = { ok: false, reason: `the rescue could not be dispatched: ${(e && e.message) || e}` };
        }
        entry.done = true;
        if (!r || !r.ok) {
          entry.error = (r && r.reason) || "no response";
          await saveRescues(rescues);
          await recordRescue(entry);
          if (entry.rescueFact) await saveRescues(rescues);
          log(`work: rescue attempt ${entry.n} on ${nodeId} could not run (${entry.error}) — escalating the refusal it was handed`);
          break;
        }
        entry.runId = r.runId || entry.runId || null;
        entry.dispatched = true;
        entry.diagnosis = String(r.diagnosis || "");
        entry.category = r.category || "unknown";
        entry.fixed = !!r.fixed;
        entry.filed = Array.isArray(r.filed) ? r.filed.filter((f) => typeof f === "string") : [];
        entry.unread = !!r.unread;
        await saveRescues(rescues);
        await recordRescue(entry);
        if (entry.rescueFact) await saveRescues(rescues);
        log(`work: rescue attempt ${entry.n} on ${nodeId} diagnosed ${entry.category}${entry.fixed ? " and committed a fix" : ""}${entry.filed.length ? `, filed ${entry.filed.join(", ")}` : ""} — re-judging the gates`);
        await readChanged({ stage: "rescue", cycle: 0, rescue: entry.n }, { runId: entry.runId || null });
      }
      await roundTrip(entry.n, entry.seed);
      refusal = await judge(entry.n, entry.seed);
      if (refusal && refusal.evidencePending) return evidenceWaiting();
      if (refusal && refusal.outageInterrupted) return outageInterrupted(refusal.outageInterrupted, refusal);
      if (!refusal) break;
    }
  }

  const rescueSummary = rescues.map((e) => ({ n: e.n, gate: e.gate, run_id: e.runId || null, category: e.category || null, diagnosis: e.diagnosis || null, fixed: !!e.fixed, filed: e.filed || [], error: e.error || null, fact: e.rescueFact || null }));
  if (!refusal) {
    return {
      state: "passed", gates: results, facts, ...chain(),
      reason: `${results.length} gate(s) passed${rescues.length ? ` (after rescue attempt ${rescues.length})` : ""}`,
      ...(rescues.length ? { rescues: rescueSummary } : {}),
    };
  }

  const { gate, outcome, attempts, ledger } = refusal;
  const rescue = rescues.length;
  let escalatedTo = outcome.escalatedTo || null;
  const escalateExtras = {
    attempts,
    detail: outcome.detail,
    evidence: outcome.evidence || "",
    findings: outcome.findings || [],
    ledger,
    ...(rescue ? { rescue, rescues: rescueSummary } : {}),
    ...(outcome.outage ? { outage: outcome.outage } : {}),
    ...(outcome.failing_tests ? { failingTests: outcome.failing_tests } : {}),
  };
  if (!escalatedTo && outcome.verdict !== "blocked") {
    try {
      const esc = await act("escalate", { gate, item, factory, ...escalateExtras }, "escalate", gate.id);
      if (esc && esc.ok) escalatedTo = esc.id;
      else log(`work: gate ${gate.id} escalation could not be filed (${(esc && esc.reason) || "no response"})`);
    } catch (e) {
      rethrowControl(e);
      log(`work: gate ${gate.id} escalation could not be filed (${(e && e.message) || e})`);
    }
  }
  const state = outcome.verdict === "blocked" ? "blocked" : "failed";
  const demoted = escalatedTo ? await demote(gate, { state, blockerId: escalatedTo }) : { demoted: false, note: null, reason: null };
  if (!escalatedTo) {
    log(
      `work: gate ${gate.id} refused ${nodeId}, but the escalation that would block it could not be filed — ` +
        `the item's status is left as the run left it; re-run this judgement with 'spor work --regate ${runId}'`
    );
  }
  const terminalRecord = refusal.recordedEvidence && !refusal.recordedEvidence.outcome.rescueNext && refusal.recordedEvidence.outcome.escalatedTo === escalatedTo ? refusal.recordedEvidence : await record(gate, outcome, {
    attempts, escalatedTo, ledger,
    demotion:
      demoted.note ||
      (demoted.reason
        ? `the item could not be demoted on the graph (${demoted.reason})`
        : escalatedTo
        ? null
        : `not attempted — no escalation could be filed to block ${nodeId}, so its status is left as the run left it`),
    rescue,
  });
  if (terminalRecord.pending) return evidenceWaiting();
  log(`work: gate ${gate.id} ${state} on ${nodeId}${rescue ? ` (after rescue attempt ${rescue})` : ""} — ${outcome.detail || "no detail"}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
  const escalationRetry = !escalatedTo && outcome.verdict !== "blocked"
    ? {
        gateId: gate.id, attempt: item.attempt, ...escalateExtras, evidence: String(escalateExtras.evidence || "").slice(0, 3000),
        factId: gateRunner.gateFactId(gate.id, nodeId, runId, item.attempt || 0, rescue, change && change.head),
      }
    : null;
  return {
    state, gates: results, facts, ...chain(),
    reason:
      `gate '${gate.id}' ${state}: ${outcome.detail || ""}`.trim() +
      (escalatedTo ? "" : " (the escalation could not be filed, so the item's status was left alone)"),
    escalated_to: escalatedTo,
    ...(outcome.failing_tests ? { failing_tests: outcome.failing_tests } : {}),
    ...(outcome.emptyDiff ? { empty_diff: true } : {}),
    demoted: demoted.demoted,
    demote_reason: demoted.reason,
    ...(escalatedTo ? {} : { escalation_failed: true }),
    ...(escalationRetry ? { escalation_retry: escalationRetry } : {}),
    ...(rescue ? { rescues: rescueSummary } : {}),
  };
}

// Bind the pipeline's deps to the kernel's activities table. `item`, `factory`
// and `log` are the pipeline's own (the activities that compose a gate attempt
// or a flake filing need them); `log` lines from inside an activity happen
// only when it EXECUTES, so they are live by construction.
function bindGateActivities(deps, { item, factory, log = () => {} }) {
  const call = (name) => async (args) => plain(await deps[name](args));
  const read = (name) => async () => plain(await deps[name]());
  const git = gateRunner.judgeGit;
  const activities = {
    // The journaled input and the journaled yield result: identity activities.
    open: (args) => plain(args),
    pass: (args) => plain(args),
    yield: (args) => plain(args),
    checkEvidenceOrigins: read("checkEvidenceOrigins"),
    evidenceOrigin: read("evidenceOrigin"),
    acceptsEvidenceOrigin: ({ origin }) => !!deps.acceptsEvidenceOrigin(origin),
    stopping: () => !!deps.stopping(),
    pinCandidate: call("pinCandidate"),
    changedPaths: call("changedPaths"),
    premature: call("premature"),
    resolved: call("resolved"),
    landed: call("landed"),
    commitsLanded: call("commitsLanded"),
    noCodeClaim: call("noCodeClaim"),
    node: call("node"),
    loadGatePools: call("loadGatePools"),
    saveGatePools: call("saveGatePools"),
    stampReviewerCooldown: call("stampReviewerCooldown"),
    reviewerIndependence: call("reviewerIndependence"),
    loadRescueState: call("loadRescueState"),
    saveRescueState: call("saveRescueState"),
    loadGateProgress: call("loadGateProgress"),
    saveGateProgress: call("saveGateProgress"),
    saveCarriedProgress: call("saveCarriedProgress"),
    recordFact: call("recordFact"),
    readFact: call("readFact"),
    linkFact: call("linkFact"),
    gateEvidenceRecorded: call("gateEvidenceRecorded"),
    demote: call("demote"),
    escalate: call("escalate"),
    dispatchFix: call("dispatchFix"),
    dispatchRescue: call("dispatchRescue"),
    rescueReport: call("rescueReport"),
    // Is `head` an ancestor of the tip — the caller's reading, else git's.
    ancestorOfTip: ({ head, tip, cwd }) => {
      if (deps.retainedHeadIsAncestor) return deps.retainedHeadIsAncestor({ head, tip }) === true;
      return !!(cwd && git(cwd, ["merge-base", "--is-ancestor", head, tip]).status === 0);
    },
    finishFlakeFiling: async ({ draft, filingOrigin }) => plain(await gateRunner.finishFlakeFiling(draft, { ...deps, filingOrigin }, log)),
    // ONE gate attempt (gate-runner.js runOneGate). A flake filing intent the
    // attempt saves mid-way is saved here, under the progress the workflow
    // handed in, and reported back with the outcome.
    judge: async ({ gate, cycle, head, changed, changedReason, noCodeRefusal, ledger, lastFix, rescue, base, retry, filingOrigin, intent }) => {
      let captured = null;
      const outcome = await gateRunner.runOneGate({
        gate, cycle, factory, item, head, changed, changedReason, noCodeRefusal, log, ledger, lastFix, rescue, base, retry,
        deps: {
          ...deps,
          filingOrigin,
          saveFlakeIntent: async (draft) => {
            if (deps.acceptsEvidenceOrigin && !deps.acceptsEvidenceOrigin(filingOrigin)) throw new Error("flake filing origin could not be verified");
            const filingIntent = { draft, ...intent.filingIntent };
            const progress = { ...intent.progress, filingIntent };
            captured = { filingIntent, progress };
            if (deps.saveGateProgress) await deps.saveGateProgress({ gate: intent.gate, item, progress, ...(rescue ? { rescue } : {}) });
          },
        },
      });
      return plain({ outcome, intent: captured });
    },
    // The one-shot fix: the launch is recorded on the gate's progress from
    // inside the activity (`onLaunchSave`), and reported back as `launched`.
    fix: async ({ onLaunchSave = null, ...args }) => {
      let launched = null;
      const onLaunch = onLaunchSave
        ? async (l) => {
            launched = { runId: (l && (l.runId || l.run_id)) || null };
            if (!deps.saveGateProgress) return;
            const progress = { ...onLaunchSave.progress, lastFix: { ...onLaunchSave.progress.lastFix, runId: launched.runId || (onLaunchSave.progress.lastFix && onLaunchSave.progress.lastFix.runId) || null } };
            try {
              await deps.saveGateProgress({ gate: onLaunchSave.gate, item, progress, ...(onLaunchSave.rescue ? { rescue: onLaunchSave.rescue } : {}) });
            } catch (e) {
              log(`work: gate ${onLaunchSave.gate.id} progress could not be saved (${(e && e.message) || e}) — a resumed pipeline would restart this gate`);
            }
          }
        : null;
      const r = await deps.fix({ ...args, ...(onLaunch ? { onLaunch } : {}) });
      const { record, ...rest } = r || {};
      return plain({ result: r == null ? r : rest, launched });
    },
    // The one-shot rescue: the launch is recorded on the rescue state from
    // inside the activity, and reported back as `launched`.
    rescue: async ({ onLaunchSave, ...args }) => {
      let launched = null;
      const r = await deps.rescue({
        ...args,
        onLaunch: async (l) => {
          launched = { runId: (l && (l.runId || l.run_id)) || null };
          const rescues = onLaunchSave.rescues.map((e) => ({ ...e }));
          const entry = rescues[onLaunchSave.n - 1];
          if (entry) {
            entry.dispatched = true;
            entry.runId = launched.runId || entry.runId || null;
          }
          if (!deps.saveRescueState) return;
          try {
            await deps.saveRescueState({ item, rescues });
          } catch (e) {
            log(`work: the rescue state of ${item.node_id} could not be saved (${(e && e.message) || e}) — a resumed pipeline would restart from the original pass`);
          }
        },
      });
      const { record, ...rest } = r || {};
      return plain({ result: r == null ? r : rest, launched });
    },
  };
  return { activities };
}

// The ACTIVITIES — what stays bespoke under the kernel. Each is a side effect
// on git, the graph or a harness; the kernel journals its RESULT once, and the
// activity makes the EFFECT idempotent under its key. Documentation and the
// test's checklist, in one table.
const GATE_ACTIVITIES = Object.freeze([
  ["open", "identity: the journaled input (the deps the caller wired, the attempt, the factory definition's digest — a resume whose live digest differs is judged afresh by the driver)"],
  ["pass", "identity: the journaled per-pass input (whether this drive is a resumed one)"],
  ["yield", "identity: the journaled interrupted result handed up before a durable yield"],
  ["checkEvidenceOrigins", "the run record's owed flake evidence and whether it belongs to this graph; a read"],
  ["evidenceOrigin", "this graph's identity for a filing; a read"],
  ["acceptsEvidenceOrigin", "does a saved origin name this graph; a read"],
  ["stopping", "has the worker been asked to stop; a read"],
  ["pinCandidate", "candidate chain: re-pin the tree under judgement — the fold decides relabel vs supersede, so a repeat is `seen`"],
  ["changedPaths", "git: the implementer's diff/head/base against the trusted ref; a read"],
  ["premature", "retype a premature resolving edge as evidence; idempotent on the graph"],
  ["resolved", "the item's resolution as the graph reads it; a read"],
  ["landed", "git: is the run's head contained in the trusted ref; a read"],
  ["commitsLanded", "git: are the item's claimed commits on the trusted ref; a read"],
  ["noCodeClaim", "the run's declared SCOPED: line; a read"],
  ["node", "one graph node by id; a read"],
  ["loadGatePools", "the shared infrastructure pool as the run record holds it; a read"],
  ["saveGatePools", "charge the pool / record a pause or a route; an overwrite of the same stamp"],
  ["stampReviewerCooldown", "the per-lane reviewer cooldown stamp; idempotent for the same until"],
  ["reviewerIndependence", "the fallback reviewer's model family; a read"],
  ["loadRescueState", "the rescue lane's durable entries; a read"],
  ["saveRescueState", "overwrite the rescue entries; idempotent"],
  ["loadGateProgress", "one gate's saved progress; a read"],
  ["saveGateProgress", "overwrite one gate's progress; idempotent"],
  ["saveCarriedProgress", "a carried obligation's receipt onto its own row; idempotent"],
  ["finishFlakeFiling", "file the per-file flake issues a saved intent names (deterministic ids, reconciled against settled state)"],
  ["recordFact", "the art-gate-*/art-rescue-* fact under a deterministic id, if_exists: skip + read-back content comparison"],
  ["readFact", "read an occupied fact id back: is it this record, which occurrence edges are on it"],
  ["linkFact", "an occurrence edge onto an existing fact through the idempotent add_edge door"],
  ["gateEvidenceRecorded", "report a settled gate's evidence to the execution store; the reporter dedups"],
  ["demote", "§10.7: roll the item's completion status back to open while its resolving edge stands"],
  ["escalate", "requires:[human] item under a deterministic id carrying blocks -> the work item; if_exists: skip"],
  ["ancestorOfTip", "git merge-base --is-ancestor (or the caller's reading); a read"],
  ["judge", "ONE gate attempt (runOneGate): the suite on the trusted tree / the review dispatch-and-await / the approval poll; a review adopts its run by name"],
  ["fix", "spor dispatch --force --no-worktree into the run's checkout, ADOPTED BY NAME, then await the run's terminal state (one-shot form)"],
  ["dispatchFix", "the launch half of `fix`: returns the run it started or adopted; the terminal state arrives as signal run:<id>"],
  ["rescue", "the rescue lane's dispatch into the run's checkout, ADOPTED BY NAME, awaited and its diagnosis read (one-shot form)"],
  ["dispatchRescue", "the launch half of `rescue`; the terminal state arrives as signal rescue-run:<id>"],
  ["rescueReport", "read the finished rescue run's structured diagnosis; a read"],
  // signals and timers, not activities — what the workflow awaits:
  ["signal run:<id>", "a dispatched fix run's terminal state, delivered by the driver"],
  ["signal rescue-run:<id>", "a dispatched rescue run's terminal state, delivered by the driver"],
  ["timer wait", "one slice of an outage backoff or an in-process reviewer wait (the driver sleeps it and re-drives)"],
  ["timer yield", "the durable yield behind an interrupted hand-up (a stop, a reviewer pause — whose wake IS the timer — pending evidence)"],
]);

// A kernel failure that means "this attempt's journal is not this worker's
// to continue": the definition it opened under changed, the journal was
// recorded by another version, or a predecessor tombstoned it. The gate list's
// own rules re-judge a moved definition and resume through the record, so the
// driver answers every one of these the same way: a fresh in-memory journal.
function unresumable(error) {
  return stageWorkflow.unresumable(error) || stageWorkflow.isTombstoned(error);
}

// A REPLAY FAULT: the recorded key sequence no longer matches the code path,
// which — now that every input the workflow branches on is journaled — is a
// bug in the workflow function, never an operator's situation. The driver
// still judges afresh (the record-based resume is the behaviour before this
// file existed, and a wedged pipeline helps nobody) but says so in its own
// words, so the line is greppable as the defect it is.
function replayFault(error) {
  return stageWorkflow.replayFault(error);
}

// The DRIVER: runGatePipeline's contract over the workflow. Builds the
// Execution over the caller's journal handle (`deps.workflowJournal`, a
// function returning {journal, persist} — lib/shell/execution-store.js's
// openWorkflowJournal — or absent, which runs the pipeline over an in-memory
// journal exactly as before the kernel existed), drives it to a settled
// state, and maps the kernel's outcomes back to the pipeline's results:
//   completed             -> the workflow's result, as the runner returned it
//   suspended on a yield  -> the journaled `interrupted` result
//   suspended on a wait   -> sleep the slice (deps.sleep) and run again
//   suspended on run:<id> -> deliver the run's terminal state (deps.awaitRun)
//                            and run again — in-process, so the slot is held
//                            exactly as the one-shot fix held it
//   failed                -> rethrown, as a thrown dep threw out of the runner
// A journal whose persist poisoned the Execution is re-opened and re-driven
// (bounded); one this worker cannot continue is judged over a fresh in-memory
// journal (see `unresumable`).
async function driveGatePipeline({ item, factory, deps, log = () => {} }) {
  const { activities } = bindGateActivities(deps, { item, factory, log });
  const driver = { parked: null };
  const input = { item, factory, deps, log, driver };
  const clock = { now: typeof deps.now === "function" ? deps.now : () => Date.now() };
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const openHandle = typeof deps.workflowJournal === "function" ? deps.workflowJournal : null;
  const exec = (handle) =>
    new Execution(gateWorkflow, input, {
      journal: handle && Array.isArray(handle.journal) ? handle.journal : [],
      persist: handle && typeof handle.persist === "function" ? handle.persist : null,
      clock,
      activities,
      workflow: WORKFLOW_NAME,
      version: WORKFLOW_VERSION,
    });
  let fresh = !openHandle;
  let runs = 0;
  // A journal this worker cannot continue is judged over a fresh in-memory
  // journal — the record-based resume, exactly as before this file existed.
  const judgeAfresh = (why) => {
    fresh = true;
    log(`work: the gate workflow journal for ${item.node_id} ${why} — judging over a fresh in-memory journal; the run record's gate progress carries the resume`);
    return { exec: exec(null) };
  };
  return stageWorkflow.driveStage({
    label: "gate",
    nodeId: item.node_id,
    log,
    open: () => exec(openHandle ? openHandle() : null),
    reopenable: () => !!openHandle && !fresh,
    onFailed: (error, e) => {
      // A failure the journal REPLAYED (an activity that threw out of the
      // workflow on an earlier drive): before the journal existed the next
      // resume re-ran that step live, so it does here too. Read FIRST: a
      // replayed failure carries the original error's name, which the two
      // readings below match on.
      if (!fresh && error && error.replayed === true) return judgeAfresh(`replays a step that threw on an earlier drive (${error.message})`);
      if (!fresh && unresumable(error)) return judgeAfresh(`cannot be continued by this worker (${error.message})`);
      if (!fresh && replayFault(error)) {
        // The gate list's key sequence is a function of the LIVE factory (the
        // gates it iterates, their kinds and cycle caps), so a journal still
        // being REPLAYED under an edited definition diverges before the
        // live-step guard ever runs. Read against the journaled binding: a
        // digest that moved is the definition changing, not a determinism bug.
        const opened = (e.journal || []).find((j) => j && j.kind === "effect" && typeof j.key === "string" && j.key.startsWith(`${item.run_id}/gates/`) && /\/open(#\d+)?$/.test(j.key));
        const journaled = opened && opened.result ? opened.result.digest : null;
        const live = definitionBindingDigest(factory);
        if (journaled && journaled !== live) return judgeAfresh(`cannot be continued by this worker (the factory definition changed while ${item.node_id}'s gate pipeline was in flight — the journal opened under ${journaled} and the factory now reads ${live})`);
        return judgeAfresh(`hit a REPLAY FAULT — a determinism bug in the gate workflow, please report it (${error.message})`);
      }
      return undefined;
    },
    onSuspended: async (r, e) => {
      runs += 1;
      if (r.kind === "timer") {
        // A yield's parked result is handed up; a wait slice is slept and
        // the Execution run again (the parked slot cleared for that run).
        if (driver.parked) return { result: driver.parked };
        await sleep(Math.max(1, r.detail.fireAt - clock.now()));
        driver.parked = null;
        return undefined;
      }
      const m = /^(run|rescue-run):(.+)$/.exec(String(r.detail && r.detail.name));
      if (!m || typeof deps.awaitRun !== "function") throw new Error(`the gate workflow suspended on signal '${r.detail && r.detail.name}' with no way to deliver it`);
      // An ORPHAN adopted mid-await (the loop marks it `resumed`; the journal
      // ends on a run this worker never dispatched): the record-based resume
      // stays the door for it in this slice — it re-runs the pass with the
      // supersession check a resumed pipeline owes (a person may have hand-landed
      // the item while no worker watched, WORKERS.md §10.8), and the dispatch door
      // adopts the very same run by name, so nothing is launched twice. A journal
      // continued past that await would skip the check. It is this case exactly
      // when the drive's FIRST run executed NOTHING live before suspending — a
      // pure replay that ended on the await — since a dispatch this drive made
      // is an executed activity (and a later run of the drive is always one).
      // `runs` counts SUSPENSIONS, so a poisoned first run that was re-opened
      // does not consume one: the re-opened Execution's first suspension is
      // still read as "the drive's first run".
      if (runs === 1 && item.resumed && !fresh && e.executedEffects === 0) return judgeAfresh(`ends awaiting run ${m[2]} dispatched by another worker`);
      let done = null;
      try {
        done = await deps.awaitRun({ runId: m[2], lane: m[1] === "rescue-run" ? "rescue" : "fix" });
      } catch (err) {
        done = { ok: false, reason: `${(err && err.message) || err}` };
      }
      const { record, ...payload } = done || {};
      // A poisoned delivery is re-opened by the drive loop (bounded).
      e.signal(r.detail.name, plain({ ...payload, ok: !!(done && done.ok), reason: (done && done.reason) || null }));
      driver.parked = null;
      return undefined;
    },
  });
}

module.exports = {
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  YIELD_MS,
  GATE_ACTIVITIES,
  depsShape,
  definitionBindingDigest,
  gateWorkflow,
  bindGateActivities,
  driveGatePipeline,
  unresumable,
  replayFault,
  UNFOLLOWABLE_FIX_NO_RESCUE_WHY,
};
