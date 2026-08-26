// shell/work-loop.js — `spor work`, the pull-based continuous worker loop over
// the queue (task-spor-work-loop, derived-from dec-spor-software-factory-
// substrate).
//
// One command turns a box into a factory worker: poll the queue, pick the
// items this machine may actually run, dispatch each one under its routed
// profile, wait for its TERMINAL state, and go round again — bounded by a
// concurrency cap and an exponential backoff when there is nothing to do.
//
// PULL, not push. Nothing schedules this loop: it takes work. That is only
// collision-safe because the lease already makes it so (dec-cc-task-claim-
// lease) — a claim is a server-held lease with a nonce, so two workers racing
// for one node end with one claim and one 409, and a worker that dies drops
// its lease by lapsing. Capabilities stay machine-local facts (dec-spor-
// machine-profile-satisfiability): this box decides what it can run, and the
// fleet scheduler remains advisory, so an offline worker degrades to "work the
// queue with what I have" rather than stopping.
//
// It ADDS NO GUARDS. Every refusal — already-resolved, `requires: human`,
// profile unsatisfiable here, a graph-declared launch field, a same-machine
// duplicate, a lease held by someone else — is `spor dispatch`'s, reached by
// calling that exact code path per item (deps.dispatch). A refused item is not
// retried in a tight loop and not silently dropped either: it is remembered
// with the refusal's own first line as the reason and a cooldown, so the
// status surface says WHY this worker is not doing that piece of work, and a
// transient refusal (a lease that lapses, a profile that becomes satisfiable)
// is picked up on the next attempt rather than never.
//
// TERMINAL STATE is the run's, not the process's: the loop frees a slot when
// the run record goes terminal (dispatch-terminal.js has already filed the
// report and released or held the lease by then), never when a launcher
// returns. A supervised run is a DETACHED process that owns that contract
// itself, so a worker that stops while runs are in flight leaves them to
// finish and self-report — the loop's own exit is not an abort.
//
// GATES are optional and layer on top (task-spor-work-gate-pipeline): with no
// factory definition configured the loop runs BARE, exactly as it shipped —
// dispatch, await, repeat. When one resolves, `deps.gate` is present and a run
// that came back RESOLVED does not free its slot on that word alone: the gate
// pipeline (gate-runner.js) runs the declared command/agent-review/human gates
// against it first, and a failed or blocked gate cools the node off — AND
// demotes the item on the graph — instead of counting it done. The loop itself
// decides nothing about a gate — it holds the slot, folds the verdict into the
// status surface, stamps it on the run record, and cools the node; the pipeline
// owns the enforcement. Adoption therefore has no cliff in either direction: no
// factory, no behavior change at all.
//
// A gate pipeline is the ONE piece of work this process owns outright, so a
// worker that dies mid-pipeline abandons it — and the run it was judging is
// already terminal and already out of the queue, so nothing would ever come
// back to it. Hence the resume pass (step 3a, orphanedGateRuns): a gate-armed
// worker adopts the pipelines a dead worker on this box left unfinished before
// it takes new work.
//
// Plain Node, zero deps. Every side effect enters through `deps`, so the loop
// itself is drivable with a fake clock, a fake queue, and a fake dispatcher.
"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./atomic-write.js");
// The gate-state vocabulary is the pure gate module's, shared with the run
// journal that writes it (shell/agent-dispatch-runner.js) so the two layers —
// which never require each other — cannot drift apart on what "settled" means.
const gates = require("../kernel/gates.js");

// Defaults are also the documented config-cascade keys (`work.*`), so a
// service unit can be `spor work` with the tuning in .spor.json.
const WORK_DEFAULTS = Object.freeze({
  concurrency: 1,
  intervalMs: 30000,
  maxIntervalMs: 300000,
  retryAfterMs: 600000,
  max: 0,
  // How long a worker follows one run before giving up on ever seeing it end.
  // Only the watchdog case needs this (runHarvest) — a native-background run
  // whose harness cannot be enumerated never goes terminal at all. 24h matches
  // the run store's own staleness ceiling for a supervised run.
  runMaxMs: 86400000,
  // How long a terminal-but-unsettled record is allowed to hold its slot while
  // the supervisor finishes the terminal-state contract. That contract is three
  // bounded 5s round-trips at worst, so a minute is generous — and BOUNDING it
  // is the point: a supervisor killed inside that window leaves
  // `contract_pending` set forever, and its pid can be recycled, so an
  // unbounded hold is a slot held for the life of the worker.
  contractGraceMs: 60000,
  statusRetentionMs: 604800000, // 7d — a stopped worker's record is an audit trail, not state
});

// How many finished items the status surface keeps. The durable record of an
// outcome is the run record and the graph; this is the operator's recent view.
const RECENT_CAP = 20;
// And how many distinct cooling-off items to remember. Bounded so a queue full
// of items this box can't run can't grow the status file without limit; the
// oldest cooldown is dropped first, which at worst re-attempts (and re-refuses)
// one item early.
const SKIP_CAP = 50;

// Exponential backoff over CONSECUTIVE empty passes: nothing to dispatch, or a
// queue read that failed. `misses` is 0 on the pass that dispatched something,
// so the first idle wait is always the plain interval and the ceiling is only
// reached by a genuinely quiet queue. Never below the interval, never above the
// ceiling, and immune to a nonsense config (a zero/negative interval would
// otherwise spin).
function nextBackoffMs(intervalMs, maxIntervalMs, misses) {
  const base = Math.max(1000, Number(intervalMs) || WORK_DEFAULTS.intervalMs);
  const cap = Math.max(base, Number(maxIntervalMs) || WORK_DEFAULTS.maxIntervalMs);
  const n = Math.max(0, Math.min(20, Math.floor(misses) || 0)); // 2**20 * base already saturates any sane cap
  return Math.min(cap, base * Math.pow(2, n));
}

