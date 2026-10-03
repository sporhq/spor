# Spike — the gate pipeline as a durable workflow (Temporal / Restate / js-wf)

`task-spor-gate-orchestration-durable-workflow-spike`, 2026-09-29. Time-boxed
to one session. Outcome recorded as
`dec-spor-gate-pipeline-durable-workflow-model-zero-dep-kernel-first`.

**Question.** The gate pipeline (`spor work --factory`: implement → gates →
fix cycle → rescue → integration → completion, WORKERS.md §10) is a
hand-rolled durable workflow engine whose failure modes keep costing slots,
debts and attestations. Would modelling it as a durable workflow — exactly-once
recorded activities, durable timers, signals, re-execution from a journal — on
Temporal, Restate or js-wf remove that class of defect, and what would still
have to be written by hand?

**Answer in one paragraph.** The pipeline's control flow fits the model
exactly, and fitting it is what removes the *durability* defect class: the
control flow is one deterministic function of ~300 lines
(`pipeline.workflow.js` — the rules, not every edge of them; see Limits), and
every resume/park/adopt/orphan/`gate_state`/`gate_progress`/stale-worker
mechanism in the shipped runner disappears because the journal *is* the
progress and re-execution *is* the resume. The shipped ~12k lines are NOT
mostly that machinery: they are dominated by the judgement and side-effect
code that stays. What stays bespoke is exactly the activities table at the
bottom of that file — 13 side-effecting activities on git, the graph and the
harnesses, plus two signal sources — and every one of them must be idempotent
under a stable key, because no engine (not Temporal, not Restate, not js-wf)
makes an effect run once; each journals the *result* once and documents "make
your side effects idempotent". The spike tests that both ways: with
adopt-by-name in the dispatch activity a crash in the execute-then-journal
window launches nothing extra; without it, it launches a second reviewer. None of the three can host this for Spor today without a
structural change: the orchestrator runs in the zero-dependency client, in
local mode as well as remote, so an external engine can only ever host the
remote/fleet half from `spor-server`. The recommendation is therefore to adopt
the **programming model** now — a ~300-line zero-dep replay kernel in the
client whose journal is stored in the execution store that already exists —
and to keep Restate as the preferred engine for a later server-hosted fleet
tier, with js-wf revisited when it grows a non-Go invocation surface.

## What is here

| file | what |
|---|---|
| ~~`harness.js`~~ | PROMOTED to `lib/kernel/workflow.js` (task-spor-gate-pipeline-as-workflow-kernel): the smallest durable-workflow runtime exhibiting the model the three engines share — replay from a journal, keyed activities (`ctx.run`), journaled clock, durable timers (`sleepUntil`), signals with deadlines (`awaitSignal`), a crash plan for the at-least-once window, a `drive()` loop standing in for an engine's worker — now shipped, versioned, with an injected `persist` seam the execution store binds (`openWorkflowJournal`). The proofs below run against the shipped kernel. |
| ~~`pipeline.workflow.js`~~ | DELETED (task-spor-delete-loop-resume-machinery-after-workflow-stages). The gate pipeline as one deterministic workflow function is now SHIPPED, stage by stage, over the kernel above: `lib/shell/integration-workflow.js` (task-spor-integration-stage-as-workflow-function), `lib/shell/gate-workflow.js` (task-spor-gate-list-as-workflow-function) and `lib/shell/implementation-workflow.js` (task-spor-implementation-stage-as-workflow-function), with the driver half they share in `lib/shell/stage-workflow.js`. The spike's single-function sketch would have drifted from them, so it is gone. |
| ~~`spike.test.js`~~ | DELETED with it. Every proof below is held by a shipped test over the real workflows: `test/workflow-kernel.test.js` (the kernel's contract), `test/integration-workflow.test.js`, `test/gate-workflow.test.js` and `test/implementation-workflow.test.js` (each stage's crash sweep over every activity boundary, the worker-dies-mid-run proof, the pure replay, the yields and durable timers, the refusal through the tombstone door), `test/dispatch-adopt-by-name.test.js` (adopt-by-name at the dispatch door), `test/stage-workflow.test.js` (the shared driver half). |

