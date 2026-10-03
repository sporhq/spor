// shell/implementation-stage.js — the IMPLEMENTATION STAGE runner's door: the
// loop that spends the attempt budget and the infrastructure retry pool
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
// The stage's control flow is `implementationWorkflow` in
// implementation-workflow.js — one deterministic function of (input, journal)
// over lib/kernel/workflow.js (task-spor-implementation-stage-as-workflow-
// function, the third per-stage slice of the gate-pipeline rewrite). This
// module is its driver's door, kept under the name and contract every caller
// and test already uses: dependency-injected like gate-runner.js and
// integration-runner.js — every side effect (the dispatch, the run-record
// stamps, the graph writes, the clock) comes in through `deps`, so
// test/gate-pipeline.test.js drives every row with a fake dispatcher and no
// harness. The re-dispatch is a run NAMED `impl-<short>-<attempt>`
// (shortRunAttempt's key, the convention the fix cycle and the rescue lane
// already adopt by) so a worker killed between the launch and its durable
// record ADOPTS the run on resume instead of dispatching a second implementer
// into one checkout.
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
// A factory that declares no `implementation:` block never enters the
// workflow — the caller gates on it — so the shipped pipeline is byte-identical.
"use strict";

const workflow = require("./implementation-workflow.js");

// The stage. `item` is the pipeline entry (`run_id`, `node_id`, `attempt`),
// `record` the implementer's run record as the loop harvested it, `factory`
// the parsed definition (its `implementation` block must be non-null — the
// caller gates on it), `deps.workflowJournal` (optional) the durable journal
// handle the workflow replays over. Returns one of:
//   {state: "candidate"}   — hand to the gates (the segment's last entry is
//                            settled `candidate`); `handoff` names the reading
//                            the pipeline settles itself, when there is one
//   {state: "declined"}    — I6: triage, no gate, no escalation
//   {state: "exhausted"}   — I11: the code pool is spent; escalated
//   {state: "escalated"}   — I8: the retry pool is spent — or the stage could
//                            not go on for a reason that is not the code's (a
//                            run this box could not follow to its end, a
//                            ledger it could not stamp, a segment with no
//                            attempt at all, a definition edited mid-attempt);
//                            escalated, the reason naming which
//   {state: "unroutable"}  — I2 on a re-dispatch: refused before any run
//                            record; nothing judged, the caller clears the hold
//   {state: "interrupted"} — the worker was asked to stop; the ledger is left
//                            for a resume to pick up
// every one carrying `attempts` (the current segment) and `reason`.
function runImplementationStage(args) {
  return workflow.driveImplementationStage(args);
}

module.exports = {
  runImplementationStage,
  implRunName: workflow.implRunName,
  STAGE_ITERATION_CAP: workflow.STAGE_ITERATION_CAP,
};