// The status store: one JSON file per worker process, under the machine-local
// journal (never the graph — a worker's liveness is not a durable fact, and
// `journal/` is already gitignored in a shared graph home).
function workDir(home) {
  return path.join(home, "journal", "work");
}

function workerStatusPath(home, workerId) {
  return path.join(workDir(home), `${workerId}.work.json`);
}

// Best-effort by contract: a worker that cannot write its status must keep
// working (the status surface is an observation channel, not the work).
function writeWorkerStatus(home, status) {
  try {
    writeFileAtomic(workerStatusPath(home, status.worker_id), `${JSON.stringify(status, null, 2)}\n`, { mkdir: true });
    return true;
  } catch {
    return false;
  }
}

// Read every worker record on this box, newest first, and say which are real.
// A record whose process is gone but which never wrote a `stopped_at` is
// STALE, not running — a killed worker must not read as live forever. Stale
// and stopped records age out after `maxAgeMs` so the directory stays bounded.
function readWorkerStatuses(home, { alive = () => true, now = Date.now, maxAgeMs = WORK_DEFAULTS.statusRetentionMs } = {}) {
  // `alive(pid, startedTicks)` — the ticks are the same pid-reuse guard the run
  // store uses (processStartTicks): a SIGKILLed worker leaves no `stopped_at`,
  // and a bare pid probe would read its recycled pid as that worker still
  // running, forever, with N slots apparently occupied.

  const dir = workDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".work.json"));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // a half-written or hand-mangled record is not worth failing a status read over
    }
    if (!rec || typeof rec !== "object" || !rec.worker_id) continue;
    const stopped = !!rec.stopped_at;
    const live = !stopped && rec.pid != null && alive(rec.pid, rec.started_ticks);
    rec.live = live;
    rec.stale = !stopped && !live;
    // A record with no readable timestamp at all (truncated, hand-edited) is
    // aged out with the rest rather than being immortal — it is already known
    // not to be live, and this directory has no other sweeper.
    const ts = Date.parse(rec.stopped_at || rec.updated_at || rec.started_at || "") || 0;
    if (!live && (!ts || now() - ts > maxAgeMs)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* the next read tries again */
      }
      continue;
    }
    records.push(rec);
  }
  records.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return records;
}

// Which queue items THIS pass may attempt, in queue order. Three exclusions,
// all of them the loop's own bookkeeping rather than a re-implemented guard:
//
//   - `readiness: human` — the one eligibility fact the queue itself already
//     computed (dec-spor-agent-readiness-derived-classification). `spor
//     dispatch` refuses only the `requires: human` subset and merely WARNS on
//     the rest, which is right for a human aiming an agent at a specific node
//     and wrong for an unattended loop picking work nobody chose: a worker
//     never claims a human-readiness item (WORKERS.md §3).
//   - already in flight from this worker — its slot is accounted for here.
//     BOTH phases count: a run still going AND a finished run whose gate
//     pipeline has not settled yet. A gating item is unfinished work, and an
//     unenforced `reported` run (the local-mode case the gates exist for) has
//     already handed its lease back, so with concurrency headroom this worker
//     would otherwise re-dispatch the very node its own first gate is still
//     judging.
//   - cooling off after a refusal, until its `until` passes.
//
// Everything else is left to the dispatch guards, so this list is a list of
// CANDIDATES, not of things that will launch.
function selectWorkCandidates(items, { skipped = new Map(), active = new Set(), now = Date.now() } = {}) {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.id) continue;
    if (active.has(it.id)) continue;
    if (it.readiness === "human") continue;
    const skip = skipped.get(it.id);
    if (skip && skip.until > now) continue;
    out.push(it);
  }
  return out;
}

// A one-line reason from a dispatch refusal. The refusal itself is an
// UNINDENTED line ("cannot dispatch X here: …"); by this CLI's own convention
// the lines that follow it are INDENTED remediation, and a non-fatal aside is
// prefixed `warning:`/`note:`. Both of those routinely print BEFORE a refusal
// — an unmintable agent token warns, then the claim is refused — so taking the
// literal first line would file every skip under the same wrong cause. Take
// the first line that is neither, falling back to the first line of any kind
// so a refusal shape we do not recognize still says something. Bounded, so a
// runaway message cannot bloat the status file.
const ASIDE_RE = /^(warning|note):/i;
function refusalReason(lines, fallback = "dispatch refused") {
  const trimmed = (lines || []).map((l) => String(l == null ? "" : l));
  const refusal = trimmed.find((l) => l.trim() && !/^\s/.test(l) && !ASIDE_RE.test(l.trim()));
  const any = trimmed.map((l) => l.trim()).find(Boolean);
  return (refusal || any || fallback).trim().slice(0, 300);
}