The directory is outside `package.json` `files` and outside every lint walk
(`test/frontmatter-lint`, `config-keys`, `record-write-lint` scan `lib`,
`bin`, `scripts`, `adapters`, `skills`, `conformance`), so it adds nothing to
the published client and can be deleted once the decision is acted on.

## What the proofs showed

(Historical — the proofs now live in the shipped tests named above; this is
the record of what the spike established and why.)

1. **Happy path**: every activity executes exactly once; replaying the journal
   through a fresh execution whose activities all throw reproduces the result
   byte-for-byte. The journal alone is the pipeline's state.
2. **Crash sweep**: a crash at *every* activity boundary of the happy path
   (before executing, after executing but before journaling, after journaling —
   3 × N cases) resumes to the identical result AND the identical side effects
   (same graph node set, same number of agent runs launched). Only the
   before-journal window re-executes anything, and it re-executes exactly one
   activity — the at-least-once window the activity absorbs by its own
   idempotency (`if_exists: skip` for graph writes, adopt-by-name for a
   dispatch). This is the structural version of
   issue-spor-gate-evidence-pending-interrupted-drops-slot-and-attests and of
   the "state loss on restart" arm of
   issue-spor-gate-pipeline-durability-concurrency.
3. **The negative**: the same crash on a dispatch WITHOUT adopt-by-name
   launches a second reviewer whose terminal signal is orphaned. The model
   narrows duplicate dispatch to one window; closing it is the activity's
   job, and the shipped adapters already do it (`adopted by name on resume`).
4. **Worker death mid-review**: execution 1 dispatches a reviewer and dies
   parked on its terminal signal; execution 2 over the same journal awaits the
   *same* run and never dispatches a second. No orphan adoption, no
   "deferred while a live run exists", no `gate_state`. This is the "duplicate
   dispatches" arm of issue-spor-gate-pipeline-durability-concurrency.
5. **Fix cycle → gate-0 restart → rescue**: a moved head restarts the list with
   each gate's ledger and spent cycles intact (a variable rebuilt by replay —
   the shipped `gate_progress` save-before-dispatch/reload-on-resume dance is
   gone); the suite re-runs at every moved head; cycles spent, the rescue runs
   once; superseded facts keep their own ids.
6. **Rescue budgets**: after the rescue each gate gets a fresh fix-cycle budget
   with the ledger carried; a refusal after the last rescue escalates.
7. **Reviewer outage = durable pause**: an `infrastructure` outcome with a
   stated reset becomes a timer that fires at the reviewer's own reset, the
   workflow suspends holding nothing, charges no fix cycle (it spends the
   shared retry pool), writes no verdict fact for the pause, and re-dispatches
   once when the clock passes it
   (issue-spor-codex-usage-limit-outage-read-as-a-code-failure's second half,
   issue-spor-integration-regate-misreads-reviewer-pause — a paused review
   inside integration's re-gate is the same `sleepUntil`, because the re-gate
   is literally a re-entry of the same function under a child key namespace).
8. **Outage bounds**: a reset beyond `pause_max_ms` and a spent retry pool
   both go to a person with an `infrastructure` gate fact and no rescue; the
   implementer's outages draw on the SAME pool as the reviewer's; an
   implementer that is out forever is bounded by the pool, never a loop.
9. **Human gate**: approval/refusal/timeout, deadline as a durable timer, the
   approval item filed once under its deterministic id; a timeout decides
   nothing for the person but still demotes the item (§10.7).
10. **Integration**: two lost CAS races retried uncharged; a conflict spends a
    fix cycle and re-gates the moved head under `run#regate1/…` keys over the
    parent's shared state — the re-gate's review fix is the second of a
    cumulative cap of two, the implementer is not re-dispatched, and the one
    attestation lists the re-gate's facts.
11. **Protected path** (glob-matched) fails closed before the suite,
    unrescued; escalation and demotion land once.
12. **The activities table is total**: every `ctx.run` in the workflow names a
    row, every row is invoked.

## Which shipped defects the MODEL removes, and which it does not

The relates-to edges on the task were read one by one.

