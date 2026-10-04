"use strict";
// The gate pipeline's and the integration stage's REAL dependencies
// (task-spor-extract-make-gate-deps-to-lib-shell).
//
// lib/shell/gate-runner.js and lib/shell/integration-runner.js are
// dependency-injected: every door they open onto the world (dispatch a review
// or a fix, pin the candidate, write a gate fact, take the gate lease, run the
// suite, land the merge) is a `deps` member. The objects that fill those
// members used to be built inline in bin/spor.js, which exports nothing, so
// every real dep was untestable by construction — the pipeline tests all stub
// them. They now live here as makeGateDeps / makeIntegrationDeps, moved
// verbatim, over an injected `host` of the CLI helpers they call (the same
// shape as lib/shell/dispatch.js's createDispatcher), so a test can build the
// real deps against a fake host. bin/spor.js keeps the wiring (cmdWork and
// runGateAndIntegration still call makeGateDeps / makeIntegrationDeps).

const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const remote = require(path.join(ROOT, "lib", "remote.js"));
const dispatchRuns = require(path.join(__dirname, "agent-dispatch-runner.js"));
const workLoop = require(path.join(__dirname, "work-loop.js"));
const gatesKernel = require(path.join(ROOT, "lib", "kernel", "gates.js"));
const candidateKernel = require(path.join(ROOT, "lib", "kernel", "candidate.js"));
const completionKernel = require(path.join(ROOT, "lib", "kernel", "completion.js"));
const completionShell = require(path.join(__dirname, "completion.js"));
const gateRunner = require(path.join(__dirname, "gate-runner.js"));
const candidatePublish = require(path.join(__dirname, "candidate-publish.js"));
const integrationRunner = require(path.join(__dirname, "integration-runner.js"));
const ciGate = require(path.join(__dirname, "ci-gate.js"));
const workerContractLib = require(path.join(__dirname, "worker-contract.js"));
const stageProjection = require(path.join(__dirname, "stage-projection.js"));

// How many recurrence rungs the per-file flake id may climb past a SETTLED
// occupant before the gate gives up and charges the failure (fileFlakeItem).
// Small on purpose: a file whose flake issue has been closed and reopened four
// times is not a convergence problem, it is a test that needs a person.
const FLAKE_ID_RUNGS = 4;

// The pipeline's OWNER as the deps see it: the lease token the caller claimed
// (`gateOwner`, runGateAndIntegration's claimPipeline), or — for deps built
// with no claim in hand — whoever holds the pipeline on disk right now (a
// legacy record's settle nonce standing in for a lease it predates). Null
// means nobody has ever claimed it.
function pipelineOwner(home, runId, gateOwner) {
  if (gateOwner !== undefined) return gateOwner;
  try {
    const r = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
    if (!r) return null;
    const lease = stageProjection.pipelineLease(home, r);
    return lease ? lease.token : r.gate_settle_id ?? r.gate_at ?? null;
  } catch {
    return null;
  }
}

// The ONE door for every stamp a gate-pipeline closure leaves on the run
// record (the fix/rescue launch ids, the proposal's park fields —
// issue-spor-gate-stamps-bypass-lease-owner): through stampGateState's `own`
// door, so it lands only while the pipeline's lease still carries this
// driver's token. A driver displaced by a takeover (its lease expired while a
// pass stalled, another worker claimed it) writes nothing onto the new
// holder's record. Deps with no owner at all may stamp only a record nobody
// has claimed since — the same arm the ledger writer refuses on, decided under
// the record lock — so a worker's record never gains a fix id a standalone
// caller launched. A stamp that did not land throws — except where there is
// no readable record at all (a run with nothing to own, which the claim also
// passed over): there is no holder to protect, so it stamps nothing, as before.
function stampPipelineLaunch(home, runId, owner, patch) {
  let present = null;
  try {
    present = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
  } catch {
    present = null;
  }
  if (!present) return null;
  const after = owner != null
    ? dispatchRuns.stampGateState(home, runId, patch, { own: owner })
    : dispatchRuns.stampGateState(home, runId, (fresh, lease) => (lease != null || fresh.gate_settle_id != null || fresh.gate_at != null ? null : patch), {});
  const landed = !!after && Object.entries(patch).every(([k, v]) => JSON.stringify(after[k]) === JSON.stringify(v));
  if (!landed) throw new Error("the run record could not be updated: the gate pipeline is settled or its owner changed");
  return after;
}

// The CLI helpers the deps call, named so a missing one fails at construction
// rather than as a ReferenceError halfway through a gate.
const HOST_FUNCTIONS = Object.freeze([
  "acquireIntegrationLease", "addGateEdge", "attestationGraphOrigin", "attestationOriginMatches",
  "attestationPublicationConfig", "awaitGateRun", "buildGateWorkNode", "buildProposalBody",
  "buildProposalTrackingNode", "candidateResolverFromReport", "dispatchAgentId",
  "dispatchResolutionReason", "dispatchThrough", "excludeRescueDiagnosisDir", "fenceSafe",
  "freshRecord", "gateApprovalState", "gateChangeSet", "gateDemoteItem", "gateDiffText",
  "gateFixText", "gateHistoryText", "gateIdSuffix", "gateLeaseBudgetMs", "gateNodeEquivalent",
  "gateRescueDiagnosis", "gateRunReportText", "gateStem", "gateWorkItemText", "git",
  "implBudgetStamp", "launchedFixRun", "mainCheckoutOf", "makeCompletionDeps", "nodeUnreadable",
  "noteReviewerSuccess", "prepareGateTree", "proposalTrackingId", "proposeIntegrationPR",
  "readReviewerCooldown", "refuseDirtyCandidate", "releaseIntegrationLease",
  "removeDispatchWorktree", "reportlessReviewReason", "rescueDiagnosisPath", "rescueHarnessAdapter",
  "rescuePassthrough", "resolveNode", "reviewPassthrough", "reviewerIndependence", "runGateCommand",
  "stageThrowawayTree", "stampReviewerCooldown", "teardownThrowawayTree", "verifyRunResolution",
  "withoutFlakeEdges", "workerContract", "worktreeDeclaredEnv", "writeGateNode",
]);

