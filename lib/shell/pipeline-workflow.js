// shell/pipeline-workflow.js — THE PIPELINE as one workflow function over one
// journal (task-spor-fold-gate-and-integration-into-one-workflow, slice 5 of
// task-spor-gate-pipeline-as-workflow-kernel).
//
// bin/spor.js `runGateAndIntegration` used to be ~370 lines of imperative glue
// BETWEEN the three stage workflows: own the pipeline, run the implementation
// stage, judge the gate list, stamp the split verdict, write the completion
// at the `gates` boundary, run the integration stage with its re-gate door,
// stamp its verdict, write the completion at the `integration` boundary,
// settle the record and attest. Each stage was a durable workflow; the glue
// was not — a worker that died between two stages left the record's
// `gates_state`, the completion write or the settle to whatever the next
// adopter happened to re-derive. This module is that glue as a deterministic
// function of (input, journal) over lib/kernel/workflow.js:
//
//   - every side effect is a `ctx.run` activity keyed on the run id and the
//     pipeline attempt (`<run>/pipeline/a<attempt>/...`) — the stage drivers
//     themselves are activities (`implementation`, `gates`, `integration`),
//     each still driving its OWN child journal (`implementation-a<n>`,
//     `gates-a<n>`, `integration-a<n>`, `gates-regate-<head>-a<n>`), so a
//     child's at-least-once re-run after a crash replays its journal to the
//     same result instead of re-judging;
//   - a child's `interrupted` hand-up is a durable YIELD of the parent: the
//     result is journaled (`…/<stage>/p<n>/yield`), a timer set to the child's
//     own wake (`paused_until`, else a short one), and the parent SUSPENDS —
//     the driver hands the parked result up, the loop frees the slot and
//     re-offers the pipeline when the timer is due (work-loop.js
//     openPipelines reads the parent journal like any stage's), and the
//     re-driven parent runs the stage's NEXT PASS (`p<n+1>`) over the same
//     child journal;
//   - the regate child's journal key is a JOURNALED INPUT of the parent
//     (`open.stages.regate`): the integration activity is handed the
//     prefix and attempt the `open` entry recorded, so a resumed parent names
//     the same child journal for the same head whatever the live entry says
//     (the slice 4b orchestrator note);
//   - the binding (`controller`, the completion boundary, which stages the
//     factory declares, the attempt) is journaled by `open` and every branch
//     below reads the JOURNALED copy — so a replay under an edited factory
//     branches exactly as the recording did; the stages enforce their own
//     definition bindings (and a stage activity whose block the live factory
//     no longer declares settles a tagged refusal rather than throwing).
//
// Ownership stays outside the function: the pipeline LEASE (claimPipeline /
// renewPipeline / releasePipeline, the journaled `pipeline.jsonl`) and the
// execution store's reporter are live resources the DRIVER takes before a
// drive and releases after it, exactly as the integration stage keeps its
// candidate tree and lease token out of its journal. The parent's lease is
// RENEWED from inside the children's long waits (every `sleep` slice the
// deps take — the review await, the fix-cycle await, the outage backoff,
// the approval poll — renews it, throttled) so a stalled-but-live worker
// past the lease TTL is never double-driven.
//
// JOURNAL-FORMAT DISCIPLINE (also in CLAUDE.md): a new REQUIRED entry (a
// step the function asks for in sequence) or a new BINDING input bumps
// WORKFLOW_VERSION — a journal of the old version is driven over a fresh
// in-memory journal (the children carry the real state; see the driver);
// an OPTIONAL, backward-readable field on an existing entry's result does not.
"use strict";

const crypto = require("node:crypto");

const { Execution } = require("../kernel/workflow.js");
const stageWorkflow = require("./stage-workflow.js");

const WORKFLOW_NAME = "spor.pipeline";
// "2": the `leave` activity is preceded by a journaled clock read
// (`…/leave/now`) whose value is the settle's verdict time — a new REQUIRED
// entry (issue-spor-slice5-leave-not-idempotent-and-regate-stamps-unowned).
const WORKFLOW_VERSION = "2";
// A yield's timer when the child's interrupted result names no wake of its
// own. The PARENT's yield is paced by its children's: the loop re-offers a
// parked pipeline at the latest open stage's `due` (stage-projection.js
// projectRun `current`, the child's own yield timer or a reviewer's stated
// reset), so this timer only has to be in the past by the time any re-drive
// arrives — one tick, never a pace of its own. The yield is the kernel's
// `yieldUntil`, which SUSPENDS ONCE whatever the clock reads (a plain
// `sleepUntil` at one tick would not suspend at all under a real clock, and
// the parent would spin into the stage's next pass inside the same drive).
const YIELD_MS = 1;

const { plain } = stageWorkflow;