| node | lived in | under the model |
|---|---|---|
| issue-spor-gate-pipeline-durability-concurrency — unpersisted gating state, duplicate dispatch, orphan adoption race, `stampGateState` clobber | control flow (+ one activity) | **gone** for state and adoption: journal is state; a dispatch is journaled before it is awaited; ownership of a journal is the engine's lease, not a per-record lock protocol. Duplicate dispatch is **narrowed** to the execute-then-journal window, which the dispatch activity's adopt-by-name closes (proof 3 shows both sides) |
| issue-spor-gate-evidence-pending-interrupted-drops-slot-and-attests | control flow | **gone**: there is no "interrupted" result and no slot — a pending evidence write is an activity that has not returned |
| issue-spor-integration-regate-misreads-reviewer-pause | control flow | **gone**: a pause is `sleepUntil` wherever it happens, and re-gate is re-entry |
| task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-reviewer | control flow + activity | pause/timer half gone; **the reset-hint parsing and the fallback-reviewer routing stay bespoke** (they are what the `dispatchReview` activity and the `run:<id>` signal carry) |
| issue-spor-codex-usage-limit-outage-read-as-a-code-failure | activity | **stays**: `failureFromEvent` / `TERMINAL_SIGNATURES` classification of a harness stream is the supervisor's, and it feeds the signal payload; the engine only makes the *consequence* (pause vs charge) durable |
| issue-spor-gate-attestation-defects — unsigned offline verify, size fallback, mutation-before-CAS | activity | verify and size fallback **stay**; "losing worker commits irreversible mutations before the settle CAS" is **narrowed**, not gone: a journal has one owner per lease, so two pipelines never run one item concurrently by design — but every engine here re-runs an activity whose worker lost its lease mid-flight, so the settle CAS and the `if_exists: skip` read-back stay in the activities |
| dec-spor-server-storage-split-plane-nats | infrastructure | unchanged; see js-wf below |

The honest reading: the *durability* class (about 60% of the seven relates-to
by count, more by re-filings) is control-flow and disappears; the *judgement*
class (what a stream means, what an attestation must carry, what an id must
compare) is activity code and no engine touches it.

## The three candidates

All three share the model the harness exhibits; they differ in who runs the
function, where the journal lives, and what it costs Spor to get there.

**Temporal.** The mature choice: Temporal Service (its own cluster plus a
persistence store — Cassandra/MySQL/PostgreSQL; a SQLite dev server for local
use), TypeScript SDK running workflow code in a V8 isolate that *enforces*
determinism, activities with retry policies and heartbeats, signals/queries/
updates, durable timers, child workflows, continue-as-new, workflow versioning
(`patched()`), Temporal Cloud if self-hosting is unwanted. Costs for Spor: a
second stateful service beside NATS and git (cuts against turnkey self-hosting,
dec-cc-spor-self-hosting-first-class); `@temporalio/worker` carries a native
Rust core (`core-bridge`) in the runtime npm tree — clears DEPENDENCIES.md for
`spor-server` as protocol-correctness class, is unthinkable for the client;
the runner rewrite is the same one this spike did, so the rewrite is not the
objection, the operational footprint is.

**Restate.** A single Rust binary with embedded storage; services are ordinary
Node HTTP handlers that embed the TypeScript SDK and are *invoked by* the
Restate server; `ctx.run()` journals a side effect; `ctx.sleep()` is a durable
timer; awakeables are externally-resolved durable promises (= our signals);
virtual objects give keyed single-writer execution (= the per-item and
per-repo serialization `serialize: repo` and the execution store's fence buy
by hand today); invocation idempotency keys dedupe starts. Younger than
Temporal, materially lighter, and the shape closest to what
EXECUTION-STATE.md already specifies (one execution per item/factory/attempt,
fenced, event-keyed). Same constraint: server-side only, `spor-server`
dependency, its own vetting decision.