// Is this run OVER, as far as a worker holding a slot for it is concerned?
// Three cases, and the two that are not "the state says so" are the ones that
// matter (task-spor-work-loop):
//
//   - The record is GONE (aged out by dispatch.runRetentionMs under a
//     long-lived worker, or removed): terminal, with no verdict — a missing
//     record is not evidence of failure, and holding the slot for a record
//     nothing will ever write to is a slot leak.
//   - The record is terminal but its OUTCOME is still provisional: a
//     supervised run's record goes terminal SYNCHRONOUSLY carrying an
//     unenforced placeholder, and the verified verdict merges in up to three
//     bounded HTTP round-trips later (agent-dispatch-runner's
//     closeWithOutcome). Harvesting inside that window records a run that
//     RESOLVED its target as an unenforced `reported` and cools the node off.
//     So wait — unless the supervisor process is gone, in which case the
//     provisional reading is all there will ever be and is the honest one.
//   - The record is NOT terminal and has aged past `maxAgeMs`: the watchdog.
//     A native-background run whose harness can no longer be enumerated never
//     reaches a terminal state at all (reconcileRuns leaves such a record
//     alone by design), so without a ceiling one unreadable `claude agents
//     --json` holds that slot for the worker's whole life and the loop
//     silently stops dispatching. Freeing it claims nothing about the run.
//
// `terminalStates` is injected rather than duplicated here — the run store owns
// that vocabulary.
function runHarvest(record, { terminalStates = null, alive = () => false, now = Date.now, maxAgeMs = 0, contractGraceMs = WORK_DEFAULTS.contractGraceMs } = {}) {
  if (!record) return { terminal: true, why: "missing" };
  const at = now();
  if (terminalStates && terminalStates.has(record.state)) {
    if (record.contract_pending) {
      // Held only while the supervisor is demonstrably still working on it AND
      // we are inside the contract's own worst case. Both bounds matter: a
      // supervisor killed mid-contract leaves this flag set for good, and on a
      // host with no process-start-time source the pid check degrades to a
      // bare probe that a recycled pid satisfies — an unbounded hold here is
      // the one slot leak `maxAgeMs` below could never free.
      const closed = Date.parse(record.finished_at || "") || 0;
      const supervisorLive = record.runner_pid != null && alive(record.runner_pid, record.runner_started_ticks);
      if (supervisorLive && closed && at - closed <= contractGraceMs) return { terminal: false, why: "contract-pending" };
    }
    return { terminal: true, why: "state" };
  }
  // Our own writers always stamp created_at; the fallbacks are for a record
  // shape that predates or outlives them — without SOME parseable start the
  // watchdog could never fire for this run at all.
  const started = Date.parse(record.created_at || record.started_at || record.launched_at || "") || 0;
  if (maxAgeMs > 0 && started && at - started > maxAgeMs) return { terminal: true, why: "watchdog" };
  return { terminal: false, why: "running" };
}

// Which finished runs the gate pipeline is FOR. Two cases, and only two:
//
//   - `resolved` — the run wrote a resolver and the terminal-state contract
//     verified the edge on the graph. That verified claim is precisely what the
//     gates exist to test; taking it on trust is what the factory refuses to do.
//   - an UNENFORCED `reported` — a run whose claim nobody could check at all
//     (local-mode dispatch, an unreachable server, a native-background launch).
//     The gates are then the only thing standing between the work and "done",
//     so skipping them there would make gating quietly mode-dependent — a
//     local-mode worker that looks gated and is not.
//
// An ENFORCED `reported` is a run that self-declares NOT done: the item is
// already back in the pool carrying its report, and there is no claim to test.
// A `failed` run produced nothing to gate.
function shouldGate(outcome) {
  if (!outcome || !outcome.terminal_state) return false;
  if (outcome.terminal_state === "resolved") return true;
  return outcome.terminal_state === "reported" && !outcome.terminal_enforced;
}

// Every NODE a live worker on this box is currently gating. A gating item is
// unfinished work for whoever holds it, and — unlike a dispatched run — there
// is nothing else standing in the way of a second worker taking it: an
// unenforced `reported` run has already handed its lease back, and its agent is
// long gone, so neither the claim nor the same-machine in-flight guard refuses
// it. So the candidate poll subtracts these too, not just this worker's own
// slots (bin/spor.js `candidates`).
function gatingNodeIds(statuses) {
  const out = new Set();
  for (const w of statuses || []) {
    if (!w || !w.live) continue;
    for (const slot of w.gating || []) if (slot && slot.node_id) out.add(slot.node_id);
  }
  return out;
}

// Which of a DEAD worker's slots were ever owed a gate verdict.
//
// The two slot lists have different provenance, and conflating them is how a
// gate gets imposed on work nobody meant to gate:
//
//   - `gating` only ever exists on a GATE-ARMED worker. A slot is there because
//     a pipeline was started for it, so it is owed a verdict by construction.
//   - `active` is populated by EVERY worker, bare ones included. A bare worker
//     (no factory declared — the shipped default, and the whole "adoption has
//     no cliff" guarantee) runs dispatch/await/repeat and its runs were never
//     owed a gate at all. Adopting those would let a later gate-armed worker
//     retroactively judge them — and, on a refusal, file a `blocks` edge and
//     roll back the status of an item a person may have deliberately closed.
//     A worker's factory is its own configuration, not a property of the box.
//
// So `active` counts only when the dead worker's own status record says it ran
// gate-armed. `gates` (the passed/failed/blocked tally) is written into that
// record if and only if `deps.gate` was present, which makes it the exact
// marker — no new write on the dispatch path, where a stamp would race the
// live supervisor still writing the run record.
function resumableSlots(w) {
  if (!w) return [];
  const gating = w.gating || [];
  // A `gating` slot is self-evidencing: it could not exist without a pipeline,
  // so it is honored even on a record whose tally is missing (hand-mangled, or
  // written by a future shape).
  return w.gates ? [...gating, ...(w.active || [])] : gating;
}

