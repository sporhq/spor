// shell/integration-workflow.js — the INTEGRATION STAGE as ONE deterministic
// workflow function over the replay kernel (lib/kernel/workflow.js;
// task-spor-integration-stage-as-workflow-function, the first per-stage slice
// of task-spor-gate-pipeline-as-workflow-kernel under
// dec-spor-gate-pipeline-durable-workflow-model-zero-dep-kernel-first).
//
// What changed and what did not. integration-runner.js's runIntegrationStage
// used to BE the control flow: a loop over deps calls with the stage's whole
// memory (attempts, cycles, races, the evidence chain, the pinned candidate)
// in local variables that a crash threw away, so a resumed pipeline re-ran the
// stage from nothing and leaned on each dep's own idempotency (adopt-by-name
// for a fix, if_exists:skip for a fact, a git CAS) to not double anything.
// The control flow is the SAME here — every rule the runner enforced is kept,
// and the existing integration suite drives it unchanged — but it is now a
// function of (input, journal):
//
//   - every deps call is `ctx.run(key, activity, args)`, journaled under a
//     key derived from the ids the stage already mints (the run id, the
//     attempt, the fact id, the blocker id), so a resumed worker replays the
//     recorded RESULT and never re-executes a step that landed;
//   - the fix cycle's run-terminal wait is a SIGNAL (`run:<id>`): the dispatch
//     is journaled with the run it launched, the workflow suspends on the
//     run's terminal state, and a worker that died mid-fix resumes awaiting the
//     SAME run (never dispatching a second — the journal holds the run id
//     before the await, and dispatch is adopt-by-name underneath,
//     dec-spor-adopt-by-name-returns-existing);
//   - the two UNSETTLED hand-ups the runner returned as `interrupted` — a ci
//     candidate suite nobody judged (an outage), and a re-gate a stop caught
//     mid-outage or on pending evidence — are a durable YIELD: the interrupted
//     result is journaled, the lease released and the candidate torn down
//     (both journaled), and the workflow suspends on a timer. The driver hands
//     that result up exactly as before, so the work loop's bounded re-offer
//     is still the scheduler; what the journal adds is that the re-driven
//     workflow continues from the yield — the next attempt, a fresh tree read,
//     a re-gate retried under a new key — instead of replaying the same
//     outage verdict forever or starting from nothing;
//   - the clock is journaled (`ctx.now`): a replayed fact carries the date it
//     was first written under, and a rebuilt result is byte-identical.
//
// What stays bespoke is the ACTIVITIES table at the bottom: each is a side
// effect on git, the graph or a harness, and each must be idempotent under
// its key, because the kernel records a result once but the effect is
// at-least-once (a crash between executing and journaling re-runs it). The
// binding (`bindIntegrationActivities`) also keeps the stage's LIVE resources
// — the candidate worktree's cleanup closure, the serialize lease's token —
// out of the journal (a closure cannot be replayed) and hands them to the
// driver to release on the way out, exactly as the runner's finally blocks
// did.
//
// Determinism rules this file holds to, so that live and replayed runs take
// the same branch:
//   - every decision reads journaled data only — the activities' results, the
//     journaled clock, and the journaled INPUT (`open`: the gated head and the
//     deps the caller wired), never `Date.now()` or a live `typeof deps.x`;
//   - every activity result is JSON-plain (the binding round-trips it), so a
//     live result and its replay are the same value;
//   - a log line is a NON-journaled side effect held to the live portion of a
//     run (`ctx.isReplaying()`), never re-emitted on resume;
//   - a kernel control throw (a suspend, a replay fault) passes through every
//     try/finally UNTOUCHED (`isControlFlow`): a journaled step taken on the
//     way out of a suspend would land out of order and poison the next resume.
//
// The DEFINITION this attempt judges under is BOUND, and a change to it fails
// CLOSED (task-spor-integration-workflow-merge-gate-fixes). The `open`
// activity journals a digest of the factory's `integration` block, its
// `trustedRef` and its `protectedPaths`, and every resume compares the live
// factory's digest against it before the next LIVE kernel step (the shared
// rule of every stage, lib/shell/stage-workflow.js guardedKernel — a journal
// that already holds the attempt's whole story replays to its result
// whatever the live factory reads): a mismatch throws `NonDeterminism`
// (tagged `definitionMismatch`) before that step is journaled, and the driver
// settles the ATTEMPT as refused — an escalation, a demotion and a fact,
// written outside the journal — never a land. The refusal is TERMINAL for that journal
// (task-spor-integration-refusal-tombstones-journal): the driver writes the
// kernel's tombstone entry FIRST, so a later resume — the factory reverted,
// or a crash between tombstone and settle — re-settles the same refusal
// under the same ids and never continues the attempt. Why not keep judging under the journaled copy: the workflow's
// branches could read the journaled block, but the ACTIVITIES behind them
// (gate-deps.js's makeIntegrationDeps closures) run the live factory's suite
// command, force the live trusted ref's copy of the protected paths and push
// the live ci definition — a resumed attempt would mix two definitions, and
// rebuilding the activities from the snapshot would run an old suite command
// against a changed factory instead. A fresh attempt (`spor work --regate
// <run>`) judges under the current definition, over its own journal.
"use strict";

const gates = require("../kernel/gates.js");
const { Execution, isControlFlow } = require("../kernel/workflow.js");
const gateRunner = require("./gate-runner.js");
const integrationRunner = require("./integration-runner.js");
const stageWorkflow = require("./stage-workflow.js");
const { plain } = stageWorkflow;

const WORKFLOW_NAME = "integration";
// "2": the `open` entry carries the definition binding (`trustedRef` +
// `digest`); a journal recorded by "1" is refused as a version mismatch and
// its attempt settled the same way a definition mismatch is (the driver).
const WORKFLOW_VERSION = "2";

// The definition binding: what a resumed attempt must still be judging
// under. The integration block (mode, strategy, target ref, command, cycles,
// reruns, ci…), the trusted ref the activities force the protected paths
// from, and the factory's protected paths themselves — the three inputs
// makeIntegrationDeps' closures read LIVE (`integration`, `factory.trustedRef`,
// `factory.protectedPaths`). Hashed over the canonical JSON
// (gates.definitionDigest), so key order and an absent-vs-null field never
// read as an edit.
function definitionBindingDigest(factory) {
  const f = factory || {};
  return gates.definitionDigest({ integration: f.integration || null, trustedRef: f.trustedRef || null, protectedPaths: f.protectedPaths || null });
}

// The fail-closed throw (stage-workflow.js definitionMismatchError): a
// NonDeterminism tagged so the driver can tell it from a genuine key-sequence
// fault and settle the attempt.
const STAGE_WHAT = "its integration block, trusted ref or protected paths";
function definitionMismatchError({ nodeId, runId, journaled, live }) {
  return stageWorkflow.definitionMismatchError({ stage: "integration", what: STAGE_WHAT, nodeId, runId, journaled, live });
}


// A yield's timer. The yield exists to hand the slot back — the interrupted
// result is reported and the work loop re-offers the pipeline on its own
// retry window (`work.retryAfterMs`, minutes) — so the timer only has to be
// past by the time any re-drive arrives, never to pace it; one second is
// that, and short enough that a test driver advancing a fake clock is not
// waiting on anything real.
const YIELD_MS = 1000;

// Which of the optional deps the caller wired — journaled as part of the
// input so a replay branches exactly as the live run did, whatever the deps
// object looks like on the resuming worker.
function depsShape(deps) {
  const fn = (k) => typeof deps[k] === "function";
  return {
    demote: fn("demote"),
    forceProtected: fn("forceProtected"),
    closeSuite: fn("closeSuite"),
    cleanupImplementer: fn("cleanupImplementer"),
    releaseLease: fn("releaseLease"),
    pinCandidate: fn("pinCandidate"),
    tipCandidate: fn("tipCandidate"),
    candidateStanding: fn("candidateStanding"),
    regate: fn("regate"),
    completedBeforeIntegration: deps.completedBeforeIntegration === true,
    // The fix cycle as dispatch + signal needs both halves: a launcher that
    // returns the run it started (or adopted) and a driver-side wait that
    // delivers the run's terminal state. A one-shot `fix` WINS over them
    // unless it is their own composition (gate-deps tags it
    // `composedOfSignals`): a caller that overrides `fix` on the real deps
    // means that fix, not the halves it did not touch.
    fixSignals: fn("dispatchFix") && fn("awaitRun") && (!fn("fix") || deps.fix.composedOfSignals === true),
  };
}