**js-wf** (the user's, https://github.com/antpallen/js-wf). Read 2026-09-29.
The primitives are the right ones — write-once starts, per-subject CAS
journal with replay and snapshots, KV-revision fencing leases, `wf.Run`
effects with stable dedup keys, durable `wf.Sleep`/`Timer`/`SelectSignal`,
signals, child workflows, reconcilers, offline `wf.Replay`, and real
three-node chaos proofs. It sits on the NATS JetStream/KV plane
dec-spor-server-storage-split-plane-nats already adopted, which is why it
looked like that decision's "first customer". Three things stop it hosting
this pipeline today, and the task's open questions answer themselves from the
README: (1) it is **Go-only with no non-Go SDK, protocol or activity-invocation
surface** — a JS worker SDK or a NATS-level activity protocol would have to be
built first; (2) hosting the workflow in a **Go sidecar** means a Go
re-implementation of the pipeline's control flow beside the Node one that
local mode still needs — a drifting twin, one of the fragility audit's seven
classes, introduced to fix another; (3) its own README says it is **not a
production-complete runtime** (metrics export, full scheduled-message recovery,
retention at scale, rebalancing outstanding) and it is single-maintainer. It
also documents the same at-least-once effect semantics as the other two, so
it removes nothing from the activities table. Verdict: not now; the moment it
is worth re-reading is when an activity can be invoked from Node over NATS
(the "activities invoked over NATS" option in the task) — that is the one
shape in which js-wf could own the fleet tier without a twin.

## Why none of them can be THE engine for Spor, and what can

The orchestrator is `spor work` in the client (`bin/spor.js` →
`lib/shell/work-loop.js` → `gate-runner.js` / `integration-runner.js` /
`implementation-stage.js`). It runs in personal/local mode with no server at
all, and the client is zero-dependency by hard rule. So whatever engine hosts
the fleet tier, **local mode needs a zero-dep replay engine anyway** — and the
harness in this directory is that engine, at ~300 lines with no fs. Building it
is not optional, so it is the first step under every branch of the decision,
and once it exists the external engine is a *journal store and scheduler*
choice for the remote tier, not a programming-model choice.

The task's named fallback — "a table-driven reducer with the transition table
as data and an event journal; `lib/kernel/execution.js` is halfway there" — is
subsumed rather than competing. `execution.js` is a *reducer over events*: a
read model / write gate the server enforces (`boundaryReached`, the fence
arithmetic). What it cannot be is the *driver*: a transition table does not
express "await this run, then sleep until the reviewer's reset, then re-enter
the gate list at gate 0 keeping each gate's ledger" without re-growing the
per-failure-mode branches this task exists to remove. A workflow function
expresses it as control flow and the journal falls out of it. The two fit
together exactly: the workflow's effect keys ARE `execution.js`'s
`derivedEventKey` vocabulary (`<exec>:<gate>:<attempt>`, `:rescue:<n>`,
`:integration:<n>`, `:completion`), so the journal the harness appends to *is*
the event log the execution store already spools and replays, and the server's
reducer stays the projection the write gate reads.

## Recommendation (the decision node says this)

1. **Adopt the durable-workflow programming model in the client now.** Promote
   the harness shape to `lib/kernel/workflow.js` (pure: replay, keyed effects,
   journaled clock, timers, signals) with the journal persisted through the
   existing execution store (`journal/executions/<tenant>/` locally,
   `/v1/executions` events remotely — `lib/shell/execution-store.js`), and
   rewrite `runGateAndIntegration` + `runGatePipeline` + `runIntegrationStage`
   + the implementation stage as ONE workflow function. `gate-runner.js` is
   already dependency-injected (`deps.changedPaths`, `deps.pinCandidate`,
   `deps.dispatchReview`, `deps.writeFact`, …), so the migration is: wrap each
   `deps.*` call in `ctx.run(key, …)` with the deterministic id it already
   mints as the key; turn every `await run terminal` poll into a signal the
   supervisor delivers; turn every backoff/pause/approval wait into a timer or
   a deadline; then DELETE the resume machinery — `gate_state`'s transitional
   writes, `gate_progress` save/reload, `orphanedGateRuns`, `resumableSlots`,
   parked re-offers, `claimGateRecord`, the interrupted-result plumbing —
   because the engine's re-execution does all of it. The work loop shrinks to
   "drive every open journal; deliver signals; advance timers". (Done as of
   task-spor-delete-loop-resume-machinery-after-workflow-stages: the three
   stages are workflow functions, the loop's resume is `openPipelines` over
   the stage journals and the pipeline lease log, and the record keeps only
   the final verdict — WORKERS.md §10.8.)
2. **Do not adopt Temporal or js-wf now.** Temporal for footprint against
   turnkey self-hosting; js-wf for the three reasons above.
3. **Keep Restate as the preferred external engine for a server-hosted fleet
   tier**, if and when one is wanted (a fleet of worker boxes whose
   pipelines must survive the box). It is a `spor-server`-side dependency,
   clears DEPENDENCIES.md as protocol-correctness class, and needs its own
   vetting decision at that time. By then the workflow function exists and the
   activities are already keyed, so the port is the kernel's journal store,
   not the pipeline.
4. **Determinism discipline becomes a rule** the kernel enforces
   (NonDeterminism on an out-of-order key), and the workflow function is
   versioned: a journal recorded under one `workflow_version` is not replayed
   by another — the runner opens a new pipeline attempt (`--regate`'s existing
   meaning) instead. Pipeline attempts are hours to days long, so this is
   cheaper than Temporal-style `patched()` branches.
5. **The same kernel covers the other hand-rolled durable pieces** the task
   names — the capture spool/outbox with 429 backoff (a workflow per payload:
   `run(send)`; on 429 `sleepUntil(retryAfter)`), claim leases (a renew loop
   with a timer), command-gate CI waits (`awaitSignal(ci:<run>)` with a
   deadline). Their wave-three fixes should stay minimal, as the task says.

## What stays bespoke, regardless (the activities table)

From `pipeline.workflow.js` `ACTIVITIES`, each idempotent under its key:

- `readChange` — git head/base/paths vs the trusted ref; dirty/gone/empty.
- `pinCandidate` — the content-addressed candidate chain and publication.
- `runSuite` — worktree at the head, protected paths forced from the trusted
  sha, judge-scrubbed env, hook-free git, failing-file evidence; or push a
  candidate ref and read a CI run.
- `dispatchReview` / `dispatchFix` / `dispatchRescue` / `dispatchImplementer`
  — `spor dispatch` with posture translation, harness-flag filtering, and
  adoption-by-name so a re-executed dispatch finds its run instead of
  launching twice.
- `writeFact` — deterministic-id graph writes with `if_exists: skip` and
  read-back comparison (facts, rescue records, merge facts, completion
  resolvers, the attestation and its size ladder, digest and signature).
- `fileEscalation` / `demote` — the §10.7 fail-closed pair.
- `buildCandidate` / `landCAS` — merge strategies, CAS by `update-ref` or
  non-fast-forward push, `gh pr` in propose mode.
- `writeCompletion` — the one CAS put of the item; the server's fence check.
- Signals: the supervisor's terminal report (termination class, reset hint,
  UTC offset) and a person's approval edge.