// ORPHANED gate work on this box (task-spor-work-gate-pipeline, review finding
// 2). A gate pipeline is an async job the WORKER PROCESS owns — unlike a
// dispatched run, which is detached and carries its own terminal contract — so
// a worker that is stopped or killed abandons whatever it was gating. The run
// itself is already terminal and (for a `resolved` one) already out of every
// queue by its resolving edge, so nothing would ever come back to it: the
// claim would stand permanently un-judged, which is the one outcome a factory
// exists to prevent. "Re-gates on the next run" has to be something a worker
// actually DOES.
//
// The durable record is the pair this box already keeps: the per-worker status
// files (which slots each worker held, and whether that worker is still alive)
// and the run records (the terminal outcome, plus the `gate_state`/`gate_worker`
// stamp a pipeline writes when it starts and when it settles). This joins them:
//
//   - a slot held by a worker that is NOT live, and that was owed a gate in the
//     first place (resumableSlots above): every `gating` slot, plus the
//     `active` slots of a worker that was itself gate-armed — one killed with
//     runs in flight never reaches the harvest that would have started their
//     gates, and those runs go terminal anyway. A BARE worker's runs are never
//     adopted: they were never owed a gate;
//   - whose run record still exists, is terminal, and carries a CLAIM worth
//     gating (shouldGate);
//   - whose `gate_state` is not already a settled verdict, and is not `running`
//     under a worker that is still live.
//
// Scoping the candidate set to slots a work loop actually held is what keeps
// this from becoming "gate every run ever dispatched on this box": a hand-run
// `spor dispatch`, or a run from a worker that had no factory, was never owed a
// gate and is never resumed.
//
// A resumed pipeline RE-RUNS the declared gates from the first one. There is no
// per-gate progress record — `gate_state` is one word about the whole pipeline
// — so the suite runs again, the review is dispatched again, and the fix loop
// is re-entered from cycle 0. The fact NODES are idempotent, so the graph
// record does not double; the side effects are not, and one of them is
// dangerous: a fix cycle dispatches an implementer at the node with `--force`
// and `--no-worktree`, into the run's own checkout. The pipeline that was
// abandoned may have left exactly such an agent running — it is a DETACHED
// process that outlived the worker that started it — and `--force` is designed
// to walk past the same-machine in-flight guard that would otherwise refuse a
// second one. Two agents committing into one checkout is the hazard dispatch
// worktree isolation exists to remove, so:
//
//   - `busyNodes` — any node with a NON-terminal run record — is excluded. The
//     orphan is not dropped, only deferred: once that agent's run goes terminal
//     the next pass adopts it. `terminalStates` is injected (the run store owns
//     that vocabulary); without it this exclusion is simply not applied, which
//     is why the CLI always passes it.
//
//     This catches the dangerous case exactly: a FIX cycle is dispatched with
//     `node: <the work item>`, so its record carries the node id. A review
//     dispatch is free-text and its record carries none, so a resumed pipeline
//     can re-dispatch a review while an abandoned one still runs. That is
//     accepted: a review gate is a READ-ONLY reviewer (it is told to edit
//     nothing and to write no node), so a duplicate is wasted spend, not a
//     corrupted tree. Stamping the node onto the review dispatch would NOT fix
//     it — a review runs against a target that already reads resolved, so
//     naming the node there would hit `spor dispatch`'s already-resolved guard
//     and refuse the gate outright, and forcing past that guard is exactly what
//     the loop must not do outside the bounded fix cycle.
//
// TWO further exclusions keep two WORKERS off one orphan, because they see each
// other through two different files and both lag: run ids in a live worker's
// own published slots, AND run records already claimed `running` by a live
// `gate_worker` (which a worker stamps BEFORE it publishes, so it is the
// earlier of the two signals). The residual is a genuine read-read race — both
// workers scanning before either writes — which cannot be closed from here
// without a cross-process lock. Its damage is bounded rather than prevented:
// the gate facts are idempotent, so a duplicate pipeline records the same
// nodes, and stampGateState refuses to overwrite a settled verdict, so a
// duplicate can never launder the winner's refusal into a pass.
function orphanedGateRuns(statuses, { records = new Map(), terminalStates = null, now = Date.now, maxAgeMs = 0 } = {}) {
  const at = now();
  const owned = new Set();
  const liveWorkers = new Set();
  for (const w of statuses || []) {
    if (!w || !w.live) continue;
    if (w.worker_id) liveWorkers.add(w.worker_id);
    for (const slot of [...(w.gating || []), ...(w.active || [])]) if (slot && slot.run_id) owned.add(slot.run_id);
  }
  // Nodes an agent may still be working. A record aged past the watchdog
  // ceiling is NOT evidence of a live agent (that is exactly the record
  // runHarvest gives up on), so it does not defer an orphan forever.
  const busyNodes = new Set();
  if (terminalStates && records && typeof records.values === "function") {
    for (const r of records.values()) {
      if (!r || !r.node_id || terminalStates.has(r.state)) continue;
      const started = Date.parse(r.created_at || r.started_at || r.launched_at || "") || 0;
      if (maxAgeMs > 0 && started && at - started > maxAgeMs) continue;
      busyNodes.add(r.node_id);
    }
  }
  const out = [];
  const seen = new Set();
  for (const w of statuses || []) {
    if (!w || w.live) continue;
    for (const slot of resumableSlots(w)) {
      if (!slot || !slot.run_id || !slot.node_id) continue;
      if (owned.has(slot.run_id) || seen.has(slot.run_id)) continue;
      seen.add(slot.run_id);
      if (busyNodes.has(slot.node_id)) continue;
      const record = records.get ? records.get(slot.run_id) : null;
      if (!record) continue; // pruned or never written: nothing left to gate
      if (record.gate_state && gates.SETTLED_GATE_STATES.has(record.gate_state)) continue;
      if (record.gate_state === "running" && record.gate_worker && liveWorkers.has(record.gate_worker)) continue;
      if (!shouldGate(record)) continue;
      // The same ceiling the run watchdog uses: resuming a gate on a week-old
      // run would re-dispatch reviews against a tree that has moved on.
      const ended = Date.parse(record.finished_at || record.created_at || "") || 0;
      if (maxAgeMs > 0 && ended && at - ended > maxAgeMs) continue;
      out.push({ run_id: slot.run_id, node_id: slot.node_id, harness: slot.harness || null, record });
    }
  }
  return out;
}