// The workflow function. `input` is {item, factory, gatedHead, log, driver}:
// `log` is the caller's logger (held to the live portion of a run), `driver`
// a side channel the driver reads a yielded result from (it is journaled
// too, so a resumed driver that lands on the same timer finds it again).
async function integrationWorkflow(ctx, input) {
  const { item } = input;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const K = (...parts) => [runId, "integration", ...parts].join("/");
  const log = (line) => {
    if (!ctx.isReplaying() && typeof input.log === "function") input.log(line);
  };
  const { buildIntegrationFact, integrationFactId, INTEGRATION_STAGE_ID, RACE_RETRY_CAP } = integrationRunner;

  // The journaled INPUT: the head the gates judged, the deps the caller
  // wired, the gate attempt, and the DEFINITION this execution judges under
  // (the integration block, the trusted ref, whether an implementation stage
  // is declared, the factory's id and definition digest, and the BINDING
  // digest over the first two). Every branch below reads these journaled
  // copies, never the live factory, so the key sequence is a function of the
  // journal — and the binding digest is what makes that honest: a factory
  // edited between a crash and the resume is REFUSED below rather than
  // judged under a journaled block whose activities would run the live one.
  // A pipeline resumed after an interruption may likewise be handed a
  // different gated head (the gate list re-judged a moved checkout before
  // calling this stage again); the replay keeps the one this execution
  // opened with and the fresh tree read after the yield is what reconciles
  // the two.
  const live = input.factory || {};
  const liveDigest = definitionBindingDigest(live);
  const opened = await ctx.run(K("open"), "open", {
    gatedHead: input.gatedHead || null,
    has: depsShape(input.deps || {}),
    attempt: item.attempt || 0,
    integration: live.integration || null,
    trustedRef: live.trustedRef || null,
    digest: liveDigest,
    implementation: !!live.implementation,
    factoryId: live.id || null,
    definition: live.definition || null,
  });
  // FAIL CLOSED on a definition edited between attempts — but only at the
  // moment this execution would take a LIVE step (the shared rule of every
  // stage, stage-workflow.js guardedKernel). The journal is bound to the
  // definition it opened under, the activities to the live one, and the two
  // must be the same thing before any step EXECUTES rather than replays: a
  // journal that already holds the attempt's whole story (a landed or parked
  // attempt the pipeline is re-entered over on an orphan resume) replays to
  // its settled result whatever the live definition reads, while one parked
  // mid-attempt refuses before its next activity, clock read, timer or
  // signal wait is journaled — so the WORKFLOW appends nothing under a mixed
  // definition (a signal DELIVERY is not a step: a fix run already in flight
  // may still end, and its terminal state lands in the journal before the
  // refusal). What the DRIVER then does is terminal: it tombstones the
  // journal before settling the refusal (`refuseUnresumable`), so "a journal
  // re-driven under the ORIGINAL definition continues exactly where it
  // stopped" holds ONLY for a journal that never refused — a bare Execution
  // (no driver) that threw here is still resumable, a driven one is closed
  // for good.
  ctx = stageWorkflow.guardedKernel(ctx, { journaled: opened.digest, live: liveDigest, mismatch: () => definitionMismatchError({ nodeId, runId, journaled: opened.digest, live: liveDigest }) });
  const gatedHead = opened.gatedHead;
  const has = opened.has;
  const integration = opened.integration;
  const gateAttempt = opened.attempt;
  const factory = { id: opened.factoryId, definition: opened.definition, implementation: opened.implementation, integration };

  const attempts = [];
  const facts = [];
  // A passing re-gate's own result and facts, carried on the stage's result:
  // the caller's `regate` dep merges them into the pipeline's result as a
  // SIDE EFFECT of running, which a resumed worker replaying the re-gate
  // never performs — so the result carries what the replay knows.
  let regateResult = null;
  const regateFacts = [];
  const startedAt = ctx.now(K("start"));
  // The evidence chain the fact and the stage's result carry — filled in as
  // the stage learns it (the re-read head, the target's tip, the landed sha).
  const chain = { head: null, gatedHead: gatedHead || null, targetSha: null, landedSha: null, candidate: null, definition: factory.definition || null };
  let exits = 0;
  const withChain = (result) => {
    const finishedAt = ctx.now(K("exit", ++exits));
    return {
      ...result,
      head: chain.head,
      gated_head: chain.gatedHead,
      head_matches_gated: chain.head && chain.gatedHead ? chain.head === chain.gatedHead : null,
      target_ref: integration.targetRef,
      target_sha: chain.targetSha,
      landed_sha: chain.landedSha,
      // The candidate-suite evidence rides on the SETTLED result in every
      // mode (see integration-runner.js's history of this field).
      candidate: chain.candidate ? { ...chain.candidate } : null,
      ...(regateResult ? { regate_result: regateResult, regate_facts: regateFacts.slice() } : {}),
      mode: integration.mode,
      strategy: integration.strategy,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: Math.max(0, finishedAt - startedAt),
    };
  };

  const record = async ({ verdict, detail, evidence, escalatedTo, demotion, trackingPending = null }) => {
    let factId = null;
    try {
      const fact = buildIntegrationFact({
        integration, nodeId, runId, project: item.project || null, verdict, detail, evidence, attempts, escalatedTo, demotion, trackingPending,
        date: new Date(ctx.now(K("fact", verdict, "now"))).toISOString().slice(0, 10),
        factory: factory.id,
        attempt: gateAttempt,
        chain,
      });
      const wrote = await ctx.run(K("fact", fact.id), "recordFact", { id: fact.id, markdown: fact.markdown });
      if (wrote && wrote.ok) factId = fact.id;
      else log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      if (isControlFlow(e)) throw e;
      log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
    if (factId) facts.push(factId);
    return factId;
  };

  // A refusal's graph-state half (WORKERS.md §10.7), shared by settle() and
  // park(): fail-soft, and only ever called WITH a blocker id.
  const demote = async ({ blockerId, verb }) => {
    if (!has.demote) return { demoted: false, note: null, reason: null };
    let r = null;
    try {
      r = await ctx.run(K("demote", blockerId), "demote", { blockerId });
    } catch (e) {
      if (isControlFlow(e)) throw e;
      r = { ok: false, reason: `${(e && e.message) || e}` };
    }
    if (r && r.ok) return { demoted: !!r.demoted, note: r.note || null, reason: null };
    const reason = (r && r.reason) || "no response";
    log(`work: integration ${verb} ${nodeId}, but the item could not be demoted on the graph (${reason}) — the verdict still stands`);
    return { demoted: false, note: null, reason };
  };
  const withheldDemotion = (demoted, blockerId, why) =>
    demoted.note ||
    (demoted.reason
      ? `the item could not be demoted on the graph (${demoted.reason})`
      : blockerId
      ? null
      : `not attempted — ${why}, so its status is left as the run left it`);

  // The `propose` half of the pipeline's outcome: a PR was opened, so the
  // item PARKS rather than landing (see integration-runner.js's original
  // commentary on why this is not settle(), and why the pair is atomic).
  const park = async ({ proposal, evidence = null }) => {
    let blockerId = null;
    let trackingPending = null;
    try {
      const filed = await ctx.run(K("park"), "parkForReview", { item, integration, proposal });
      if (filed && filed.ok) blockerId = filed.id;
      else if (filed && filed.id && !filed.existing) trackingPending = filed.id;
      if (!blockerId) log(`work: the integration proposal tracking item for ${nodeId} could not be filed (${(filed && filed.reason) || "no response"})`);
    } catch (e) {
      if (isControlFlow(e)) throw e;
      // An OWNER-CHANGED throw (stampPipelineLaunch: the pipeline's lease no
      // longer carries this driver's token, or the record settled under
      // another) is not a filing failure and must not read as one: the
      // tracking item may well be on the graph; it is this DRIVER that has
      // been displaced, and its own settle is refused the same way.
      const displaced = /owner changed|is settled/.test(String((e && e.message) || e));
      log(displaced
        ? `work: the integration proposal for ${nodeId} was parked by a driver that no longer owns the pipeline (${(e && e.message) || e}) — its park fields are not stamped and its verdict will be refused at the settle`
        : `work: the integration proposal tracking item for ${nodeId} could not be filed (${(e && e.message) || e})`);
    }
    const demoted = blockerId ? await demote({ blockerId, verb: "parked" }) : { demoted: false, note: null, reason: null };
    if (!blockerId) {
      log(
        `work: integration parked ${nodeId}, but the tracking item that would block it could not be filed — ` +
          `the item's status is left as the run left it until a later pass heals the tracking item`
      );
    }
    await record({
      verdict: "proposed", detail: proposal.detail, evidence: [proposal.url || "", evidence || ""].filter(Boolean).join("\n\n") || null, escalatedTo: blockerId, trackingPending,
      demotion: withheldDemotion(demoted, blockerId, `no tracking item could be filed to block ${nodeId}${trackingPending ? ` (it is re-filed as ${trackingPending} by a later pass, which completes the demotion then)` : ""}`),
    });
    log(`work: integration proposed ${nodeId} — ${proposal.detail || "PR opened"}${blockerId ? ` (tracked as ${blockerId})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
    return withChain({
      state: "parked", facts, reason: `integration proposed: ${proposal.detail || ""}`.trim(),
      escalated_to: blockerId, demoted: demoted.demoted, demote_reason: demoted.reason,
      ...(trackingPending ? { tracking_pending: trackingPending } : {}),
      proposal: { number: proposal.number || null, url: proposal.url || null, repo: proposal.repo || null, branch: proposal.branch || null },
    });
  };

  // The unsettled result an interrupted re-gate or a ci outage leaves: nothing
  // to record, escalate or demote — handed up as is (through a yield).
  const interrupted = (detail, outage, pause = null) => withChain({
    state: "interrupted", ...(outage ? { outage_interrupted: true } : {}), facts, reason: detail, attempts,
    ...(pause && pause.pausedUntil ? { paused_until: pause.pausedUntil, paused_profile: pause.pausedProfile || null } : {}),
    ...(pause && pause.fallbackRoute ? { fallback_route: true } : {}),
  });

  // The fix cycles and races this stage has CHARGED (see integration-runner.js
  // for why `attempts` is not a cycle log).
  let cycle = 0;
  let races = 0;

  const settle = async (state, { detail, evidence, escalatedTo: given = null }) => {
    let escalatedTo = given || null;
    if (!escalatedTo) {
      try {
        const esc = await ctx.run(K("escalate"), "escalate", { attempts, detail, evidence: evidence || "", kind: state === "mismatch" ? "mismatch" : null, fixCycles: cycle });
        if (esc && esc.ok) escalatedTo = esc.id;
        else log(`work: the integration escalation for ${nodeId} could not be filed (${(esc && esc.reason) || "no response"})`);
      } catch (e) {
        if (isControlFlow(e)) throw e;
        log(`work: the integration escalation for ${nodeId} could not be filed (${(e && e.message) || e})`);
      }
    }
    const demoted = escalatedTo ? await demote({ blockerId: escalatedTo, verb: "refused" }) : { demoted: false, note: null, reason: null };
    if (!escalatedTo) {
      log(
        `work: integration ${state} on ${nodeId}, but the escalation that would block it could not be filed — ` +
          `the item's status is left as the run left it; re-run this judgement with 'spor work --regate ${runId}'`
      );
    }
    await record({
      verdict: state, detail, evidence, escalatedTo,
      demotion: withheldDemotion(demoted, escalatedTo, `no escalation could be filed to block ${nodeId}`),
    });
    log(`work: integration ${state} on ${nodeId} — ${detail || "no detail"}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
    // The replay payload for the bounded auto-retry (WORKERS.md §10.7) — the
    // same shape the gate pipeline leaves, so ONE retry machine serves both.
    const escalationRetry = escalatedTo
      ? null
      : {
          stage: INTEGRATION_STAGE_ID, gateId: INTEGRATION_STAGE_ID, attempt: item.attempt,
          completedBeforeIntegration: has.completedBeforeIntegration,
          attempts, detail, evidence: String(evidence || "").slice(0, 3000),
          factId: integrationFactId(nodeId, runId, integration.mode === "propose" ? state : null, gateAttempt),
        };
    return withChain({
      state, facts,
      reason:
        `integration ${state}: ${detail || ""}`.trim() +
        (escalatedTo ? "" : " (the escalation could not be filed, so the item's status was left alone)"),
      escalated_to: escalatedTo, demoted: demoted.demoted, demote_reason: demoted.reason,
      ...(escalatedTo ? {} : { escalation_failed: true }),
      ...(escalationRetry ? { escalation_retry: escalationRetry } : {}),
    });
  };

  // ---- the serialize:repo lease and the yield ----
  // `epoch` counts resumes: a yield releases the lease and the next epoch
  // re-takes it, each under its own key, so a replay finds every acquire and
  // release exactly where the live run made them.
  let epoch = 0;
  let lease = null;
  let leaseHeld = false;
  const acquireLease = async () => {
    try {
      lease = await ctx.run(K("lease", epoch, "acquire"), "acquireLease", {});
    } catch (e) {
      if (isControlFlow(e)) throw e;
      lease = null;
      log(`work: the integration lease for ${nodeId} could not be acquired (${(e && e.message) || e}) — proceeding without it`);
    }
    // Released on the way out whatever the acquire returned — the runner's
    // finally called releaseLease with whatever it held, null included.
    leaseHeld = true;
  };
  const releaseLease = async () => {
    if (!leaseHeld) return;
    leaseHeld = false;
    if (!has.releaseLease) return;
    try {
      await ctx.run(K("lease", epoch, "release"), "releaseLease", { token: lease == null ? null : lease });
    } catch (e) {
      if (isControlFlow(e)) throw e;
      /* best effort — a lease this box could not release lapses on its own TTL */
    }
  };
  // Hand an unsettled result up and SUSPEND. The result is journaled (so a
  // driver that re-lands on the same unfired timer finds it), the lease is
  // released first (the runner's finally did), and the next drive past the
  // timer continues here: a new epoch, the lease re-taken.
  const yieldInterrupted = async (result) => {
    await releaseLease();
    // The parked result rides the Suspend's `meta` (the kernel's channel for
    // live driver data), not a side slot on the input.
    const parked = await ctx.run(K("yield", epoch, "parked"), "yield", result);
    const at = ctx.now(K("yield", epoch, "now"));
    ctx.sleepUntil(K("yield", epoch), at + YIELD_MS, { parked });
    epoch += 1;
    await acquireLease();
  };
  // Every settled exit releases the lease on its way out, as the runner's
  // outer finally did — and journals the CLOSING entry (the settled state), as
  // the gate list does: with it a full replay stays inside the recorded past
  // to its last line, and the projection reads the stage as settled off the
  // journal alone (stage-projection.js projectJournal).
  const leave = async (result) => {
    await releaseLease();
    await ctx.run(K("settled"), "settled", { state: (result && result.state) || null });
    return result;
  };

  // ---- the opening read ----
  let tree = await ctx.run(K("tree"), "changedTree", {});
  if (!tree.ok) {
    const detail = tree.reason || "the change to integrate could not be read";
    attempts.push({ verdict: "failed", detail });
    return leave(await settle("failed", { detail }));
  }
  chain.head = tree.head || null;
  // HEAD EQUALITY (task-spor-factory-gate-attestation, piece 3): fail closed
  // and hand it to a person — never a fix cycle (a fix commits).
  if (gatedHead && tree.head && tree.head !== gatedHead) {
    const detail =
      `the implementer's checkout moved after the gates judged it — the last passing gate judged \`${gatedHead}\`, ` +
      `but the tree now reads \`${tree.head}\`; nothing has judged that head, so the stage refuses to land it (re-gate the run: 'spor work --regate ${runId}')`;
    attempts.push({ verdict: "failed", detail });
    return leave(await settle("failed", { detail }));
  }

  // RE-PIN the candidate after an integration fix cycle (see the runner's
  // original commentary: owed by this stage's own fix cycles only, fail-soft,
  // RETURNS the tip it pinned because the tip is what this stage integrates).
  let refreshes = 0;
  const pin = async (R, cycleNo, { runId: fixRunId = null } = {}) => {
    if (!factory.implementation || !has.pinCandidate) return null;
    try {
      const r = await ctx.run(R("pin"), "pinCandidate", { submittedBy: { stage: "integration-fix", cycle: cycleNo, rescue: 0 }, runId: fixRunId });
      if (r && r.ok) {
        if (r.change === "created" || r.change === "superseded") {
          log(`work: pinned candidate ${r.candidate.candidate_id} for ${nodeId} (tree ${String(r.candidate.tree).slice(0, 12)}, integration-fix)`);
        }
        return r.candidate || null;
      }
      if (r && r.reason) {
        log(`work: no candidate could be pinned for ${nodeId} (${r.reason}) — the tree is judged regardless`);
      }
    } catch (e) {
      if (isControlFlow(e)) throw e;
      log(`work: no candidate could be pinned for ${nodeId} (${(e && e.message) || e}) — the tree is judged regardless`);
    }
    return null;
  };

  // WHAT THIS STAGE INTEGRATES: the PINNED CANDIDATE's commit, not the branch
  // head, whenever one is pinned AND can be checked against the branch.
  let candidate = null;
  if (factory.implementation && has.tipCandidate && has.candidateStanding) {
    try {
      candidate = (await ctx.run(K("tip"), "tipCandidate", {})) || null;
    } catch (e) {
      if (isControlFlow(e)) throw e;
      log(`work: the pinned candidate for ${nodeId} could not be read (${(e && e.message) || e}) — the branch head is integrated instead`);
    }
  }
  const integrateCommit = () => (candidate && candidate.commit ? candidate.commit : tree.head);

  // The §4.2 M1 reading (FACTORY-IMPLEMENTATION-STAGE.md): is the branch still
  // carrying the candidate the gates judged? The refusal's detail, or null.
  let standings = 0;
  const candidateDrift = async () => {
    const commit = candidate && candidate.commit ? candidate.commit : null;
    if (!commit || !has.candidateStanding) return null;
    let st = null;
    try {
      st = await ctx.run(K("standing", ++standings), "candidateStanding", { top: tree.top, head: tree.head, commit, tree: candidate.tree || null });
    } catch (e) {
      if (isControlFlow(e)) throw e;
      st = { known: false, reason: `${(e && e.message) || e}` };
    }
    const why = !st || !st.known
      ? `it could not be verified against the branch head ${String(tree.head).slice(0, 8)}${st && st.reason ? ` (${st.reason})` : ""}`
      : st.commitTreeMatches === false
      ? `its pinned commit no longer resolves to its pinned tree`
      : !st.contained && !st.headTreeMatches
      ? `the branch head ${String(tree.head).slice(0, 8)} no longer contains it`
      : integration.mode === "propose" && !st.headTreeMatches
      ? `the branch head ${String(tree.head).slice(0, 8)} carries commits the candidate does not, and \`propose\` mode lands the branch itself`
      : null;
    if (!why) return null;
    const where = candidate.reference && candidate.reference.locator ? `, published at ${candidate.reference.locator}` : "";
    return (
      `the pinned candidate ${candidate.candidate_id || "cand-?"} (commit ${String(commit).slice(0, 8)}, tree ${String(candidate.tree || "?").slice(0, 8)}${where}) ` +
      `is not what this checkout would land: ${why} — the gates judged a tree this branch no longer carries, so nothing was integrated`
    );
  };

  // Re-read the implementer's checkout after a fix cycle (or after a yield —
  // the runner's resumed call read it fresh), re-pin when a fix produced the
  // tree, re-check the drift, and re-gate a moved head. {ok} | {ok:false,
  // verdict, detail, escalatedTo} | {ok:false, interrupted, ...}.
  const refreshTree = async ({ cycle: cycleNo = null, runId: fixRunId = null, repin = true } = {}) => {
    const n = ++refreshes;
    const R = (...p) => K("refresh", n, ...p);
    const refreshed = await ctx.run(R("tree"), "changedTree", {});
    if (!refreshed.ok) {
      const detail = refreshed.reason || "the change to integrate could not be re-read after the fix cycle";
      attempts.push({ verdict: "failed", detail });
      return { ok: false, verdict: "failed", detail };
    }
    tree = refreshed;
    if (repin) {
      // The tip moves ONLY here — an integration fix cycle is the one thing in
      // this stage that commits (§3.3) — and is consumed only when it can be
      // checked against the branch.
      const repinned = await pin(R, cycleNo, { runId: fixRunId });
      candidate = has.candidateStanding ? repinned : null;
    }
    const drift = await candidateDrift();
    if (drift) {
      attempts.push({ verdict: "mismatch", detail: drift });
      return { ok: false, verdict: "mismatch", detail: drift };
    }
    chain.head = tree.head || null;
    if (!chain.gatedHead || !tree.head || tree.head === chain.gatedHead) return { ok: true };
    if (!has.regate) {
      const detail =
        `the fix cycle moved the implementer's head to \`${tree.head}\` but the gates judged \`${chain.gatedHead}\`, ` +
        "and this stage has no way to re-gate the moved head — nothing has judged it, so it is not landed (re-gate the run: 'spor work --regate " + runId + "')";
      attempts.push({ verdict: "failed", detail });
      return { ok: false, detail };
    }
    log(`work: the fix cycle moved ${nodeId}'s head to ${String(tree.head).slice(0, 12)} (the gates judged ${String(chain.gatedHead).slice(0, 12)}) — re-gating it before it can land`);
    let rg = null;
    try {
      rg = await ctx.run(R("regate"), "regate", { head: tree.head, gatedHead: chain.gatedHead, item });
    } catch (e) {
      if (isControlFlow(e)) throw e;
      rg = { state: "failed", reason: `the re-gate threw: ${(e && e.message) || e}` };
    }
    const state = rg && rg.state ? rg.state : "failed";
    // The carried re-gate is the LAST one: a later re-gate that did not pass
    // supersedes an earlier pass, so the result never reports a head as
    // re-gated that a newer judgement refused — and its FACTS go with it:
    // a superseded re-gate's facts judged a head that is not the one being
    // landed, and the driver adopts `regate_facts` as the landed head's gate
    // evidence (task-spor-integration-workflow-merge-gate-fixes), so only
    // the carried re-gate's facts may ride the result.
    regateResult = null;
    regateFacts.length = 0;
    // An `interrupted` re-gate judged nothing: handed up UNSETTLED.
    if (state === "interrupted") return { ok: false, interrupted: true, outage: !!rg.outage_interrupted, ...(rg.paused_until ? { pausedUntil: rg.paused_until, pausedProfile: rg.paused_profile || null } : {}), ...(rg.fallback_route ? { fallbackRoute: true } : {}), detail: rg.reason || "the re-gate was interrupted before it reached a verdict" };
    if (state === "passed" && rg.head && rg.head === tree.head) {
      chain.gatedHead = tree.head;
      regateResult = rg;
      for (const f of Array.isArray(rg.facts) ? rg.facts : []) if (!regateFacts.includes(f)) regateFacts.push(f);
      attempts.push({ verdict: "regated", detail: `the moved head ${String(tree.head).slice(0, 12)} passed every gate again` });
      return { ok: true };
    }
    const detail =
      `the fix cycle moved the implementer's head to \`${tree.head}\`, and re-gating that head ${state}` +
      `${rg && rg.reason ? ` — ${rg.reason}` : state === "passed" ? ` — the re-gate judged \`${rg.head || "an unknown head"}\`, not the moved one` : ""}` +
      "; nothing that passed has judged the head that would land, so the stage does not land it";
    attempts.push({ verdict: "failed", detail });
    return { ok: false, detail, escalatedTo: rg && rg.escalated_to ? rg.escalated_to : null };
  };

  // The tip as it stands BEFORE anything is built or serialized.
  const drift = await candidateDrift();
  if (drift) {
    attempts.push({ verdict: "mismatch", detail: drift });
    return leave(await settle("mismatch", { detail: drift }));
  }

  // The first failure of a candidate suite that then PASSED on a declared
  // rerun: carried onto the landed fact as evidence.
  let rerunEvidence = null;
  await acquireLease();

  // A fix cycle, run as dispatch + run-terminal SIGNAL when the caller wired
  // both halves, else as the one-shot `fix` activity. Either way the result
  // is {ok, runId?, reason?} and a throw reads as a refusal (runFix's rule).
  const runFix = async (A, args) => {
    if (has.fixSignals) {
      let launched = null;
      try {
        launched = await ctx.run(A("fix"), "dispatchFix", args);
      } catch (e) {
        if (isControlFlow(e)) throw e;
        return { ok: false, reason: `${(e && e.message) || e}` };
      }
      if (!launched || !launched.ok) return { ok: false, reason: (launched && launched.reason) || "no response" };
      if (!launched.runId) return { ok: false, reason: "the fix dispatch reported no run to await" };
      const ended = ctx.awaitSignal(A("fix-ended"), `run:${launched.runId}`);
      const outcome = ended.payload || {};
      // `unfollowable` rides the refusal (issue-spor-integration-runfix-
      // ignores-unfollowable): a fix this worker stopped following (an idle
      // stop that did not take, the age watchdog) may still hold the checkout.
      return outcome.ok ? { ok: true, runId: launched.runId } : { ok: false, reason: outcome.reason || "the fix run did not reach a terminal state", runId: launched.runId, ...(outcome.unfollowable ? { unfollowable: true } : {}) };
    }
    try {
      return await ctx.run(A("fix"), "fix", args);
    } catch (e) {
      if (isControlFlow(e)) throw e;
      return { ok: false, reason: `${(e && e.message) || e}` };
    }
  };

  // A fix cycle that did not run to an end this worker saw: SETTLED, never
  // rebuilt. Two readings (issue-spor-integration-runfix-ignores-unfollowable):
  // a fix that could not run (a refused dispatch, a run that failed), and a
  // fix this worker stopped FOLLOWING (`unfollowable`: an idle stop that did
  // not take, the age watchdog) — whose fixer may still hold the checkout a
  // rebuild would read and a later fix would be dispatched into. Both escalate
  // through `settle`; the unfollowable one says so in its detail and tags the
  // result, so the escalation a person reads names the live fixer rather than
  // a fix that "could not run". The integration stage has no rescue lane, so
  // there is no second dispatch to withhold here beyond the rebuild itself.
  const fixRefused = async (fixed, cause, evidence = undefined) => {
    const unfollowable = !!(fixed && fixed.unfollowable);
    const why = (fixed && fixed.reason) || "no response";
    const detail = unfollowable
      ? `the fix cycle${fixed && fixed.runId ? ` (run ${String(fixed.runId).slice(0, 8)})` : ""} was launched but this worker could not follow it to its end (${why}) — the fixer may still hold the checkout, so the candidate is not rebuilt and nothing is dispatched into it`
      : `the fix cycle could not run (${why})`;
    attempts.push({ verdict: "failed", detail });
    const settled = await settle("failed", { detail: `${cause}; ${detail}`, ...(evidence !== undefined ? { evidence } : {}) });
    return unfollowable ? { ...settled, unfollowable: true } : settled;
  };

  // After a fix cycle (or a yield): the re-read that decides whether the loop
  // may rebuild. null = carry on; {done} = a settled exit; {yield} = hand up.
  const afterFix = async (refresh) => {
    const refreshed = await refreshTree(refresh);
    if (refreshed.ok) return null;
    if (refreshed.interrupted) return { yield: interrupted(refreshed.detail, refreshed.outage, refreshed), refresh };
    return { done: await settle(refreshed.verdict || "failed", { detail: refreshed.detail, escalatedTo: refreshed.escalatedTo || null }) };
  };

  // ONE attempt: build the candidate, force the protected paths, run the
  // suite, land (or propose). The candidate worktree is torn down on EVERY
  // exit from this block that is not a kernel suspend — a settled exit, a
  // rebuild, a yield, a thrown dep — never left to a scattered call.
  // {done} | {next} | {refresh} | {yield, refresh?}.
  let attemptNo = 0;
  const attempt = async () => {
    const n = ++attemptNo;
    const A = (...p) => K("attempt", n, ...p);
    // `head` is the PINNED commit whenever a candidate is pinned, else the
    // branch head; a lost race rebuilds against the ref's new tip with the
    // SAME candidate.
    const built = await ctx.run(A("build"), "buildCandidate", { top: tree.top, head: integrateCommit(), targetRef: integration.targetRef, strategy: integration.strategy, mode: integration.mode });
    if (!built.ok) {
      attempts.push({ verdict: built.conflict ? "conflict" : "failed", detail: built.reason });
      if (gates.cycleDecision(integration, cycle) === "retry") {
        log(`work: integration ${built.conflict ? "conflict" : "failure"} on ${nodeId} — fix cycle ${cycle + 1}/${integration.cycles}`);
        const fixed = await runFix(A, { cycle, kind: built.conflict ? "conflict" : "build", detail: built.reason, evidence: built.evidence });
        cycle += 1;
        if (!fixed.ok) return { done: await fixRefused(fixed, built.reason, built.evidence) };
        return { refresh: { cycle, runId: (fixed && fixed.runId) || null } };
      }
      return { done: await settle("failed", { detail: built.reason, evidence: built.evidence }) };
    }

    const buildKey = A("build");
    const cleanupCandidate = async () => {
      try {
        await ctx.run(A("cleanup"), "cleanupCandidate", { buildKey, top: tree.top, dir: built.dir || null });
      } catch (e) {
        if (isControlFlow(e)) throw e;
        /* best effort — the runner's cleanup swallowed everything too */
      }
    };
    let out;
    try {
      out = await judgeAndLand(A, built);
    } catch (e) {
      // A kernel control throw (the fix's signal suspend, a replay fault)
      // leaves the candidate standing: the resumed workflow replays into
      // this same block and tears it down from here.
      if (isControlFlow(e)) throw e;
      await cleanupCandidate();
      throw e;
    }
    await cleanupCandidate();
    if (out.landed) {
      // The implementer's own worktree is cleaned up only NOW, after the
      // candidate's — its removal would otherwise yank away the cwd the
      // candidate's own cleanup needed.
      if (has.cleanupImplementer) {
        try {
          await ctx.run(A("cleanup-implementer"), "cleanupImplementer", {});
        } catch (e) {
          if (isControlFlow(e)) throw e;
          /* best effort — a leaked implementer worktree is not worth failing a landed integration over */
        }
      }
      log(
        out.landed.state === "parked"
          ? `work: ${nodeId} — integration proposed a PR onto ${integration.targetRef}; parked pending review`
          : `work: ${nodeId} — integration landed on ${integration.targetRef}`
      );
      return { done: out.landed };
    }
    return out;
  };

  // The judged half of an attempt, over a built candidate. {landed: result}
  // | {done} | {next} | {refresh} | {yield}.
  const judgeAndLand = async (A, built) => {
    // `top` rides on every git-side activity's args (here, the suite, the
    // candidate's discard): a resumed worker's deps closures never saw the
    // opening read this workflow replays, so the implementer's checkout must
    // reach them as DATA, not as a closure variable of a process that died.
    const forced = has.forceProtected ? await ctx.run(A("force"), "forceProtected", { top: tree.top, dir: built.dir, sha: built.sha, base: built.expectedSha }) : { ok: true, sha: built.sha };
    if (!forced.ok) {
      attempts.push({ verdict: "failed", detail: forced.reason });
      return { done: await settle("failed", { detail: forced.reason }) };
    }
    const landSha = forced.sha || built.sha;
    chain.targetSha = built.expectedSha || null;
    chain.landedSha = landSha;

    // The candidate suite's bounded same-tree rerun (gates.rerunDecision).
    let suite = null;
    let firstFailure = null;
    let run = 0;
    for (;;) {
      run += 1;
      suite = await ctx.run(A("suite", run), "runSuite", { top: tree.top, dir: built.dir, base: built.expectedSha, head: landSha, attempt: run });
      if (suite.ok) break;
      if (suite.outage) break;
      if (!firstFailure) firstFailure = suite;
      if (gates.rerunDecision(integration, run) !== "rerun") break;
      log(`work: the integration candidate suite failed on ${nodeId} (${suite.reason || "no reason"}) — rerun ${run}/${gates.rerunCap(integration)} on the same candidate`);
    }
    if (has.closeSuite) {
      try {
        await ctx.run(A("close-suite"), "closeSuite", { head: landSha });
      } catch (e) {
        if (isControlFlow(e)) throw e;
        /* best effort — a leftover candidate branch is overwritten by the next push */
      }
    }
    // CI could not judge the candidate: an outage, not a verdict — nothing
    // lands, nothing is recorded, and the stage YIELDS. The reason is
    // deliberately STABLE so the loop's re-offer cap can count it.
    if (!suite.ok && suite.outage) {
      log(`work: the integration candidate suite on ${nodeId} was not judged by CI (${suite.reason || suite.outage.reason || "no reason"}) — an outage; nothing landed, and the pipeline is re-offered`);
      return { yield: interrupted(`the integration candidate's CI (workflow \`${(integration.ci && integration.ci.workflow) || "unknown"}\`) did not judge the candidate — an outage, not a verdict on the change; nothing was landed and no fix cycle was charged`, true) };
    }
    if (suite.ok && firstFailure) {
      rerunEvidence = gateRunner.failureEvidence(firstFailure.output || "");
      attempts.push({ verdict: "passed", detail: gates.describeRerun(integration.command, run, firstFailure.reason) });
    }
    chain.candidate = { base: built.expectedSha || null, sha: landSha, suite: suite.ok ? "passed" : "failed", command: integration.command, trusted_sha: forced.trusted_sha || null };
    if (!suite.ok) {
      const reason = gates.describeRerunsExhausted(suite.reason, run);
      const evidence = gateRunner.failureEvidence(suite.output || "");
      attempts.push({ verdict: "failed", detail: reason, evidence });
      if (gates.cycleDecision(integration, cycle) === "retry") {
        log(`work: the integration candidate suite failed on ${nodeId}${run > 1 ? ` on every one of ${run} runs` : ""} — fix cycle ${cycle + 1}/${integration.cycles}`);
        const fixed = await runFix(A, { cycle, kind: "suite", detail: reason, evidence });
        cycle += 1;
        if (!fixed.ok) return { done: await fixRefused(fixed, reason, evidence) };
        return { refresh: { cycle, runId: (fixed && fixed.runId) || null } };
      }
      return { done: await settle("failed", { detail: reason, evidence }) };
    }

    // `propose` mode NEVER lands — it opens a PR from the pinned candidate's
    // own commit (see the runner's original commentary).
    const landing =
      integration.mode === "propose"
        ? await ctx.run(A("propose"), "propose", {
            top: tree.top, dir: built.dir, head: integrateCommit(), sha: landSha, targetRef: integration.targetRef,
            chain: { ...chain, head: integrateCommit(), candidate: { ...chain.candidate } },
          })
        : await ctx.run(A("land"), "land", { top: tree.top, dir: built.dir, sha: landSha, expectedSha: built.expectedSha, targetRef: integration.targetRef, mode: integration.mode });

    if (landing.ok && integration.mode === "propose") {
      attempts.push({ verdict: "proposed", detail: landing.detail });
      return { landed: await park({ proposal: landing, evidence: rerunEvidence }) };
    }
    if (landing.ok) {
      attempts.push({ verdict: "landed", detail: landing.detail });
      if (landing.sha) chain.landedSha = landing.sha;
      await record({ verdict: "landed", detail: landing.detail, evidence: rerunEvidence });
      return { landed: withChain({ state: "passed", facts, reason: landing.detail || `landed on ${integration.targetRef}` }) };
    }
    if (landing.race) {
      races += 1;
      attempts.push({ verdict: "race", detail: landing.reason });
      if (races >= RACE_RETRY_CAP) {
        log(`work: integration for ${nodeId} lost the landing race on ${integration.targetRef} ${races} times in a row — giving up`);
        return { done: await settle("failed", { detail: `lost the landing race ${races} times in a row: ${landing.reason}` }) };
      }
      log(`work: integration for ${nodeId} lost the landing race on ${integration.targetRef} — rebuilding (${races}/${RACE_RETRY_CAP})`);
      return { next: true }; // rebuild fresh against the ref's new tip — a lost race is nobody's fix cycle
    }
    attempts.push({ verdict: "failed", detail: landing.reason });
    if (gates.cycleDecision(integration, cycle) === "retry") {
      log(`work: integration could not ${integration.mode === "propose" ? "propose" : "land"} ${nodeId} — fix cycle ${cycle + 1}/${integration.cycles}`);
      const fixed = await runFix(A, { cycle, kind: integration.mode === "propose" ? "propose" : "land", detail: landing.reason });
      cycle += 1;
      if (!fixed.ok) return { done: await fixRefused(fixed, landing.reason) };
      return { refresh: { cycle, runId: (fixed && fixed.runId) || null } };
    }
    return { done: await settle("failed", { detail: landing.reason }) };
  };

  // ---- the loop ----
  // `refresh` is owed before the next build: after a fix cycle (re-read,
  // re-pin, re-gate a moved head) and after a yield (the runner's resumed
  // call read the tree fresh; a yield that interrupted a re-gate retries it
  // under the next refresh key).
  let refresh = null;
  for (;;) {
    if (refresh) {
      const r = await afterFix(refresh);
      if (r && r.done) return leave(r.done);
      if (r && r.yield) {
        await yieldInterrupted(r.yield);
        refresh = { ...refresh, repin: false };
        continue;
      }
      refresh = null;
    }
    const out = await attempt();
    if (out.done) return leave(out.done);
    if (out.yield) {
      await yieldInterrupted(out.yield);
      refresh = out.refresh ? { ...out.refresh, repin: false } : { cycle, runId: null, repin: false };
      continue;
    }
    refresh = out.refresh || null;
  }
}

// Bind the stage's deps to the kernel's activities table, keeping the LIVE
// resources — a candidate worktree's cleanup closure, the serialize lease's
// token — out of the journal. `resources.release()` is the driver's finally:
// whatever the workflow did not release through a journaled step (a thrown
// dep, a replay fault) is released here, exactly as the runner's finally
// blocks did.
function bindIntegrationActivities(deps) {
  const resources = {
    candidates: new Map(), // build key -> cleanup closure
    lease: null, // { token } while a live acquire is unreleased
    release: () => {
      for (const [key, cleanup] of resources.candidates) {
        resources.candidates.delete(key);
        try {
          cleanup();
        } catch {
          /* the runner's cleanup swallowed everything too */
        }
      }
      const held = resources.lease;
      resources.lease = null;
      if (held && typeof deps.releaseLease === "function") {
        try {
          const r = deps.releaseLease(held.token);
          if (r && typeof r.catch === "function") r.catch(() => {});
        } catch {
          /* best effort — a lease this box could not release lapses on its own TTL */
        }
      }
    },
  };
  const call = (name) => async (args) => plain(await deps[name](args));
  const activities = {
    // The journaled input and the journaled yield result: identity activities.
    // The journal's creation stamp rides the open RESULT (journaled once,
    // replayed thereafter), so a reader orders two re-gate children of one
    // attempt by when they were opened, never by a file's mtime
    // (stage-projection.js stageJournals).
    open: (args) => ({ ...plain(args), opened_at: new Date().toISOString() }),
    yield: (args) => plain(args),
    settled: (args) => plain(args),
    changedTree: async () => plain(await deps.changedTree()),
    tipCandidate: async () => plain(await deps.tipCandidate()),
    candidateStanding: call("candidateStanding"),
    pinCandidate: call("pinCandidate"),
    acquireLease: async () => {
      // Re-executed in the at-least-once window (a crash — or a poisoned
      // persist and re-open — between taking the lease and journaling it):
      // this process already holds it, so hand the held token back rather
      // than contend with ourselves for the local lockfile.
      if (resources.lease) return plain(resources.lease.token);
      const token = await deps.acquireLease();
      resources.lease = { token: token === undefined ? null : token };
      return plain(token === undefined ? null : token);
    },
    releaseLease: async ({ token }) => {
      // The live token when this process took the lease, else the journaled
      // one (a resumed worker releasing what its predecessor held).
      const held = resources.lease;
      resources.lease = null;
      await deps.releaseLease(held ? held.token : token);
      return { ok: true };
    },
    buildCandidate: async (args, { key }) => {
      // A build re-executed under its key (the at-least-once window) builds a
      // second throwaway; the first — registered and never journaled — is
      // released here, so it is not dropped from the registry and leaked.
      const prior = resources.candidates.get(key);
      if (prior) {
        resources.candidates.delete(key);
        try {
          prior();
        } catch {
          /* best effort */
        }
      }
      const built = (await deps.buildCandidate(args)) || {};
      const { cleanup, ...rest } = built;
      if (typeof cleanup === "function") resources.candidates.set(key, cleanup);
      return plain(rest);
    },
    // The candidate's teardown: the closure its build registered when this
    // process built it; else (a resumed worker, whose predecessor's closure
    // died with it) the caller's by-path discard, so the worktree a dead
    // worker left under the OS temp dir does not leak.
    cleanupCandidate: async ({ buildKey, top, dir }) => {
      const cleanup = resources.candidates.get(buildKey);
      resources.candidates.delete(buildKey);
      if (cleanup) {
        try {
          cleanup();
        } catch {
          /* best effort */
        }
        return { ok: true, live: true };
      }
      if (dir && typeof deps.discardCandidate === "function") {
        await deps.discardCandidate({ top, dir });
        return { ok: true, live: false };
      }
      return { ok: true, live: false, skipped: true };
    },
    forceProtected: call("forceProtected"),
    runSuite: call("runSuite"),
    closeSuite: call("closeSuite"),
    land: call("land"),
    propose: call("propose"),
    parkForReview: call("parkForReview"),
    // The fix's run record is a few KB nobody downstream reads — the
    // workflow consumes {ok, runId, reason} — so it is not journaled.
    fix: async (args) => {
      const r = (await deps.fix(args)) || {};
      const { record, ...rest } = r;
      return plain(rest);
    },
    dispatchFix: async (args) => {
      const r = (await deps.dispatchFix(args)) || {};
      const { record, ...rest } = r;
      return plain(rest);
    },
    escalate: call("escalate"),
    demote: call("demote"),
    recordFact: call("recordFact"),
    cleanupImplementer: async () => {
      await deps.cleanupImplementer();
      return { ok: true };
    },
    regate: call("regate"),
  };
  return { activities, resources };
}

// The ACTIVITIES — what stays bespoke under the kernel. Each is a side effect
// on git, the graph or a harness; the kernel journals its RESULT once, and
// the activity makes the EFFECT idempotent under its key. Documentation and
// the test's checklist, in one table.
const INTEGRATION_ACTIVITIES = Object.freeze([
  ["open", "identity: the journaled input (gated head, wired deps, attempt, the integration definition judged under and its binding digest — a resume whose live digest differs fails closed)"],
  ["changedTree", "git: the implementer's head/base/top against the target ref; a read, naturally idempotent"],
  ["tipCandidate", "the run record's pinned candidate as it reads now; a read"],
  ["candidateStanding", "git: is the pinned commit contained in / a relabel of the branch head; a read"],
  ["pinCandidate", "candidate chain: re-pin after an integration fix cycle — the fold decides relabel vs supersede, so a repeat is `seen`"],
  ["acquireLease", "serialize:repo lease (server claim on a synthetic lock node / local lockfile); a repeat hands back the token this process already holds"],
  ["releaseLease", "release that lease; a repeat on a released token is a no-op"],
  ["buildCandidate", "merge(target_ref, head) in a throwaway worktree per strategy; a repeat under the same key builds a second throwaway and releases the first"],
  ["cleanupCandidate", "tear the candidate worktree down — the registered closure, or a by-path discard on a resumed worker"],
  ["forceProtected", "force the protected paths back to the trusted copy and re-commit; idempotent on the same tree"],
  ["runSuite", "run the declared suite on the candidate tree (or push a candidate ref and read its CI run)"],
  ["closeSuite", "let go of the CI candidate branch; idempotent"],
  ["land", "git update-ref CAS / push whose non-fast-forward rejection is the CAS; a ref already at the candidate sha reads as landed"],
  ["propose", "gh pr create from the candidate commit; a PR already open for the branch is adopted by gh"],
  ["parkForReview", "the proposal tracking item under a deterministic id, if_exists: skip"],
  ["fix", "spor dispatch --force --no-worktree into the run's checkout, ADOPTED BY NAME, then await the run's terminal state (one-shot form)"],
  ["dispatchFix", "the launch half of `fix`: returns the run it started or adopted; the terminal state arrives as signal run:<id>"],
  ["escalate", "requires:[human] item under a deterministic id carrying blocks -> the work item; if_exists: skip"],
  ["demote", "§10.7: roll the item's completion status back to open while its resolving edge stands"],
  ["recordFact", "the art-merge-* fact under a deterministic id, if_exists: skip + read-back content comparison"],
  ["cleanupImplementer", "remove the dispatch worktree once a landing no longer needs it; idempotent"],
  ["regate", "re-run the gate pipeline over a moved head (its own idempotency: gate_progress, adopt-by-name)"],
  ["yield", "identity: the journaled interrupted result handed up before a durable yield"],
  ["settled", "identity: the journaled closing entry (the settled state), so a full replay stays inside the recorded past to its last line"],
  // signals and timers, not activities — what the workflow awaits:
  ["signal run:<id>", "a dispatched fix run's terminal state, delivered by the driver"],
  ["timer yield", "the durable yield behind an unsettled hand-up (a ci outage, an interrupted re-gate)"],
]);

// The DRIVER: runIntegrationStage's contract over the workflow. Builds the
// Execution over the caller's journal handle (`deps.workflowJournal`, a
// function returning {journal, persist} — lib/shell/execution-store.js's
// openWorkflowJournal — or absent, which runs the stage over an in-memory
// journal exactly as before the kernel existed), drives it to a settled
// state, and maps the kernel's outcomes back to the stage's results:
//   completed            -> the workflow's result, as the runner returned it
//   suspended on a timer -> the journaled `interrupted` result (the yield)
//   suspended on run:<id>-> deliver the run's terminal state (deps.awaitRun)
//                           and run again — in-process, so the slot is held
//                           exactly as the one-shot fix held it
//   failed               -> rethrown, as a thrown dep threw out of the runner
// A journal whose persist poisoned the Execution is re-opened and re-driven
// (bounded): the kernel's own contract is that memory never runs ahead of
// disk, and a fresh handle holds whatever truly landed.
async function driveIntegrationStage({ item, factory, deps, log = () => {}, gatedHead = null }) {
  const { activities, resources } = bindIntegrationActivities(deps);
  const input = { item, factory, gatedHead, deps, log };
  const clock = { now: typeof deps.now === "function" ? deps.now : () => Date.now() };
  const openHandle = typeof deps.workflowJournal === "function" ? deps.workflowJournal : null;
  const exec = () => {
    const handle = openHandle ? openHandle() : null;
    return new Execution(integrationWorkflow, input, {
      journal: handle && Array.isArray(handle.journal) ? handle.journal : [],
      persist: handle && typeof handle.persist === "function" ? handle.persist : null,
      clock,
      activities,
      workflow: WORKFLOW_NAME,
      version: WORKFLOW_VERSION,
    });
  };
  const build = (error) => refusalRecord({ item, factory, gatedHead, error, clock });
  const settle = (refusal, { replayed }) => settleRefusal({ item, deps, log, refusal, replayed });
  try {
    return await stageWorkflow.driveStage({
      label: "integration",
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
          return {
            result: (r.detail.meta && r.detail.meta.parked) || {
              state: "interrupted", facts: [], attempts: [],
              reason: `the integration stage is yielded until ${new Date(r.detail.fireAt).toISOString()} and resumes on the next pass`,
              paused_until: new Date(r.detail.fireAt).toISOString(),
            },
          };
        }
        const m = /^run:(.+)$/.exec(String(r.detail && r.detail.name));
        if (!m || typeof deps.awaitRun !== "function") throw new Error(`the integration workflow suspended on signal '${r.detail && r.detail.name}' with no way to deliver it`);
        let done = null;
        try {
          done = await deps.awaitRun({ runId: m[1], lane: "fix" });
        } catch (err) {
          done = { ok: false, reason: `${(err && err.message) || err}` };
        }
        e.signal(r.detail.name, { ok: !!(done && done.ok), reason: (done && done.reason) || null, ...(done && done.unfollowable ? { unfollowable: true } : {}) });
        return undefined;
      },
    });
  } finally {
    resources.release();
  }
}