// Every activity the function may ask for, with what it does — the deps the
// driver binds (bin/spor.js runGateAndIntegration builds them over cfg, the
// record and the reporter).
const PIPELINE_ACTIVITIES = Object.freeze([
  ["open", "journal the binding: controller completion, the boundary, which stages the factory declares, the attempt, the child journal names (the regate child's key included), the clock"],
  ["implementation", "drive the implementation stage over its own child journal (`stage` names it); its result"],
  ["withdraw", "an `unroutable` implementation stage: end the execution and clear the hold (withdrawHeldExecution)"],
  ["gates", "drive the gate list over its own child journal; its result as the runner returned it"],
  ["stampGatesState", "the split verdict's first half on the run record (`gates_state`, `completion_facts`)"],
  ["completeAtGates", "the controller's completion write at the `gates` boundary"],
  ["integrationStart", "`integration_state: running` on the record and the store's integrationStarted event"],
  ["integration", "drive the integration stage over its own child journal, the re-gate door wired to the journaled child key; {intResult, gateResult, gateFacts} as they stand after any re-gate"],
  ["stampIntegrationState", "the split verdict's second half (`integration_state`, `completion_facts`) and the store's integrationSettled event"],
  ["completeAtIntegration", "the controller's completion write at the `integration` boundary"],
  ["reconcileLanded", "landed-work detection over the landed range (reconcileAfterLand)"],
  ["leave", "settle the run record (compare-and-swap on the lease token) at the journaled `at`, attest, refresh a parked proposal's PR body; idempotent per lease token — a re-run after the settle landed but before its result was journaled returns the record's verdict unchanged and skips what already ran; the pipeline's result"],
  ["yield", "a child's interrupted hand-up, journaled before the parent suspends (identity)"],
  ["settled", "the journal's closing entry: the pipeline's final state (identity)"],
]);

// The deps shape the driver binds. `yield` and `settled` are the parent's own.
function bindPipelineActivities(deps) {
  const act = (name) => {
    const fn = deps[name];
    if (typeof fn !== "function") throw new TypeError(`the pipeline workflow needs deps.${name}`);
    return async (args) => plain(await fn(args));
  };
  return {
    open: act("open"),
    implementation: act("implementation"),
    withdraw: act("withdraw"),
    gates: act("gates"),
    stampGatesState: act("stampGatesState"),
    completeAtGates: act("completeAtGates"),
    integrationStart: act("integrationStart"),
    integration: act("integration"),
    stampIntegrationState: act("stampIntegrationState"),
    completeAtIntegration: act("completeAtIntegration"),
    reconcileLanded: act("reconcileLanded"),
    leave: act("leave"),
    yield: (args) => plain(args),
    settled: (args) => plain(args),
  };
}