// Fold one terminal run record into the worker's counters. The outcome
// dimension is the run's (WORKERS.md §8) — read, never recomputed. `unenforced`
// is a CROSS-CUTTING tally over the three verdict buckets, not a fourth bucket:
// every unenforced run is also counted under its own verdict, and the pair is
// rendered "failed 3 (3 unenforced)" so a box whose server was unreachable
// cannot read as a box that verified anything
// (dec-spor-dispatch-terminal-states-supervised-first). Sum the three verdicts
// for a total; never add `unenforced` to them.
function outcomeOf(record) {
  const state = record && typeof record.terminal_state === "string" ? record.terminal_state : null;
  const enforced = !!(record && record.terminal_enforced);
  return {
    run_id: (record && record.run_id) || null,
    node_id: (record && record.node_id) || null,
    harness: (record && record.harness) || null,
    state: (record && record.state) || null,
    terminal_state: state,
    terminal_enforced: enforced,
    ...(record && record.resolved_by ? { resolved_by: record.resolved_by } : {}),
    ...(record && record.report_node_id ? { report_node_id: record.report_node_id } : {}),
    ...(record && record.terminal_note ? { note: String(record.terminal_note).slice(0, 300) } : {}),
  };
}

// The loop. `deps` are the only way out to the world:
//   candidates()        -> [queue item]  (throwing/returning null = a failed
//                                         poll: backoff, never crash the loop)
//   dispatch(item)      -> {ok, run, reason}
//   pollRuns(runIds)    -> [run record]  (terminal ones carry terminal_state)
//   gate(entry, record) -> Promise<{state, reason, gates}>  (OPTIONAL — absent
//                                         when no factory definition resolves,
//                                         which is the shipped bare loop)
//   pendingGates()      -> [{run_id, node_id, harness, record}]  (OPTIONAL,
//                                         gate-armed workers only: the gate
//                                         pipelines a DEAD worker on this box
//                                         left unfinished, for step 3a)
//   markGate(runId, patch) -> void       (OPTIONAL: stamp the pipeline's state
//                                         onto the run record — the durable
//                                         half pendingGates reads back)
//   sleep(ms)           -> Promise, wakeable by `control.wake()`
//   now()               -> epoch ms
//   publish(status)     -> persist the status snapshot (best-effort)
//   log(line)           -> operator-facing progress line
// `control` carries the stop request (a signal handler sets `stopping`), so a
// SIGTERM stops the loop at the next boundary instead of at the end of a
// five-minute backoff.
async function runWorkLoop({ opts = {}, deps, control = {} }) {
  const concurrency = Math.max(1, Number(opts.concurrency) || WORK_DEFAULTS.concurrency);
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || WORK_DEFAULTS.intervalMs);
  const maxIntervalMs = Math.max(intervalMs, Number(opts.maxIntervalMs) || WORK_DEFAULTS.maxIntervalMs);
  const retryAfterMs = Number.isFinite(Number(opts.retryAfterMs))
    ? Math.max(0, Number(opts.retryAfterMs))
    : WORK_DEFAULTS.retryAfterMs;
  const max = Math.max(0, Number(opts.max) || 0);
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});

  const status = {
    worker_id: opts.workerId,
    pid: opts.pid ?? process.pid,
    started_ticks: opts.startedTicks ?? null,
    state: "polling",
    project: opts.project || null,
    concurrency,
    interval_ms: intervalMs,
    max_interval_ms: maxIntervalMs,
    max: max || null,
    once: !!opts.once,
    started_at: new Date(now()).toISOString(),
    updated_at: new Date(now()).toISOString(),
    dispatched: 0,
    outcomes: { resolved: 0, reported: 0, failed: 0, unenforced: 0 },
    // The gate pipeline's own tally, kept APART from the run outcomes above for
    // the same reason `unenforced` is: a run that resolved its target and a
    // gate that then refused it are two different facts, and folding them would
    // let a box read as productive while every gate it ran said no.
    ...(deps.gate ? { gates: { passed: 0, failed: 0, blocked: 0 }, factory: opts.factory || null } : {}),
    active: [],
    gating: [],
    recent: [],
    skipped: [],
    next_poll_at: null,
    stopped_at: null,
    stop_reason: null,
  };
  const skipped = new Map(); // node id -> {reason, until, at}
  // Cool an item off: not dispatchable by THIS worker until `until`. Delete
  // before set so re-cooling an item moves it to the END — the map is then
  // ordered oldest-refresh-first, which is what the SKIP_CAP eviction below
  // relies on (a plain re-set keeps the original position, so the item being
  // refused most often would be the first evicted).
  const cool = (id, reason, forMs = retryAfterMs) => {
    if (!id) return;
    skipped.delete(id);
    skipped.set(id, { reason, at: new Date(now()).toISOString(), until: now() + Math.max(retryAfterMs, forMs) });
    while (skipped.size > SKIP_CAP) skipped.delete(skipped.keys().next().value);
  };
  const publish = (state) => {
    if (state) status.state = state;
    status.updated_at = new Date(now()).toISOString();
    status.skipped = [...skipped.entries()]
      .map(([id, s]) => ({ id, reason: s.reason, at: s.at, until: new Date(s.until).toISOString() }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (deps.publish) deps.publish(status);
  };
  const stopping = () => !!control.stopping;

  // In-flight gate pipelines, by run. The pipeline is an async job this process
  // owns (unlike a dispatched run, which is a detached process with its own
  // contract), so the loop keeps a handle and polls it at each pass boundary
  // rather than awaiting it inline — a gate that waits a day on a human
  // approval must not stop the worker from harvesting everything else.
  const gateJobs = new Map(); // run_id -> {done, result, error}
  // Stamp the pipeline's state onto the RUN RECORD — the durable, machine-local
  // half of the gate verdict (orphanedGateRuns above reads it back). Optional
  // and best-effort by contract, exactly like the status file: a journal that
  // cannot be written must not stop the gate from running.
  const markGate = (runId, patch) => {
    if (!deps.markGate || !runId) return;
    try {
      deps.markGate(runId, { gate_at: new Date(now()).toISOString(), gate_worker: opts.workerId || null, ...patch });
    } catch {
      /* the verdict still stands; the resume scan just re-offers this run */
    }
  };
  const startGate = (slot, record) => {
    const job = { done: false, result: null, error: null };
    gateJobs.set(slot.run_id, job);
    markGate(slot.run_id, { gate_state: "running" });
    Promise.resolve()
      .then(() =>
        deps.gate(
          { run_id: slot.run_id, node_id: slot.node_id, harness: slot.harness || null, project: opts.project || null },
          record
        )
      )
      .then(
        (r) => {
          job.result = r || { state: "passed" };
        },
        (e) => {
          job.error = e;
        }
      )
      .then(() => {
        job.done = true;
        // Collapse a pending backoff so a settled verdict is folded in now,
        // not after a five-minute idle wait.
        if (control.wake) control.wake();
      });
  };

  // Settle whatever gate pipelines have reported. A pipeline that PASSED leaves
  // the item as the run left it (resolved, out of the queue); one that failed or
  // is blocked on a person cools the node off — the work is not done, and this
  // worker re-dispatching it on the next poll would just race its own
  // escalation. The verdict is folded into the run's own recent entry rather
  // than a second one: one run, one line, two dimensions.
  //
  // A function rather than an inline block because it is called TWICE: once per
  // pass, and once more immediately before a stop breaks the loop. A verdict
  // that already exists must not be thrown away and re-run by the next worker
  // just because a signal arrived in the same tick.
  const settleGates = () => {
    if (!status.gating.length) return;
    const stillGating = [];
    for (const g of status.gating) {
      const job = gateJobs.get(g.run_id);
      if (job && !job.done) {
        stillGating.push(g);
        continue;
      }
      // No handle at all can only mean the job was never created or was
      // already taken; either way it will never report, and treating it as
      // still-running would hold a slot for the life of the worker with no
      // watchdog behind it (the run watchdog covers runs, not pipelines).
      gateJobs.delete(g.run_id);
      const res = !job
        ? { state: "failed", reason: "the gate pipeline handle was lost before it reported — nothing was verified" }
        : job.error
        ? { state: "failed", reason: `the gate pipeline threw: ${job.error && job.error.message ? job.error.message : String(job.error)}` }
        : job.result;
      const state = res && res.state ? res.state : "failed";
      const reason = res && res.reason ? String(res.reason).slice(0, 300) : null;
      if (status.gates && status.gates[state] != null) status.gates[state] += 1;
      markGate(g.run_id, { gate_state: state, ...(reason ? { gate_reason: reason } : {}) });
      const entry = status.recent.find((r) => r.run_id === g.run_id);
      if (entry) {
        entry.gate = state;
        entry.gate_reason = reason;
        if (res && res.gates) entry.gates = res.gates;
        if (res && res.escalated_to) entry.escalated_to = res.escalated_to;
        if (res && res.demoted != null) entry.demoted = !!res.demoted;
        if (res && res.demote_reason) entry.demote_reason = String(res.demote_reason).slice(0, 300);
      }
      if (state !== "passed" && g.node_id) {
        cool(g.node_id, `gate pipeline ${state}${reason ? ` — ${reason}` : ""}`);
      }
      log(`work: ${g.node_id || g.run_id.slice(0, 8)} gates ${state}${reason ? ` — ${reason}` : ""}`);
    }
    if (stillGating.length !== status.gating.length) {
      status.gating = stillGating;
      publish();
    }
  };

  publish("polling");
  let misses = 0;
  let passes = 0;

  for (;;) {
    // 1. Harvest. A run leaves the active set only when its RECORD says the
    //    run is over — the outcome contract has run by then, so the item is
    //    either resolved, back in the queue carrying its report, or failed
    //    with the lease handed back. Nothing here re-derives that verdict.
    if (status.active.length) {
      let records = [];
      try {
        records = (await deps.pollRuns(status.active.map((a) => a.run_id))) || [];
      } catch {
        records = []; // an unreadable run store must not strand the loop; try again next pass
      }
      const byId = new Map(records.map((r) => [r && r.run_id, r]));
      const stillActive = [];
      for (const a of status.active) {
        const rec = byId.get(a.run_id);
        if (!rec || !rec.terminal) {
          stillActive.push(a);
          continue;
        }
        const outcome = { ...outcomeOf(rec.record || rec), node_id: a.node_id, at: new Date(now()).toISOString() };
        if (outcome.terminal_state && status.outcomes[outcome.terminal_state] != null) {
          status.outcomes[outcome.terminal_state] += 1;
        }
        if (outcome.terminal_state && !outcome.terminal_enforced) status.outcomes.unenforced += 1;
        // A run that did NOT resolve its target hands the lease back, so the
        // item returns to the pool — carrying its report, which is the point
        // (WORKERS.md §6). It must not come straight back to THIS worker: the
        // next poll would re-dispatch the node the run just failed at, over
        // and over, at the pace of the queue. Cool it off on the same window a
        // refusal gets, so a transient cause (a rate limit, a flaky suite) is
        // retried later and a systematic one goes to another box or a human
        // instead of burning this one. A resolved target leaves the queue by
        // itself and needs no cooldown.
        if (a.node_id && outcome.terminal_state !== "resolved") {
          // `cool_ms` lets the harvester ask for a LONGER window than an
          // ordinary refusal gets. The watchdog uses it: giving up on following
          // a run is not evidence the run stopped, and re-dispatching at a node
          // an agent may still be working is the one thing a pull worker must
          // not do — remotely the claim nonce refuses it, but a local-mode
          // worker has no lease to lean on.
          cool(
            a.node_id,
            `last run here ended ${outcome.terminal_state || outcome.state || "without a verdict"}${outcome.report_node_id ? ` (report ${outcome.report_node_id})` : ""}`,
            rec.cool_ms || 0
          );
        }
        status.recent.unshift(outcome);
        status.recent.length = Math.min(status.recent.length, RECENT_CAP);
        log(
          `work: ${a.node_id || a.run_id.slice(0, 8)} finished — ${outcome.terminal_state || outcome.state || "unknown"}` +
            `${outcome.terminal_state && !outcome.terminal_enforced ? " (unenforced)" : ""}` +
            `${outcome.resolved_by ? ` by ${outcome.resolved_by}` : ""}`
        );
        // GATES (task-spor-work-gate-pipeline). A run carrying a CLAIM of
        // completion (shouldGate) is precisely what a factory does not take on
        // trust, so its slot is NOT freed here: it moves from `active` to
        // `gating` and frees when the pipeline settles. Every other outcome is
        // already back in the pool with its report and needs no gate. The
        // cooldown above still stands for a non-resolved run — a gate verdict
        // refreshes it either way when it lands.
        if (deps.gate && a.node_id && shouldGate(outcome)) {
          outcome.gate = "running";
          status.gating.push({
            run_id: a.run_id,
            node_id: a.node_id,
            harness: a.harness || null,
            started_at: new Date(now()).toISOString(),
          });
          startGate(a, rec.record || rec);
          log(`work: ${a.node_id} — running the gate pipeline before this worker calls it done`);
        }
      }
      if (stillActive.length !== status.active.length) {
        status.active = stillActive;
        publish();
      }
    }


    // 1b. Fold in every gate verdict that has landed.
    settleGates();

    // 2. Stop conditions. Draining is deliberate: a stop request stops PICKING
    //    UP work, and the loop then leaves — the in-flight runs are detached
    //    and own their own terminal contract, so waiting on them would only
    //    delay the exit without making anything safer. An in-flight GATE
    //    pipeline is different — it runs in THIS process, so a stop abandons
    //    it; the loop MARKS each abandoned pipeline `interrupted` on its run
    //    record and leaves its slot standing in the published status, which is
    //    exactly the pair orphanedGateRuns joins — so "re-gates on the next
    //    run" is something the next worker actually does (step 3a), not a
    //    promise nothing keeps. The resumed pipeline re-runs its gates from the
    //    first one — the facts are idempotent, so the graph record does not
    //    double — and orphanedGateRuns is what keeps the re-run from colliding
    //    with an agent this pipeline may have left working.
    if (stopping()) break;
    const quotaReached = max > 0 && status.dispatched >= max;
    if (quotaReached && !status.active.length && !status.gating.length) break;
    if (opts.once && passes > 0 && !status.active.length && !status.gating.length) break;

    // 3. Fill the free slots.
    let launchedThisPass = 0;
    const draining = opts.once && passes > 0;
    // A gating item still occupies a slot: the worker has not finished with
    // that piece of work until its gates say so.
    let free = concurrency - status.active.length - status.gating.length;
    if (free > 0 && !quotaReached && !draining) {
      // 3a. RESUME orphaned gate pipelines first (task-spor-work-gate-pipeline).
      //     A worker that was killed or stopped mid-pipeline left a terminal run
      //     standing with an un-judged claim, and that run is already out of the
      //     queue — no candidate poll would ever bring it back. So a gate-armed
      //     worker adopts them AHEAD of taking new work: finishing what the box
      //     already promised to judge outranks starting something else, and a
      //     resumed pipeline occupies a slot exactly like one this worker
      //     started. Bounded by the free slots, so a backlog is worked down over
      //     passes rather than spawning a pipeline per orphan at once — and
      //     placed under the SAME wind-down guards as a dispatch, so `--max` and
      //     `--once` still mean what they say (a winding-down worker leaves the
      //     orphans for the next one, which is exactly what they are for).
      if (deps.gate && deps.pendingGates) {
        let orphans = [];
        try {
          orphans = (await deps.pendingGates()) || [];
        } catch {
          orphans = []; // an unreadable journal retries next pass; it never strands the loop
        }
        for (const o of orphans) {
          if (free <= 0 || stopping()) break;
          if (!o || !o.run_id || !o.node_id) continue;
          // By RUN and by NODE. Run id alone is not enough across passes: a
          // scan that missed an orphan (an unflushed status file, a
          // pendingGates throw) lets this worker dispatch that node, and the
          // next pass would then adopt the orphan alongside its own live run —
          // two pipelines, one checkout, which is the hazard busyNodes exists
          // to prevent.
          const taken = (s) => s.run_id === o.run_id || s.node_id === o.node_id;
          if (status.gating.some(taken) || status.active.some(taken)) continue;
          const slot = { run_id: o.run_id, node_id: o.node_id, harness: o.harness || null, started_at: new Date(now()).toISOString(), resumed: true };
          status.gating.push(slot);
          // The verdict lands on a `recent` entry; a resumed run has none from
          // this worker's own harvest, so seed one from the run record.
          status.recent.unshift({ ...outcomeOf(o.record), node_id: o.node_id, at: new Date(now()).toISOString(), gate: "running", resumed: true });
          status.recent.length = Math.min(status.recent.length, RECENT_CAP);
          startGate(slot, o.record);
          free -= 1;
          // Published per adoption, not once at the end of the loop: this file
          // is how another worker on this box learns the slot is taken, and
          // every extra moment it lags is more of the read-read window in which
          // both could adopt the same orphan.
          publish();
          log(`work: ${o.node_id} — resuming the gate pipeline an earlier worker left unfinished (run ${String(o.run_id).slice(0, 8)})`);
        }
      }

      // 3b. Take new work with whatever is left.
      if (free > 0 && !stopping()) {
        let items = null;
        try {
          items = await deps.candidates();
        } catch {
          items = null; // a dead server backs off; it never takes the worker down (fail-open)
        }
        const cands = selectWorkCandidates(items || [], {
          skipped,
          // GATING counts as in flight (review finding 3): the worker has not
          // finished with that node until its pipeline settles, and an
          // unenforced `reported` run has already handed the lease back — so
          // without this a second free slot re-dispatches the very item the
          // first gate is still judging.
          active: new Set([...status.active, ...status.gating].map((a) => a.node_id).filter(Boolean)),
          now: now(),
        });
        for (const item of cands) {
          if (free <= 0 || stopping()) break;
          publish("dispatching");
          let res;
          try {
            res = await deps.dispatch(item);
          } catch (e) {
            res = { ok: false, reason: `dispatch threw: ${e && e.message ? e.message : String(e)}` };
          }
          if (res && res.ok && res.run && res.run.run_id) {
            status.active.push({
              run_id: res.run.run_id,
              node_id: item.id,
              harness: res.run.harness || null,
              launch_mode: res.run.launch_mode || null,
              started_at: new Date(now()).toISOString(),
            });
            status.dispatched += 1;
            skipped.delete(item.id);
            free -= 1;
            launchedThisPass += 1;
            log(`work: dispatched ${item.id} (run ${String(res.run.run_id).slice(0, 8)}${res.run.harness ? `, ${res.run.harness}` : ""})`);
          } else {
            // Refused, or launched something we cannot track. Either way this
            // worker is not holding a slot for it — cool it off so the next pass
            // moves on down the queue instead of re-refusing the same item
            // forever, and keep the reason for the status surface.
            const reason = (res && res.reason) || "dispatch refused";
            cool(item.id, reason);
            log(`work: skipping ${item.id} — ${reason}`);
          }
          if (max > 0 && status.dispatched >= max) break;
        }
      }
    }

    passes += 1;
    // 4. Pace. Backoff is for an IDLE worker only — nothing launched and
    //    nothing in flight, i.e. a queue with no work for this box or a queue
    //    we could not read at all (a failed poll counts as a miss, so an
    //    unreachable server is not hammered at the base interval). A worker
    //    with runs in flight keeps polling at the plain interval: it is waiting
    //    on a run record, not on the queue, and a five-minute backoff there
    //    would just leave a finished slot idle.
    const idle = launchedThisPass === 0 && status.active.length === 0 && status.gating.length === 0;
    misses = idle ? misses + 1 : 0;
    if (opts.once && !status.active.length && !status.gating.length) break;
    if (stopping()) break;
    const waitMs = idle ? nextBackoffMs(intervalMs, maxIntervalMs, misses - 1) : intervalMs;
    status.next_poll_at = new Date(now() + waitMs).toISOString();
    publish(status.active.length ? "waiting" : "idle");
    await deps.sleep(waitMs);
  }

  // Whatever exit brought us here — and there are several, including a stop
  // that lands mid-pass and breaks before the stop-condition step — fold in
  // every gate verdict that DID land before writing this worker off. A pipeline
  // that reported has a verdict, and throwing it away so the next worker re-runs
  // the whole thing is the one avoidable waste in the resume path.
  settleGates();
  // Whatever is still gating is abandoned by this exit: mark it on the run
  // record so the pair orphanedGateRuns joins says so, and leave the slot
  // standing in the published status — that is what the next worker resumes
  // from. Only a stop can get here with anything gating (the quota and --once
  // exits both require an empty gating list).
  if (status.gating.length) {
    for (const g of status.gating) markGate(g.run_id, { gate_state: "interrupted" });
    log(`work: ${status.gating.length} gate pipeline(s) abandoned by the stop — their items stay uncleared, and the next 'spor work' on this box resumes them`);
  }

  status.next_poll_at = null;
  status.stopped_at = new Date(now()).toISOString();
  status.stop_reason =
    control.reason || (max > 0 && status.dispatched >= max ? `dispatched ${status.dispatched} item(s) (--max)` : opts.once ? "one pass (--once)" : "stopped");
  publish("stopped");
  return status;
}

module.exports = {
  WORK_DEFAULTS,
  runHarvest,
  RECENT_CAP,
  SKIP_CAP,
  nextBackoffMs,
  workDir,
  workerStatusPath,
  writeWorkerStatus,
  readWorkerStatuses,
  selectWorkCandidates,
  shouldGate,
  orphanedGateRuns,
  resumableSlots,
  gatingNodeIds,
  refusalReason,
  outcomeOf,
  runWorkLoop,
};