// Settle an unresumable attempt as REFUSED. Two halves, so the refusal is
// TERMINAL for its journal (task-spor-integration-refusal-tombstones-journal):
//
//   1. `refusalRecord` reads the refusal — WHY (the mismatch, or the version),
//      the clock, and the handful of live-factory fields the settle's ids and
//      fact body are built from — into one JSON-plain record;
//   2. the driver writes that record into the journal as the kernel's
//      TOMBSTONE (persisted before anything else happens), and only then
//      `settleRefusal` makes the three graph writes `settle()` makes inside
//      the workflow — the `requires:[human]` escalation that blocks the item,
//      the §10.7 demotion, the `art-merge-*` fact — each under the
//      deterministic id the attempt would have minted, each idempotent, each
//      best-effort, reading NOTHING but the record.
//
// Tombstone FIRST because the settle's writes are durable and nothing
// reverses them: a refusal that left the journal resumable could be
// continued — and landed — by reverting the factory edit and re-driving it,
// under an escalation and a demotion still standing on the graph. A
// tombstoned journal fails every later `run()` before its version is read,
// and the driver re-settles from the RECORDED tombstone: same detail, same
// date, same ids, so a crash between the tombstone and the settle is
// re-settled idempotently on the next attempt, and a resume after the factory
// is reverted refuses again and never lands. Nothing is built, run or landed.
// The result is the stage's settled `failed` shape, tagged with WHY the
// attempt ended so the loop, `--status` and the record read it as a refusal
// of this attempt; the door back is a fresh attempt (`spor work --regate
// <run>`), which opens its own journal and judges under the current
// definition.
function refusalRecord({ item, factory, gatedHead, error, clock }) {
  const live = factory || {};
  const integration = live.integration || {};
  return {
    ...stageWorkflow.refusalRecord({ stage: "integration", what: STAGE_WHAT, verb: "landed", item, error, clock }),
    gatedHead: gatedHead || null,
    factoryId: live.id || null,
    definition: live.definition || null,
    integration: { mode: integration.mode || null, strategy: integration.strategy || null, targetRef: integration.targetRef || null },
  };
}