// The binding digest: sha256 over the canonical JSON of the bound inputs —
// what `open` journals, so a resumed drive can tell a journal recorded under
// another binding (reported in the log; the stages enforce their own).
function bindingDigest(binding) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canon(binding))).digest("hex")}`;
}

// The child journal names for a pipeline attempt — the ONE place they are
// spelled, journaled by `open` so a replay drives the same children.
function stageNames(attempt) {
  const a = Math.max(0, Number(attempt) || 0);
  return {
    implementation: `implementation-a${a}`,
    gates: `gates-a${a}`,
    integration: `integration-a${a}`,
    // The re-gate child's key as a journaled input: `<prefix><head>-a<attempt>`
    // (bin/spor.js regateStageName spells the head half and refuses a
    // non-hex head).
    regate: { prefix: "gates-regate-", attempt: a },
  };
}

// What the pipeline reports for a refused implementation stage (every
// non-candidate verdict but `unroutable`'s hold release, which `withdraw`
// does): the shape runGateAndIntegration always returned for it.
function implementationRefusal(stage) {
  const state = stage.state === "interrupted" ? "interrupted" : "failed";
  return {
    state,
    gates: [],
    facts: [],
    reason: `implementation stage ${stage.state}: ${stage.reason || ""}`.trim(),
    stage: stage.state,
    escalated_to: stage.escalated_to || null,
    demoted: false,
    demote_reason: null,
    ...(stage.escalation_failed ? { escalation_failed: true } : {}),
    ...(stage.escalation_retry ? { escalation_retry: stage.escalation_retry } : {}),
    ...(stage.paused_until ? { paused_until: stage.paused_until } : {}),
    ...stageWorkflow.carryRefusalTags(stage),
  };
}

// The interrupted result the integration stage's hand-up becomes at the
// pipeline level (the gate list's facts carried beside the stage's).
function integrationInterrupted(intResult, gateResult, gateFacts) {
  return {
    state: "interrupted",
    ...(intResult.outage_interrupted ? { outage_interrupted: true } : {}),
    ...(intResult.paused_until ? { paused_until: intResult.paused_until, paused_profile: intResult.paused_profile || null } : {}),
    ...(intResult.fallback_route ? { fallback_route: true } : {}),
    gates: (gateResult && gateResult.gates) || [],
    facts: [...(gateFacts || []), ...(intResult.facts || [])],
    reason: intResult.reason,
  };
}

// THE WORKFLOW FUNCTION. `input` is {item, binding, log}; every decision below
// reads journaled data (the `open` result and the activities' results).
async function pipelineWorkflow(ctx, input) {
  const { item, log = () => {} } = input;
  const attempt = Math.max(0, Number(item && item.attempt) || 0);
  const K = (...parts) => [`${item.run_id}/pipeline/a${attempt}`, ...parts].join("/");
  const live = () => !ctx.isReplaying();
  const say = (line) => {
    if (live()) log(line);
  };

  const binding = plain(input.binding) || {};
  const open = await ctx.run(K("open"), "open", { ...binding, digest: bindingDigest(binding), stages: stageNames(attempt) });
  const b = { ...binding, ...open };
  const stages = (open && open.stages) || stageNames(attempt);

  // A child's interrupted hand-up: journaled, then a durable timer the parent
  // suspends on (the parked result rides the Suspend's meta for the driver).
  const yieldInterrupted = async (scope, result) => {
    const parked = await ctx.run(K(...scope, "yield"), "yield", result);
    const at = ctx.now(K(...scope, "yield", "now"));
    const pausedUntil = parked && parked.paused_until ? (typeof parked.paused_until === "number" ? parked.paused_until : Date.parse(parked.paused_until)) : NaN;
    ctx.yieldUntil(K(...scope, "yield", "timer"), Number.isFinite(pausedUntil) && pausedUntil > at + YIELD_MS ? pausedUntil : at + YIELD_MS, { parked });
  };
  // Drive one stage until it hands up something other than `interrupted`,
  // yielding the parent between passes.
  const stateOf = (res) => (res && res.intResult ? res.intResult.state : res && res.state);
  // `parked(res, args)` shapes a child's interrupted result into the
  // pipeline-level result the driver hands the loop (what runGateAndIntegration
  // always returned for that stage's interruption).
  const passes = async (name, args, parked) => {
    for (let n = 0; ; n += 1) {
      const scope = [name, `p${n}`];
      const res = await ctx.run(K(...scope), name, { ...args, pass: n });
      if (!res || stateOf(res) !== "interrupted") return res;
      await yieldInterrupted(scope, parked ? parked(res, args) : res);
    }
  };
  // The `leave` activity at a JOURNALED clock read: the verdict's time is
  // part of the record the settle writes, so it is read once, journaled, and
  // handed in — an at-least-once re-run of `leave` (its result never reached
  // the journal) settles at the same instant, never a fresh `new Date()`.
  const leave = async (args) => {
    const at = ctx.now(K("leave", "now"));
    return ctx.run(K("leave"), "leave", { ...args, at });
  };
  const settle = async (result) => {
    await ctx.run(K("settled"), "settled", { state: (result && result.state) || "failed" });
    return result;
  };

  // THE IMPLEMENTATION STAGE (before any gate; gated on a declared stage
  // under controller completion — the journaled reading).
  if (b.hasImplementation) {
    const stage = await passes("implementation", { stage: stages.implementation }, (res) => implementationRefusal(res));
    if (!stage || stage.state !== "candidate") {
      const st = stage || { state: "escalated", reason: "the implementation stage returned nothing" };
      if (st.state === "unroutable") await ctx.run(K("implementation", "withdraw"), "withdraw", { reason: st.reason || "the implementer could not be re-dispatched" });
      return settle(implementationRefusal(st));
    }
    if (stage.handoff) say(`work: ${item.node_id} — implementation stage hands the run to the gates: ${stage.handoff}`);
  }

  // THE GATE LIST.
  let gateResult = await passes("gates", { stage: stages.gates });
  let gateFacts = [...((gateResult && gateResult.facts) || [])];
  await ctx.run(K("gates", "stamp"), "stampGatesState", { state: gateResult.state, facts: gateFacts });
  let completed = null;
  if (b.controller && b.boundary === "gates" && gateResult.state === "passed") {
    completed = await ctx.run(K("gates", "complete"), "completeAtGates", { facts: gateFacts });
  }
  if (gateResult.state !== "passed" || !b.hasIntegration) {
    const left = await leave({ result: gateResult, gateResult, gateFacts, intResult: null });
    return settle(left);
  }

  // THE INTEGRATION STAGE. `completedBeforeIntegration`: the item is already
  // completed by declaration (`after: gates`), so a landing failure files a
  // `relates-to` item and never demotes — `consumed` counts too.
  const completedBeforeIntegration = !!(completed && completed.ok && (completed.settled === "written" || completed.settled === "consumed"));
  await ctx.run(K("integration", "start"), "integrationStart", {});
  const outcome = await passes("integration", { stage: stages.integration, regate: stages.regate, completedBeforeIntegration, gateResult, gateFacts }, (res, args) => integrationInterrupted(res.intResult, res.gateResult || args.gateResult, res.gateFacts || args.gateFacts));
  const intResult = outcome.intResult;
  gateResult = outcome.gateResult || gateResult;
  gateFacts = outcome.gateFacts || gateFacts;
  const allFacts = [...gateFacts, ...(intResult.facts || [])];
  const stamped = await ctx.run(K("integration", "stamp"), "stampIntegrationState", { intResult: { state: intResult.state, ref: intResult.ref || null, commit: intResult.commit || intResult.sha || null }, facts: allFacts });
  const intState = (stamped && stamped.state) || intResult.state;
  if (b.controller && b.boundary === "integration" && intState === "landed") {
    await ctx.run(K("integration", "complete"), "completeAtIntegration", { facts: allFacts });
  }
  if (intState === "landed" && b.reconcileLanded) {
    await ctx.run(K("integration", "reconcile"), "reconcileLanded", { ref: intResult.target_ref || null, targetSha: intResult.target_sha || null, landedSha: intResult.landed_sha || null });
  }
  const result =
    completedBeforeIntegration && intResult.state !== "passed" && intResult.state !== "parked"
      ? { ...intResult, gates: gateResult.gates, gate_head: gateResult.head || null, facts: allFacts, demoted: false, demote_reason: null, reason: `${intResult.reason || intResult.state} (the item was completed at the 'gates' boundary and stays completed; the landing is a person's to finish)` }
      : { ...intResult, gates: gateResult.gates, gate_head: gateResult.head || null, facts: allFacts };
  const left = await leave({ result, gateResult, gateFacts, intResult });
  return settle(left);
}

