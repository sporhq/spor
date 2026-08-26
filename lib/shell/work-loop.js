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
// v1 runs BARE by design: dispatch-only, no gates. task-spor-work-gate-pipeline
// layers the deterministic gate pipeline in between claim and resolve when a
// factory definition resolves, so adoption has no cliff.
//
// Plain Node, zero deps. Every side effect enters through `deps`, so the loop
// itself is drivable with a fake clock, a fake queue, and a fake dispatcher.
"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./atomic-write.js");

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
function runHarvest(record, { terminalStates = null, alive = () => false, now = Date.now, maxAgeMs = 0 } = {}) {
  if (!record) return { terminal: true, why: "missing" };
  if (terminalStates && terminalStates.has(record.state)) {
    const supervisorLive = record.runner_pid != null && alive(record.runner_pid, record.runner_started_ticks);
    if (record.contract_pending && supervisorLive) return { terminal: false, why: "contract-pending" };
    return { terminal: true, why: "state" };
  }
  const started = Date.parse(record.created_at || "") || 0;
  if (maxAgeMs > 0 && started && now() - started > maxAgeMs) return { terminal: true, why: "watchdog" };
  return { terminal: false, why: "running" };
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
    active: [],
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
  const cool = (id, reason) => {
    if (!id) return;
    skipped.delete(id);
    skipped.set(id, { reason, at: new Date(now()).toISOString(), until: now() + retryAfterMs });
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
          cool(
            a.node_id,
            `last run here ended ${outcome.terminal_state || outcome.state || "without a verdict"}${outcome.report_node_id ? ` (report ${outcome.report_node_id})` : ""}`
          );
        }
        status.recent.unshift(outcome);
        status.recent.length = Math.min(status.recent.length, RECENT_CAP);
        log(
          `work: ${a.node_id || a.run_id.slice(0, 8)} finished — ${outcome.terminal_state || outcome.state || "unknown"}` +
            `${outcome.terminal_state && !outcome.terminal_enforced ? " (unenforced)" : ""}` +
            `${outcome.resolved_by ? ` by ${outcome.resolved_by}` : ""}`
        );
      }
      if (stillActive.length !== status.active.length) {
        status.active = stillActive;
        publish();
      }
    }

    // 2. Stop conditions. Draining is deliberate: a stop request stops PICKING
    //    UP work, and the loop then leaves — the in-flight runs are detached
    //    and own their own terminal contract, so waiting on them would only
    //    delay the exit without making anything safer.
    if (stopping()) break;
    const quotaReached = max > 0 && status.dispatched >= max;
    if (quotaReached && !status.active.length) break;
    if (opts.once && passes > 0 && !status.active.length) break;

    // 3. Fill the free slots.
    let launchedThisPass = 0;
    const draining = opts.once && passes > 0;
    let free = concurrency - status.active.length;
    if (free > 0 && !quotaReached && !draining) {
      let items = null;
      try {
        items = await deps.candidates();
      } catch {
        items = null; // a dead server backs off; it never takes the worker down (fail-open)
      }
      const cands = selectWorkCandidates(items || [], {
        skipped,
        active: new Set(status.active.map((a) => a.node_id).filter(Boolean)),
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

    passes += 1;
    // 4. Pace. Backoff is for an IDLE worker only — nothing launched and
    //    nothing in flight, i.e. a queue with no work for this box or a queue
    //    we could not read at all (a failed poll counts as a miss, so an
    //    unreachable server is not hammered at the base interval). A worker
    //    with runs in flight keeps polling at the plain interval: it is waiting
    //    on a run record, not on the queue, and a five-minute backoff there
    //    would just leave a finished slot idle.
    const idle = launchedThisPass === 0 && status.active.length === 0;
    misses = idle ? misses + 1 : 0;
    if (opts.once && !status.active.length) break;
    if (stopping()) break;
    const waitMs = idle ? nextBackoffMs(intervalMs, maxIntervalMs, misses - 1) : intervalMs;
    status.next_poll_at = new Date(now() + waitMs).toISOString();
    publish(status.active.length ? "waiting" : "idle");
    await deps.sleep(waitMs);
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
  refusalReason,
  outcomeOf,
  runWorkLoop,
};