function createGateDeps(host) {
  const missing = HOST_FUNCTIONS.filter((k) => typeof (host && host[k]) !== "function");
  if (missing.length) throw new Error(`createGateDeps: host is missing ${missing.join(", ")}`);
  if (!(Number(host.GATE_DIFF_CAP_BYTES) > 0)) throw new Error("createGateDeps: host is missing GATE_DIFF_CAP_BYTES");
  const {
    GATE_DIFF_CAP_BYTES,
    acquireIntegrationLease, addGateEdge, attestationGraphOrigin, attestationOriginMatches,
    attestationPublicationConfig, awaitGateRun, buildGateWorkNode, buildProposalBody,
    buildProposalTrackingNode, candidateResolverFromReport, dispatchAgentId,
    dispatchResolutionReason, dispatchThrough, excludeRescueDiagnosisDir, fenceSafe, freshRecord,
    gateApprovalState, gateChangeSet, gateDemoteItem, gateDiffText, gateFixText, gateHistoryText,
    gateIdSuffix, gateLeaseBudgetMs, gateNodeEquivalent, gateRescueDiagnosis, gateRunReportText,
    gateStem, gateWorkItemText, git, implBudgetStamp, launchedFixRun, mainCheckoutOf,
    makeCompletionDeps, nodeUnreadable, noteReviewerSuccess, prepareGateTree, proposalTrackingId,
    proposeIntegrationPR, readReviewerCooldown, refuseDirtyCandidate, releaseIntegrationLease,
    removeDispatchWorktree, reportlessReviewReason, rescueDiagnosisPath, rescueHarnessAdapter,
    rescuePassthrough, resolveNode, reviewPassthrough, reviewerIndependence, runGateCommand,
    stageThrowawayTree, stampReviewerCooldown, teardownThrowawayTree, verifyRunResolution,
    withoutFlakeEdges, workerContract, worktreeDeclaredEnv, writeGateNode,
  } = host;

  // The ONE wait half every lane shares — the gate pipeline's fix and rescue
  // cycles, the implementation stage's re-dispatch, AND the integration
  // stage's own fix cycle (issue-spor-unfollowable-fix-may-still-dispatch-
  // rescue folded the third, separate awaitRun in here, so it too gets the
  // idle ceiling and the `unfollowable` reading). Shape, every lane:
  // {ok, runId, record, classification, finishedAt, unfollowable, reason?}.
  // `lane` picks the window — the operator's ceiling (--run-max) for a fix or
  // an implementer, the rescue lane's declared `await_ms` for a rescue — and
  // the AGE watchdog is per lane (a rescue's `await_ms` is a WAIT budget from
  // this await, never an age, so `maxAgeMs` is 0 there). `ok` means FOLLOWED
  // TO A TERMINAL STATE this worker read: a run the poll gave up on (an idle
  // stop that did not take, the watchdog) comes back `ok: false,
  // unfollowable: true` with whatever record it has — not evidence the agent
  // stopped, so no lane judges its tree as finished work or re-dispatches
  // into a checkout something may still hold.
  function laneAwaitRun(cfg, { factory, runMaxMs, runIdleMs, warn, sleep }) {
    return async ({ runId, lane = "fix" }) => {
      const rescueMs = lane === "rescue" && factory && factory.rescue && Number(factory.rescue.awaitMs) > 0 ? Number(factory.rescue.awaitMs) : 0;
      const timeoutMs = rescueMs || runMaxMs;
      const done = await awaitGateRun(cfg, runId, { timeoutMs, warn, sleep, maxAgeMs: lane === "rescue" ? 0 : runMaxMs, idleMs: runIdleMs });
      const record = (done && done.record) || null;
      if (!done.ok) return { ok: false, runId, record, classification: null, finishedAt: null, unfollowable: false, reason: done.reason };
      if (done.unfollowable) {
        return { ok: false, runId, record, classification: null, finishedAt: null, unfollowable: true, reason: (record && record.terminal_note) || "this worker stopped following the run" };
      }
      return { ok: true, runId, record, classification: gatesKernel.classifyExecutionOutcome(record), finishedAt: (record && record.finished_at) || null, unfollowable: false };
    };
  }

  function makeGateDeps(
    cfg,
    { record, entry, factory, slug, passthrough, warn, sleep, log, workerId = null, gateOwner = undefined, runMaxMs = workLoop.WORK_DEFAULTS.runMaxMs, runIdleMs = workLoop.WORK_DEFAULTS.runIdleMs, stopping = () => false, dispatch = dispatchThrough, home = cfg.userConfigHome() }
  ) {
    const date = () => new Date().toISOString().slice(0, 10);
    const stem = gateStem(entry.node_id);
    // A re-gate (entry.attempt > 1) mints ids under an attempt-scoped key so its
    // facts and escalations never collide with the first attempt's.
    const short = gateRunner.shortRunAttempt(entry.run_id, entry.attempt);
    const runKey = gateRunner.gateRunKey(entry.run_id, entry.attempt);
    // A RESCUE pass (task-spor-factory-rescue-lane) re-runs the gates on the
    // same run; everything it files or names is keyed one segment deeper so it
    // never collides with — or silently adopts — the original pass's node.
    // Pass 0 hands back the exact keys above.
    const keysFor = (rescue) => (rescue ? { short: gateRunner.shortRunAttempt(entry.run_id, entry.attempt, rescue), runKey: gateRunner.gateRunKey(entry.run_id, entry.attempt, rescue) } : { short, runKey });
    const progressKey = (gate, rescue) => (rescue ? `${gate.id}#x${rescue}` : gate.id);
    // Capture the owning nonce once, never refresh it after another adopter
    // takes over. The controller supplies its claim explicitly; standalone
    // callers inherit only the record they observed when creating these deps.
    const readRecordNow = () => {
      try {
        return dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record) || record || null;
      } catch {
        return record || null;
      }
    };
    const progressOwner = pipelineOwner(home, entry.run_id, gateOwner);
    // The gate LEDGER's writer (stage-projection.js writeGateProgress): the
    // append-only gate-progress log beside the run's stage journals, written
    // under the record lock with the same refusals the record writer had
    // (settled, owner changed, attempt changed), never the record itself
    // (task-spor-run-surfaces-read-stage-journal).
    const updateGateProgress = (mutate) => {
      const result = stageProjection.writeGateProgress(home, entry.run_id, mutate, { key: runKey, attempt: entry.attempt, own: progressOwner });
      if (!result.ok) throw new Error(`the run record could not be updated: ${result.reason}`);
      return result.progress;
    };
    // The launch stamps a fix/rescue closure leaves on the RECORD
    // (`gate_fix_*`, `gate_rescue_*`: a child run's identity, which is the
    // record's to keep), through the owned door; a stamp that did not land —
    // a settled record, an owner that changed — throws like the ledger write.
    const stampLaunch = (patch) => stampPipelineLaunch(home, entry.run_id, progressOwner, patch);
    // The current ledger stamp, read fresh off the log (then, read-only, a
    // legacy record's own `gate_progress`).
    const readProgressNow = () => stageProjection.latestProgress(home, readRecordNow() || { run_id: entry.run_id }).stamp;
    let change = null;
    // The local graph, loaded lazily and at most once, for the one inbound fact
    // the `node` dep cannot read off a node's own file (see there). Remote mode
    // never loads it; a graph that will not load answers "nothing supersedes
    // this", which is the fail-closed reading for every caller.
    //
    // EVERY superseder, not `graph.supersededBy`'s: that index is single-winner
    // and last-writer-wins over file read order, so where two nodes supersede one
    // item — a genuine third-party supersession plus a resolver using
    // `supersedes` as its item link — which one it reports depends on readdir
    // order, and the caller's "is the only superseder the node this run declared"
    // test would then pass on one box and fail on another.
    let localGraph;
    const localSupersededBy = (id) => {
      if (remote.isRemote(cfg)) return [];
      if (localGraph === undefined) {
        try {
          localGraph = require(path.join(ROOT, "lib", "graph.js")).loadGraph(cfg.nodesDir());
        } catch {
          localGraph = null;
        }
      }
      if (!localGraph || !localGraph.nodes) return [];
      const out = [];
      for (const n of Object.values(localGraph.nodes)) {
        if ((n.edges || []).some((e) => e && String(e.type).toLowerCase() === "supersedes" && e.to === id)) out.push(n.id);
      }
      return out;
    };
    // The work item's own text, read once for the review prompt: a reviewer
    // judging "does this do what was asked" has to be told what was asked.
    let itemText = null;
    const workItemText = async () => {
      if (itemText !== null) return itemText;
      try {
        const node = await resolveNode(cfg, entry.node_id);
        itemText = node && !nodeUnreadable(node) ? gateWorkItemText(node) : "";
      } catch {
        itemText = "";
      }
      return itemText;
    };

    // The review prompt (task-spor-review-gate-stateful-bounded). Everything the
    // reviewer needs is IN the prompt — the work item, the diff itself, the
    // prior findings with the ids the ledger gave them, the fix the last cycle
    // made — so review N does not restart from nothing in the implementer's
    // checkout and raise a fourth new finding where three were already open.
    // The verdict protocol it is asked to follow is the one
    // gates.parseReviewVerdict enforces; the prose here only explains it.
    const review = async ({ gate, cycle, prior = [], raised = [], fix = null, rescue = 0, base = 0, retry = 0 }) => {
      if (!change) return { ok: false, reason: "the change under review could not be read" };
      const cap = gatesKernel.cycleCap(gate);
      // On a rescue pass the cycle index continues (so the stateful protocol
      // treats the rescue's fix as a fix), but the budget the reviewer is told
      // about is the rescue pass's own, counted from `base`.
      const shown = rescue ? cycle - base : cycle;
      const item = await workItemText();
      const diff = gateDiffText(change);
      const fixText = fix ? gateFixText(change, fix) : "";
      // How many fix cycles each prior finding has already survived, and the
      // rows an earlier review enumerated for it: a finding carried a second
      // time must be answered with the mechanism's rows (below), not the next
      // one (task-spor-review-gate-carried-finding-names-the-mechanism-not-the-
      // next-row).
      const carriedOf = (p) => gatesKernel.carriedFixCycles(p, cycle);
      const secondCarry = prior.filter((p) => carriedOf(p) >= gatesKernel.ROW_BY_ROW_CARRY);
      // The carried findings the ledger records as a done-condition dispute: a
      // second confirmation of one ends this gate's fix cycles (the runner's
      // short-circuit, task-spor-review-gate-item-done-condition-vs-implementer-
      // conclusion), so the reviewer is told what its answer costs — not to
      // soften it, but so it says what the item asks and what the change does.
      const unmetPrior = prior.filter((p) => gatesKernel.categoryOf(p) === gatesKernel.UNMET_CONDITION);
      const priorText = prior
        .map(
          (p) =>
            `${p.id} [${p.severity}${gatesKernel.categoryTag(p)}${carriedOf(p) ? `, carried ${carriedOf(p)} fix cycle${carriedOf(p) === 1 ? "" : "s"}` : ""}] ${p.file ? `${p.file} — ` : ""}${p.summary}` +
            (p.evidence ? `\n    evidence: ${String(p.evidence).replace(/\s+/g, " ").slice(0, 400)}` : "") +
            gatesKernel.mechanismRows(p.rows).map((r) => `\n    row (enumerated by the last review${Number.isInteger(p.rowsCycle) ? `, cycle ${p.rowsCycle}` : ""}): ${r}`).join("") +
            // An enumeration the LAST review did not re-confirm is replayed as
            // history, never as the current row list (F1 on the second cut).
            (gatesKernel.mechanismRows(p.rows).length ? [] : gatesKernel.mechanismRows(p.earlierRows))
              .map((r) => `\n    row (enumerated at ${Number.isInteger(p.earlierRowsCycle) ? `cycle ${p.earlierRowsCycle}` : "an earlier cycle"}, NOT re-confirmed by the last review — re-enumerate if it still stands): ${r}`)
              .join("")
        )
        .join("\n");
      const raisedText = raised
        // The category rides this line for the same reason it rides `priorText`:
        // an upgrade by id INHERITS it, so the reviewer must be able to see the
        // one it is about to keep (F1 on the fourth cut of this gate).
        .map(
          (p) =>
            `${p.id} [${p.severity}${gatesKernel.categoryTag(p)}, undemonstrated at cycle ${p.opened}] ${p.file ? `${p.file} — ` : ""}${p.summary}`
        )
        .join("\n");
      const verdictShape =
        `{"verdict": "pass" | "changes_requested",` +
        // `category` is on the prior shape because the prose below tells the
        // reviewer to reclassify a carried finding with it (F2 on the fourth cut
        // of this gate: the field was asked for and never shown). It is the one
        // OPTIONAL key here — omitting it keeps the finding's recorded category,
        // which is what a reviewer that is not reclassifying wants — so it is
        // labelled as such, and the parser reads only the category vocabulary
        // it was taught, so an echo of this template reclassifies nothing.
        (prior.length
          ? ` "prior": [{"id": "${prior[0].id}", "status": "resolved" | "open", "note": "what you checked", "rows": ["each remaining row of the mechanism, when open"], "category": "correctness|unmet-condition|unrequested-mechanism — OPTIONAL, only to RECLASSIFY it; omit to keep the one it has"}],`
          : "") +
        ` "findings": [{"severity": "blocking|major|minor", "category": "correctness|unmet-condition|unrequested-mechanism", "file": "path", "summary": "what is wrong", "evidence": "the command/test you ran and what it showed"` +
        (cycle > 0 ? `, "introduced_by_fix": true | false` : "") +
        `}]}`;
      const prompt = [
        `You are the '${gate.id}' review gate for Spor work item ${entry.node_id}` +
          (rescue
            ? shown === 0
              ? ` (the review after the rescue lane's fix, rescue attempt ${rescue} — judge the rescue's commits as a fix cycle).`
              : ` (the review after fix cycle ${shown} of ${cap} of rescue attempt ${rescue}).`
            : cycle === 0
              ? " (the initial review)."
              : ` (the review after fix cycle ${cycle} of ${cap}).`),
        "You are running READ-ONLY. Do NOT edit any file, do NOT commit, and do NOT resolve, close, or write any Spor node:",
        "you are a gate, not an implementer. Run commands and tests freely to check your claims.",
        "",
        "## The work item",
        "",
        item || `(the node ${entry.node_id} could not be read — judge the change against its commit messages)`,
        "",
        "## The change",
        "",
        `\`git diff ${change.base}..${change.head}\` in ${change.cwd} (${Array.isArray(change.paths) ? change.paths.length : "?"} file(s)):`,
        "",
        "```diff",
        gateRunner.fenceSafe(diff.text),
        "```",
        diff.truncated ? `(diff truncated at ${Math.round(GATE_DIFF_CAP_BYTES / 1024)}KB — run the git command above for the rest)` : "",
        "",
        ...(prior.length
          ? [
              "## Prior findings — answer these FIRST",
              "",
              "Earlier cycles of this gate raised the following BLOCKING findings, which the implementer was sent to fix.",
              "For EACH one, check the current tree and say whether the fix resolved it (`prior` in the verdict):",
              "",
              priorText,
              "",
              ...(fixText ? ["## What the last fix cycle changed", "", fixText, ""] : []),
              "A verdict that omits any prior finding (neither cleared nor confirmed) is UNREADABLE and counts as",
              "changes_requested for the prior set only — nothing new you raise is admitted in that case.",
              "",
              "### A carried finding names the MECHANISM, not the next row",
              "",
              "When you confirm a prior finding open, do not answer with the next failing case. Name the mechanism the",
              "finding is one instance of (the thing every case has in common — a stream the client reads text off, a",
              "flag one pass writes for another, a path spelling), enumerate EVERY remaining row of it you can see as",
              "`rows` on that prior entry (one string per row — the cases one fix would have to close together), and say",
              "in the note which rows the fix must close for the finding to resolve. A fix closes the row it was shown;",
              "a finding answered one row per cycle spends the whole cycle budget on one mechanism.",
              ...(secondCarry.length
                ? [
                    "",
                    `${secondCarry.map((p) => p.id).join(", ")} ${secondCarry.length === 1 ? "has" : "have"} already been carried through ${gatesKernel.ROW_BY_ROW_CARRY} or more fix cycles: if you confirm ${secondCarry.length === 1 ? "it" : "any of them"} open, \`rows\``,
                    "is REQUIRED — a confirmation naming fewer than two rows is recorded as row-by-row on the finding and on the",
                    "gate's fact, and the fixer is told to enumerate the rows itself.",
                  ]
                : []),
              ...(unmetPrior.length
                ? [
                    "",
                    `${unmetPrior.map((p) => p.id).join(", ")} ${unmetPrior.length === 1 ? "is" : "are"} recorded as an UNMET DONE CONDITION — a scope dispute, not a defect. Confirming`,
                    `${unmetPrior.length === 1 ? "it" : "one"} open once it has been carried ${gatesKernel.UNMET_CONDITION_CARRY} fix cycles ENDS this gate's fix cycles: no further implementer is`,
                    "dispatched at it and the refusal goes to the rescue lane or to a person, whose call a re-scope is.",
                    "Confirm it open anyway if the condition is still unmet — that is the correct answer and the routing is",
                    "not yours to manage — and use the note to say what the item asks, what the change achieves against it,",
                    "and what the last fix argued.",
                  ]
                : []),
              "",
            ]
          : []),
        "## What to look for",
        "",
        gate.instructions || "Look for correctness defects: does this change do what the work item asked, and does it break anything?",
        "",
        "## Finding category — a defect, an unmet done condition and unrequested mechanism are different findings",
        "",
        "Every finding carries a `category`:",
        "",
        "- `correctness` (the default): the change is WRONG — a defect, silent data loss, a contract break.",
        "- `unmet-condition`: the change is not wrong, it does not do what the WORK ITEM ASKED. Its stated done",
        "  condition is unmet — a measured bar the result misses, a deliverable that was not attempted.",
        "- `unrequested-mechanism`: the defect is real but it is in mechanism the item's acceptance does not require,",
        "  and REMOVING that mechanism would also satisfy the finding. That removal test is the whole category: if",
        "  deleting the surface would not close what you found, it is `correctness`, not this.",
        "",
        "Categorize honestly; they are answered differently. A defect is fixed. An unmet condition is met by a fresh,",
        "materially different attempt at the thing, or by a person re-scoping the item — never by more evidence that it",
        `is unmet, so once one has been carried ${gatesKernel.UNMET_CONDITION_CARRY} fix cycles the runner stops dispatching fixes at it and routes the`,
        "refusal to the rescue lane or a person. To reclassify a prior finding you already raised, put `category` on its",
        "`prior` entry; omit it and the finding keeps the category it has, which is what you want when you are only",
        "confirming it. Naming one of the two earlier findings by id, to demonstrate it, likewise keeps the category it",
        "was raised under unless you restate one. A finding you rate `unmet-condition` blocks on exactly the same terms as any other: only if you",
        "DEMONSTRATE it — `evidence` naming what you ran and what it showed against the item's condition.",
        "",
        "A fix that ARGUES the condition is unattainable — a doc verdict, a test pinning the miss, a second measurement",
        "of the same approach — has not met it: confirm the finding open and say so. A fix that files a decision",
        "re-scoping the item has not met it either, and accepting a re-scope is not a reviewer's call: confirm it open,",
        "name the decision in the note, and let the person the runner routes it to judge the re-scope.",
        "",
        "Unrequested mechanism is answered by DELETION, so it is recorded advisory and never fails this gate however",
        "well you demonstrate it — the fixer is asked to remove the surface, not to harden it. Rate it honestly rather",
        "than reaching for `correctness` to make it stick: a fix cycle spent hardening mechanism the item never asked",
        "for is the budget gone, and the next review then attacks what that hardening added.",
        "",
        "## Scope — say what a blocking finding fails",
        "",
        "A blocking finding names ONE of two things, in its summary or its evidence: the line of the WORK ITEM's",
        "acceptance the change does not meet, or the defect this DIFF introduces into behaviour that worked before.",
        "A finding that is neither — a hardening you would like, a case the item never claimed to cover, a design you",
        "would have chosen — is `major`/`minor`, recorded and not enforced.",
        ...(cycle > 0
          ? [
              "",
              "On a fix cycle this is where the budget goes: a previous fix added mechanism to answer a finding, and the",
              "mechanism it added has its own defects, each true and each `introduced_by_fix`. Before you block on one, ask",
              "the removal question and ANSWER it in the note: would deleting the mechanism this finding attacks also",
              "satisfy the finding, and does the item's acceptance require that mechanism at all? If deleting it would",
              "satisfy you, the finding is `unrequested-mechanism` — say so and let the fixer delete it, rather than",
              "blocking until it is hardened enough that the next review finds the next hole in it.",
            ]
          : []),
        "",
        "## Durable retry/debt flags — review the mechanism WHOLE, in this one verdict",
        "",
        "If the change introduces or extends a durable retry/debt flag — a `*_pending` field on a run record, a journal",
        "line, a cooldown file, an outbox entry: anything one pass writes so a later pass owes an action — walk EVERY",
        "row below against it and file every row that is open in THIS verdict, each as its own finding naming the row.",
        "Do not raise one row now and the next after the fix: a flag reviewed one failure mode per cycle spends the",
        "whole cycle budget on one design.",
        "",
        gatesKernel.renderDurableFlagChecklist(),
        "",
        ...(cycle > 0
          ? [
              "On a fix cycle, walk the table again against the writes the fix added or reordered: a row the fix",
              "INTRODUCED is blocking (`introduced_by_fix: true`); a row that was open at the initial review and was not",
              "raised then is advisory now.",
              "",
            ]
          : []),
        "## Outcome-field forwarding",
        "",
        gatesKernel.renderOutcomeFieldForwardingCheck(),
        "",
        ...(raised.length
          ? [
              "## Earlier findings rated blocking but not demonstrated",
              "",
              "These were recorded as advisory because no command or test backed them. If you can DEMONSTRATE one now,",
              "raise it again under `findings` with ITS id and `evidence`; it then counts as raised at its original cycle.",
              "",
              raisedText,
              "",
            ]
          : []),
        ...(prior.length || raised.length
          ? [
              "## Finding ids — you name one only to answer `prior` or upgrade a raised finding",
              "",
              "A finding you raise FRESH under `findings` carries NO `id` — the ledger mints one once this verdict folds",
              "in, and the fixer and the next review then address it by that name. The only findings you put an `id` on",
              "are: answering an entry under `prior` above (its id goes under `prior`, never under `findings`)" +
                (raised.length ? ", and re-raising one of the undemonstrated findings above under `findings` with ITS id to upgrade it." : ".") +
              " Do not invent an id for anything else — a numbering scheme of your own (`F1`, `F2`, …) can land on a name",
              "the ledger already uses for something else, and is then read as that other finding's name already taken,",
              "not as the id of the finding you meant.",
              "",
            ]
          : []),
        "## Severity — only `blocking` blocks",
        "",
        "- `blocking`: a correctness defect, silent data loss, or contract break that MUST be fixed before this lands —",
        "  and that you DEMONSTRATED: `evidence` names the command or test you ran and what it showed. A blocking",
        "  finding without evidence is recorded as advisory, not enforced — a `changes_requested` backed ONLY by",
        "  undemonstrated blocking findings passes with those findings recorded as advisory. Demonstrate what you block on:",
        "  `evidence` is a string naming what you ran; `true`, `yes` or a bare affirmation is not evidence.",
        ...(cycle > 0
          ? [
              "- On a fix cycle, a NEW blocking finding must be one the fix INTRODUCED (`introduced_by_fix: true`). A defect",
              "  that was there at the initial review and was not raised then is advisory now — record it, do not block on it.",
            ]
          : []),
        "- `major` / `minor`: worth noting, never a reason to fail the gate. Style, naming and formatting are minor.",
        "",
        "End your final message with your verdict as a fenced json block, exactly this shape:",
        "```json",
        verdictShape,
        "```",
        `Use "pass" only when nothing blocking remains${prior.length ? " — including every prior finding you confirmed" : ""}. An unreadable verdict counts as changes_requested.`,
      ].join("\n");
      // "no-auto-route": a free-text review dispatch names no `node:`, so today's
      // auto tier can't act on it anyway (it only re-routes a NODE dispatch) —
      // but the flag rides here too, explicitly, so this stays true if the
      // profile ever resolves against the work item's node in the future
      // (issue-spor-auto-route-reaches-fix-cycle-and-rescue-dispatches).
      // The run NAME is a launch identity: the dispatch door adopts a run
      // already launched under it (dec-spor-adopt-by-name-returns-existing),
      // so everything that legitimately re-dispatches a review at the same
      // cycle must change the name — the judged head (a fix cycle restarts the
      // list from gate 0 at a new head, and a review of H1 is no verdict on
      // H2), the ROUTED lane (a fallback reviewer is a different launch) and
      // the infrastructure retry count (a re-ask after an outage must not
      // adopt the dead reviewer). A worker that dies mid-review and resumes
      // at the same head/lane/count adopts the reviewer still running, which
      // is the duplicate-dispatch defect this closes.
      const laneStem = String(gate.profile || "lane").replace(/^profile-/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 24) || "lane";
      const reviewName = `gate-${gate.id}-${keysFor(rescue).short}-${cycle}-${String(change.head || "nohead").slice(0, 8)}-${laneStem}${Number(retry) > 0 ? `-t${Number(retry)}` : ""}`;
      const launched = await dispatch(
        cfg,
        { ...reviewPassthrough(passthrough), profile: gate.profile, dir: change.cwd, "no-brief": true, "no-worktree": true, "read-only": true, "no-auto-route": true, name: reviewName },
        [prompt]
      );
      if (launched.ok && launched.adopted) log(`work: gate ${gate.id} review (cycle ${cycle}) on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
      // The CLASSIFICATION rides every failure this closure hands back
      // (FACTORY-IMPLEMENTATION-STAGE.md §5.3, task-spor-factory-execution-
      // outcome-classifier). The kernel owns the table; the shell owns the two
      // inputs it reads — the dispatch REFUSAL (no run record was ever created)
      // and the run RECORD (one was). The runner never guesses at either.
      if (!launched.ok) {
        return {
          ok: false,
          reason: `the review under ${gate.profile} could not be dispatched: ${launched.reason}`,
          classification: gatesKernel.classifyExecutionOutcome(null, launched.reason),
        };
      }
      const done = await awaitGateRun(cfg, launched.run.run_id, { timeoutMs: gate.awaitMs, warn, sleep });
      // A review that burned its whole `await_ms` window, or whose record could
      // not be read, is deliberately NOT classified: there is no terminal record
      // to read, and waiting again buys nothing that waiting has not already
      // failed to buy. It keeps the fail-closed reading it always had.
      if (!done.ok) return { ok: false, reason: done.reason };
      // The reviewer's harness reached a terminal state. If that state is an
      // OUTAGE — credit or rate exhaustion, an auth refusal, a harness that died
      // at boot, a supervisor that vanished — then whatever it did or did not
      // write is not a verdict on the change, and reading its (absent) report as
      // `changes_requested` is what dispatched a fixer at a finding nobody made
      // (issue-spor-review-gate-reviewer-outage-read-as-rejection). Read BEFORE
      // the report, so the misleading "no final report" message stops standing in
      // for the harness's own reason.
      const classification = gatesKernel.classifyExecutionOutcome(done.record);
      if (classification.outcome === "infrastructure") {
        return { ok: false, reason: `the review run under ${gate.profile} ${classification.reason}`, classification, runId: launched.run.run_id, finishedAt: (done.record && done.record.finished_at) || null };
      }
      const text = gateRunReportText(done.record);
      if (!text.trim()) {
        // `classification` rides back for the record, not for a branch:
        // `outageOf` acts only on `infrastructure`/`unroutable`, and this arm is
        // reached only after the infrastructure branch above declined it — so
        // the refusal is charged exactly as it always was, and only its REASON
        // changes (issue-spor-review-gate-reportless-run-blamed-on-routing).
        return {
          ok: false,
          reason: `the review run under ${gate.profile} ${reportlessReviewReason(done.record, classification)}`,
          classification,
          runId: launched.run.run_id,
        };
      }
      return { ok: true, text, runId: launched.run.run_id, startedAt: (done.record && done.record.created_at) || null, finishedAt: (done.record && done.record.finished_at) || null };
    };

    // The fix cycle in two halves — the launch (adopt-by-name, so a re-run
    // under the same name returns the run already started) and the wait for
    // its terminal state — so the gate workflow can journal the run it
    // launched and await it as a SIGNAL (lib/shell/gate-workflow.js); `fix`
    // is the one-shot composition of the two, for a caller that drives the
    // pipeline without the signal seam.
    const dispatchFix = async ({ gate, cycle, findings, detail, evidence, ledger, rescue = 0, base = 0 }) => {
      // The one place the worker deliberately passes --force. The loop never
      // does (a loop that forces past the resolved/duplicate guards is the
      // runaway a pull worker must not be), but here the runner KNOWS why the
      // node reads resolved — its own gate just refused that resolution — and the
      // cycle cap bounds how often this can happen before a person is asked.
      //
      // A review gate's findings arrive classified (blocking / advisory) and
      // named by ledger id; the fixer is told to name the ids it addressed so
      // the next review can answer "was F2 fixed" against its commits.
      const blocking = (findings || []).filter((f) => f.blocking !== false);
      // …minus the ones released on acceptance grounds: they get their own
      // section below, and "fix if cheap" is the opposite of what that section
      // asks for.
      const advisory = (findings || []).filter((f) => f.blocking === false && !gatesKernel.isUnrequestedMechanism(f));
      const resolved = (ledger || []).filter((e) => e.status === "resolved");
      // The blocking findings that already survived a fix cycle: the fixer is
      // asked to enumerate the mechanism's rows itself and say which the fix
      // closes and which it leaves, so the next review reads a design rather
      // than the next probe (task-spor-review-gate-carried-finding-names-the-
      // mechanism-not-the-next-row). `cycle` is the review index the findings
      // came from; the dirty-tree round-trip's `"tree"` carries nothing.
      const carriedFindings = blocking.filter((f) => gatesKernel.carriedFixCycles(f, cycle) >= 1);
      // The blocking findings the review classified as an UNMET DONE CONDITION
      // rather than a defect (task-spor-review-gate-item-done-condition-vs-
      // implementer-conclusion): the fixer is told the two are answered
      // differently, because the run that named this answered a condition with
      // three cycles of evidence that it was unmet and the rescue then met it in
      // one materially different attempt.
      const unmetFindings = blocking.filter((f) => gatesKernel.categoryOf(f) === gatesKernel.UNMET_CONDITION);
      // The findings the review rated against mechanism the item never asked
      // for (task-spor-factory-review-gate-fix-cycles-grow-unrequested-
      // mechanism). These are always ADVISORY — the parser's acceptance floor
      // downgrades them — so they arrive under `advisory`, not `blocking`, and
      // the answer asked for is the opposite of the usual one: delete the
      // surface the finding is about instead of hardening it. Read off the
      // whole findings list rather than either bucket, so a fold that ever
      // classifies one differently still routes it here.
      const unrequestedFindings = (findings || []).filter((f) => gatesKernel.isUnrequestedMechanism(f));
      const carriedText = carriedFindings
        .map((f) => {
          const n = gatesKernel.carriedFixCycles(f, cycle);
          return `${f.id} has survived ${n} fix cycle${n === 1 ? "" : "s"}${f.rowByRow ? " and the review named only the next row (row-by-row)" : ""}`;
        })
        .join("\n");
      const prompt = [
        // The dirty-tree round-trip arrives as `cycle: "tree"` — not a fix
        // cycle, so it is never numbered against the cap on either pass.
        `The '${gate.id}' gate refused your resolution of ${entry.node_id}${rescue ? ` (rescue attempt ${rescue}${Number.isInteger(cycle) ? `, fix cycle ${cycle - base + 1} of ${gatesKernel.cycleCap(gate)}` : ""})` : cycle > 0 ? ` (fix cycle ${cycle + 1} of ${gatesKernel.cycleCap(gate)})` : ""}.`,
        "",
        detail || "",
        "",
        blocking.length ? `${blocking.some((f) => f.id) ? "Blocking findings — fix each, by id" : "Findings"}:\n${gatesKernel.renderFindings(blocking)}` : "",
        advisory.length ? `Advisory (recorded, not enforced — fix if cheap):\n${gatesKernel.renderFindings(advisory)}` : "",
        resolved.length ? `Already resolved by earlier cycles (do not regress):\n${gatesKernel.renderFindings(resolved)}` : "",
        evidence && !blocking.length ? `Evidence:\n${String(evidence).slice(0, 4000)}` : "",
        "",
        `Fix the cause in the same worktree and commit${blocking.some((f) => f.id) ? ", naming the finding ids you addressed in the commit message —" : "."}`,
        ...(blocking.some((f) => f.id) ? ["the next review is handed your commits and asked whether each prior finding is resolved."] : []),
        ...(carriedFindings.length
          ? [
              "",
              "Carried findings — close the MECHANISM, not the next row:",
              carriedText,
              "A finding that survives a fix is one instance of a mechanism, and the last fix closed the one row it was",
              "shown. Before you change anything, enumerate the mechanism's rows yourself — every case the finding can",
              "take that you can see, whether or not the review listed it (the rows it did list are under the finding",
              "above) — then fix so that ONE change closes them together, and state in the commit message which rows",
              "the fix closes and which it deliberately leaves and why. The next review reads that design; a fix that",
              "closes the row it was shown and leaves the next is a fix cycle spent.",
            ]
          : []),
        ...(unrequestedFindings.length
          ? [
              "",
              "Unrequested mechanism — DELETE it, do not extend it:",
              gatesKernel.renderFindings(unrequestedFindings),
              `${unrequestedFindings.length === 1 ? "This finding is" : "These findings are"} against mechanism the work item's acceptance does not require, and the review said`,
              "removing that mechanism would close it. So remove it: delete the surface, or reduce it to the simplest",
              "thing the item actually asked for, and say in the commit message what you deleted and why the item does",
              "not need it. Do NOT answer these by hardening the mechanism — every guard you add to surface nobody asked",
              "for is more surface for the next review to find a hole in, and that is the fix-cycle budget gone. These",
              `${unrequestedFindings.length === 1 ? "does" : "do"} not block the gate; they are here because deleting is cheap and the right answer.`,
            ]
          : []),
        ...(cycle > 0
          ? [
              "",
              "Before you extend anything, ask whether a PREVIOUS fix cycle added it. A finding against mechanism your own",
              "earlier cycle introduced is a signal that the mechanism should not be there: prefer deleting or simplifying",
              "it to guarding it, and keep the change inside what the work item asked for — a prose contract for agents,",
              "a helper, a derived scheme nobody requested is surface the next review will attack. Say in the commit",
              "message which mechanism you removed and which you kept, and why the item needs what you kept.",
            ]
          : []),
        ...(unmetFindings.length
          ? [
              "",
              "Unmet done condition — meet it or re-scope it; do not argue it:",
              unmetFindings.map((f) => `${f.id ? `${f.id} ` : ""}${f.summary}`).join("\n"),
              `${unmetFindings.length === 1 ? "This finding says" : "These findings say"} the change does not do what the work item ASKED — not that it is wrong. More`,
              "evidence that the condition is unmet does not close it: a doc verdict, a test pinning the miss, a second",
              "measurement of the same approach are all the same answer said louder, and the last item answered that way",
              "spent every fix cycle and a rescue before one materially different attempt met the condition. So do exactly ONE",
              "of these — not a third restatement:",
              "",
              "  (1) make a fresh attempt at the condition that is materially DIFFERENT from the one that missed — a",
              "      different approach, not the same one argued harder — and say in the commit message what you changed",
              "      about the approach and what it now measures against the condition; or",
              "  (2) if you have concluded the condition cannot be met, file a Spor DECISION that re-scopes the item — what",
              `      was asked, what is achievable and on what evidence, what you propose instead — with a \`relates-to\` edge`,
              `      to ${entry.node_id}, and name its id in the commit message.`,
              "",
              "Filing (2) does not clear the gate and is not meant to: the next review confirms the finding open, the runner",
              "stops dispatching fix cycles at it, and the re-scope goes to a person, whose call it is. That is the",
              "designed exit — it is not a failure, and it is a better answer than a third restatement.",
            ]
          : []),
        "If the fix touches a durable retry/debt flag (a `*_pending` run-record field, a journal line, a cooldown file),",
        "design it against ALL of these at once and say how each is handled in the commit message — the next review",
        "walks the whole table in one verdict, and a fix that closes one row by opening the next is a fix cycle spent:",
        gatesKernel.renderDurableFlagChecklist(),
        "If the fix adds a field to an outcome/result object recorded at more than one write site, forward it at",
        "EVERY site that records that object, not only the one this fix's own tests exercise:",
        gatesKernel.renderOutcomeFieldForwardingCheck(),
        "The gate will re-run against the trusted ref's copy of the acceptance suite, so do not edit protected test",
        "paths — a change that touches them fails the gate closed.",
        // The one-turn notice: a fix that backgrounds its suite and ends its turn
        // waiting on it leaves the gate the dirty tree it was fixing (issue-spor-
        // rescue-and-fix-sessions-end-turn-waiting-on-background-job).
        workerContractLib.ONE_TURN_NOTICE,
      ]
        .filter((l) => l !== "")
        .join("\n");
      const fixName = `fix-${gate.id}-${keysFor(rescue).short}-${cycle}`;
      // A fix this pipeline ALREADY launched at this cycle — the worker died
      // between the launch and the durable record of it (the run-id stamp
      // below, or the runner's launched-progress save) — is adopted from its own
      // run record rather than dispatched a second time (review finding 4 on the
      // third cut). The name is unique per pipeline run, attempt, gate and
      // cycle, and the launcher writes the child's record before dispatch
      // returns, so the record exists from the first moment a crash could leave
      // the launch unrecorded.
      const already = launchedFixRun(home, entry.node_id, fixName);
      const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(
        cfg,
        // `record.cwd` when the change could not be read: the commit-or-discard
        // round-trip a DIRTY tree gets (gate-runner.js runGatePipeline) runs
        // before any change set exists, and it has to land in the run's own
        // checkout — a fresh worktree would never see the uncommitted files.
        // "no-auto-route": a pipeline-internal dispatch never re-routes
        // (issue-spor-auto-route-reaches-fix-cycle-and-rescue-dispatches) — this
        // worker already holds the lease and the gate on entry.node_id, so a
        // standing dispatch.autoRoute must not hand it to another box mid-fix; an
        // unsatisfiable lane profile here stays a refusal the runner escalates.
        { ...passthrough, node: entry.node_id, dir: change ? change.cwd : (record && record.cwd) || undefined, force: true, "no-worktree": true, "no-auto-route": true, name: fixName },
        [prompt]
      );
      // Refused before any run record: `unroutable` (§5.3) — it spends neither
      // pool and it is not a defect, so the runner keeps it out of the rescue
      // lane rather than paying a strong-model dispatch to diagnose a fixer
      // that never started.
      if (!launched.ok) return { ok: false, reason: launched.reason, classification: gatesKernel.classifyExecutionOutcome(null, launched.reason) };
      if (launched.adopted) log(`work: gate ${gate.id} fix cycle ${cycle} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
      // The fix cycle's own run is DETACHED — it outlives this worker process,
      // and the await below can run for up to `runMaxMs` (a day by default). If
      // this worker is stopped while that await is still pending, nothing else
      // ever learns which run it left in flight: the pipeline's own run record
      // (`entry.run_id`) is what the loop marks `interrupted` on exit
      // (work-loop.js runWorkLoop), so stamping the fix run's id onto it NOW —
      // before the long wait, not after — is what makes that interrupted record
      // name the orphan rather than just say "something was running"
      // (issue-spor-work-stop-abandons-inflight-gates; the record keeps the
      // child run's identity, the journals the rest). `stampGateState` only
      // ever writes `gate_*` fields and never clobbers a settled verdict, so this
      // can't race the loop's own interrupted/passed/failed stamp into anything
      // wrong — worst case is a stale id on a pipeline that has already settled.
      // `gate_fix_gate`/`gate_fix_cycle` say WHICH fix the stamped run is, so a
      // resumed pipeline whose progress save never landed (the crash window
      // between this stamp and `onLaunch` below) can read the launch back from
      // the stamp instead of taking the fix for undispatched (loadGateProgress).
      // A record stamp, not a ledger write: the child run's identity is the
      // record's to keep (stage-projection.js).
      stampLaunch({ gate_fix_run_id: launched.run.run_id, gate_fix_at: new Date().toISOString(), gate_fix_gate: gate.id, gate_fix_cycle: cycle });
      return { ok: true, runId: launched.run.run_id, adopted: !!launched.adopted };
    };
    // The wait half, shared by every lane this pipeline dispatches into its
    // own checkout — a FIX cycle, a RESCUE, an IMPLEMENTATION re-dispatch
    // (task-spor-gate-deps-unify-await-run): `laneAwaitRun` above.
    const awaitRun = laneAwaitRun(cfg, { factory, runMaxMs, runIdleMs, warn, sleep });
    const fix = async ({ onLaunch = null, ...args }) => {
      const launched = await dispatchFix(args);
      if (!launched.ok) return launched;
      // …and the runner charges the fix cycle to the gate's progress at this
      // same moment: launched, not merely decided on (a worker killed before
      // this line resumes INTO the fix; one killed after it resumes past it).
      if (onLaunch) {
        try {
          await onLaunch({ runId: launched.runId });
        } catch (e) {
          warn(`warning: the fix cycle's launch could not be recorded on the gate's progress (${(e && e.message) || e})`);
        }
      }
      const done = await awaitRun({ runId: launched.runId, lane: "fix" });
      if (!done.ok) return { ok: false, reason: done.reason, ...(done.unfollowable ? { unfollowable: true } : {}) };
      return { ok: true, runId: launched.runId, classification: done.classification };
    };
    // Tagged as the composition of the two halves: the workflow then takes
    // the signal form, while a caller that OVERRIDES `fix` on these deps keeps
    // the one-shot it wrote — an untagged `fix` is the caller's own and wins.
    fix.composedOfSignals = true;

    // The gate's durable memory (review finding 1 on this gate's first cut):
    // the per-gate finding ledger, fix-cycle count, attempt history and last
    // fix ride in the run's GATE-PROGRESS LOG beside its stage journals
    // (stage-projection.js; the run record used to carry it as
    // `gate_progress`), keyed by this attempt's run key so a `--regate` (a
    // new attempt) starts clean while a RESUMED pipeline (§10.8 — same run,
    // same attempt) reads back exactly where the killed worker left each
    // gate. Read fresh from disk, not from the record this closure was
    // handed: the fix cycle's own stamp (`gate_fix_run_id`) lands on the
    // record, and the last fix's run id is recovered from it when the
    // progress entry never got to record it.
    const loadGateProgress = async ({ gate, rescue = 0 }) => {
      const r = readRecordNow();
      const all = readProgressNow();
      if (!all || all.key !== runKey || !all.gates || typeof all.gates !== "object") return null;
      const p = all.gates[progressKey(gate, rescue)];
      if (!p || typeof p !== "object") return null;
      const lastFix = p.lastFix && typeof p.lastFix === "object" ? { ...p.lastFix } : null;
      if (lastFix && !lastFix.runId && r.gate_fix_run_id) lastFix.runId = r.gate_fix_run_id;
      // A fix the progress entry recorded as NOT launched, but whose launch the
      // fix closure stamped on the record (this gate, this cycle) before the
      // worker died: it launched. Read it as such — dispatched, charged — so
      // the resume reviews its result instead of dispatching it again.
      if (lastFix && lastFix.dispatched === false && r.gate_fix_run_id && r.gate_fix_gate === gate.id && r.gate_fix_cycle === lastFix.cycle) {
        lastFix.dispatched = true;
        lastFix.runId = r.gate_fix_run_id;
        return { ...p, fixes: Math.max(Number.isInteger(p.fixes) ? p.fixes : 0, lastFix.cycle + 1), lastFix };
      }
      return { ...p, lastFix };
    };
    const saveGateProgress = async ({ gate, progress, rescue = 0 }) => updateGateProgress({ gates: { [progressKey(gate, rescue)]: progress } });
    // The rescue lane's durable state (task-spor-factory-rescue-lane): one
    // entry per rescue attempt — the refusal it was handed, the seed its gate
    // pass starts from, its run and its diagnosis — on the same ledger
    // stamp, keyed to this attempt, so a killed worker resumes INSIDE the
    // rescue (adopting its run, or re-judging its pass) instead of re-running
    // the original pass and paging a person a rescue was about to spare.
    const loadRescueState = async () => {
      const r = readRecordNow();
      const all = readProgressNow();
      if (!all || all.key !== runKey || !Array.isArray(all.rescue)) return [];
      return all.rescue.map((e) => {
        const out = { ...e };
        // A launch the rescue closure stamped before the worker died.
        if (out.n === r.gate_rescue_attempt && r.gate_rescue_run_id && !out.runId) {
          out.runId = r.gate_rescue_run_id;
          out.dispatched = true;
        }
        return out;
      });
    };
    const saveRescueState = async ({ rescues }) => updateGateProgress({ rescue: rescues });

    // The pipeline's shared INFRASTRUCTURE pool (FACTORY-IMPLEMENTATION-STAGE.md
    // §5.3, task-spor-factory-execution-outcome-classifier): ONE count for the
    // whole pipeline — implementation, reviews, fixes and rescues together — on
    // the SAME ledger stamp, keyed to this attempt so a `--regate`
    // starts with a fresh pool while a RESUMED pipeline inherits exactly the
    // charges the killed worker had already spent. Without that an outage that
    // outlives a worker would be handed a full allowance by every resume, which
    // is precisely the unbounded case the pool exists to stop. Unlike the
    // ledger's fail-soft saves, a charge that does not land THROWS: the runner
    // refuses the retry it could not pay for rather than spending an
    // unrecorded one.
    //
    // The durable-flag rows (gatesKernel.renderDurableFlagChecklist), each
    // answered:
    //   (a) the write fails — it THROWS, and the runner refuses the retry it was
    //       paying for. Nothing is owed, because nothing was spent.
    //   (b) the crash window — the charge is written BEFORE the retry it
    //       authorizes, and the pool is only ever INCREMENTED (there is no clear
    //       to order against it). A crash in between costs one retry that never
    //       ran, which is the bounded side; the mirror ordering would spend an
    //       unrecorded one, which the next resume would grant again.
    //   (c) the check-then-write race — one worker owns a pipeline: a second is
    //       kept off the node by the gating-slot exclusion, and an ORPHAN is
    //       adopted only after its worker is dead (§10.8), reading this count
    //       back before it charges. The merging writer checks the captured
    //       owner and attempt under the record lock and refuses settled state.
    //       Atomic reservations can use updateGateProgress's fresh callback.
    //   (d) a stale count against settled state — the count is keyed on the
    //       ATTEMPT's run key, so a `--regate` reads none and starts fresh (the
    //       outage that exhausted the last pool may be long over), and a
    //       settled pipeline never reads it again.
    const loadGatePools = async () => {
      const all = readProgressNow();
      if (!all || all.key !== runKey || !all.pools || typeof all.pools !== "object") return null;
      return all.pools;
    };
    const saveGatePools = async ({ pools }) => updateGateProgress((fresh) => ({ pools: {
      ...fresh.pools,
      ...Object.fromEntries(Object.entries(pools).map(([name, pool]) => [name, { ...fresh.pools?.[name], ...pool }])),
    } }));

    // --- the rescue lane (task-spor-factory-rescue-lane, WORKERS.md §10.10) ---
    // Composed HERE, deterministically, like the review and the fix: the
    // strong-model profile is handed everything the run left behind — the work
    // item, the diff, the commit history of every fix cycle, the refused gate's
    // detail and evidence, the finding ledger, the gate facts already on the
    // graph, and any earlier rescue's diagnosis — and asked to diagnose, fix in
    // the same checkout, and file factory-improvement tasks. It is NOT asked to
    // pass anything: the runner re-runs the gates on whatever it commits. Its
    // structured diagnosis is read in code (gatesKernel.parseRescueReport) and
    // only feeds the escalation body and the rescue fact — fail-soft, so a
    // rescue that fixed the tree and forgot the block still gets its fix
    // judged. The dispatch runs under the RESCUE profile, so the worker's
    // ROUTING flags (--model/--agent) are dropped — the lane's profile is what
    // names the strong model — while its unattended POSTURE rides, filtered to
    // what the rescue's own harness accepts (rescuePassthrough).
    // The rescue in the same two halves as the fix (plus the report read), so
    // the gate workflow awaits the rescue run as signal rescue-run:<id>.
    const dispatchRescue = async ({ gate, attempt, detail, evidence, findings, attempts, ledger, fact, facts = [], previous = [] }) => {
      const lane = factory && factory.rescue;
      if (!lane || !lane.profile) return { ok: false, reason: "no rescue lane is declared on the factory" };
      const cwd = change ? change.cwd : (record && record.cwd) || undefined;
      if (!cwd) return { ok: false, reason: "the run's checkout is unknown, so the rescue has nowhere to work" };
      const item = await workItemText();
      const diff = change ? gateDiffText(change) : null;
      const history = change ? gateHistoryText(change) : "";
      const spent = gatesKernel.describeCycles(gate, attempts || []);
      const blocking = (findings || []).filter((f) => f.blocking !== false);
      const advisory = (findings || []).filter((f) => f.blocking === false);
      const name = `rescue-${short}-${attempt}`;
      // The harness-agnostic diagnosis channel (see gateRescueDiagnosis): the
      // file the prompt names, git-excluded in the checkout before the launch.
      const diagnosisFile = rescueDiagnosisPath(cwd, name);
      const prompt = [
        `You are the RESCUE lane of the '${factory.id || "factory"}' factory for Spor work item ${entry.node_id} (rescue attempt ${attempt} of ${lane.attempts}).`,
        `The '${gate.id}' ${gate.kind} gate refused this item and its fix cycles are spent (${spent.text}). Without you, a person`,
        "would be paged now. Your job, in order:",
        "",
        "1. DIAGNOSE what actually went wrong. Pick ONE category: `reviewer-drift` (the reviewer moved the goalposts or",
        "   demanded something the item never asked for), `real-defect` (the implementation is wrong and the gate is right),",
        "   `stale-premise` (the item's premise no longer holds — already done, wrong repo, superseded), or `environment`",
        "   (a red trusted ref, a flaky suite, a missing dependency, a harness problem — nothing about the change itself).",
        "2. FIX IT if a fix is the right answer: work in THIS checkout, commit with a clear message that names the finding",
        "   ids you addressed (the gates re-run on your commits and the next review is asked whether each prior finding is",
        "   resolved). Do NOT edit protected test paths — a change that touches them fails the gate closed. Leave the tree",
        "   CLEAN. If the premise is stale or the environment is at fault, say so and change nothing you cannot justify.",
        "   Verify in the FOREGROUND and read the exit before you commit — never background a suite and end your turn",
        "   waiting on it (see the session rule under \"Your report\").",
        "3. FILE what would have prevented this. Whether or not your fix lands, capture at least one Spor task proposing a",
        "   factory, gate, prompt or item change (a review instruction to tighten, a cycles cap to change, a suite to fix,",
        "   an item to re-scope) — `spor put-node - --if-exists skip` with a `type: task` node carrying",
        `   \`{type: derived-from, to: ${fact || "<the gate fact>"}}\` so /spor:factory's maintenance mode can read it, or \`spor add "..."\``,
        "   when you are unsure of the shape. Do not resolve, close or re-status the work item itself.",
        "",
        "You never mark a gate passed: the runner re-judges the whole gate list on the tree you leave.",
        "",
        "## The work item",
        "",
        item || `(the node ${entry.node_id} could not be read — judge the change against its commit messages)`,
        "",
        "## The refusal",
        "",
        `Gate \`${gate.id}\` (${gate.kind}): ${detail || "no detail"}`,
        ...(fact ? [`Gate fact on the graph: ${fact}${facts.length > 1 ? ` (all facts for this run: ${facts.join(", ")})` : ""}`] : []),
        "",
        ...((attempts || []).length > 1
          ? [`Cycles (${spent.text}):`, ...attempts.map((a, i) => `${i + 1}. ${i === 0 ? "initial review" : `after fix cycle ${i}`}: ${a.verdict} — ${String(a.detail || "").slice(0, 300)}`), ""]
          : []),
        ...(blocking.length ? ["Blocking findings still open:", gatesKernel.renderFindings(blocking), ""] : []),
        ...(advisory.length ? ["Advisory (recorded, not enforced):", gatesKernel.renderFindings(advisory), ""] : []),
        ...(ledger && ledger.length ? ["Finding ledger (every finding the gate's cycles raised, what cleared it, what still stands):", gatesKernel.renderLedger(ledger), ""] : []),
        ...(evidence ? ["Evidence:", "```", gateRunner.fenceSafe(String(evidence).slice(0, 4000)), "```", ""] : []),
        ...(previous.length
          ? [
              "## Earlier rescue attempts",
              "",
              ...previous.map((p) => `- attempt ${p.n}${p.runId ? ` (run ${String(p.runId).slice(0, 8)})` : ""}: ${p.error ? `could not run — ${p.error}` : `${p.category || "unknown"} — ${p.diagnosis || "(no diagnosis read)"}${(p.filed || []).length ? `; filed ${p.filed.join(", ")}` : ""}`}`),
              "",
              "Your diagnosis should say why the earlier rescue did not land, not repeat it.",
              "",
            ]
          : []),
        ...(change
          ? [
              "## The change",
              "",
              `\`git diff ${change.base}..${change.head}\` in ${cwd} (${Array.isArray(change.paths) ? change.paths.length : "?"} file(s)):`,
              "",
              "```diff",
              gateRunner.fenceSafe(diff.text),
              "```",
              ...(diff.truncated ? [`(diff truncated at ${Math.round(GATE_DIFF_CAP_BYTES / 1024)}KB — run the git command above for the rest)`] : []),
              "",
              ...(history ? ["## Every commit on the branch — the implementer's and each fix cycle's", "", "```", gateRunner.fenceSafe(history), "```", ""] : []),
            ]
          : [`## The change`, "", `The change under judgement could not be read from ${cwd}: ${detail || "see the refusal above"}. Start by reading the checkout's state (\`git status\`, \`git log\`).`, ""]),
        ...(lane.instructions ? ["## Factory instructions for the rescue", "", lane.instructions, ""] : []),
        "## Your report",
        "",
        "The fenced diagnosis block is MANDATORY. Write it the moment you have diagnosed — BEFORE any fix or long",
        "verification, so a session cut short still yields a category — and restate it at the end of your final message",
        "once `fixed` and `filed` are known (the runner reads the LAST block of your final message, and falls back to the",
        "last block of any earlier message — so the early block counts even if your final message never comes). Exactly this shape:",
        "",
        `ALSO write that same JSON object (the object alone, no fence needed) to \`${diagnosisFile}\` the moment you have`,
        "diagnosed, and rewrite it whenever `fixed` or `filed` change — the runner reads that file whenever your final",
        "message carries no block, whatever harness you run under. The file is git-excluded and untracked: it does not",
        "dirty the tree, and you must never `git add` or commit it.",
        "```json",
        `{"diagnosis": "what went wrong, in one or two sentences", "category": "reviewer-drift" | "real-defect" | "stale-premise" | "environment", "fixed": true | false, "filed": ["task-..."]}`,
        "```",
        "`fixed` is whether you committed a change you believe resolves the refusal; `filed` lists the Spor task ids you",
        "created. The runner reads this block for the escalation it files if the gates refuse again — it never decides a verdict.",
        "",
        workerContractLib.ONE_TURN_NOTICE,
      ].join("\n");
      // Adopted on resume exactly like a fix cycle: the launcher writes the run
      // record before dispatch returns, so a worker killed between the launch
      // and its durable record still finds the run by its unique name.
      const already = launchedFixRun(home, entry.node_id, name);
      // Read the lane's harness only when there is a launch to shape — an
      // adopted run was already launched under whatever posture it got.
      let values = null;
      // Set only for the genuinely ATTENDED sub-case below (the lane's own
      // declared attended posture, or no lane spelling at all): the read-only
      // narrowing already runs fine under the worker preflight (it sets
      // `values["read-only"]`, which the preflight gate never judges), so it
      // needs no acknowledgement. This is the caller's deliberate, non-widening
      // choice that lets preflight proceed instead of hard-refusing
      // (issue-spor-rescue-posture-attended-translation-hard-refuses).
      let allowAttended = false;
      if (!already) {
        const shaped = rescuePassthrough(passthrough, await rescueHarnessAdapter(cfg, lane.profile));
        if (shaped.dropped.length) {
          warn(
            `warning: the worker's ${shaped.dropped.map((d) => `--${d.flag}`).join(", ")} does not ride to the rescue under` +
              ` ${lane.profile} — ${shaped.dropped[0].message}`
          );
        }
        const appliedFlags = shaped.applied.map((a) => (a.value === true ? `--${a.flag}` : `--${a.flag} ${a.value}`)).join(" ");
        if (shaped.translated && shaped.translated.meaning === "read-only") {
          warn(
            `warning: the worker's posture (${shaped.translated.from}) reads as read-only, so the rescue under ${lane.profile} runs` +
              ` under that harness's own read-only posture (${appliedFlags}) — it can diagnose but not fix; a rescue never widens the worker's posture.`
          );
        } else if (shaped.translated && shaped.translated.meaning === "attended") {
          // Narrowed to read-only already runs fine (values["read-only"] short-
          // circuits the preflight gate below); the other two sub-cases are
          // genuinely attended, so the preflight write-posture gate must be
          // told this dispatch's posture was chosen deliberately, not left
          // un-postured — else it hard-refuses before this run ever gets a
          // chance to stall the way it always has
          // (issue-spor-rescue-posture-attended-translation-hard-refuses).
          allowAttended = !shaped.translated.narrowed;
          warn(
            shaped.translated.narrowed
              ? `warning: the worker's posture (${shaped.translated.from}) reads as attended, and ${lane.profile}'s harness has no attended posture` +
                ` (it never asks), so the rescue narrows to that harness's read-only posture (${appliedFlags}) — it can diagnose but not fix;` +
                ` a rescue never widens the worker's posture. Pass an unattended posture the worker means.`
              : shaped.applied.length
                ? `warning: the worker's posture (${shaped.translated.from}) reads as attended, so the rescue under ${lane.profile} runs attended` +
                  ` there as ${appliedFlags} — the more restrictive of the two; it stops on its first unapproved write. Pass an unattended posture the worker means.`
                : `warning: the worker's posture (${shaped.translated.from}) reads as attended and has no ${lane.profile} spelling, so the rescue` +
                  ` runs attended there — the more restrictive of the two; on claude-code it stalls on its first write. Pass an unattended posture the worker means.`
          );
        } else if (shaped.applied.length) {
          warn(
            (shaped.translated
              ? `warning: the worker's posture (${shaped.translated.from}) reads as unattended, so the rescue under ${lane.profile}`
              : `warning: the rescue under ${lane.profile} carries none of the worker's posture, so it`) +
              ` runs unattended with ${appliedFlags} — that harness stalls on its first write without it.`
          );
        }
        // "no-auto-route": this worker holds the lease and the gate on
        // entry.node_id for the DURATION of the rescue — a standing
        // dispatch.autoRoute must not hand it to another box because the
        // rescue's lane profile is unsatisfiable here
        // (issue-spor-auto-route-reaches-fix-cycle-and-rescue-dispatches); that
        // stays a refusal the runner escalates through the rescue's own path.
        values = { ...shaped.values, profile: lane.profile, node: entry.node_id, dir: cwd, force: true, "no-worktree": true, "no-auto-route": true, name };
        // Fail-soft and silent: where the exclude cannot be written (not a git
        // checkout, an unwritable info/exclude) the gates' own untracked-residue
        // tolerance is the backstop.
        excludeRescueDiagnosisDir(cwd);
      }
      const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(cfg, values, [prompt], { allowAttended });
      if (!launched.ok) return { ok: false, reason: `the rescue under ${lane.profile} could not be dispatched: ${launched.reason}` };
      if (launched.adopted) log(`work: rescue attempt ${attempt} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
      stampLaunch({ gate_rescue_run_id: launched.run.run_id, gate_rescue_at: new Date().toISOString(), gate_rescue_attempt: attempt });
      return { ok: true, runId: launched.run.run_id, adopted: !!launched.adopted };
    };
    // The finished rescue run's structured diagnosis (gateRescueDiagnosis):
    // the record is re-read by id, the diagnosis file by the run's name.
    const rescueReport = async ({ runId, attempt }) => {
      const cwd = change ? change.cwd : (record && record.cwd) || undefined;
      const name = `rescue-${short}-${attempt}`;
      let done = null;
      try {
        done = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record) || null;
      } catch {
        done = null;
      }
      const parsed = gateRescueDiagnosis(done, home, { file: cwd ? rescueDiagnosisPath(cwd, name) : null });
      if (parsed.salvaged === "file") log(`work: rescue attempt ${attempt} on ${entry.node_id} left no diagnosis block in its final report — read the one it wrote to ${cwd ? rescueDiagnosisPath(cwd, name) : "its diagnosis file"}`);
      else if (parsed.salvaged) log(`work: rescue attempt ${attempt} on ${entry.node_id} left no diagnosis block in its final report — read the last one from an earlier message on its stream`);
      if (!parsed.ok) log(`work: rescue attempt ${attempt} on ${entry.node_id} left no structured diagnosis (${parsed.error}) — its tree is judged regardless`);
      return { diagnosis: parsed.diagnosis, category: parsed.category, fixed: parsed.fixed, filed: parsed.filed, unread: !parsed.ok };
    };
    const rescue = async ({ onLaunch = null, ...args }) => {
      const launched = await dispatchRescue(args);
      if (!launched.ok) return launched;
      if (onLaunch) {
        try {
          await onLaunch({ runId: launched.runId });
        } catch (e) {
          warn(`warning: the rescue's launch could not be recorded on the run record (${(e && e.message) || e})`);
        }
      }
      const done = await awaitRun({ runId: launched.runId, lane: "rescue" });
      if (!done.ok) return { ok: false, reason: done.reason };
      const report = await rescueReport({ runId: launched.runId, attempt: args.attempt });
      return { ok: true, runId: launched.runId, ...report };
    };
    rescue.composedOfSignals = true;

    // --- the implementation stage (task-spor-factory-implementation-stage-
    // runner, FACTORY-IMPLEMENTATION-STAGE.md §4.2 I3-I11, WORKERS.md §10.16) ---
    // The ledger (`impl_attempts[]`) rides the pipeline's OWN run record beside
    // `impl_state`/`impl_attempt`, through stampImplState — read fresh, like the
    // gate progress, so a resumed worker sees every stamp the killed one made.
    const loadImplAttempts = async () => {
      const r = readRecordNow();
      return { attempts: r && Array.isArray(r.impl_attempts) ? r.impl_attempts.map((e) => ({ ...e })) : [], record: r };
    };
    // A stamp that did not land THROWS: the stage refuses to act on a charge
    // nobody recorded (owe before you clear). `impl_state` writes onto a
    // settled record are dropped by stampImplState itself, which is the
    // settled-is-final rule, not a failure — so the verification is on the
    // ledger, the one field this dep owns.
    const saveImplAttempts = async ({ attempts, patch = {} }) => {
      const stamped = dispatchRuns.stampImplState(home, entry.run_id, { ...patch, impl_attempts: attempts });
      if (!stamped || !Array.isArray(stamped.impl_attempts) || stamped.impl_attempts.length !== attempts.length) throw new Error("the run record could not be updated");
    };
    // The re-dispatch: the implementer sent back into the run's OWN checkout
    // (`--no-worktree`, the tree it left is what it continues from) under the
    // profile the original launch resolved (`record.resolved_profile` — the same
    // routing decision, never a substitution; the lane default where that is
    // unknown), carrying the worker's posture exactly as the original dispatch
    // did (§5.2 — an implementation dispatch is not read-only), the worker
    // contract, and a preamble naming the attempt and what the prior one left.
    // `--force` for the same reason the fix cycle passes it: the item is HELD
    // by this pipeline's execution and the runner knows why it is not open.
    // "no-auto-route": a pipeline-internal dispatch never re-routes. Adopted by
    // its unique NAME on resume, like a fix cycle and a rescue.
    // The run that actually PRODUCED the tree when nobody names one: the
    // ledger's last settled attempt of this pipeline attempt, where it is not
    // the pipeline's own run (a re-dispatched implementer). Read by the
    // candidate pin's provenance and the no-code claim, so neither attributes a
    // re-dispatched attempt's work — or reads its report — off attempt 1.
    const stageProducerRunId = () => {
      const r = readRecordNow();
      const seg = gatesKernel.implAttemptsFor(r && r.impl_attempts, entry.attempt || 0).filter((e) => gatesKernel.implAttemptSettled(e) && e.run_id);
      const last = seg.length ? seg[seg.length - 1] : null;
      return last && last.run_id && last.run_id !== entry.run_id ? last.run_id : null;
    };
    const stageProducerRecord = () => {
      const id = stageProducerRunId();
      if (!id) return null;
      try {
        return dispatchRuns.readJson(dispatchRuns.runPaths(home, id).record) || null;
      } catch {
        return null;
      }
    };
    // The re-dispatch in two halves — the launch (adopt-by-name, so a re-run
    // under the same name returns the run already started) and the wait for
    // its terminal state — so the workflow (implementation-workflow.js) can
    // journal the run it launched and await it as a SIGNAL; `implement` is the
    // one-shot composition of the two, for a caller that drives the stage
    // without the signal seam.
    const dispatchImplement = async ({ attempt, of, name, prior = [], dirty = false }) => {
      const cwd = (record && record.cwd) || undefined;
      if (!cwd) return { ok: false, reason: "the run's checkout is unknown, so the implementer has nowhere to work", classification: gatesKernel.classifyExecutionOutcome(null, "the run's checkout is unknown") };
      const last = prior.length ? prior[prior.length - 1] : null;
      const lane = factory && factory.implementation;
      const preamble = [
        `This is implementation attempt ${attempt}${of ? ` of ${of}` : ""} on Spor work item ${entry.node_id} under the '${factory.id || "factory"}' factory.`,
        last
          ? last.outcome === "no-candidate"
            ? `The previous attempt (run ${String(last.run_id || "?").slice(0, 8)}) ended cleanly but committed NOTHING past ${factory.trustedRef} in this checkout — the gates had no candidate to judge. Do the work here and COMMIT it.`
            : dirty
              ? `The previous attempt (run ${String(last.run_id || "?").slice(0, 8)}) left UNCOMMITTED changes to tracked files in this checkout: ${last.reason || "a dirty tree"}. Commit what belongs to ${entry.node_id} (a clear message), discard what does not (\`git restore\`), and leave the working tree CLEAN — a dirty tree is not a candidate.`
              : `The previous attempt (run ${String(last.run_id || "?").slice(0, 8)}) ended ${last.outcome}${last.reason ? `: ${last.reason}` : ""}. This checkout may hold partial work — read \`git status\` and \`git log\` first, then finish the item and commit.`
          : "",
        `Work in THIS checkout (${cwd}) — it is the run's own; do not create a worktree or switch branches.`,
        "",
      ].filter((l) => l !== null);
      const prompt = [...preamble, workerContract({ nodeId: entry.node_id, factory }), ...(lane && lane.instructions ? ["", "## Factory instructions for the implementation lane", "", lane.instructions] : [])].join("\n");
      const already = launchedFixRun(home, entry.node_id, name);
      const values = { ...passthrough, node: entry.node_id, dir: cwd, force: true, "no-worktree": true, "no-auto-route": true, name };
      if (!values.profile) {
        if (record && record.resolved_profile) values.profile = record.resolved_profile;
        else if (lane && lane.profile) values.profile = lane.profile;
      }
      // The stage's per-run ceilings ride the child's record too (§5.1): the
      // poll bounds the implementation run by the factory's budget, whichever
      // attempt it is.
      const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(cfg, values, [prompt], { recordFields: { ...implBudgetStamp(lane), impl_parent_run_id: entry.run_id, impl_attempt: attempt } });
      if (!launched.ok) return { ok: false, reason: launched.reason, classification: gatesKernel.classifyExecutionOutcome(null, launched.reason) };
      return { ok: true, runId: launched.run.run_id, adopted: !!launched.adopted };
    };
    // The wait is the shared `awaitRun` above under the "implement" lane: a
    // run this worker could not follow to its end (`ok: false`, whether the
    // launcher's own deadline or the poll's watchdog) is handed to the stage
    // as `unfollowable`, which stops it rather than re-dispatching into a
    // checkout something may still hold.
    const implement = async ({ onLaunch = null, ...args }) => {
      const launched = await dispatchImplement(args);
      if (!launched.ok) return launched;
      if (onLaunch) {
        try {
          await onLaunch({ runId: launched.runId });
        } catch (e) {
          warn(`warning: implementation attempt ${args.attempt}'s launch could not be recorded on the ledger (${(e && e.message) || e})`);
        }
      }
      // A wait that THROWS is still a run that LAUNCHED: the signal form's
      // driver reads it as `ok: false` and the stage as unfollowable, so the
      // one-shot reads it the same way — never as a pre-record refusal, which
      // would withdraw the reservation and clear the hold over a run that is
      // in flight (task-spor-shared-stage-workflow-helper).
      let done;
      try {
        done = await awaitRun({ runId: launched.runId, lane: "implement" });
      } catch (e) {
        done = { ok: false, record: null, reason: `${(e && e.message) || e}` };
      }
      if (!done.ok) return { ok: true, runId: launched.runId, adopted: launched.adopted, record: done.record || null, unfollowable: true, reason: done.reason };
      return { ok: true, runId: launched.runId, adopted: launched.adopted, record: done.record, classification: done.classification };
    };
    // Tagged as the composition of the two halves: the workflow then takes
    // the signal form, while a caller that OVERRIDES `implement` on these deps
    // keeps the one-shot it wrote — an untagged `implement` is the caller's
    // own and wins.
    implement.composedOfSignals = true;
    // The escalation a spent pool files (I8, I11, M1): a `requires: [human]`
    // item that `blocks` the work item, keyed deterministically on the
    // pipeline's run key so a resume re-files the same node. The hold STAYS
    // (T1) and the body says so.
    const escalateStage = async ({ state, attempts = [], reason }) => {
      const id = `task-impl-${state}-${stem}-${short}-${gateIdSuffix("implement", state, entry.node_id, runKey)}`.toLowerCase();
      const cap = gatesKernel.executionPoolCap(factory.implementation, "implementation");
      const retryCap = gatesKernel.executionPoolCap(factory.implementation, "retry");
      const lines = attempts.map((a) => `${a.index}. run ${String(a.run_id || "?").slice(0, 8)}: ${a.outcome}${a.pool ? ` (${a.pool} pool)` : ""}${a.reason ? ` — ${String(a.reason).slice(0, 200)}` : ""}`);
      const body = [
        state === "escalated"
          ? `The implementation stage on ${entry.node_id} stopped without a candidate for a reason that is not the code's: ${reason || "no detail"}. That is not a verdict on any change — an outage charges the shared infrastructure retry pool (${retryCap} declared), never an implementation attempt, and a run this box could not follow or a ledger it could not stamp charges nothing it can act on.`
          : state === "mismatch"
            ? `The implementation stage produced a candidate for ${entry.node_id} whose evidence does not verify: ${reason || "no detail"}. Neither pool was charged; a person settles it.`
            : `The implementation stage spent its budget (${cap} attempt${cap === 1 ? "" : "s"}) on ${entry.node_id} without producing a candidate: ${reason || "no detail"}. A person decides what happens next — the worker has stopped re-dispatching it.`,
        "",
        ...(lines.length ? ["Attempts:", "", ...lines, ""] : []),
        `This item \`blocks\` ${entry.node_id} on the graph. The run's own record is \`${entry.run_id}\` ('spor runs ${entry.run_id}').`,
        ...(completionKernel.isControllerRecord(record)
          ? [
              "",
              `${entry.node_id} is HELD by execution \`${record.impl_claim.execution_id}\` (this factory completes items itself, at its`,
              `'${record.impl_claim.completion.after}' boundary): no resolving edge and no terminal status retires it while the hold stands, and a`,
              "fresh worker never takes a held item. The doors back are 'spor work --regate " + entry.run_id + "' (re-judge this run under",
              `the same execution) or 'spor release ${entry.node_id} --execution ${record.impl_claim.execution_id}' (end the execution; the item then`,
              "returns to the pool, or is resolved by hand as usual).",
            ]
          : []),
      ].join("\n");
      return writeGateNode(
        cfg,
        id,
        buildGateWorkNode({
          id,
          title: state === "escalated" ? `Implementation stage escalation — the implementer could not finish on ${entry.node_id} (not a code verdict)` : state === "mismatch" ? `Implementation stage escalation — candidate evidence mismatch on ${entry.node_id}` : `Implementation stage exhausted — no candidate for ${entry.node_id} after ${cap} attempt${cap === 1 ? "" : "s"}`,
          summary:
            state === "escalated"
              ? `The implementation stage on ${entry.node_id} stopped without a candidate: ${String(reason || "no detail").slice(0, 240)}. No code was judged wrong. Needs a person, or 'spor work --regate ${entry.run_id}' once the cause is cleared.`
              : `The implementation stage on ${entry.node_id} settled ${state}: ${String(reason || "no detail").slice(0, 300)}. A person decides what happens next.`,
          body,
          project: slug,
          date: date(),
          edges: [{ type: "blocks", to: entry.node_id }],
          requiresHuman: true,
        })
      );
    };

    const openLocalSuite = async ({ gate, trustedRef, protectedPaths }) => {
      if (!change) return { ok: false, reason: "the change under judgement could not be read" };
      // The repo's own worktree-setup hook stages the throwaway tree exactly as
      // it stages an implementer's worktree (node_modules, a pinned sibling
      // checkout) — without it a repo whose suite needs anything not in git
      // fails its own gate on a missing dependency, never on the change.
      const tree = prepareGateTree(change, {
        trustedRef,
        protectedPaths,
        setup: (dir) => stageThrowawayTree(dir, change.top, { slug, nodeId: entry.node_id, what: "gate", role: "gate" }),
        teardown: (dir) => teardownThrowawayTree(dir, change.top, { slug, nodeId: entry.node_id, role: "gate", warn }),
      });
      if (!tree.ok) return tree;
      return {
        ok: true,
        dir: tree.dir,
        // `command` overrides the gate's declared one for THIS run only — the
        // door the off-diff isolation pass uses (WORKERS.md §10.3 `isolate`)
        // to re-run just the failing files on this same prepared tree. Absent,
        // the run is the declared suite, byte-identical to before.
        run: async (attempt = 1, command = null) => {
          // What the suite is judging, in its env (task-spor-gate-command-
          // change-env): a script can `git diff $SPOR_GATE_BASE..$SPOR_GATE_HEAD`
          // inside the tree and decide what to run, the way a CI job reads the
          // pull request's file list.
          const env = {
            ...worktreeDeclaredEnv(tree.dir),
            SPOR_GATE_STAGE: "gate",
            SPOR_GATE_BASE: change.base,
            SPOR_GATE_HEAD: change.head,
            SPOR_TRUSTED_REF: trustedRef,
            SPOR_GATE_NODE: entry.node_id || "",
            // 1 for the declared run, N+1 for the Nth same-tree rerun — a
            // suite can log or tighten itself on a rerun.
            SPOR_GATE_ATTEMPT: String(attempt),
            // Set only for the isolation run, so a suite that wants to skip its
            // own setup for a single-file re-run can tell the two apart.
            ...(command ? { SPOR_GATE_ISOLATE: "1" } : {}),
          };
          return await runGateCommand(command ? { ...gate, command } : gate, tree.dir, { env });
        },
        // Called by the runner only after the LAST run has returned (its loop
        // awaits each run), never under a running suite.
        close: () => tree.cleanup(),
      };
    };

    // A `ci` suite (dec-spor-command-gate-ci-mode): the verdict comes from the
    // repo's CI run for the candidate commit, not a suite on this box. The
    // candidate is the judged head with the protected paths — the CI definition
    // included — forced back to the trusted ref's copy and re-committed
    // (integration-runner's reconcileCandidateSha, the same restore-and-amend
    // the integration stage lands), so CI judges exactly the tree a local gate
    // would. The throwaway tree only builds that commit: no setup hook is
    // staged, since nothing runs here. `local_fallback` is the one door back to
    // this box, taken only when CI could not be reached.
    const openCiGateSuite = async (args) => {
      const { gate, trustedRef, protectedPaths } = args;
      if (!change) return { ok: false, reason: "the change under judgement could not be read" };
      const tree = prepareGateTree(change, { trustedRef, protectedPaths });
      if (!tree.ok) return tree;
      let sha = null;
      try {
        const pinned = integrationRunner.reconcileCandidateSha({ dir: tree.dir, sha: change.head, protectedPaths, message: `spor candidate for ${entry.node_id}` });
        if (!pinned || !pinned.ok) return { ok: false, reason: (pinned && pinned.reason) || "the CI candidate commit could not be built" };
        sha = pinned.sha;
      } finally {
        tree.cleanup();
      }
      const opened = await ciGate.openCiSuite({
        top: change.top, sha, branch: gatesKernel.ciCandidateBranch(entry.node_id, "gate"), ci: gate.ci,
        timeoutMs: gate.timeoutMs, label: `CI workflow \`${gate.ci.workflow}\` for gate ${gate.id}`, log,
      });
      if (!gate.ci.localFallback) return opened;
      // The declared fallback: a CI that could not be reached — at the push, or
      // on any later run — hands THAT run to the local suite, lazily opened once
      // and kept for the rest of the gate's reruns.
      let local = null;
      const fallBack = async (why, attempt) => {
        log(`work: gate ${gate.id} — CI could not be reached (${why}); running it on this box under local_fallback`);
        if (!local) local = await openLocalSuite(args);
        if (!local.ok) return { ...local, fallback: why };
        return { ...(await local.run(attempt)), fallback: why };
      };
      const closeLocal = async () => {
        if (local && local.ok) await local.close();
      };
      if (!opened.ok) {
        const why = (opened.outage && opened.outage.reason) || opened.reason || "the candidate could not be pushed";
        return { ok: true, dir: "", run: (attempt = 1) => fallBack(why, attempt), close: closeLocal };
      }
      return {
        ok: true,
        dir: "",
        run: async (attempt = 1) => {
          if (local) return fallBack("CI was already unreachable earlier in this gate", attempt);
          const r = await opened.run(attempt);
          return r && r.outage ? fallBack(r.outage.reason || r.reason, attempt) : r;
        },
        close: async () => {
          await opened.close();
          await closeLocal();
        },
      };
    };

    return {
      now: () => Date.now(),
      sleep,
      // A worker asked to stop does not keep a human gate waiting: the pipeline
      // reports it BLOCKED (the approval item stands, unanswered) rather than
      // pretending to a verdict nobody gave.
      stopping,
      loadGateProgress,
      checkEvidenceOrigins: () => {
        const progress = readProgressNow();
        if (!progress) return { ok: true };
        // This attempt's own rows, plus every obligation an earlier attempt
        // still owes — carried onto this stamp already, or still sitting on the
        // prior attempt's stamp this attempt has not yet written over
        // (task-spor-gate-regate-obligation-semantics). A re-gate never hides a
        // debt by changing the key.
        const owed = gatesKernel.owedGateObligations(progress, runKey);
        const saved = progress.key === runKey ? Object.values(progress.gates || {}) : [];
        const evidence = [...saved.flatMap((p) => p ? [p.evidence, p.filingIntent] : []), ...owed.filter((o) => o.carryKey).flatMap((o) => [o.progress.evidence, o.progress.filingIntent])].filter(Boolean);
        // Enumerate the journal, not the current gate list: removing/renaming a
        // declaration must not make an existing graph obligation unreachable.
        const current = new Set((factory.gates || []).map((g) => g.id));
        const orphan = owed.map((o) => o.progress.filingIntent || o.progress.evidence).find((e) => !e.gate || !current.has(e.gate.id));
        if (orphan) return { ok: false, reason: "pending flake evidence belongs to a removed or renamed gate; restore its original declaration and settle its obligation before changing the factory" };
        if (!evidence.every((e) => attestationOriginMatches(cfg, e.origin))) return { ok: false, reason: "pending flake evidence belongs to a different or unknown graph; resume against its original graph" };
        const pending = owed.map((o) => ({
          gate: (o.progress.filingIntent || o.progress.evidence).gate,
          rescue: o.rescue,
          progress: o.progress,
          ...(o.carryKey ? { carryKey: o.carryKey, attempt: o.attempt } : {}),
        }));
        return pending.length ? { ok: true, pending } : { ok: true };
      },
      // A carried obligation's receipt is written back where it was carried to,
      // never onto this attempt's own row for the same gate (which is this
      // attempt's own judgement and would overwrite, or be overwritten by, it).
      saveCarriedProgress: async ({ carryKey, progress }) => updateGateProgress((prior) => ({ carried: { ...(prior.carried || {}), [carryKey]: progress } })),
      saveGateProgress,
      loadRescueState,
      saveRescueState,
      loadGatePools,
      saveGatePools,
      // The per-lane reviewer COOLDOWN and the fallback's independence check
      // (task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-
      // reviewer) — machine-local, like every other gate deps' state.
      reviewerCooldown: async ({ profile, now }) => readReviewerCooldown(home, profile, now),
      stampReviewerCooldown: async (stamp) => stampReviewerCooldown(home, stamp),
      noteReviewerSuccess: async ({ profile, at }) => noteReviewerSuccess(home, profile, at),
      reviewerIndependence: async ({ profile }) => reviewerIndependence(cfg, { fallback: profile, implementer: record && record.resolved_profile }),
      updateGateProgress,
      rescue,
      dispatchRescue,
      rescueReport,
      implement,
      dispatchImplement,
      loadImplAttempts,
      saveImplAttempts,
      escalateStage,
      changedPaths: async ({ trustedRef }) => {
        change = null;
        const c = gateChangeSet(record, trustedRef);
        if (!c.ok) return c;
        change = c;
        return c;
      },
      // Pin the CANDIDATE the pipeline is judging (task-spor-factory-candidate-
      // record, FACTORY-IMPLEMENTATION-STAGE.md §3): the tree, the commit that
      // labels it, the base it was cut from and the provenance of the run that
      // produced it, folded against whatever this record already carries and
      // stamped onto the run journal in the additive `impl_` namespace.
      //
      // Reuses the change-set the read above just cached, so the pin costs two
      // git reads (the tree and the branch) rather than a second whole-diff pass,
      // and so the candidate's `clean` verdict IS the command gate's own.
      //
      // Only a factory that declares an `implementation:` block gets here (the
      // pipeline's own guard) — a factory that declares none pins nothing, stamps
      // nothing, and is byte-identical to before the stage existed.
      pinCandidate: async ({ submittedBy, runId = null }) => {
        // candidate.require_clean, checked before anything else here — see
        // refuseDirtyCandidate's own comment for why this is a distinct,
        // earlier check rather than a duplicate of gateChangeSet's.
        const refused = refuseDirtyCandidate(factory, (change && change.cwd) || (record && record.cwd));
        if (refused) return refused;
        // The pipeline's OWN record, re-read: the `impl_` stamps are written out
        // of band from the two in-process record writers, so the copy this
        // closure captured at pipeline start is not authoritative about anything
        // an earlier pin already recorded.
        let current = record;
        try {
          current = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record) || record;
        } catch {
          /* an unreadable record folds against what we have, which is the safe direction */
        }
        // WHOSE commit this is. A re-pin is made by a fix cycle or a rescue — a
        // different run, with its own record — so EVERY per-run field below reads
        // from THAT record: the harness that made it, when it ran, and what it
        // left on the graph. Mixing the two would describe a run that never
        // existed. The implementation stage's own pin is the case where the
        // producer IS this pipeline's record.
        const producerId = runId || stageProducerRunId() || entry.run_id;
        let producer = current;
        if (producerId !== entry.run_id) {
          try {
            producer = dispatchRuns.readJson(dispatchRuns.runPaths(home, producerId).record) || {};
          } catch {
            producer = {};
          }
        }
        // ...and the profile it ran under. A RESCUE is the one step that routes
        // itself: `rescue.profile` is dispatched deliberately in place of the
        // worker's own (and `rescuePassthrough` strips the routing flags so the
        // lane's stronger model wins), so reading the worker's passthrough there
        // would name a profile that demonstrably did not produce this tree. Every
        // other stage reads `producer.resolved_profile` — the profile cmdDispatch
        // ACTUALLY resolved for the producer's own launch (its own
        // `resolveDispatchProfile` verdict, stamped onto that run's record at
        // launch: see launchSupervisedHarness), not the worker's
        // `--profile` passthrough — so an item that routed ITSELF (a `profile:`
        // frontmatter, an `assigned -> agent {profile:}` edge, §2.3 levels 2-3)
        // records the profile it actually ran under instead of null
        // (issue-spor-candidate-provenance-profile-blind-to-self-routed-items).
        const producerProfile =
          submittedBy && submittedBy.stage === "rescue"
            ? (factory.rescue && factory.rescue.profile) || null
            : producer.resolved_profile || null;
        const pinned = gateRunner.pinCandidate(record, factory.trustedRef, {
          change,
          // The ITEM's own repo, not the worker's scope token: the repo is part
          // of the candidate's identity (§3.2), and under a multi-repo factory
          // those differ. `item_repo` is the stamp AS CLAIMED at launch, which is
          // the same "before" value §10.11's re-stamp check reads.
          repo: record.item_repo || entry.project || slug || null,
          nodeId: entry.node_id,
          submittedBy,
          provenance: {
            run_id: producerId,
            attempt: current.impl_attempt || 1,
            // Only the implementation stage's own submission charges the CODE
            // pool (§5.3). A fix cycle spends its gate's `cycles` and a rescue
            // spends `rescue.attempts` — neither is one of the two pools, so
            // naming one here would be a false accounting claim. (The accounting
            // itself is task-spor-factory-execution-outcome-classifier's.)
            pool: submittedBy && submittedBy.stage === "implementation" ? "implementation" : null,
            harness: producer.harness || null,
            // The rescue lane's declared profile, else the profile the producer's
            // own launch resolved to — see `producerProfile` above. The work-loop
            // SLOT (`entry`) carries no profile — it is `{run_id, node_id,
            // harness, project}`, and its shape is the one
            // `journal/work/*.work.json` publishes — but that is no longer where
            // this reads from; a resolveDispatchProfile miss (no explicit flag,
            // no frontmatter, no assigned edge) is still recorded as null, which
            // means "unrouted" here, not "not recorded".
            profile: producerProfile,
            agent: dispatchAgentId(cfg),
            worker: workerId || null,
            machine: os.hostname(),
            started_at: producer.started_at || producer.launched_at || producer.created_at || null,
            finished_at: producer.finished_at || null,
          },
          // What the run left on the graph, AS THE RUN RECORD SAW IT. The
          // terminal contract writes `resolved_by`/`resolved_edge` together and
          // only together, and only when it verified a live resolving edge — so
          // what this block records is exactly "a resolving edge was observed,
          // from this node". `resolves_edge: true` is therefore a PREMATURE
          // resolution under `completion.by: controller` (§4.5), which is what
          // the candidate is here to record; the completion boundary
          // (task-spor-factory-controller-completion-boundary) is what acts on it.
          //
          // The mirror case — a resolver node written with NO edge, the intended
          // steady state under controller completion — leaves no trace on the run
          // record at all, so `node: null, written: false` here means "no
          // resolving edge was observed", never "no resolver exists". Finding it
          // needs a graph read that belongs to the completion boundary, not to a
          // pin. `answers` counts beside `resolves`: both retire an item, so
          // reading only one would be the fail-open direction.
          resolver: await candidateResolverFromReport(cfg, producer, entry.node_id, {
            node: producer.resolved_by || null,
            written: !!producer.resolved_by,
            resolves_edge: producer.resolved_edge === "resolves" || producer.resolved_edge === "answers",
          }),
        });
        if (!pinned.ok) return pinned;
        let folded = candidateKernel.repinCandidate(current.impl_candidate || null, pinned.candidate);
        // A late or racing FIRST pin (issue-spor-pin-candidate-settled-record-
        // stamp-race): `current.impl_candidate` reads null — so `folded.change`
        // reads "created" — whenever no earlier pin from THIS record's own
        // history landed, but the record's `impl_state` can already be settled
        // through a path that never went through this closure at all (the
        // two-workers-adopt-one-orphan race stampImplState's own comment
        // describes: the winner settles `exhausted` directly, never having
        // pinned a candidate). Treating that as an ordinary first submission
        // would stamp impl_run_id/impl_attempt/impl_pool — the stage's OWN
        // dimensions, meant to name the implementer that actually settled it —
        // onto a record a settled verdict already closed, making a resolved
        // item read as an active live candidate. This is narrower than the
        // journal's own `impl_state`-key strip: a RE-PIN after settling (a fix
        // cycle or integration-fix moving the tip on an already-accepted
        // candidate, folded.change "seen"/"unchanged"/"superseded") is the
        // documented steady state and must still land — only a "created" event
        // arriving at an already-settled record is a submission that never
        // actually happened, and it is refused whole: fail-soft, logged, no
        // write, the settled record standing exactly as it was.
        if (folded.change === "created" && candidateKernel.implSettled(current.impl_state)) {
          warn(`warning: pinCandidate refusing a late first-pin stamp on ${entry.run_id} — impl_state already settled (${current.impl_state})`);
          return { ok: true, candidate: current.impl_candidate || null, change: "refused-settled" };
        }
        // PUBLISH (task-spor-factory-candidate-portable-reference, §3.4).
        // Submission is not complete until the reference verified, and there is
        // no `publish: none` — so a candidate with a commit and no verified
        // reference is a publish OWED, never a deliberate omission. It runs at
        // submission and again at every re-pin; a re-pin that only grew
        // `commits_seen` returns the SAME already-published object and the
        // publisher does nothing (`candidateSubmitted` short-circuits it).
        //
        // A failure NEVER refuses the pin: the tree is judged regardless (a
        // publish is how a controller obtains the candidate, not what makes the
        // candidate). What it does is leave the stage UNSETTLED with
        // `publish_pending` owed — re-attemptable from the workspace on the next
        // re-pin under the retry pool, which is the one retry that must never
        // re-dispatch the implementer.
        let publishPending = null;
        if (!candidateKernel.candidateSubmitted(folded.candidate)) {
          const policy = (factory.implementation && factory.implementation.candidate) || {};
          const kinds = candidatePublish.publishKinds(policy.publish);
          let store = null;
          let storeReason = "";
          if (kinds.includes("bundle")) {
            const resolved = candidatePublish.resolveBundleStore(factory, { graphHome: home, mode: cfg.mode() });
            // A store the worker's own startup check already refused is reported
            // here too rather than silently skipped: this closure also runs for a
            // pipeline RESUMED by a worker that never made that check. It is
            // handed to the publisher as the REASON rather than short-circuiting,
            // so the failure leaves the same `publish_attempts` trail every other
            // one does.
            store = resolved.errors.length ? null : resolved.store;
            storeReason = resolved.errors[0] || "";
          }
          const published = await candidatePublish.publishCandidate(folded.candidate, {
            cwd: (folded.candidate.provenance && folded.candidate.provenance.cwd) || record.cwd || null,
            publish: policy.publish,
            bundleStore: store,
            bundleStoreReason: storeReason,
            remote: policy.remote,
            http: candidatePublish.httpStoreClient({ bearer: cfg.mode() === "remote" ? remote.token(cfg) : null }),
          });
          folded = { ...folded, candidate: published.candidate || folded.candidate };
          if (!published.ok) publishPending = { reason: published.reason, classification: published.classification, at: new Date().toISOString() };
          else if (published.published) log(`work: published candidate ${folded.candidate.candidate_id} to ${folded.candidate.reference.locator}`);
          if (publishPending) log(`work: candidate ${folded.candidate.candidate_id} is not published yet (${publishPending.reason}) — the tree is judged regardless`);
        }
        const patch = {
          impl_candidate: folded.candidate,
          impl_candidates: candidateKernel.appendCandidateChain(current.impl_candidates, folded.candidate),
          // Cleared by the publish that verifies, so an operator reading `spor
          // runs` never sees a stale debt beside a published candidate.
          publish_pending: publishPending,
        };
        // The FIRST pin is the stage's submission and is the only one that
        // stamps the stage's own dimensions: a re-pin never touches `impl_state`
        // (§3.3 — the stage settled at the first candidate; a moved HEAD is not a
        // new verdict), and the attempt, pool and run it names are the
        // implementer's, not a fixer's.
        if (folded.change === "created") {
          patch.impl_run_id = entry.run_id;
          patch.impl_attempt = current.impl_attempt || 1;
          // Which pool THIS RECORD's own attempt belongs to — the record is an
          // implementation run, whichever step happened to make the first
          // readable tree, so this is not the same subject as the candidate's
          // `provenance.pool` (which names what the PIN's producer spent, and is
          // null for a fixer). The pool ACCOUNTING — the budgets, the classifier
          // that decides which pool an outcome charges — is
          // task-spor-factory-execution-outcome-classifier's.
          patch.impl_pool = "implementation";
        }
        // §3.4: submission is not complete until the reference verified, so a
        // candidate carrying no verified reference leaves the stage UNSETTLED
        // with the publish owed.
        //
        // Deliberately NOT confined to the first pin. §3.3's "a re-pin never
        // touches `impl_state`" is a rule about not REOPENING a settled verdict —
        // which `stampImplState` enforces on its own, by dropping an `impl_state`
        // write onto an already-settled record — not a rule about never reaching
        // one. A publish that failed and was re-attempted from the workspace
        // settles on a LATER pin, and gating that on `created` left exactly the
        // retry path §3.4 prescribes with a verified reference, no debt, and a
        // stage stuck at `running` forever.
        if (folded.change === "created" || candidateKernel.candidateSubmitted(folded.candidate)) {
          patch.impl_state = candidateKernel.candidateSubmitted(folded.candidate) ? "candidate" : "running";
        }
        const stamped = dispatchRuns.stampImplState(home, entry.run_id, patch);
        // stampImplState hands back null when the write could not be made (an
        // unreadable run record, a mid-write exception) — silently reporting
        // success there is exactly this closure's own bug
        // (issue-spor-pin-candidate-silent-stamp-failure): the candidate was
        // minted but never landed, so `spor runs`/`spor work --status` would
        // show a stale or missing impl_candidate with no way to tell. Fail-soft
        // like the rest of pinCandidate (the caller's `pin` wrapper logs `reason`
        // and judges the tree regardless), but never a silent ok:true.
        if (!stamped) return { ok: false, reason: `the candidate for ${entry.node_id} was pinned but could not be stamped onto its run record` };
        // `publish_pending` rides along so a caller that gates gate-start on
        // `candidateSubmitted` (issue-spor-gate-start-not-conditional-on-
        // candidate-submitted) can report WHY, not just that submission is
        // unsettled — the same debt `spor runs`/`spor work --status` already
        // read off the run record.
        return { ok: true, candidate: folded.candidate, change: folded.change, publish_pending: publishPending };
      },
      // The premature-resolution check at submission (task-spor-factory-
      // controller-completion-boundary, §4.5): the shell/completion.js retype
      // driven on this pipeline's own record, and the candidate stamped
      // `premature_resolution: true` when anything was retyped.
      premature: async () => {
        const current = freshRecord(home, record);
        if (!completionKernel.isControllerRecord(current)) return { ok: true, retyped: [] };
        const r = await completionShell.retractPremature({ record: current, deps: makeCompletionDeps(cfg, { home, runId: entry.run_id }), log });
        if (r && r.retyped && r.retyped.length && current.impl_candidate) {
          dispatchRuns.stampImplState(home, entry.run_id, { impl_candidate: { ...current.impl_candidate, premature_resolution: true } });
        }
        return r;
      },
      // The two reads behind a SUPERSEDED verdict (issue-spor-work-adopts-
      // orphaned-pipeline-of-hand-landed-run): is the item resolved on the graph
      // — the same verify leg the loop's harvest uses — and is the run's head
      // already on the trusted ref. Consulted only for an adopted pipeline.
      resolved: async () => verifyRunResolution(cfg, record),
      landed: async ({ trustedRef }) => gateRunner.gateHeadLanded(record, trustedRef),
      // The two reads behind a SCOPED verdict (WORKERS.md §10.11): the run's own
      // fixed-form claim, off its FINAL report only — the claim is "the first
      // line of my final message", so an earlier message on the stream is not
      // one (unlike a rescue's diagnosis, which the stream may legitimately
      // carry) — and any node by id, so the runner can check what the claim
      // names against the graph in either mode.
      // The claim is read off the run that PRODUCED the empty diff: the record
      // the stage hands over (`record`), else the ledger's last settled attempt,
      // else the pipeline's own run — a re-dispatched implementer that scoped
      // the item out is not read through attempt 1's report.
      noCodeClaim: ({ record: r } = {}) => gatesKernel.parseNoCodeReport(gateRunReportText(r || stageProducerRecord() || record)),
      // The read behind a STALE-PREMISE verdict (task-spor-factory-skip-
      // resolved-items-with-empty-diff): the item's `commits:` stamps AS
      // CLAIMED — `record.item_commits`, captured at launch — checked against
      // the trusted ref in this run's own checkout. Deliberately NOT a fresh
      // graph read: `commits:` is an ordinary editable list field, so a run with
      // graph-write access could otherwise append its own already-landed sha to
      // ITS OWN item mid-run and manufacture the "predates the run" evidence
      // this check exists to require — exactly the hazard `item_repo` (§10.11's
      // re-stamp check) is already built to avoid for the sibling declared
      // route. `slug` scopes which stamps this checkout can even verify — a
      // stamp for a sibling repo is unverifiable here and silently excluded.
      // Absent on a record predating this field, a free-text dispatch, or a
      // node carrying no stamp — `gateCommitsLanded` reads that as nothing to
      // check, exactly as an empty list does.
      commitsLanded: async ({ trustedRef }) => gateRunner.gateCommitsLanded(record, trustedRef, record.item_commits, slug || null),
      node: async ({ id }) => {
        let node = null;
        try {
          node = await resolveNode(cfg, id);
        } catch (e) {
          return { ok: false, reason: `${id} could not be read: ${(e && e.message) || e}` };
        }
        // An unreadable body must fail this check exactly like a missing node —
        // returning ok:true with an all-empty node (no outcome, no edges) would
        // read as "confirmed no evidence of resolution" instead of "could not
        // check" (issue-spor-resolve-node-unguarded-json-reads-null-as-unknown).
        if (!node || nodeUnreadable(node)) return { ok: false, reason: `${id} could not be read from the graph` };
        return {
          ok: true,
          node: {
            id: node.id,
            type: node.type || "",
            status: node.status || "",
            repo: node.repo || null,
            outcome: (node.frontmatter && node.frontmatter.outcome) || null,
            edges: node.edges || [],
            // Supersession is an INBOUND fact, so it comes from the server's own
            // enrichment remotely and from the loaded graph locally — a node
            // stores only its own out-edges, and reading the frontmatter alone
            // would make the check's supersession leg dead in local mode. A LIST,
            // because the caller has to ask "is there a superseder other than the
            // node this run declared" and one id cannot answer that. The graph is
            // loaded at most once per pipeline, and only on the path that runs
            // for an empty diff with a declared claim.
            superseded_by: node.superseded_by ? [node.superseded_by] : localSupersededBy(id),
          },
        };
      },
      // The judged tree is prepared ONCE per gate and handed back as a suite
      // handle: `run(attempt)` executes the declared command on it, `close()`
      // tears it down. The gate runner's rerun loop (WORKERS.md §10.3
      // `reruns`) calls `run` once per attempt on this ONE checkout — the
      // same worktree, the same forced protected paths, the same staged
      // dependencies — so a rerun is literally the same tree, not a fresh
      // build that happens to have the same sha, and the setup/teardown hooks
      // fire once for the whole loop rather than once per run.
      openSuite: (args) => (args && args.gate && args.gate.ci ? openCiGateSuite(args) : openLocalSuite(args)),
      // The per-gate serialize lease (task-spor-gate-serialize-lease) reuses the
      // integration stage's: keyed on the repo's MAIN checkout locally, the
      // synthetic per-repo lock node remotely, so a `serialize: repo` command
      // gate and the integration stage never overlap on one box either. Unlike
      // the integration stage's own short landing pass, sized to THIS gate's
      // own declared run (issue-spor-serialize-lease-does-not-wait-out-a-long-
      // suite) — a 30min CPU-bound suite waits out a same-sized holder instead
      // of running beside it, judges a live holder's staleness against its own
      // declared budget rather than a fixed 30min, and stretches a remote
      // claim's TTL up front to cover the whole run.
      acquireGateLease: ({ gate } = {}) => {
        const budgetMs = gateLeaseBudgetMs(gate);
        return acquireIntegrationLease(cfg, home, change ? change.top : record && record.cwd, { slug, waitMs: budgetMs, budgetMs });
      },
      releaseGateLease: (token) => releaseIntegrationLease(cfg, token),
      review,
      fix,
      dispatchFix,
      awaitRun,
      evidenceOrigin: () => attestationGraphOrigin(cfg),
      acceptsEvidenceOrigin: (origin) => attestationOriginMatches(cfg, origin),
      recordFact: async ({ id, markdown, flakeIssues = [], origin }) => {
        const publicationCfg = origin ? attestationPublicationConfig(cfg, origin) : flakeIssues.length ? null : cfg;
        if (!publicationCfg) return { ok: false, reason: "flake evidence belongs to a different or unknown graph" };
        // Occurrence edges use the guarded micro-mutation even on fresh facts:
        // issue selection is not a liveness guarantee at publication time.
        const bare = withoutFlakeEdges(markdown, flakeIssues);
        const wrote = await writeGateNode(publicationCfg, id, bare);
        return { ...wrote, linked: [] };
      },
      // Reconcile the complete evidence identity, ignoring only this flake's
      // occurrence edges (including recurrence rungs). Those edges are separate
      // guarded payments; title equality alone cannot vouch for a judged head,
      // gate definition, or evidence body. Return typed edges so mentions never
      // discharge occurrence debt.
      readFact: async ({ id, markdown, flakeIssues = [], origin }) => {
        const publicationCfg = origin ? attestationPublicationConfig(cfg, origin) : cfg;
        if (!publicationCfg) return { ok: false, reason: "flake evidence belongs to a different or unknown graph" };
        const graphLib = require(path.join(ROOT, "lib", "graph.js"));
        const read = {};
        let node = null;
        try {
          node = await resolveNode(publicationCfg, id, read);
        } catch (e) {
          return { ok: false, reason: `${id} could not be read (${(e && e.message) || e})` };
        }
        if (!node || nodeUnreadable(node)) return (read.unreadable || (node && nodeUnreadable(node))) ? { ok: false, reason: `${id} could not be read` } : { ok: true, same: false, edges: [] };
        let edges = [];
        try {
          edges = graphLib.parseFrontmatter(node.raw || "", `${id}.md`).edges || [];
        } catch (e) {
          return { ok: false, reason: `${id}'s frontmatter could not be parsed (${(e && e.message) || e})` };
        }
        let mine = "";
        try {
          mine = String(graphLib.parseFrontmatter(String(markdown || ""), `${id}.md`).title || "").trim();
        } catch {
          mine = "";
        }
        const theirs = String(node.title || "").trim();
        return {
          ok: true,
          // An unreadable title on either side is not a match: `same` is a
          // POSITIVE reading or nothing.
          same: !!(mine && theirs && gateNodeEquivalent(withoutFlakeEdges(node.raw, flakeIssues), withoutFlakeEdges(markdown, flakeIssues))),
          edges: edges.filter((e) => e && e.to).map((e) => ({ type: String((e && e.type) || ""), to: String(e.to) })),
        };
      },
      // Pay a flake occurrence edge the FACT itself could not carry (F13). The
      // fact's id was already occupied, so this markdown — and the edges in its
      // frontmatter — did not land, and for a PASSING gate or the final refusal
      // there is no later fact of this pass to carry them: without this door the
      // occurrence is a permanent debt sink, an issue no fact names. Written
      // through the same add_edge micro-mutation `spor edge` uses, which is
      // IDEMPOTENT on both sides (the server answers `skipped`, local dedups
      // against the edges already on the node), so two workers paying the same
      // occurrence cannot double-count it — and which REFUSES a dangling target,
      // so a flake issue that vanished leaves the debt logged unpaid rather than
      // an edge pointing at nothing.
      linkFact: async function ({ id, type, to, gate, file, files, origin }) {
        const publicationCfg = origin ? attestationPublicationConfig(cfg, origin) : file ? null : cfg;
        if (!publicationCfg) return { ok: false, reason: "flake evidence belongs to a different or unknown graph" };
        const first = await addGateEdge(publicationCfg, id, type, to);
        if (first.ok || !["target_not_live", "local_atomic_unavailable"].includes(first.code) || !file || !gate) return first;
        // A settled selection owes a recurrence. Before selecting another rung,
        // recover a payment that landed before a process died: it remains paid
        // even when that recurrence itself has since been settled.
        const source = await resolveNode(publicationCfg, id);
        if (!source || nodeUnreadable(source)) return { ok: false, reason: "the occurrence fact could not be read before recurrence selection" };
        const graphLib = require(path.join(ROOT, "lib", "graph.js"));
        const family = (target) => String(target).replace(/-r[2-4]$/, "");
        const edges = graphLib.parseFrontmatter(source.raw, `${id}.md`).edges || [];
        const paid = edges.find((e) => e.type === type && family(e.to) === family(to));
        if (paid) return { ok: true, id, to: paid.to };
        if (first.code === "local_atomic_unavailable") return first;
        const next = await this.fileFlakeItem({ gate, file, files, command: gate.command, isolate: gate.isolate, origin });
        if (!next || !next.ok) return next || { ok: false, reason: "recurrence selection returned no answer" };
        return { ...await addGateEdge(publicationCfg, id, type, next.id), to: next.id };
      },
      fileTestLaneItem: async ({ gate, paths, profile, rescue = 0 }) => {
        const k = keysFor(rescue);
        const id = `task-test-lane-${stem}-${k.short}-${gateIdSuffix("test-lane", gate.id, entry.node_id, k.runKey)}`;
        const body = [
          `The implementer's branch for ${entry.node_id} changed protected test path(s):`,
          "",
          paths.slice(0, 50).map((p) => `- \`${p}\``).join("\n") + (paths.length > 50 ? `\n- …and ${paths.length - 50} more` : ""),
          "",
          `The \`${gate.id}\` command gate therefore failed CLOSED — the acceptance suite is never run from a`,
          "branch that edits it, because the same entity writing the test and the code under test carries the",
          "same misunderstanding into both (dec-spor-software-factory-substrate).",
          "",
          `Make the test change here instead, in the separate lane: run it under \`${profile}\`, e.g.`,
          "",
          `    spor dispatch ${id} --profile ${profile}`,
          "",
          `(or point a worker at the lane: \`spor work --profile ${profile}\`.) Once the test change lands on the`,
          `trusted ref, re-dispatch ${entry.node_id} and its gate runs against the new trusted suite.`,
        ].join("\n");
        return writeGateNode(
          cfg,
          id,
          buildGateWorkNode({
            id,
            title: `Test-change lane — ${entry.node_id} edited protected test paths`,
            summary: `The gated change for ${entry.node_id} touched ${paths.length} protected test path(s); the test change belongs in the ${profile} lane, not the implementer's branch.`,
            body,
            project: slug,
            date: date(),
            profile,
            // `blocks`, not `relates-to`: the gated item cannot legitimately
            // stand until the test change lands in its own lane, and that
            // dependency has to be readable by everyone, not just this box's
            // cooldown map.
            edges: [{ type: "blocks", to: entry.node_id }, ...(profile ? [{ type: "relates-to", to: profile }] : [])],
          })
        );
      },
      // The off-diff FLAKE report (task-spor-factory-flake-rescue-should-not-
      // burn-when-failure-is-off-diff): a whole-suite failure in files the change
      // never touched, which passed alone on the same tree. Filed as an ISSUE —
      // a defect in the suite, not work the gated item owes — and routed to the
      // same `test_lane_profile` the protected-path lane uses, because fixing a
      // flaky test IS a test change and must not come from the implementer.
      //
      // Alone among the nodes a gate files, its id and its BODY are keyed on ONE
      // failing FILE rather than on the run — the runner calls this once per file
      // the failure named. A flake is a property of the file, not of the set it
      // happened to fail beside (a set that changes with load and ordering, and
      // whose every permutation would otherwise be its own issue), and the same
      // file flaking on ten dispatches must converge on ONE issue
      // (writeGateNode's `if_exists: skip` remotely, and its identical-content
      // adoption locally, both then read the repeat as a no-op) instead of ten
      // near-duplicates nobody triages. The occurrence count is the inbound
      // `relates-to` edges from the `art-gate-*` facts, which each carry the run,
      // the item and the evidence — so nothing run-specific is lost by leaving
      // it out here, and there is no per-run content to make the write diverge.
      //
      // The convergence is RECONCILED against settled state, never taken on the
      // strength of the id (the stale-flag failure mode): the same file can flake
      // again months after its issue was fixed and closed, and a fresh occurrence
      // attached to a terminal node is no signal at all — nothing resurfaces it,
      // nobody triages it, and the gate would have passed a red suite against a
      // record that reads "already handled". So each candidate id is READ first
      // and only an id that is free (create) or occupied by LIVE work (link) is
      // taken; a settled occupant advances to the next rung (`-r2`, `-r3`, …),
      // which is a live issue for the recurrence that also points back at the
      // one that was closed. All rungs settled — a file closed and reopened four
      // times — is reported unfiled, which the runner turns into a charged
      // failure and a person, the right answer for a file that keeps coming back.
      //
      // And a read that could not be MADE decides nothing at all: it is neither
      // absence (which would write) nor liveness (which would link) nor
      // settledness (which would climb), so it is reported unfiled and the
      // failure is charged. The write is not a second chance at that question —
      // its door reports an occupied id as a SUCCESS, so believing it would adopt
      // whatever is there unread, which for a resolved occupant is the very
      // "fresh occurrence attached to a terminal node" this reconciliation
      // exists to prevent. That is why a write that did not create anything
      // (`existing`, in either mode) sends the id back through the read once,
      // instead of being returned as a filing.
      fileFlakeItem: async ({ gate, file, files, command, isolate, origin }) => {
        const publicationCfg = origin ? attestationPublicationConfig(cfg, origin) : origin === null ? null : cfg;
        if (!publicationCfg) return { ok: false, reason: "flake filing belongs to a different or unknown graph" };
        const list = (files || []).map(String);
        // ONE issue per FILE, keyed on that file and nothing else. Keying it on
        // the whole co-failing SET would mint a fresh issue for the same flaky
        // file every time its companions — or their order — changed, which is
        // exactly the near-duplicate a convergent id exists to prevent: the file
        // is what someone fixes, so the file is the key. The rest of the
        // failure's files are context in the body, never in the id.
        const target = String(file || list[0]);
        const others = list.filter((f) => f !== target);
        const stem = target.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 34).replace(/-+$/, "") || "suite";
        const base = `issue-flake-${stem}-${gateIdSuffix("flake", gate.id, slug || "", target)}`;
        const profile = factory.testLaneProfile || null;
        const markdown = (id, priorId, priorWhy) =>
          buildGateWorkNode({
            id,
            type: "issue",
            title: `Flaky under the ${gate.id} gate — ${target} fails the full suite and passes alone`,
            summary: `${target} failed factory \`${factory.id}\`'s \`${gate.id}\` gate (\`${command}\`) and passed when re-run alone on the same tree — an off-diff flake, not a failure of any change under judgement.`,
            body: [
              `The \`${gate.id}\` command gate of factory \`${factory.id}\` failed its whole-suite run \`${command}\`,`,
              "in this file, which the change under judgement did not touch and which references nothing it edits:",
              "",
              `- \`${target}\``,
              ...(others.length ? ["", `It failed alongside ${others.map((f) => `\`${f}\``).join(", ")}, each of which carries its own issue — the`, "companion set is context here, not part of this issue's identity, so the same file converges on this", "node however it fails next time."] : []),
              "",
              `Re-running the failure's files alone on that same tree (\`${isolate}\`) PASSED, so the failure was the`,
              "suite's scheduling — load, ordering, a shared fixture — and not the change. An off-diff flake costs",
              "this issue rather than the item's fix cycles, its rescue lane and finally a person, all spent on",
              "work that was never wrong (WORKERS.md §10.3).",
              "",
              "Fix the flake in the file itself: make it independent of what else is running. Every `art-gate-*`",
              "fact that relates to this issue is one occurrence — the inbound edges are the count, and each",
              "carries the run, the item and the whole-suite failure it saw as evidence.",
              ...(priorId ? ["", `This is a RECURRENCE: \`${priorId}\` holds the earlier occurrences of the same flake and is`, `already settled (${priorWhy}), so this file carries the ones since.`] : []),
              ...(profile ? ["", `Test changes belong in the \`${profile}\` lane, not an implementer's branch.`] : []),
            ].join("\n"),
            project: slug,
            date: date(),
            profile,
            // The test this flake issue COVERS, as data: once the issue is fixed,
            // a refusal whose every failing test is covered by a fixed flake is
            // re-gated without a person (spor work --regate-flakes).
            lists: { covers_tests: [target] },
            edges: [
              ...(factory.id ? [{ type: "relates-to", to: factory.id }] : []),
              ...(profile ? [{ type: "relates-to", to: profile }] : []),
              ...(priorId ? [{ type: "relates-to", to: priorId }] : []),
            ],
          });
        // The occupant of one candidate id, as the FOUR answers the adoption rule
        // needs rather than the two a null carries. "Could not look" is the one
        // the old reading collapsed into "absent": a read that timed out was
        // followed by a write, the write's door reported the id already taken as
        // a success (`if_exists: skip` remotely, identical-content adoption
        // locally), and a RESOLVED occupant was adopted unread — the stale-flag
        // failure exactly. It is now its own answer and it settles nothing.
        const occupantOf = async (id) => {
          const read = {};
          let node = null;
          try {
            node = await resolveNode(publicationCfg, id, read);
          } catch (e) {
            return { state: "unknown", why: `${id} could not be read (${(e && e.message) || e})` };
          }
          if (node && !nodeUnreadable(node)) {
            const settled = dispatchResolutionReason(publicationCfg, node);
            return settled ? { state: "settled", why: settled } : { state: "live" };
          }
          return (read.unreadable || (node && nodeUnreadable(node))) ? { state: "unknown", why: `${id} could not be read` } : { state: "absent" };
        };
        let prior = null;
        let priorWhy = "";
        let rung = 0;
        let raced = false;
        while (rung < FLAKE_ID_RUNGS) {
          const id = rung === 0 ? base : `${base}-r${rung + 1}`;
          const occupant = await occupantOf(id);
          // Nothing is concluded from a read that failed. Climbing to the next
          // rung would mint a duplicate beside a live issue; adopting would link
          // a possibly-settled one. Both are answers about state we did not see,
          // so the filing is refused — which the runner turns into a charged
          // failure, the same direction every other unreadable answer takes here.
          if (occupant.state === "unknown") return { ok: false, reason: `the flake's issue ${occupant.why}, so whether it is still live could not be decided` };
          if (occupant.state === "live") return { ok: true, id, existing: true };
          if (occupant.state === "settled") {
            prior = id;
            priorWhy = occupant.why;
            rung += 1;
            raced = false;
            continue;
          }
          const written = await writeGateNode(publicationCfg, id, markdown(id, prior, priorWhy));
          // Created it: this filing IS the record.
          if (written.ok && !written.existing) return written;
          // The id was occupied between the read and the write — another worker
          // filed the same flake first (its content is this flake's by
          // construction, the id being keyed on the file and nothing else), or
          // the same-content door adopted it. Either way this markdown did not
          // land, so the occupant is read back ONCE and the same live/settled/
          // unknown rule decides, rather than adopted on the strength of the id.
          if (written.existing && !raced) {
            raced = true;
            continue;
          }
          // Occupied by content that is not this flake's, or occupied again after
          // a re-read that said absent: the id is not usable, climb a rung.
          if (written.existing) {
            rung += 1;
            raced = false;
            continue;
          }
          return written;
        }
        return { ok: false, reason: `every candidate id for this flake (${base}, +${FLAKE_ID_RUNGS - 1} recurrence rungs) is already settled — the file has been closed and reopened too often to file another` };
      },
      fileHumanItem: async ({ gate, classes, head, rescue = 0 }) => {
        if (!head || !/^[0-9a-f]{40,64}$/i.test(head)) return { ok: false, reason: "the judged commit is unknown; approval cannot be bound to a candidate" };

        const k = keysFor(rescue);
        const id = `task-approve-${gate.id.slice(0, 24)}-${stem}-${k.short}-${gateIdSuffix("approve", gate.id, entry.node_id, `${k.runKey}@${head}`)}`.toLowerCase();
        const body = [
          `The \`${gate.id}\` human gate is armed for ${entry.node_id}: the change touches` +
            (classes.length ? ` the declared risk class(es) ${classes.map((c) => `\`${c.class}\``).join(", ")}.` : " work this factory always has a person approve."),
          "",
          ...(classes.length
            ? classes.map((c) => `- \`${c.class}\`: ${c.paths.slice(0, 8).map((p) => `\`${p}\``).join(", ")}${c.paths.length > 8 ? ` (+${c.paths.length - 8} more)` : ""}`)
            : []),
          "",
          `Judged commit: \`${head}\`. This approval applies only to this commit; a changed candidate needs a new approval.`,
          "",
          gate.instructions || "Review the change and decide whether it may stand.",
          "",
          `The worker is BLOCKED on this: ${entry.node_id} is not treated as done until this item is answered.`,
          `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
          "completion status the worker rolled it back — a gate records what was enforced, it never asserts",
          `completion, so approving here does not re-flip it. Close the loop on ${entry.node_id} yourself.`,
          "",
          "To APPROVE, resolve this item — capture the decision and point it here:",
          "",
          `    spor add "Approved the ${gate.id} gate on ${entry.node_id} — <why>"`,
          `    spor edge <the-new-node-id> resolves ${id}`,
          "",
          "To REFUSE:",
          "",
          `    spor set-status ${id} abandoned`,
        ].join("\n");
        return writeGateNode(
          cfg,
          id,
          buildGateWorkNode({
            id,
            title: `Approval — ${gate.id} gate on ${entry.node_id}`,
            summary: `A person must approve the ${gate.id} gate for ${entry.node_id}${classes.length ? ` (risk: ${classes.map((c) => c.class).join(", ")})` : ""}; the worker blocks its resolve until this is answered.`,
            body,
            project: slug,
            date: date(),
            requiresHuman: true,
            // The judged commit rides the frontmatter as well as the body and the
            // id hash, so the READ side can bind the answer to the commit it was
            // asked about rather than trusting the id alone.
            fields: { gate_head: head.toLowerCase() },
            // `blocks`: an unanswered approval is not an approval, so the gated
            // item is not done — and that must be true on the graph, not only in
            // this worker's cooldown map.
            edges: [{ type: "blocks", to: entry.node_id }],
          })
        );
      },
      checkApproval: ({ id, head }) => gateApprovalState(cfg, id, { head }),
      demote: ({ blockerId }) => gateDemoteItem(cfg, entry.node_id, { blockerId }),
      escalate: async ({ gate, attempts, detail, evidence, findings, ledger, rescue = 0, rescues = [], outage = null, failingTests = null }) => {
        const k = keysFor(rescue);
        const id = `task-gate-${gate.id.slice(0, 24)}-${stem}-${k.short}-${gateIdSuffix("escalate", gate.id, entry.node_id, k.runKey)}`.toLowerCase();
        const cycles = attempts.length;
        // Counted in FIX CYCLES against the cap, not in attempts: `attempts` has
        // one entry per review, so "4 attempts, cap 3" read as an off-by-one
        // when it was the initial review plus the three fix cycles declared.
        const spent = gatesKernel.describeCycles(gate, attempts);
        // The rescue lane ran first (task-spor-factory-rescue-lane): the body
        // OPENS with its diagnosis — the person is paged only because the
        // rescue also failed, and what it found is the first thing to read.
        const last = rescues.length ? rescues[rescues.length - 1] : null;
        const rescueLines = last
          ? [
              last.error
                ? `Rescue attempt ${last.n} could not run (${last.error}) — this is the refusal it was handed.`
                : `Rescue diagnosis (attempt ${last.n}${rescues.length > 1 ? ` of ${rescues.length}` : ""}, ${last.category || "unknown"}): ${last.diagnosis || "(the rescue left no readable diagnosis)"}`,
              ...(last.run_id ? [`The rescue ran as \`${last.run_id}\`${last.fixed ? " and committed a fix; the gates below refused the tree it left" : " and committed no fix it claims resolves the refusal"}.`] : []),
              ...((last.filed || []).length ? [`Filed by the rescue: ${last.filed.join(", ")}.`] : []),
              ...(rescues.length > 1
                ? rescues.slice(0, -1).map((r) => `Earlier rescue attempt ${r.n}: ${r.error ? `could not run (${r.error})` : `${r.category || "unknown"} — ${String(r.diagnosis || "").slice(0, 300)}`}`)
                : []),
              "",
            ]
          : [];
        // An OUTAGE refusal did not judge the change at all — the dispatch never
        // answered — so the body must not open by saying the gate refused the
        // item and spent its fix cycles. It spent NONE: that is the whole point
        // of the classification (§5.3, issue-spor-review-gate-reviewer-outage-
        // read-as-rejection), and a person paged with the wrong story looks for
        // a defect that is not there.
        const outageLines = outage
          ? [
              `The \`${gate.kind}\` gate \`${gate.id}\` could not JUDGE ${entry.node_id}: its dispatch never answered`,
              `(${outage.reason || "no reason was recorded"}).`,
              outage.outcome === "unroutable"
                ? "This box refused the dispatch before it ever started — an unsatisfiable profile, or a launcher that does not resolve — so it is a configuration problem, not a defect in the change, and no budget was spent on it."
                : "That is an OUTAGE, not a verdict on the change: no fix cycle was charged for it, no finding was folded and no implementer was dispatched at one.",
              // WHY the gate stopped instead of asking again — recorded by the
              // runner (gate-runner.js spendOutage), never guessed here. "The
              // pool is spent" and "the worker was asked to stop" settle the
              // gate identically and send a person to two different places.
              `It stopped rather than asking again because ${outage.notRetried || "the runner recorded no reason"}.`,
              "",
              `Nothing here says the change is wrong. Re-run the gates once the harness is back with 'spor work --regate ${entry.run_id}'.`,
              "",
            ]
          : [];
        const body = [
          ...rescueLines,
          ...outageLines,
          ...(outage
            ? []
            : [
                `The \`${gate.kind}\` gate \`${gate.id}\` refused ${entry.node_id} and its fix cycles are spent`,
                `(${spent.text})${rescue ? `, after rescue attempt ${rescue}` : ""}. A person decides what happens next —`,
                "the worker has stopped re-dispatching it.",
              ]),
          "",
          `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
          "completion status the worker rolled it back. The run's resolver is left standing: it is the record of",
          "what the agent did, and retiring it (or letting it stand) is the judgement this item is asking for.",
          ...(completionKernel.isControllerRecord(record)
            ? [
                "",
                `${entry.node_id} is HELD by execution \`${record.impl_claim.execution_id}\` (this factory completes items itself, at its`,
                `'${record.impl_claim.completion.after}' boundary): no resolving edge and no terminal status retires it while the hold stands, and a`,
                "fresh worker never takes a held item. The doors back are 'spor work --regate " + entry.run_id + "' (re-judge this run under",
                `the same execution) or 'spor release ${entry.node_id} --execution ${record.impl_claim.execution_id}' (end the execution; the item then`,
                "returns to the pool, or is resolved by hand as usual).",
              ]
            : []),
          "",
          detail ? `Last outcome: ${detail}` : "",
          "",
          ...(findings && findings.length ? ["Findings:", "", gatesKernel.renderFindings(findings), ""] : []),
          ...(ledger && ledger.length ? ["Finding ledger:", "", gatesKernel.renderLedger(ledger), ""] : []),
          ...(evidence ? ["Evidence:", "", "```", fenceSafe(String(evidence).slice(0, 3000)), "```", ""] : []),
          ...(cycles > 1
            ? [`Cycles (${spent.text}):`, ...attempts.map((a, i) => `${i + 1}. ${i === 0 ? "initial review" : `after fix cycle ${i}`}: ${a.verdict} — ${String(a.detail || "").slice(0, 200)}`), ""]
            : []),
          `The run's own record is \`${entry.run_id}\` ('spor runs ${entry.run_id}').`,
        ]
          .filter((l) => l !== "")
          .join("\n");
        return writeGateNode(
          cfg,
          id,
          buildGateWorkNode({
            id,
            title: outage
              ? `Gate escalation — ${gate.id} could not review ${entry.node_id} (${outage.outcome === "unroutable" ? "dispatch refused" : "reviewer unavailable"})`
              : `Gate escalation — ${gate.id} refused ${entry.node_id}${rescue ? " after rescue" : ""}`,
            summary: outage
              ? `The ${gate.id} ${gate.kind} gate could not judge ${entry.node_id}: its dispatch never answered (${String(outage.reason || "no reason recorded").slice(0, 200)}). No fix cycle was charged and the change was not judged wrong — it needs a person, or 'spor work --regate'.`
              : last
                ? `Rescue ${last.error ? "could not run" : `diagnosed ${last.category || "unknown"}`}: ${String(last.error || last.diagnosis || "no diagnosis").slice(0, 200)} — the ${gate.id} ${gate.kind} gate still refused ${entry.node_id}; it needs a person.`
                : `The ${gate.id} ${gate.kind} gate refused ${entry.node_id} after ${spent.fixes} fix cycle(s); it needs a person${detail ? `: ${String(detail).slice(0, 200)}` : "."}`,
            body,
            project: slug,
            date: date(),
            requiresHuman: true,
            lists: { failing_tests: failingTests || [] },
            // `blocks`: the escalation is what the gated item now waits on, and
            // the graph has to say so — a refusal that lives only in one box's
            // cooldown map leaves every other reader calling the item done.
            edges: [{ type: "blocks", to: entry.node_id }],
          })
        );
      },
      log,
    };
  }

  function makeIntegrationDeps(cfg, { record, entry, factory, slug, passthrough, warn, sleep, log, workerId = null, gateOwner = undefined, runMaxMs = workLoop.WORK_DEFAULTS.runMaxMs, runIdleMs = workLoop.WORK_DEFAULTS.runIdleMs, dispatch = dispatchThrough, home = cfg.userConfigHome(), completedBeforeIntegration = false, gateResult = null, regate = null, buildProposalBody: buildBody = buildProposalBody, proposeIntegrationPR: proposePR = proposeIntegrationPR }) {
    // These activities close over the LIVE factory — `integration` here,
    // `factory.trustedRef` and `factory.protectedPaths` in forceProtected/
    // runSuite below — while the
    // workflow driving them journals the definition it opened under. The two
    // are held equal by the workflow's binding digest (integration-workflow.js
    // `definitionBindingDigest`): a factory edited between attempts fails the
    // resume closed before any of these run, so an activity never executes a
    // definition the journal did not open with
    // (task-spor-integration-workflow-merge-gate-fixes).
    const integration = factory.integration;
    // The gate pipeline's result AS IT STANDS — a re-gate of a moved head
    // (below) replaces it, and the PR body's attestation must carry the latest.
    const currentGate = () => (typeof gateResult === "function" ? gateResult() : gateResult);
    const date = () => new Date().toISOString().slice(0, 10);
    const stem = gateStem(entry.node_id);
    const short = gateRunner.shortRunAttempt(entry.run_id, entry.attempt);
    const runKey = gateRunner.gateRunKey(entry.run_id, entry.attempt);
    // Whose pipeline this stage stamps for (the gate deps' progressOwner).
    const launchOwner = pipelineOwner(home, entry.run_id, gateOwner);
    let top = null;
    // The open `ci` candidate suite, if the integration block declares one:
    // {head, handle, unreachable} — one push per candidate, reused by its reruns.
    let ciSuite = null;
    // The change-set behind the pinCandidate dep below — kept current by
    // `changedTree`, which integration-runner.js re-calls before every fix
    // cycle (issue-spor-integration-fix-cycle-does-not-repin-candidate). Unlike
    // makeGateDeps' own `change`, this one is diffed against
    // `integration.targetRef` — the ref this stage is actually landing onto —
    // not `factory.trustedRef`, and gate deps never refresh it once the gate
    // pipeline hands off here.
    let change = null;

    // The implementer's checkout for a git-side activity: the arg the workflow
    // passes (its journaled tree read), else this process's own read, else the
    // record's cwd. A RESUMED worker replays the opening read, so its
    // closure `top` is never set — the arg is what keeps a rebuilt candidate
    // off a null cwd (task-spor-integration-stage-as-workflow-function).
    const topFor = (from) => from || top || (record && record.cwd) || null;

    // The fix cycle in two halves — the launch (adopt-by-name, so a re-run
    // under the same name returns the run already started) and the wait for
    // its terminal state — so the workflow can journal the run it launched
    // and await it as a SIGNAL; `fix` is the one-shot composition of the two,
    // for a caller that drives the stage without the signal seam.
    const dispatchFix = async ({ cycle, kind, detail, evidence }) => {
      const why =
        kind === "conflict"
          ? `the integration stage could not merge your branch onto \`${integration.targetRef}\` — it conflicts.`
          : kind === "suite"
          ? `the integration stage's candidate suite (\`${integration.command}\`) failed on the merged tree.`
          : kind === "propose"
          ? `the integration stage could not open a pull request for your change onto \`${integration.targetRef}\`.`
          : `the integration stage could not land your change onto \`${integration.targetRef}\`.`;
      const prompt = [
        `The integration stage refused to land ${entry.node_id} onto \`${integration.targetRef}\` (\`${integration.mode}\` mode, \`${integration.strategy}\` strategy).`,
        "",
        why,
        "",
        detail || "",
        "",
        evidence ? `Evidence:\n${String(evidence).slice(0, 4000)}` : "",
        "",
        kind === "conflict"
          ? `Merge or rebase onto the current \`${integration.targetRef}\` yourself in this checkout, resolve the conflict, and commit.`
          : "Fix the cause in this checkout and commit.",
        "The stage will rebuild the candidate and re-run the full suite, so do not edit protected test paths — a change",
        "that touches them fails the acceptance gate closed, separately from this stage.",
        workerContractLib.ONE_TURN_NOTICE,
      ]
        .filter((l) => l !== "")
        .join("\n");
      const fixName = `integration-fix-${short}-${cycle}`;
      // Adopt a fix this stage already launched at this cycle (see the gate
      // deps' fix closure) rather than dispatching it twice.
      const already = launchedFixRun(home, entry.node_id, fixName);
      // "no-auto-route": the SAME pipeline-internal guard the gate deps' `fix`
      // and `rescue` carry (issue-spor-auto-route-reaches-fix-cycle-and-rescue-
      // dispatches) — the integration stage holds entry.node_id's lease for the
      // duration of its own fix cycle, so a standing dispatch.autoRoute must not
      // re-route it either.
      const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(cfg, { ...passthrough, node: entry.node_id, dir: record ? record.cwd : undefined, force: true, "no-worktree": true, "no-auto-route": true, name: fixName }, [prompt]);
      if (!launched.ok) return { ok: false, reason: launched.reason };
      if (launched.adopted) log(`work: integration fix cycle ${cycle} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
      // Through the pipeline's owned door (the gate deps' stampLaunch): a
      // driver whose lease another worker took over stamps nothing onto the
      // new holder's record, and throws like the gate deps' fix.
      stampPipelineLaunch(home, entry.run_id, launchOwner, { gate_fix_run_id: launched.run.run_id, gate_fix_at: new Date().toISOString(), gate_fix_gate: "integration", gate_fix_cycle: cycle });
      return { ok: true, runId: launched.run.run_id, adopted: !!launched.adopted };
    };
    // The SAME wait half the gate deps use (`laneAwaitRun`): the integration
    // fix cycle is followed under the worker's idle ceiling and reports a run
    // it stopped following as `unfollowable`, exactly as a gate fix cycle is.
    const awaitRun = laneAwaitRun(cfg, { factory, runMaxMs, runIdleMs, warn, sleep });
    const fix = async (args) => {
      const launched = await dispatchFix(args);
      if (!launched.ok) return launched;
      const done = await awaitRun({ runId: launched.runId, lane: "fix" });
      if (!done.ok) return { ok: false, reason: done.reason, ...(done.unfollowable ? { unfollowable: true } : {}) };
      return { ok: true, runId: launched.runId, record: done.record };
    };
    // Tagged as the composition of the two halves: the workflow then takes
    // the signal form, while a caller that OVERRIDES `fix` on these deps (a
    // test standing in a real fix cycle's commit) keeps the one-shot it wrote
    // — an untagged `fix` is the caller's own and wins.
    fix.composedOfSignals = true;

    return {
      completedBeforeIntegration: completedBeforeIntegration === true,
      now: () => Date.now(),
      changedTree: async () => {
        const c = gateRunner.gateChangeSet(record, integration.targetRef);
        if (c.ok) {
          top = c.top;
          change = c;
        }
        return c;
      },
      // Re-pin the candidate for a tree THIS STAGE produced
      // (issue-spor-integration-fix-cycle-does-not-repin-candidate,
      // task-spor-factory-candidate-record, FACTORY-IMPLEMENTATION-STAGE.md
      // §3.3): integration-runner.js calls this from its own per-cycle
      // `refreshTree`, exactly where the gate pipeline's fix cycles call
      // makeGateDeps' `pinCandidate` above, so a fix cycle here re-pins the same
      // way — the fold in kernel/candidate.js decides whether the new commit is
      // a relabel of the same tree (`commits_seen`) or a new candidate
      // (`supersedes`). Fail-soft: a pin that could not be read leaves the tree
      // judged regardless (integration-runner.js's own `pin` closure logs and
      // swallows it), same contract as the gate pipeline's version.
      //
      // This mirrors makeGateDeps' `pinCandidate` rather than reusing it,
      // because that closure folds against ITS OWN `change` — the gate
      // pipeline's diff against `factory.trustedRef`, read once per gate
      // fix/rescue cycle and never again once the gate pipeline hands off to
      // integration. Reusing it here would pin whatever tree the gate pipeline
      // last read, not the tree this stage's own fix cycle just committed.
      pinCandidate: async ({ submittedBy, runId = null }) => {
        // candidate.require_clean — see makeGateDeps' own pinCandidate above and
        // refuseDirtyCandidate's comment.
        const refused = refuseDirtyCandidate(factory, (change && change.cwd) || (record && record.cwd));
        if (refused) return refused;
        let current = record;
        try {
          current = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record) || record;
        } catch {
          /* an unreadable record folds against what we have, which is the safe direction */
        }
        const producerId = runId || entry.run_id;
        let producer = current;
        if (producerId !== entry.run_id) {
          try {
            producer = dispatchRuns.readJson(dispatchRuns.runPaths(home, producerId).record) || {};
          } catch {
            producer = {};
          }
        }
        const pinned = gateRunner.pinCandidate(record, integration.targetRef, {
          change,
          repo: record.item_repo || entry.project || slug || null,
          nodeId: entry.node_id,
          submittedBy,
          provenance: {
            run_id: producerId,
            attempt: current.impl_attempt || 1,
            // An integration fix cycle spends the integration gate's own
            // `cycles`, never one of the two code pools makeGateDeps' version
            // accounts for — see that closure's own comment for the pool rule
            // this mirrors.
            pool: null,
            harness: producer.harness || null,
            profile: (passthrough && passthrough.profile) || null,
            agent: dispatchAgentId(cfg),
            worker: workerId || null,
            machine: os.hostname(),
            started_at: producer.started_at || producer.launched_at || producer.created_at || null,
            finished_at: producer.finished_at || null,
          },
          resolver: {
            node: producer.resolved_by || null,
            written: !!producer.resolved_by,
            resolves_edge: producer.resolved_edge === "resolves" || producer.resolved_edge === "answers",
          },
        });
        if (!pinned.ok) return pinned;
        const folded = candidateKernel.repinCandidate(current.impl_candidate || null, pinned.candidate);
        // Same settled-record race makeGateDeps' own pinCandidate guards against
        // (issue-spor-pin-candidate-settled-record-stamp-race): the gate
        // pipeline's opening read is fail-soft, so a factory can reach
        // integration having never successfully pinned anything — a late or
        // racing first pin from HERE then arrives at a record whose `impl_state`
        // was already settled through a path that never pinned a candidate at
        // all (two workers adopting one orphaned pipeline; the winner's
        // `exhausted` lands via stampImplState directly). Refuse the whole
        // stamp rather than only the `impl_state` key: a genuine re-pin after
        // settling (`folded.change` "seen"/"unchanged"/"superseded") still must
        // land — only a "created" event reaching an already-settled record is a
        // submission that never actually happened.
        if (folded.change === "created" && candidateKernel.implSettled(current.impl_state)) {
          warn(`warning: pinCandidate refusing a late first-pin stamp on ${entry.run_id} — impl_state already settled (${current.impl_state})`);
          return { ok: true, candidate: current.impl_candidate || null, change: "refused-settled" };
        }
        const patch = {
          impl_candidate: folded.candidate,
          impl_candidates: candidateKernel.appendCandidateChain(current.impl_candidates, folded.candidate),
        };
        // Ordinarily `impl_run_id`/`impl_attempt`/`impl_pool`/`impl_state` name
        // the IMPLEMENTATION stage's own submission and are stamped once by
        // makeGateDeps' pinCandidate at the gate pipeline's own (unconditional)
        // opening read — `stampImplState` merges additively, so leaving them
        // out of every OTHER re-pin here never clobbers what that pin wrote.
        // But that opening read is itself fail-soft (a dirty/unreadable tree
        // just logs and the gate pipeline proceeds regardless), so a factory
        // can reach integration having never successfully pinned anything.
        // `folded.change === "created"` is exactly that case reached from here
        // instead: THIS is now the first-ever pin, so it must stamp the same
        // fields the gate version's own `created` branch does, or they would
        // stay unset forever even once `impl_candidate` exists.
        if (folded.change === "created") {
          patch.impl_run_id = entry.run_id;
          patch.impl_attempt = current.impl_attempt || 1;
          patch.impl_pool = "implementation";
          patch.impl_state = candidateKernel.candidateSubmitted(folded.candidate) ? "candidate" : "running";
        }
        const stamped = dispatchRuns.stampImplState(home, entry.run_id, patch);
        // See makeGateDeps' own pinCandidate above
        // (issue-spor-pin-candidate-silent-stamp-failure): a null return means
        // the write did not land, and that must surface as a refusal rather
        // than a silent ok:true — the caller's `pin` wrapper already logs
        // `reason` and judges the tree regardless.
        if (!stamped) return { ok: false, reason: `the candidate for ${entry.node_id} was pinned but could not be stamped onto its run record` };
        return { ok: true, candidate: folded.candidate, change: folded.change };
      },
      // The TIP candidate as the run record reads NOW (task-spor-integration-
      // builds-candidate-from-pinned-commit): every pin the gate pipeline made
      // — its opening one, each fix cycle's, a rescue's — landed on disk AFTER
      // this closure's `record` was captured, so the captured copy is the
      // fallback, never the source of truth. `null` means nothing was ever
      // pinned and the branch head is integrated exactly as it always was.
      tipCandidate: async () => {
        let current = record;
        try {
          current = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record) || record;
        } catch {
          /* an unreadable record falls back to the captured copy, which is the safe direction */
        }
        return (current && current.impl_candidate) || null;
      },
      // The git facts behind the §4.2 M1 reading; the judgement is the runner's.
      // `top` is whatever `changedTree` last resolved — the implementer's own
      // checkout, which is where the pinned commit lives.
      candidateStanding: async ({ top: from, head, commit, tree }) => integrationRunner.candidateStanding({ top: topFor(from), head, commit, tree }),
      acquireLease: () => acquireIntegrationLease(cfg, home, topFor(null), { slug }),
      releaseLease: (token) => releaseIntegrationLease(cfg, token),
      // A candidate worktree a DEAD worker built: its cleanup closure died
      // with it, so the resumed workflow tears it down by path.
      discardCandidate: ({ top: from, dir }) => integrationRunner.discardCandidateTree({ top: topFor(from), dir }),
      buildCandidate: async ({ top: from, head, targetRef, strategy, mode }) => {
        const at = topFor(from);
        const built = integrationRunner.buildCandidateTree({
          top: at, head, targetRef, strategy, mode, label: entry.node_id,
          teardown: (dir) => teardownThrowawayTree(dir, at, { slug, nodeId: entry.node_id, role: "integration", warn }),
        });
        if (!built.ok) return built;
        // Same staging the command gate's tree gets (stageThrowawayTree): the
        // candidate suite runs here, and a repo whose suite needs a hook-staged
        // dependency must not fail its own landing on a bare checkout.
        const staged = stageThrowawayTree(built.dir, at, { slug, nodeId: entry.node_id, what: "integration candidate", role: "integration" });
        if (!staged.ok) {
          built.cleanup();
          return { ok: false, reason: staged.reason };
        }
        return built;
      },
      forceProtected: ({ top: from, dir, sha, base }) => {
        const at = topFor(from);
        // Pin the trusted ref to ONE commit before touching the tree, and force
        // from that sha — never from the symbolic ref, which can advance between
        // this restore and the attestation naming it (cross-model review, major
        // finding 5). An unresolvable ref refuses the stage rather than forcing
        // from whatever the ref means by the time checkout runs.
        const pin = git(at, ["rev-parse", "--verify", `${factory.trustedRef}^{commit}`]);
        const trustedSha = pin.status === 0 ? (pin.stdout || "").trim() : null;
        if (!trustedSha) return { ok: false, reason: `the trusted ref '${factory.trustedRef}' does not resolve to a commit in ${at}, so the candidate's protected paths cannot be pinned to it` };
        // A `ci` candidate suite also pins the CI definition to the trusted
        // copy (gates.suiteProtectedPaths): CI must not judge the candidate
        // with a workflow the candidate wrote.
        const protectedPaths = gatesKernel.suiteProtectedPaths(integration, factory.protectedPaths);
        // ...and a candidate that EDITS the CI definition is refused, never
        // quietly reverted: forcing it back would land (or propose) a change
        // with its workflow edit silently dropped. A command gate refuses the
        // same edit up front for its own ci suite; this is the integration
        // stage's twin, for a factory whose gates run locally.
        if (integration.ci && base) {
          const touched = git(dir, ["diff", "--name-only", "--no-renames", base, sha], { maxBuffer: 64 * 1024 * 1024 });
          if (touched.status !== 0) return { ok: false, reason: `could not read which paths the candidate changes, so its CI definition cannot be checked: ${(touched.stderr || "").trim().split("\n")[0] || "git diff failed"}` };
          const hits = gatesKernel.matchPaths((touched.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean), gatesKernel.CI_PROTECTED_PATHS);
          if (hits.length) {
            return { ok: false, reason: `the candidate changes the CI definition that would judge it (${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` +${hits.length - 5} more` : ""}); a ci candidate suite is never run from a change that edits it — land the CI change on its own` };
          }
        }
        const forced = gateRunner.forceProtectedPaths({ top: at, dir, trustedRef: trustedSha, protectedPaths });
        if (!forced.ok) return forced;
        // The restore above only touches the candidate worktree's WORKING
        // DIRECTORY — `sha` still names the pre-restoration commit. Landing it
        // as-is would ship the tampered protected-path edits the restore is
        // meant to strip (issue-spor-integration-landed-sha-pre-restoration), so
        // re-commit when the restore actually changed anything and land that
        // sha instead; a no-op restore returns `sha` unchanged. `base` lets it
        // also see the EARLIER commits the landing makes reachable (a rebase's
        // replayed chain, a merge's second parent) and collapse them when one
        // touched a protected path
        // (issue-spor-integration-rebase-intermediate-protected-paths).
        const reconciled = integrationRunner.reconcileCandidateSha({
          dir, sha, base, protectedPaths,
          message: `Integrate ${entry.node_id} onto ${integration.targetRef}`,
        });
        return reconciled && reconciled.ok ? { ...reconciled, trusted_sha: trustedSha } : reconciled;
      },
      runSuite: async ({ top: from, dir, base, head, attempt = 1 }) => {
        const at = topFor(from);
        const runLocal = () =>
          gateRunner.runGateCommand({ id: "integration", command: integration.command, timeoutMs: integration.timeoutMs }, dir, {
            env: {
              ...worktreeDeclaredEnv(dir),
              SPOR_GATE_STAGE: "integration",
              SPOR_GATE_BASE: base || "",
              SPOR_GATE_HEAD: head || "",
              SPOR_TRUSTED_REF: factory.trustedRef,
              SPOR_GATE_NODE: entry.node_id || "",
              SPOR_GATE_ATTEMPT: String(attempt),
            },
          });
        if (!integration.ci) return runLocal();
        // A `ci` candidate suite (dec-spor-command-gate-ci-mode): the merged
        // candidate `head` (protected paths already forced and re-committed by
        // forceProtected) is pushed once per candidate and its CI run is the
        // verdict; a rerun re-runs that same CI run. `local_fallback` runs the
        // suite here instead when CI cannot be reached.
        if (!ciSuite || ciSuite.head !== head) {
          if (ciSuite && ciSuite.handle.ok) await ciSuite.handle.close();
          const handle = await ciGate.openCiSuite({
            top: at, sha: head, branch: gatesKernel.ciCandidateBranch(entry.node_id, "integration"), ci: integration.ci,
            timeoutMs: integration.timeoutMs, label: `CI workflow \`${integration.ci.workflow}\` for the integration candidate`, log,
          });
          ciSuite = { head, handle, unreachable: handle.ok ? null : handle.reason };
        }
        let r = ciSuite.unreachable ? ciSuite.handle : await ciSuite.handle.run(attempt);
        if (r && r.outage && integration.ci.localFallback) {
          const why = (r.outage && r.outage.reason) || r.reason;
          log(`work: the integration candidate's CI could not be reached (${why}); running the suite on this box under local_fallback`);
          r = { ...(await runLocal()), fallback: why };
        }
        return r;
      },
      closeSuite: async () => {
        if (ciSuite && ciSuite.handle.ok) await ciSuite.handle.close();
        ciSuite = null;
      },
      land: (args) => integrationRunner.landCandidate(args),
      // The PR body carries the run's attestation (task-spor-factory-gate-
      // attestation, piece 4): the gate verdicts as they stand, bound to the head
      // being proposed, with the candidate suite the stage just ran. Built here
      // rather than in the pure runner because it needs the gate pipeline's
      // result (ctx.gateResult) and the environment, which the stage never sees.
      // A PR that cannot carry its attestation is NOT opened (cross-model
      // review, major finding 5): the attestation-bearing body is the contract
      // a PR-policy repo's CI validates, and a PR opened with a generic body
      // would pass through that repo's merge queue with nothing to check. A
      // body that cannot be built is a failed proposal, which the stage
      // routes like any other failure (§10.9) — never a silent downgrade.
      propose: ({ top: from, head, targetRef, chain = null }) => {
        const at = topFor(from);
        let body = null;
        try {
          body = buildBody({
            cfg, entry, factory, slug, workerId, top: at, head, targetRef, chain, integration,
            gate: currentGate() || { state: "passed", gates: [], facts: [], definition: factory.definition || null },
          });
        } catch (e) {
          const reason = `the attestation for the pull request body could not be built (${(e && e.message) || e}) — a proposal must carry its attestation, so no PR was opened`;
          log(`work: ${reason}`);
          return { ok: false, reason };
        }
        if (!body) return { ok: false, reason: "the attestation for the pull request body was not built — a proposal must carry its attestation, so no PR was opened" };
        // `chain.targetSha` is target_ref's tip AT PROPOSE TIME (the candidate
        // build resolved it fresh, before this PR ever opened) — carried on the
        // returned proposal so parkForReview can stamp it durably, since it is
        // the one fact reconcileAfterProposalLanded needs later and has no other
        // way to recover once this run's implementer worktree is gone.
        return { ...proposePR({ top: at, head, targetRef, body }), targetSha: (chain && chain.targetSha) || null };
      },
      parkForReview: async ({ proposal }) => {
        const id = proposalTrackingId(entry.node_id, entry.run_id);
        const written = await writeGateNode(
          cfg,
          id,
          buildProposalTrackingNode({ id, nodeId: entry.node_id, runId: entry.run_id, targetRef: integration.targetRef, proposal, project: slug, date: date() })
        );
        // Stamped BEFORE gate_state becomes "parked" (the caller writes that
        // right after this pipeline settles) — a proposal's own open/landed/
        // closed lifecycle can never live in a stamp AFTER settlement
        // (stampGateState refuses to touch a record whose gate_state already
        // reads a SETTLED_GATE_STATES value), so every field checkProposals
        // needs later is captured here, in the one window before it does.
        // Through the pipeline's OWNED door (issue-spor-gate-stamps-bypass-
        // lease-owner): it lands only while this driver still holds the
        // lease, so a driver displaced by a takeover parks nothing onto the
        // new holder's record — the throw reads as a tracking item that could
        // not be filed, and this driver's settle is refused the same way.
        //
        // Stamped regardless of `written.ok`
        // (issue-spor-integration-park-orphan). The pull request already exists
        // by the time this runs (deps.propose already opened it), so
        // gate_proposal_number is the durable fact "there is a PR to check",
        // and it must never become unreachable just because the tracking-node
        // write above hit a transient failure. `id` is deterministic
        // (proposalTrackingId), so checkProposals can always find/recompute it
        // and heal a tracking item that never actually landed on the graph.
        //
        // `gate_proposal_repo_dir` and `gate_proposal_target_sha` are what
        // task-spor-propose-mode-post-land-reconcile's checkProposals pass needs
        // once the PR merges: the run's own implementer worktree (record.cwd) is
        // removed by cleanupImplementer right after this park() returns, so the
        // durable main checkout it belongs to (mainCheckoutOf) — and target_ref's
        // pre-propose tip, before any of this PR's own commits landed on it —
        // must be captured in this same window or never at all.
        stampPipelineLaunch(home, entry.run_id, launchOwner, {
          gate_proposal_number: proposal.number || null,
          gate_proposal_repo: proposal.repo || null,
          gate_proposal_url: proposal.url || null,
          gate_proposal_branch: proposal.branch || null,
          gate_proposal_target_ref: integration.targetRef,
          gate_proposal_target_sha: proposal.targetSha || null,
          gate_proposal_repo_dir: (record && record.cwd && mainCheckoutOf(record.cwd)) || null,
          gate_proposal_strategy: integration.strategy,
          gate_proposal_blocker: id,
          gate_proposal_project: slug || null,
          gate_proposal_factory: factory.id || null,
        });
        return { ...written, id };
      },
      fix,
      dispatchFix,
      awaitRun,
      // A fix cycle moved the implementer's head: the stage hands it back to the
      // gate pipeline before anything at that head can land (review finding 2).
      // Wired by runGateAndIntegration, which owns the pipeline's result.
      ...(typeof regate === "function" ? { regate } : {}),
      recordFact: ({ id, markdown }) => writeGateNode(cfg, id, markdown),
      cleanupImplementer: async () => {
        const dir = record && record.cwd;
        if (!dir) return;
        const common = (git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout || "").trim();
        const repoDir = common ? path.dirname(common) : null;
        if (!repoDir || path.resolve(repoDir) === path.resolve(dir)) return; // the main checkout, not a dispatch worktree — nothing to remove
        removeDispatchWorktree(repoDir, dir, path.basename(dir));
      },
      // Post-completion integration (FACTORY-IMPLEMENTATION-STAGE.md §4.2 C3-C4):
      // under `completion.after: gates` the item was completed BEFORE this stage
      // ran, so a failure here never demotes it — a completed item has nothing
      // to block — and its escalation `relates-to` the work item instead.
      demote: ({ blockerId }) =>
        completedBeforeIntegration
          ? Promise.resolve({ ok: true, demoted: false, note: `${entry.node_id} was completed at the 'gates' boundary and stays completed; the landing is left for a person (${blockerId})` })
          : gateDemoteItem(cfg, entry.node_id, { blockerId }),
      escalate: async ({ attempts, detail, evidence, kind = null, fixCycles = null }) => {
        const id = `task-integration-${stem}-${short}-${gateIdSuffix("integration-escalate", "integration", entry.node_id, runKey)}`.toLowerCase();
        // A lost CAS race is nobody's fix cycle (integration-runner.js never
        // charges it against the cap), so it must not be counted as one here —
        // an escalation reading "5 attempts, cap 0" after 5 races and zero real
        // fixes would mislead whoever triages it about what actually happened.
        const raced = attempts.filter((a) => a.verdict === "race").length;
        const cycles = attempts.length - raced;
        // A `mismatch` did not spend its fix cycles — it refused the candidate
        // rather than failing to land it (task-spor-integration-builds-
        // candidate-from-pinned-commit) — so it says exactly that rather than
        // borrowing the spent-cycles wording. It can still arrive MID-pipeline:
        // the drift is re-checked after every fix cycle's re-pin, so the cycles
        // spent BEFORE the drift are reported beside it, or the escalation would
        // claim nothing was spent directly above an `Attempts:` list saying
        // otherwise.
        //
        // The count is the runner's OWN charged-cycle counter (`fixCycles`),
        // never `attempts.length`: the attempt list is not a cycle log — a
        // rerun-rescued suite pass pushes an entry of its own — so inferring it
        // from the list over-reports, and past a couple of reruns prints a
        // number above the declared cap. An older caller that sends no count
        // falls back to the inference rather than claiming zero.
        const mismatchCycles = kind !== "mismatch" ? cycles : Number.isFinite(fixCycles) ? Math.max(0, fixCycles) : Math.max(0, cycles - 1);
        const why =
          kind === "mismatch"
            ? `the branch no longer carries the candidate its gates judged, so there is nothing safe to land${
                mismatchCycles ? ` (found after ${mismatchCycles} fix cycle${mismatchCycles === 1 ? "" : "s"}, cap ${integration.cycles})` : ""
              }`
            : cycles
            ? `its fix cycles are spent (${cycles} attempt${cycles === 1 ? "" : "s"}, cap ${integration.cycles})`
            : `it lost the landing race ${raced} time${raced === 1 ? "" : "s"} in a row`;
        const body = [
          `The integration stage could not land ${entry.node_id} onto \`${integration.targetRef}\` — ${why}. A person`,
          "decides what happens next — the worker has stopped retrying it.",
          "",
          ...(completedBeforeIntegration
            ? [
                `This item \`relates-to\` ${entry.node_id}, which was COMPLETED at the factory's 'gates' boundary before this`,
                "stage ran and stays completed — the operator chose to release dependents before the change is on the",
                kind === "mismatch"
                  ? "target ref. The gates passed on the previously pinned candidate; the current branch has not been accepted."
                  : "target ref. Every declared gate already passed; only the merge-queue landing itself is unresolved.",
              ]
            : [
                `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
                kind === "mismatch"
                  ? "completion status the worker rolled it back. The gates passed on the previously pinned candidate; the current branch has not been accepted."
                  : "completion status the worker rolled it back. Every declared gate already passed; only the merge-queue landing itself is unresolved.",
                "The run's resolver is left standing.",
              ]),
          "",
          detail ? `Last outcome: ${detail}` : "",
          "",
          ...(evidence ? ["Evidence:", "", "```", fenceSafe(String(evidence).slice(0, 3000)), "```", ""] : []),
          ...(kind === "mismatch"
            ? [
                mismatchCycles
                  ? `Nothing was landed: ${mismatchCycles} fix cycle${mismatchCycles === 1 ? " ran" : "s ran"} and the drift was found on the re-check after${
                      mismatchCycles === 1 ? " it" : " them"
                    }, so the`
                  : "Nothing was built and nothing was landed: the stage refused before it cut a candidate worktree, so the",
                "candidate itself was never judged again and no further cycle or budget was spent on it. Re-pin the",
                "candidate (re-run the item) or restore the branch to the commit named above, then re-judge with",
                `'spor work --regate ${entry.run_id}'.`,
                "",
              ]
            : []),
          ...(attempts.length > 1 ? ["Attempts:", ...attempts.map((a, i) => `${i + 1}. ${a.verdict} — ${String(a.detail || "").slice(0, 200)}`), ""] : []),
          `The run's own record is \`${entry.run_id}\` ('spor runs ${entry.run_id}').`,
        ]
          .filter((l) => l !== "")
          .join("\n");
        return writeGateNode(
          cfg,
          id,
          buildGateWorkNode({
            id,
            title: kind === "mismatch" ? `Integration mismatch — ${entry.node_id} drifted off its candidate` : `Integration escalation — could not land ${entry.node_id}`,
            summary:
              kind === "mismatch"
                ? `The integration stage refused to land ${entry.node_id} onto ${integration.targetRef}: the branch no longer carries the candidate its gates judged; it needs a person${detail ? `: ${String(detail).slice(0, 200)}` : "."}`
                : `The integration stage could not land ${entry.node_id} onto ${integration.targetRef} after ${attempts.length} attempt(s); it needs a person${detail ? `: ${String(detail).slice(0, 200)}` : "."}`,
            body,
            project: slug,
            date: date(),
            requiresHuman: true,
            edges: [{ type: completedBeforeIntegration ? "relates-to" : "blocks", to: entry.node_id }],
          })
        );
      },
      log,
    };
  }

  return { makeGateDeps, makeIntegrationDeps };
}

module.exports = { createGateDeps, stampPipelineLaunch, HOST_FUNCTIONS, FLAKE_ID_RUNGS };