// THE DRIVER. `deps` is the activities table above plus the optional
// `workflowJournal` (a function returning {journal, persist}) and `now`.
// Returns the pipeline's result — the `leave` activity's, or a child's
// interrupted hand-up (the parent suspended on its yield timer). A journal
// this code cannot continue — another version, a replay fault — is NOT
// refused: the children hold the real state and their own bindings, so the
// parent logs it and drives over a fresh in-memory journal (the gate list's
// own fallback rule).
async function drivePipeline({ item, binding, deps, log = () => {} }) {
  const activities = bindPipelineActivities(deps);
  const input = { item, binding, log };
  const clock = { now: typeof deps.now === "function" ? deps.now : () => Date.now() };
  const openHandle = typeof deps.workflowJournal === "function" ? deps.workflowJournal : null;
  let fresh = false;
  const exec = (handle) =>
    new Execution(pipelineWorkflow, input, {
      journal: handle && Array.isArray(handle.journal) ? handle.journal : [],
      persist: handle && typeof handle.persist === "function" ? handle.persist : null,
      clock,
      activities,
      workflow: WORKFLOW_NAME,
      version: WORKFLOW_VERSION,
    });
  return stageWorkflow.driveStage({
    label: "pipeline",
    nodeId: item.node_id,
    log,
    open: () => exec(openHandle && !fresh ? openHandle() : null),
    reopenable: () => !!openHandle && !fresh,
    onFailed: async (error) => {
      if (fresh) return undefined;
      if (stageWorkflow.isVersionMismatch(error) || stageWorkflow.isTombstoned(error) || stageWorkflow.replayFault(error)) {
        log(`work: the pipeline journal for ${item.node_id} (run ${String(item.run_id).slice(0, 8)}) cannot be continued by this worker (${error.message}) — the stages are driven from their own journals over a fresh pipeline journal`);
        fresh = true;
        return { exec: exec(null) };
      }
      return undefined;
    },
    onSuspended: async (r) => {
      if (r.kind === "timer") {
        const parked = r.detail.meta && r.detail.meta.parked;
        return { result: parked || { state: "interrupted", gates: [], facts: [], reason: `the pipeline is yielded until ${new Date(r.detail.fireAt).toISOString()} and resumes on the next pass`, paused_until: new Date(r.detail.fireAt).toISOString() } };
      }
      throw new Error(`the pipeline workflow suspended on signal '${r.detail && r.detail.name}' with no way to deliver it`);
    },
  });
}

module.exports = {
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  YIELD_MS,
  PIPELINE_ACTIVITIES,
  bindPipelineActivities,
  bindingDigest,
  stageNames,
  implementationRefusal,
  integrationInterrupted,
  pipelineWorkflow,
  drivePipeline,
};