Plus everything that classifies: what a harness stream means
(`failureFromEvent`, `TERMINAL_SIGNATURES`), what a review verdict says
(`foldFindings`), what an attestation must carry and how it verifies. The
engine makes their *consequences* durable; it does not make their *readings*
right.

## Limits of this spike

- The harness is synchronous and single-owner; it does not model leases,
  partitions or worker pools. That is on purpose — the question was whether
  the control flow fits, and those are the engine's business — but it means
  the ownership half of issue-spor-gate-pipeline-durability-concurrency is
  answered by "the engine leases the journal", not demonstrated here. The
  execution store's fence (`lib/kernel/execution.js` `ownershipLive`) is the
  local answer and already exists.
- The crash plan fires around activities only. Timer, clock and await
  appends are not crash-tested; the pipeline's happy path has no timers, so
  the sweep's "every boundary" is every ACTIVITY boundary.
- The pipeline function preserves the shipped rules but not every edge of
  them: no-code outcomes (§10.11), flake isolation and per-file issue
  filing, the candidate's `require_clean`, `ci` suite mode, propose mode's
  later PR poll, the fallback reviewer, escalation-retry payloads, the owed
  evidence a re-gate carries (7b6b4db). Each is more activity code or one
  more branch, not a different shape. Glob matching is a toy; the real one is
  `lib/kernel/coupling.js`.
- No engine was installed or benchmarked. Temporal and Restate facts are from
  their public documentation as of the spike date; js-wf from its README on
  2026-09-29. A fleet-scale proof is the follow-on the decision defers.