// A tombstone with NO record on it (the driver always writes one; only a
// hand-written tombstone lacks it): the settle still needs ids, so the
// record is rebuilt from the item and the live factory — the one place the
// live factory is read on the replayed path, and only because there is
// nothing else to read — honestly tagged by the tombstone's own `reason`,
// with the detail saying the record was missing.
function recordlessRefusal({ item, factory, gatedHead, entry, clock }) {
  return refusalRecord({ item, factory, gatedHead, error: stageWorkflow.recordlessError({ item, entry }), clock });
}

async function settleRefusal({ item, deps, log, refusal, replayed = false }) {
  const { buildIntegrationFact, integrationFactId, INTEGRATION_STAGE_ID } = integrationRunner;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const { detail, at, integration } = refusal;
  const gateAttempt = refusal.attempt || 0;
  const attempts = [{ verdict: "failed", detail }];
  const facts = [];
  const fn = (k) => typeof deps[k] === "function";
  let escalatedTo = null;
  try {
    const esc = fn("escalate") ? await deps.escalate({ attempts, detail, evidence: "", kind: null, fixCycles: 0 }) : null;
    if (esc && esc.ok) escalatedTo = esc.id;
    else log(`work: the integration escalation for ${nodeId} could not be filed (${(esc && esc.reason) || "no response"})`);
  } catch (e) {
    log(`work: the integration escalation for ${nodeId} could not be filed (${(e && e.message) || e})`);
  }
  let demoted = { demoted: false, note: null, reason: null };
  if (escalatedTo && fn("demote")) {
    try {
      const r = await deps.demote({ blockerId: escalatedTo });
      if (r && r.ok) demoted = { demoted: !!r.demoted, note: r.note || null, reason: null };
      else demoted = { demoted: false, note: null, reason: (r && r.reason) || "no response" };
    } catch (e) {
      demoted = { demoted: false, note: null, reason: `${(e && e.message) || e}` };
    }
    if (demoted.reason) log(`work: integration refused ${nodeId}, but the item could not be demoted on the graph (${demoted.reason}) — the verdict still stands`);
  }
  if (!escalatedTo) {
    log(
      `work: integration failed on ${nodeId}, but the escalation that would block it could not be filed — ` +
        `the item's status is left as the run left it; re-run this judgement with 'spor work --regate ${runId}'`
    );
  }
  const chain = { head: null, gatedHead: refusal.gatedHead || null, targetSha: null, landedSha: null, candidate: null, definition: refusal.definition || null };
  if (fn("recordFact")) {
    try {
      const fact = buildIntegrationFact({
        integration, nodeId, runId, project: item.project || null, verdict: "failed", detail, evidence: null, attempts, escalatedTo, trackingPending: null,
        demotion: demoted.note || (demoted.reason ? `the item could not be demoted on the graph (${demoted.reason})` : escalatedTo ? null : `not attempted — no escalation could be filed to block ${nodeId}, so its status is left as the run left it`),
        date: new Date(at).toISOString().slice(0, 10),
        factory: refusal.factoryId || null,
        attempt: gateAttempt,
        chain,
      });
      const wrote = await deps.recordFact({ id: fact.id, markdown: fact.markdown });
      if (wrote && wrote.ok) facts.push(fact.id);
      else log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
  }
  log(`work: integration failed on ${nodeId} — ${detail}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}${replayed ? " (re-settled from the attempt's refusal tombstone)" : ""}`);
  const escalationRetry = escalatedTo
    ? null
    : {
        stage: INTEGRATION_STAGE_ID, gateId: INTEGRATION_STAGE_ID, attempt: item.attempt,
        completedBeforeIntegration: deps.completedBeforeIntegration === true,
        attempts, detail, evidence: "",
        factId: integrationFactId(nodeId, runId, integration.mode === "propose" ? "failed" : null, gateAttempt),
      };
  const finishedAt = new Date(at).toISOString();
  return {
    state: "failed", facts,
    reason: `integration failed: ${detail}` + (escalatedTo ? "" : " (the escalation could not be filed, so the item's status was left alone)"),
    escalated_to: escalatedTo, demoted: demoted.demoted, demote_reason: demoted.reason,
    ...(escalatedTo ? {} : { escalation_failed: true }),
    ...(escalationRetry ? { escalation_retry: escalationRetry } : {}),
    ...stageWorkflow.refusalTags(refusal, { replayed }),
    attempts,
    head: null, gated_head: chain.gatedHead, head_matches_gated: null,
    target_ref: integration.targetRef || null, target_sha: null, landed_sha: null, candidate: null,
    mode: integration.mode || null, strategy: integration.strategy || null,
    started_at: finishedAt, finished_at: finishedAt, duration_ms: 0,
  };
}

// The one-shot composition the driver runs on a fresh refusal: record,
// tombstone, settle (stage-workflow.js settleOrRefuse). The tombstone is the
// kernel's own append — persisted before it returns, and a persist failure
// poisons the Execution and THROWS here, so a refusal that could not be made
// durable settles nothing: no escalation, no demotion, no fact lands over a
// journal that is still resumable. The throw takes the thrown-dep path up
// through the work loop, which files the pipeline as a settled `failed` ("the
// gate pipeline threw") and cools the item off — not a re-offer — so the door
// back is the explicit `spor work --regate <run> --resume`, whose re-drive
// refuses again, this time with a tombstone that lands.
async function refuseUnresumable({ item, factory, deps, log, gatedHead, error, clock, exec }) {
  const out = await stageWorkflow.settleOrRefuse(error, exec, {
    item,
    build: (e) => refusalRecord({ item, factory, gatedHead, error: e, clock }),
    settle: (refusal, { replayed }) => settleRefusal({ item, deps, log, refusal, replayed }),
  });
  if (!out) throw error;
  return out.result;
}

module.exports = {
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  YIELD_MS,
  INTEGRATION_ACTIVITIES,
  depsShape,
  definitionBindingDigest,
  integrationWorkflow,
  bindIntegrationActivities,
  driveIntegrationStage,
  refusalRecord,
  recordlessRefusal,
  refuseUnresumable,
  settleRefusal,
};
