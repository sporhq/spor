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
// back to it. Hence the resume pass (step 3a, openPipelines): a gate-armed
// worker adopts every OPEN pipeline on this box — a journal a dead worker left
// running, a journal parked on a yield whose timer is due — before it takes
// new work. The stage journals and the pipeline lease log are the whole
// record of that (stage-projection.js); the run record carries only the
// final verdict.
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
const { refusalSurface } = require("./stage-workflow.js");

// Defaults are also the documented config-cascade keys (`work.*`), so a
// service unit can be `spor work` with the tuning in .spor.json.
const WORK_DEFAULTS = Object.freeze({
  concurrency: 1,
  intervalMs: 30000,
  maxIntervalMs: 300000,
  retryAfterMs: 600000,
  max: 0,
  // The acceptance policy (task-spor-work-accept-policy, dec-spor-work-accept-
  // policy-configurable): which readiness classifications this loop may pick
  // up. `ready` — the default — is explicit consent: only items a person
  // stamped agent-ready (or explicitly routed to an agent) are dispatched, so
  // on a team nobody routes work onto a teammate's box without that green
  // light. `open` restores the looser original pickup: everything except
  // `readiness: human`, untriaged included. The human floor is NOT part of
  // this knob — no policy value makes a worker claim a human-readiness item.
  accept: "ready",
  // How long a worker follows one run before giving up on ever seeing it end.
  // Only the watchdog case needs this (runHarvest) — a native-background run
  // (one a resumed pipeline adopted from before the supervised default; this
  // loop launches only supervised runs) whose harness cannot be enumerated
  // never goes terminal at all. 24h matches the run store's own staleness
  // ceiling for a supervised run.
  runMaxMs: 86400000,
  // How long a run may go SILENT — nothing appended to its log or its
  // transcript — before this worker stops it and classifies it
  // (task-spor-work-idle-run-detection). `runMaxMs` above bounds a run's total
  // LENGTH and only ever stops FOLLOWING it; this bounds its silence and
  // actually ends it, because the failure it exists for is not a long run but
  // a wedged one: an agent waiting forever on a prompt nobody will answer
  // holds its slot, its lease and its worktree for the whole 24h ceiling while
  // doing nothing at all. Deliberately generous and well under that ceiling —
  // a legitimately quiet step (a long build, a big test matrix) writes nothing
  // for a while, and stopping real work is a far worse error than holding a
  // slot an extra half hour. 0 disables it.
  //
  // What it measures is SILENCE, not idleness, and the two differ in one real
  // case worth naming: an agent's output only moves when a tool RESULT comes
  // back, so a single tool call that runs longer than the ceiling — a full
  // matrix, a slow image build — is indistinguishable from a wedged agent and
  // is stopped mid-work. That is the accepted trade at this default (an agent
  // making one 45-minute call is rare; one waiting forever on a prompt nobody
  // will answer is what these runs actually do), and `--run-idle` is the lever
  // for a lane whose steps genuinely run longer. WORKERS.md §8 says so where an
  // operator reading an `idle-timeout` record will look.
  runIdleMs: 2700000, // 45m
  // How long a terminal-but-unsettled record is allowed to hold its slot while
  // the supervisor finishes the terminal-state contract. That contract is three
  // bounded 5s round-trips at worst, so a minute is generous — and BOUNDING it
  // is the point: a supervisor killed inside that window leaves
  // `contract_pending` set forever, and its pid can be recycled, so an
  // unbounded hold is a slot held for the life of the worker.
  contractGraceMs: 60000,
  statusRetentionMs: 604800000, // 7d — a stopped worker's record is an audit trail, not state
  // task-spor-gate-escalation-bounded-auto-retry: how many times the bounded
  // auto-retry re-attempts one refusal's escalation write before it gives up
  // loudly and leaves the recovery to a person (`spor work --regate`), and the
  // exponential backoff between attempts (doubling from the base, capped at
  // the max) — generous, because the usual cause is the graph being
  // unreachable for a while, not something a tight loop would fix any faster.
  escalationRetryMaxAttempts: 5,
  escalationRetryBackoffMs: 300000, // 5m
  escalationRetryMaxBackoffMs: 3600000, // 1h
  // How often the retry scan is allowed to read this box's own run journal at
  // all, independent of each record's own backoff — the journal can hold
  // thousands of records (14-day retention), so a worker configured with a
  // sub-minute poll interval must not turn "is anything due for retry" into
  // its dominant per-pass cost.
  escalationRetryScanMs: 60000,
  // task-spor-work-loop-parked-reoffer-cap: how many CONSECUTIVE identical
  // yields (same reason, within one pipeline attempt's journal) one gate
  // pipeline may make before the worker stops re-offering it and files a
  // `requires: [human]` escalation instead. A parked journal is re-offered
  // whenever its own timer is due (openPipelines), and an interruption that
  // cannot clear on its own (evidence owed to a gate the factory no longer
  // declares, a graph it cannot read) would otherwise be re-run for the
  // box's whole lifetime. The count is read off the journal
  // (stage-projection.js projectJournal `reoffers`). 0 disables the cap
  // (re-offer forever, the behavior before it existed).
  parkedReofferMax: 10,
});

// The whole accept-policy vocabulary. cmdWork validates against this and
// REFUSES an unknown value (the same posture as a bad --interval: an
// unattended `--accept $TYPO` must not quietly become either policy).
const WORK_ACCEPT_POLICIES = Object.freeze(["ready", "open"]);

// How many finished items the status surface keeps. The durable record of an
// outcome is the run record and the graph; this is the operator's recent view.
const RECENT_CAP = 20;
// And how many distinct cooling-off items to remember. Bounded so a queue full
// of items this box can't run can't grow the status file without limit; the
// oldest cooldown is dropped first, which at worst re-attempts (and re-refuses)
// one item early.
const SKIP_CAP = 50;
// And how many of one pass's skips to name individually on stdout before the
// rest are aggregated. The page a worker reads can be widened well past
// SKIP_CAP when nothing on it is dispatchable (bin/spor.js's
// dispatchableQueuePage), and the cooldown map — which is what keeps a skip
// from being re-reported every poll — only remembers SKIP_CAP of them, so an
// uncoalesced log re-prints every evicted skip on every pass. The aggregate
// keeps that honest without turning a service log into one line per untriaged
// queue item per 30s.
const SKIP_LOG_CAP = 5;
// And how many `recent` (done) entries `spor work --status` names individually
// on stdout before the rest are aggregated — the same glance-vs-full-detail
// split as SKIP_LOG_CAP, mirrored for the other list the human renderer used
// to hard-truncate with no total (issue-spor-cmd-work-status-truncation).
const RECENT_LOG_CAP = 5;

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

// Which queue items THIS pass may attempt, in queue order. Four exclusions,
// all of them the loop's own bookkeeping rather than a re-implemented guard:
//
//   - `readiness: human` — the one eligibility fact the queue itself already
//     computed (dec-spor-agent-readiness-derived-classification). `spor
//     dispatch` refuses only the `requires: human` subset and merely WARNS on
//     the rest, which is right for a human aiming an agent at a specific node
//     and wrong for an unattended loop picking work nobody chose: a worker
//     never claims a human-readiness item (WORKERS.md §3). This floor holds
//     under EVERY accept policy — it is not configurable.
//   - not accepted by the policy (dec-spor-work-accept-policy-configurable):
//     under `accept: "ready"` (the default) an item nobody stamped agent-ready
//     — readiness `untriaged`, or missing entirely — is skipped, and `onSkip`
//     is told so the loop can surface WHY (a policy skip must be visible in
//     --status and on stdout, never silently hidden). `accept: "open"` is the
//     opt-in back to the original pickup: anything except human. The check
//     runs AFTER the cooldown check below, so an already-cooling policy skip
//     is not re-reported every pass.
//   - already in flight from this worker — its slot is accounted for here.
//     BOTH phases count: a run still going AND a finished run whose gate
//     pipeline has not settled yet. A gating item is unfinished work, and an
//     unenforced `reported` run (the local-mode case the gates exist for) has
//     already handed its lease back, so with concurrency headroom this worker
//     would otherwise re-dispatch the very node its own first gate is still
//     judging.
//   - carries a live decline finding (task-spor-decline-finding-gates-
//     redispatch): a prior dispatched run declared this exact node's own
//     PREMISE wrong (`DECLINED: ...`) rather than merely unfinished, and left
//     a standing `find-declined-*` finding instead of a resolver. `spor
//     dispatch --node` already refuses this (defense in depth for a human
//     aiming at one node directly), but an unattended loop must not even
//     ATTEMPT the dispatch that would refuse it — it holds under EVERY accept
//     policy, same as the human floor, and is skipped visibly through
//     `onSkip`, like a policy skip, never silently dropped. rankQueue's own
//     `findings` ride-along already excludes anything superseded or terminal
//     (resolved/dismissed), so a finding a person has since judged drops out
//     on its own — no special-casing needed here.
//   - cooling off after a refusal, until its `until` passes.
//   - outside the factory's declared repo scope (issue-spor-work-scope-union-
//     factory-mismatch). A gated worker's queue scope does not bound what it
//     gates: a bare `--project` slug unions its whole home-project grouping,
//     so a factory whose suite and integration command were authored for one
//     repo is otherwise handed a sibling repo's items and judges them anyway.
//     `repos` (the factory's declared scope, empty for an unscoped factory)
//     is the bound, checked against the item's own project stamp — skipped
//     visibly through `onSkip`, like a policy skip, never silently dropped.
//
// Everything else is left to the dispatch guards, so this list is a list of
// CANDIDATES, not of things that will launch.
function selectWorkCandidates(items, { skipped = new Map(), active = new Set(), now = Date.now(), accept = WORK_DEFAULTS.accept, repos = null, graph = null, selfAgent = null, onSkip = null } = {}) {
  const out = [];
  // Hoisted: one scope set per call, not one per item. `graph` (local-mode
  // only, task-spor-factory-alias-resolution-local-mode) expands the scope
  // with each declared repo's canonical alias so a historically-stamped item
  // is recognized — see gates.repoScope/inRepoScope.
  const scope = gates.repoScope(repos, graph);
  for (const it of items || []) {
    if (!it || !it.id) continue;
    if (active.has(it.id)) continue;
    if (it.readiness === "human") continue;
    const skip = skipped.get(it.id);
    if (skip && skip.until > now) continue;
    // Scope before policy, and both AFTER the cooldown — see classifyWorkItem,
    // which is the single definition of these two checks (the queue page fetch
    // applies the same one so it can widen past a page of un-dispatchable
    // items). The human floor above stays here: it is checked before the
    // cooldown and is never reported, so it can never become a policy skip.
    const verdict = classifyWorkItem(it, { accept, repos, scope, graph, selfAgent });
    if (verdict) {
      if (onSkip) onSkip(it, verdict.reason, verdict.kind);
      continue;
    }
    out.push(it);
  }
  return out;
}

// The ITEM-level half of the filter above: the exclusions that depend only on
// the item and the worker's declared policy, never on this worker's own
// bookkeeping (its slots, its cooldowns). Split out because the QUEUE PAGE has
// to apply them too: the ranked page is a fixed size, so under the default
// `accept: ready` a page filled by untriaged items would hide an agent-ready
// one ranked below it, forever — the fetch widens until at least one item
// passes THIS check (bin/spor.js's dispatchableQueuePage `eligible` hook). One
// definition, so what the page widens for and what the loop then takes can
// never disagree. Returns null when the item is a candidate, else
// {reason, kind}.
function classifyWorkItem(it, { accept = WORK_DEFAULTS.accept, repos = null, scope = null, graph = null, selfAgent = null } = {}) {
  if (!it || !it.id) return { reason: "not a queue item", kind: "invalid" };
  // The floor under EVERY policy (WORKERS.md §3). selectWorkCandidates checks
  // it first and silently — it is not a policy skip — so this branch is only
  // reached through the page filter.
  if (it.readiness === "human") return { reason: "readiness: human", kind: "human" };
  // Another floor, also held under EVERY policy (task-spor-decline-finding-
  // gates-redispatch): a prior dispatch already declared this exact node's
  // premise wrong and left the standing finding, so an unattended loop must
  // not re-pay the investigation. `it.findings` is rankQueue's own open-
  // findings ride-along (ids only) — already excludes anything superseded or
  // terminal, so a finding since resolved/dismissed is not in the list at all.
  const declined = Array.isArray(it.findings) ? it.findings.find((f) => typeof f === "string" && f.startsWith("find-declined-")) : null;
  if (declined) {
    return {
      reason: `live decline finding ${declined} — a prior dispatch declined this item; resolve/dismiss it, or dispatch --node --force`,
      kind: "declined",
    };
  }
  // Assignee-filtered (issue-spor-auto-route-additive-assignment-two-assignees):
  // a live `assigned -> agent` edge naming an agent that is NOT this box is
  // someone else's work — the auto-route consumer's own re-route target, or a
  // person's manual `assigned -> agent-x` — so this worker must not re-select
  // it, mirroring what the queue's `assignee=me` view already does for a
  // person. `assigned_agents` (lib/kernel/queue.js) is empty/absent for the
  // ordinary case (no agent assignment, or unknown until `selfAgent` is
  // configured — a box with no dispatch identity can't tell "someone else"
  // from "me", so it stays byte-identical and leaves this to the dispatch
  // guards). A node assigned to THIS box (or to nobody) passes through
  // unchanged; checked before the policy/scope checks below since it is a
  // stronger fact than either.
  if (selfAgent && Array.isArray(it.assigned_agents) && it.assigned_agents.length && !it.assigned_agents.includes(selfAgent)) {
    return { reason: `assigned to agent ${it.assigned_agents.filter((a) => a !== selfAgent).join(", ")}`, kind: "assigned-elsewhere" };
  }
  // Empty/absent scope => unscoped, and this check is a no-op, so a bare loop
  // and a factory that declares no repos stay byte-identical.
  // `project` is what rankQueue emits; `repo` is read too because that is the
  // stamp KEY (dec-cc-repo-project-two-layer-identity) and a queue payload
  // spelling it that way must not make the guard fail closed on every item.
  const stamp = it.project ?? it.repo ?? null;
  if (!gates.inRepoScope(stamp, scope || gates.repoScope(repos, graph), graph)) {
    const list = repos || [];
    const label = list.length > 3 ? `${list.slice(0, 3).join(", ")} (+${list.length - 3} more)` : list.join(", ");
    return { reason: `outside the factory's repo scope (${stamp ? `repo ${stamp}` : "no project stamp"}; this factory judges ${label})`, kind: "scope" };
  }
  if (accept !== "open" && it.readiness !== "agent") return { reason: `not agent-ready; work.accept ${accept}`, kind: "policy" };
  return null;
}

// Would this item survive the page-level filter? The predicate form, for the
// queue fetch to widen against.
function pageEligible(it, opts) {
  return classifyWorkItem(it, opts) === null;
}

// A skip reason names ONE item's specifics (the repo it was stamped with, the
// node a refusal spoke about, the detail after a gate/run verdict), so
// aggregating them needs a CLASS. Every cooldown site now stamps a `kind`
// (task-spor-work-loop-extend-cooldown-kinds) — "policy", "scope", "human",
// "invalid" (classifyWorkItem's own vocabulary), "gate" (a gate pipeline
// verdict), "outcome" (a harvested run that did not resolve its target), and
// "refusal" (a dispatch guard declined the item, free text with no fixed
// shape) — so classification is a lookup on `kind` first, and per-kind
// extraction only where the reason still carries a variable detail (gate/
// outcome). String-prefix parsing survives ONLY as the "refusal" fallback:
// a dispatch guard's reason is free text from `spor dispatch`'s own guards
// (bin/spor.js), which has no kind of its own to carry, and as the fallback
// for a bare string passed with no kind at all (back-compat for callers that
// still hand skipClass/summarizeSkips a plain reason).
//
// A dispatch refusal leads with the NODE it is about ("cannot dispatch task-a
// here: this machine can't satisfy profile-x"), so the id sits before the
// first colon and would make every refusal its own class — the one thing an
// aggregate must not do. Drop that prefix and classify by the CAUSE.
const REFUSAL_PREFIX_RE = /^cannot dispatch \S+(?: here)?:\s*/;
// "gate pipeline failed — worktree busy" -> the VERDICT word, dropping the
// per-run detail after the em dash (the generic split below only cuts on
// `;`/`:`, so without this every distinct detail fragments the aggregate).
const GATE_STATE_RE = /^gate pipeline (\S+)/;
// "last run here ended declined (report art-x) — no reason given" -> the
// TERMINAL STATE, same reasoning as the gate extractor above. Non-greedy and
// stopping at a report/detail marker (or the end of the string) rather than
// the next SPACE: unlike a gate verdict, the no-state fallback text this
// builds from ("last run here ended without a verdict", outcomeOf's own
// default) is itself multiple words, and `\S+` would truncate it to "without".
const OUTCOME_STATE_RE = /^last run here ended (.+?)(?:\s\(| —|$)/;
// A preflight workspace/lock refusal (lib/shell/preflight.js checkWorkspace /
// bin/spor.js's candidate-claim race) names the CHECKOUT another launch on
// this box already occupies, never a property of the item being dispatched —
// "task-b" was refused only because "task-a" (this worker's own earlier
// dispatch, under `--concurrency` > 1 with no `dispatch.worktree`, or a
// same-box racer) got there first. Neither refusal carries a structured kind
// through `spor dispatch`'s exit code, so it is recognized from the two exact
// phrasings those call sites share (task-spor-work-loop-workspace-refusal-
// cooldown-on-worker-not-item). The first alternative is scoped to the
// SHARED-checkout wording on purpose: `checkWorkspace`'s `where` also reads
// "the worktree <dir>" when isolation is on, and there each candidate gets
// its OWN tree, so a live writer in one item's worktree says nothing about
// the REST of this pass's candidates the way a shared checkout does — that
// case still falls back to an ordinary item cooldown. The second alternative
// (the pre-launch candidate-claim race) has no such isolation tell in its
// text either way, but only fires when two launches race for the exact same
// path, which this worker's own `active` exclusion already keeps from
// happening against itself — so treating it as worker-scoped too costs at
// most one extra poll interval in the rare cross-process case.
const WORKSPACE_REFUSAL_RE = /the shared checkout .+ already has \d+ live writer\(s\) on this box|another dispatch on this box is launching into /;
function isWorkspaceRefusal(reason) {
  return WORKSPACE_REFUSAL_RE.test(String(reason == null ? "" : reason));
}
// One classifier per kind that has a label independent of the reason's free
// text (policy/scope/human always say the same thing) or narrowly parseable
// from it (gate/outcome). A kind with no entry here — "refusal", "invalid",
// or none at all — falls through to the legacy string parsing, which is
// exactly where a dispatch guard's free-text reason belongs.
const KIND_LABELS = {
  policy: () => "not agent-ready",
  scope: () => "outside the factory's repo scope",
  human: () => "readiness: human",
  declined: () => "live decline finding",
  workspace: () => "shared checkout occupied on this box",
  "assigned-elsewhere": () => "assigned to another agent",
  gate: (reason) => {
    const m = GATE_STATE_RE.exec(String(reason == null ? "" : reason));
    return m ? `gate pipeline ${m[1]}` : "gate pipeline failed";
  },
  outcome: (reason) => {
    const m = OUTCOME_STATE_RE.exec(String(reason == null ? "" : reason));
    return m ? `run ended ${m[1]}` : "run ended without a verdict";
  },
};
// Accepts either a raw reason string (legacy shape, and still how a bare
// dispatch-refusal reason arrives) or a `{reason, kind}` entry (every
// structured cooldown site's own shape — see `cool()`). Object form is tried
// first and, for a recognized kind, never touches the reason text at all.
function skipClass(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const label = KIND_LABELS[entry.kind];
    if (label) return label(entry.reason);
    return skipClass(entry.reason); // unrecognized/absent kind -> legacy parsing below
  }
  let s = String(entry == null ? "" : entry)
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const refusal = s.match(REFUSAL_PREFIX_RE);
  if (refusal) s = s.slice(refusal[0].length).trim() || "dispatch refused";
  return (s.split(/[;:]/)[0].trim() || s || "skipped").slice(0, 60);
}

// "18 not agent-ready, 2 outside the factory's repo scope" — the honest short
// form of a skip list too long to print. Both surfaces that truncate one use
// it: the loop's per-pass stdout log and `spor work --status`.
function summarizeSkips(reasons, { max = 3 } = {}) {
  const counts = new Map();
  for (const r of reasons || []) {
    const cls = skipClass(r);
    counts.set(cls, (counts.get(cls) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown = sorted.slice(0, max).map(([cls, n]) => `${n} ${cls}`);
  const rest = sorted.slice(max).reduce((sum, [, n]) => sum + n, 0);
  if (rest) shown.push(`${rest} other`);
  return shown.join(", ");
}

// The `recent` (done) list's own classifier, mirroring skipClass: the
// terminal state a `done:` line already prints, with the same "(unenforced)"
// qualifier that line appends when the verdict wasn't actually checked.
function recentClass(entry) {
  const state = (entry && (entry.terminal_state || entry.state)) || "unknown";
  return entry && entry.terminal_state && !entry.terminal_enforced ? `${state} (unenforced)` : state;
}

// "15 resolved, 3 reported, 2 failed" — summarizeSkips' twin for the `recent`
// list, so `spor work --status` can say what the entries it doesn't print
// individually actually were, instead of just a bare count
// (issue-spor-cmd-work-status-truncation).
function summarizeRecent(entries, { max = 3 } = {}) {
  const counts = new Map();
  for (const r of entries || []) {
    const cls = recentClass(r);
    counts.set(cls, (counts.get(cls) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown = sorted.slice(0, max).map(([cls, n]) => `${n} ${cls}`);
  const rest = sorted.slice(max).reduce((sum, [, n]) => sum + n, 0);
  if (rest) shown.push(`${rest} other`);
  return shown.join(", ");
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
//   - The record is NOT terminal and has gone SILENT past `idleMs`: idle. The
//     run's own OBSERVED output (`activityAt`, injected — the run store owns
//     what counts, and answers 0 when there is nothing observable) has not
//     moved for longer than a run reasonably goes quiet, so the run is wedged
//     rather than working. Unlike every other arm this one is a verdict ABOUT
//     the run, not just about following it: the caller is expected to stop the
//     session and classify it, which is why the threshold is generous and
//     disabled by default-if-zero.
//   - The record is NOT terminal and has aged past `maxAgeMs`: the watchdog.
//     A native-background run whose harness can no longer be enumerated never
//     reaches a terminal state at all (reconcileRuns leaves such a record
//     alone by design), so without a ceiling one unreadable `claude agents
//     --json` holds that slot for the worker's whole life and the loop
//     silently stops dispatching. Since the supervised default that record can
//     only be one a resumed pipeline adopted (the loop launches none); the
//     ceiling stays as the bound on any run that never ends. Freeing it claims
//     nothing about the run.
//
// `terminalStates` is injected rather than duplicated here — the run store owns
// that vocabulary.
function runHarvest(record, { terminalStates = null, alive = () => false, now = Date.now, maxAgeMs = 0, contractGraceMs = WORK_DEFAULTS.contractGraceMs, idleMs = 0, activityAt = null } = {}) {
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
  // IDLE before the watchdog: both would free the slot, but only this one is a
  // statement about the RUN, and a wedged run should be reported (and stopped)
  // as wedged rather than as one we simply followed for too long.
  //
  // `activityAt` must report OBSERVED output only (the run store's
  // `observedActivityAt`), answering 0 for a run with no channel this box can
  // read — an unbound native-background launch has none. A zero is therefore
  // "we cannot judge this run's silence", never "it has been silent since
  // launch", and it falls through to the watchdog: judging it on the launch
  // timestamp alone would declare every such run wedged the moment the ceiling
  // passed, however healthy it was.
  if (idleMs > 0 && typeof activityAt === "function") {
    const quiet = Number(activityAt(record)) || 0;
    if (quiet > 0 && at - quiet > idleMs) return { terminal: true, why: "idle", quietMs: at - quiet };
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
// A `failed` run produced nothing to gate. A `declined` run — the agent
// declared the ITEM wrong in the fixed form (dispatch-terminal.js parseDecline)
// — is never gated, enforced or not: it claims nothing, its tree is meant to be
// clean, and running it into the review gate's fail-closed empty-diff rule is
// exactly how two honest declines became human escalations
// (task-spor-worker-declined-outcome). Its route is triage: the finding the
// contract filed re-briefs the item.
//
// A THIRD case under `completion.by: controller` (task-spor-factory-
// controller-completion-boundary, FACTORY-IMPLEMENTATION-STAGE.md §4.2 I3):
// the implementer never writes the resolving edge, so its run can never read
// `resolved` — the graph, under the item's execution hold, answers "not
// resolved" and the contract files an ENFORCED `reported`. That run IS the
// candidate submission, and gating it is the whole point of the stage. So a
// record whose claim pins controller completion (`record.impl_claim`) is gated
// on every terminal state but `declined`; the pipeline's own empty-diff and
// dirty-tree refusals judge whether a candidate is actually there. A legacy
// record (no `impl_claim`) reads exactly as before.
function shouldGate(outcome, record = null) {
  if (!outcome || !outcome.terminal_state) return false;
  if (outcome.terminal_state === "declined") return false;
  if (record && controllerRecord(record)) return true;
  if (outcome.terminal_state === "resolved") return true;
  return outcome.terminal_state === "reported" && !outcome.terminal_enforced;
}

function controllerRecord(record) {
  const claim = record && record.impl_claim;
  return !!(claim && typeof claim === "object" && claim.completion && claim.completion.by === "controller");
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

// The runs DEAD workers' published status files say were owed a gate — the
// bridge openPipelineCandidates takes as `owedBy` (run id -> the dead worker's
// factory, null when its record names none), for the one legacy shape the
// journals cannot witness: a run dispatched by a gate-armed worker from before
// the `gate_factory` stamp, whose pipeline never started (no lease, no
// journal) before that worker was replaced (issue-spor-loop-scan-orphans-
// legacy-gating-slot). The rule is the deleted `resumableSlots`':
//   - a `gating` slot is SELF-EVIDENCING — it could not exist without a
//     pipeline — so it counts even when the record carries no `gates` tally
//     (hand-mangled, or a shape that never wrote one);
//   - an `active` slot counts only when the dead worker's own record says it
//     ran gate-armed (`gates`, written iff `deps.gate` was present). EVERY
//     worker publishes `active`, bare ones included, and a bare worker's runs
//     were never owed a gate — adopting them would let a later gate-armed
//     worker judge, block and roll back items nobody meant to gate.
// A live worker's slots are its own, never evidence here (its lease or its
// own harvest covers them). The first dead worker naming a run wins.
// Each value is {factory, slot}: the dead worker's factory and WHICH slot kind
// was the evidence — a `gating` slot is a pipeline that was in flight, an
// `active` one only a tally's inference, so a foreign-factory report is made
// for the first and held back for the second (the noise the orchestrator
// asked cut, task-spor-fold-gate-and-integration-into-one-workflow).
const SLOT_HEARTBEAT_STALE_MS = 30 * 60 * 1000; // stage-projection.js PIPELINE_LEASE_TTL_MS; spelled here so this module stays a pure decision over statuses

function owedByDeadWorkers(statuses) {
  const owedBy = new Map();
  for (const w of statuses || []) {
    if (!w || w.live) continue;
    for (const slot of w.gating || []) if (slot && slot.run_id && !owedBy.has(slot.run_id)) owedBy.set(slot.run_id, { factory: w.factory || null, slot: "gating" });
    if (!w.gates) continue;
    for (const slot of w.active || []) if (slot && slot.run_id && !owedBy.has(slot.run_id)) owedBy.set(slot.run_id, { factory: w.factory || null, slot: "active" });
  }
  return owedBy;
}

// The run ids LIVE workers' published slots name — `openPipelines`'
// `liveSlots`: a run with no lease yet that a live worker holds is its own.
// A published slot EXPIRES (task-spor-fold-gate-and-integration-into-one-
// workflow): a worker that is alive by pid but has stopped publishing — hung
// inside a pass — used to hold a lease-less run forever, since a pid never
// ages. Its status file's `updated_at` is its heartbeat (the loop rewrites it
// every pass), so a slot is honored only while that is inside `staleMs` —
// the pipeline lease TTL, the same horizon a claimed pipeline gets.
function liveWorkerSlots(statuses, { now = Date.now, staleMs = SLOT_HEARTBEAT_STALE_MS } = {}) {
  const owned = new Set();
  const at = now();
  for (const w of statuses || []) {
    if (!w || !w.live) continue;
    const beat = Date.parse(w.updated_at || w.started_at || "") || 0;
    if (staleMs > 0 && beat && at - beat > staleMs) continue;
    for (const slot of [...(w.gating || []), ...(w.active || [])]) if (slot && slot.run_id) owned.add(slot.run_id);
  }
  return owned;
}

// OPEN gate pipelines on this box (task-spor-delete-loop-resume-machinery-
// after-workflow-stages, WORKERS.md §10.8) — ONE scan over the stage journals,
// replacing the worker-status-file join (`orphanedGateRuns`/`resumableSlots`),
// the in-process parked re-offer, and the `running`/`interrupted` record
// stamps that used to carry the same facts.
//
// A gate pipeline is an async job the WORKER PROCESS owns, so a worker that is
// stopped or killed abandons whatever it was gating; and a pipeline that
// YIELDS (`interrupted`: a stop inside a wait, evidence it could not yet
// publish, a reviewer's stated reset) parks its journal on a durable timer and
// frees its slot. Either way the run is terminal and (for a `resolved` one)
// out of every queue, so nothing comes back to it unless a worker scans for
// it. Every gated run has a durable stage journal and a pipeline LEASE log
// beside it (stage-projection.js), so the scan is over those; the record's
// final verdict decides only whether there is anything left to judge.
//
// `candidates` is stage-projection.js openPipelineCandidates' output —
// [{record, projection, lease, factory}] for every run something says was
// owed a gate (a lease claimed, a stage journal, a `gate_factory` stamped at
// a gate-armed worker's dispatch; a hand-run `spor dispatch` has none and is
// never one). One is OPEN, and adopted, when:
//   - its record carries a claim worth gating (shouldGate) and no SETTLED
//     verdict (gates.SETTLED_GATE_STATES);
//   - it was started by THIS factory, or one it was renamed from
//     (`factoryAliases`, issue-spor-factory-rename-strands-pipelines) — an
//     orphan of another factory is reported through `onForeign`, never adopted
//     (issue-spor-work-scope-union-factory-mismatch: a resumed pipeline never
//     goes through selection, so the repo-scope guard would otherwise have a
//     back door into another factory's repo). A pipeline whose factory is
//     unknown (a journal with no lease, from before the lease log) keeps the
//     pre-existing behavior and is adopted;
//   - its node has no NON-terminal run record (`busyNodes`: a fix cycle this
//     pipeline dispatched may still be in the run's own checkout, and a
//     resumed pipeline re-dispatches with `--force --no-worktree`; the orphan
//     is deferred, not dropped — once that run goes terminal the next pass
//     adopts it; a record aged past `maxAgeMs` is not evidence of a live agent);
//   - its lease is not HELD — released by a yield, expired, or held by a worker
//     that is not live on this box (`ownerLive`, the worker status files) — so
//     two workers never drive one journal. A lease nobody can READ is nobody's
//     to take. With NO lease, a run a live worker's published slot names
//     (`liveSlots`) is that worker's;
//   - a PARKED journal's own timer is DUE (`projection.current.due`): a
//     reviewer pause wakes at its stated reset, an ordinary yield after the
//     workflow's short timer — the journal is the schedule, the loop has none;
//   - it is inside `maxAgeMs` of the run's end, or of its pause's wake (a
//     two-day quota pause must not be dropped by the very scan that must
//     resume it).
// Each entry carries how many times the parked journal yielded identically in
// a row (`reoffers`, read off the journal) and, at `parkedReofferMax`,
// `escalate: true` — the loop then files the re-offer cap's escalation
// instead of re-offering (task-spor-work-loop-parked-reoffer-cap).
function openPipelines(candidates, { records = null, now = Date.now, maxAgeMs = 0, terminalStates = null, factory = null, factoryAliases = [], ownerLive = () => false, liveSlots = null, onForeign = null, parkedReofferMax = 0 } = {}) {
  const projectionLib = require("./stage-projection.js");
  const at = now();
  const acceptedFactories = factory ? new Set([factory, ...factoryAliases]) : null;
  // Nodes an agent may still be working.
  const busyNodes = new Set();
  const all = !records ? [] : Array.isArray(records) ? records : typeof records.values === "function" ? [...records.values()] : [];
  if (terminalStates) {
    for (const r of all) {
      if (!r || !r.node_id || terminalStates.has(r.state)) continue;
      const started = Date.parse(r.created_at || r.started_at || r.launched_at || "") || 0;
      if (maxAgeMs > 0 && started && at - started > maxAgeMs) continue;
      busyNodes.add(r.node_id);
    }
  }
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const record = c && c.record;
    if (!record || !record.run_id || !record.node_id || seen.has(record.run_id)) continue;
    seen.add(record.run_id);
    if (record.gate_state && gates.SETTLED_GATE_STATES.has(record.gate_state)) continue;
    if (!shouldGate(record, record)) continue;
    const pipelineFactory = c.factory || (c.lease && c.lease.factory) || record.gate_factory || (record.impl_claim && record.impl_claim.factory && record.impl_claim.factory.node_id) || null;
    if (acceptedFactories && pipelineFactory && !acceptedFactories.has(pipelineFactory)) {
      // Reported only for a run SOMETHING witnessed a pipeline for (a lease, a
      // journal, a gate-armed dispatch, a dead worker's `gating` slot); a dead
      // worker's `active` slot is a tally's inference and is skipped in silence.
      if (onForeign && !(c.owedSlot === "active" && !c.lease && !(c.projection && c.projection.stages && c.projection.stages.length) && !record.gate_factory)) onForeign({ run_id: record.run_id, node_id: record.node_id, factory: pipelineFactory });
      continue;
    }
    if (busyNodes.has(record.node_id)) continue;
    if (c.leaseError) continue;
    // A journal nobody can read is nobody's to drive either: adopting it would
    // fail the open and settle a merely torn journal as `failed`. It is
    // reported by `spor runs` (projectRun.unreadable), never adopted.
    if (c.projection && Array.isArray(c.projection.unreadable) && c.projection.unreadable.length) continue;
    if (c.lease && projectionLib.leaseHeld(c.lease, { now, ownerLive })) continue;
    // No lease yet: the only claim on the run is a LIVE worker's published
    // slot — its dispatch went terminal and its own harvest has not started
    // the pipeline yet (or a worker from before the lease log is driving it).
    // That worker's, not an orphan; the deleted join excluded it the same way.
    if (!c.lease && liveSlots && liveSlots.has(record.run_id)) continue;
    const p = c.projection || null;
    const current = p && p.current && (p.current.status === "running" || p.current.status === "parked") ? p.current : null;
    const parked = current && current.status === "parked" ? current : null;
    if (parked && parked.due && at < parked.due) continue;
    const yielded = parked && parked.parked ? parked.parked : null;
    const pausedUntil = yielded && yielded.paused_until ? (typeof yielded.paused_until === "number" ? yielded.paused_until : Date.parse(yielded.paused_until) || 0) : 0;
    // `gate_paused_until` is a pre-journal pipeline's pause, stamped on the
    // record by the deleted parked re-offer: read-only, it still ages the run
    // from its wake.
    const ended = Math.max(Date.parse(record.finished_at || record.created_at || "") || 0, pausedUntil, parked ? Number(parked.due) || 0 : 0, Date.parse(record.gate_paused_until || "") || 0);
    if (maxAgeMs > 0 && ended && at - ended > maxAgeMs) continue;
    const reoffers = parked ? Number(parked.reoffers) || 0 : 0;
    // The pipeline ATTEMPT the open journal belongs to — the one a `--regate`
    // opened (gate_regate_count + 1), or 0 for a work loop's own — so an
    // adopted re-gate continues ITS journal (`gates-a<n>`), never a0's
    // (cmdWorkRegate's own reading of a resume).
    const regateCount = projectionLib.pipelineAttempt(record, c.lease);
    out.push({
      run_id: record.run_id,
      node_id: record.node_id,
      harness: record.harness || null,
      project: record.item_repo || null,
      attempt: regateCount ? regateCount + 1 : 0,
      record,
      stage: current ? current.stage : null,
      reoffers,
      reason: yielded ? yielded.reason || null : null,
      escalate: !!(parked && parkedReofferMax > 0 && reoffers >= parkedReofferMax),
    });
  }
  return out;
}

// task-spor-gate-escalation-bounded-auto-retry, dec-spor-gate-refusal-atomic-
// escalate-then-demote. A refusal whose escalation write failed SETTLES
// anyway (gate_escalation_failed:true) rather than staying open for the
// resume scan above — re-running the whole pipeline to retry one write would re-dispatch
// a suite or a review against a tree that has moved on, for a failure that
// was never the item's. This is the lightweight door instead: pick out this
// box's own SETTLED-but-unescalated run records that are due another
// attempt, so the caller can retry ONLY `deps.escalate`+`deps.demote` — both
// already idempotent by id/status, so a retry can only ever finish what the
// first attempt started, never double-file or double-demote.
//
// `records` is a plain array: nothing here needs to look one up by id, only
// to filter and sort the whole set. Bounding how many are worked in one pass
// is the caller's call (openPipelines leaves "how many to adopt this pass" to
// the loop the same way).
function pendingEscalationRetries(records, { now = Date.now } = {}) {
  const at = now();
  const out = [];
  for (const record of records || []) {
    if (!record || !record.run_id || !record.node_id) continue;
    // Not settled, already escalated, or this box already gave up loudly:
    // nothing left for this scan to do.
    if (!record.gate_escalation_failed || record.gate_escalated_to) continue;
    if (record.gate_escalation_retry_exhausted) continue;
    if (!record.gate_escalation_pending) continue; // nothing to replay (e.g. a blocked human gate)
    const dueAt = Date.parse(record.gate_escalation_retry_at || "") || 0;
    if (dueAt && at < dueAt) continue;
    out.push({ run_id: record.run_id, node_id: record.node_id, attempts: Number(record.gate_escalation_retry_count) || 0, record });
  }
  return out;
}

// The backoff between escalation-retry attempts: doubling from `backoffMs`,
// capped at `maxBackoffMs` — generous on purpose (WORK_DEFAULTS above), since
// the ordinary cause is the graph being unreachable for a while.
function nextEscalationRetryDelay(attempts, backoffMs = WORK_DEFAULTS.escalationRetryBackoffMs, maxBackoffMs = WORK_DEFAULTS.escalationRetryMaxBackoffMs) {
  const n = Math.max(0, Number(attempts) || 0);
  const base = Math.max(0, Number(backoffMs) || WORK_DEFAULTS.escalationRetryBackoffMs);
  const cap = Math.max(base, Number(maxBackoffMs) || WORK_DEFAULTS.escalationRetryMaxBackoffMs);
  return Math.min(cap, base * Math.pow(2, n));
}

// Fold one terminal run record into the worker's counters. The outcome
// dimension is the run's (WORKERS.md §8) — read, never recomputed. `unenforced`
// is a CROSS-CUTTING tally over the four verdict buckets, not a fifth bucket:
// every unenforced run is also counted under its own verdict, and the pair is
// rendered "failed 3 (3 unenforced)" so a box whose server was unreachable
// cannot read as a box that verified anything
// (dec-spor-dispatch-terminal-states-supervised-first). Sum the four verdicts
// for a total; never add `unenforced` to them.
function outcomeOf(record) {
  const state = record && typeof record.terminal_state === "string" ? record.terminal_state : null;
  const enforced = !!(record && record.terminal_enforced);
  // WHICH CLASS this run's ending falls in, read through the one shared
  // classifier (kernel/gates.js `classifyExecutionOutcome`,
  // FACTORY-IMPLEMENTATION-STAGE.md §5.3). It is a READING, never a charge —
  // the pools are spent by the pipeline that owns the dispatch — but a worker
  // whose runs are dying on credit exhaustion must not read as a worker whose
  // code keeps failing, on `--status` or in the log. Additive, like every
  // other field here (WORKERS.md §8).
  const execution = record ? gates.classifyExecutionOutcome(record, null) : { outcome: "completed" };
  return {
    run_id: (record && record.run_id) || null,
    node_id: (record && record.node_id) || null,
    harness: (record && record.harness) || null,
    state: (record && record.state) || null,
    terminal_state: state,
    terminal_enforced: enforced,
    ...(record && record.resolved_by ? { resolved_by: record.resolved_by } : {}),
    ...(record && record.report_node_id ? { report_node_id: record.report_node_id } : {}),
    ...(record && record.declined_reason ? { declined_reason: String(record.declined_reason).slice(0, 300) } : {}),
    ...(record && record.finding_node_id ? { finding_node_id: record.finding_node_id } : {}),
    ...(record && record.terminal_note ? { note: String(record.terminal_note).slice(0, 300) } : {}),
    // Omitted for a run that simply ended cleanly — the ordinary case carries
    // no class, so the field appears only when it says something.
    ...(execution.outcome === "completed" ? {} : { execution_class: execution.outcome }),
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
//   pendingGates()      -> [{run_id, node_id, harness, record, reoffers,
//                            reason, escalate}]  (OPTIONAL, gate-armed workers
//                                         only: the OPEN pipelines on this box
//                                         that are due — openPipelines over
//                                         the stage journals — for step 3a)
//   markGate(runId, patch) -> record     (OPTIONAL: stamp a SETTLED verdict
//                                         onto the run record — the final
//                                         outcome; never a transitional state)
//   renewGates(runIds)  -> void          (OPTIONAL: renew the pipeline leases
//                                         this worker is driving, once a pass)
//   runRecord(runId)    -> record|null   (OPTIONAL: the run record as it reads
//                                         now, for the exit-time notice)
//   retryEscalations()  -> Promise<void> (OPTIONAL, gate-armed workers only:
//                                         re-attempt any failed gate
//                                         escalation WRITE this box's journal
//                                         is due to retry — never the
//                                         pipeline that produced it — step 1e)
//   escalateParked({run_id, node_id, project, reason, count, record})
//                       -> Promise<{ok, id, demoted?, reason?}> (OPTIONAL,
//                                         gate-armed workers only: file the
//                                         `requires: [human]` item for a
//                                         pipeline whose journal yielded
//                                         identically `parkedReofferMax`
//                                         times in a row (pendingGates says
//                                         `escalate`); absent, a parked
//                                         pipeline is re-offered without bound)
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
  // cmdWork already refused an unknown value loudly; anything else that drives
  // this loop directly normalizes to the DEFAULT — the strict policy, so a
  // mistyped opt can only skip more, never dispatch untriaged work.
  const accept = WORK_ACCEPT_POLICIES.includes(opts.accept) ? opts.accept : WORK_DEFAULTS.accept;
  // The factory's declared repo scope (issue-spor-work-scope-union-factory-
  // mismatch), empty for a bare loop or an unscoped factory — in which case
  // every use of it below is inert. `let`, not `const` (task-spor-work-
  // factory-reload-extend-to-repo-scope): the reload step below (0.) swaps
  // these in from `deps.reloadFactory()`'s result whenever the caller
  // (cmdWork) recomputed them off a live `repos:` edit, so a factory
  // widened or narrowed mid-run reaches `selectWorkCandidates` and the
  // scope-starvation notice on the very next pass — not just the gate
  // knobs task-spor-work-reload-factory-definition-per-pass already covers.
  let repos = Array.isArray(opts.repos) ? opts.repos.filter(Boolean) : [];
  // A local-mode graph, loaded once by the caller (cmdWork) and passed
  // through so historical `project:` stamps resolve against the scope above
  // via `graph.projectAliases` (task-spor-factory-alias-resolution-local-
  // mode). Null in remote mode, or when no factory declared a scope — either
  // way every downstream use stays the byte-identical raw-stamp comparison.
  // Also refreshed by the reload step below, alongside `repos`.
  let graph = opts.graph || null;
  // This box's own agent identity (issue-spor-auto-route-additive-assignment-
  // two-assignees), threaded through so the loop's OWN re-check agrees with
  // the page fetch's `eligible` hook it mirrors — see classifyWorkItem. Null
  // (the default) leaves the assignee filter a no-op, byte-identical to
  // before it existed.
  const selfAgent = opts.selfAgent || null;
  // `--restart-on-land` (task-spor-work-announce-lib-commit-and-notice-main-
  // moved): opt-in, for a self-hosting factory whose worker runs from the very
  // checkout its own pipelines land onto. When `deps.noticeCode` reports the
  // loaded code moved past, the loop stops TAKING work and exits once every
  // run and gate pipeline in flight has settled — a supervisor (systemd,
  // a shell loop) then restarts it on the new code. It is a drain, not a
  // stop: an in-process gate pipeline abandoned by a stop would be resumed
  // from gate 0 by the restarted worker, so the loop waits it out instead.
  // Off by default and byte-identical off: the latch below is only ever set
  // when this is on.
  const restartOnLand = !!opts.restartOnLand;
  let landed = null; // the tip the loaded code was moved past, once seen — latched, never cleared
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});

  const status = {
    worker_id: opts.workerId,
    pid: opts.pid ?? process.pid,
    started_ticks: opts.startedTicks ?? null,
    state: "polling",
    project: opts.project || null,
    accept,
    concurrency,
    interval_ms: intervalMs,
    max_interval_ms: maxIntervalMs,
    max: max || null,
    once: !!opts.once,
    ...(restartOnLand ? { restart_on_land: true } : {}),
    started_at: new Date(now()).toISOString(),
    updated_at: new Date(now()).toISOString(),
    dispatched: 0,
    outcomes: { resolved: 0, reported: 0, failed: 0, declined: 0, unenforced: 0 },
    // The gate pipeline's own tally, kept APART from the run outcomes above for
    // the same reason `unenforced` is: a run that resolved its target and a
    // gate that then refused it are two different facts, and folding them would
    // let a box read as productive while every gate it ran said no.
    ...(deps.gate
      ? {
          gates: {
            passed: 0,
            failed: 0,
            blocked: 0,
            parked: 0,
            superseded: 0,
            scoped: 0,
            mismatch: 0,
            // Which revision of the factory node is currently judging (task-
            // spor-work-reload-factory-definition-per-pass) — the blob sha the
            // caller resolved at startup, refreshed every pass by
            // `deps.reloadFactory` below. `factory_error` names the last
            // rejected reload's problem, cleared the moment a later reload
            // parses clean; both are null on a bare worker (deps.reloadFactory
            // absent) and on a worker whose factory has never failed to reload.
            factory_revision: opts.factoryRevision || null,
            factory_error: null,
          },
          factory: opts.factory || null,
          ...(repos.length ? { repos } : {}),
        }
      : {}),
    active: [],
    gating: [],
    recent: [],
    skipped: [],
    // The worker-scoped twin of `skipped` above (task-spor-work-loop-
    // workspace-refusal-cooldown-on-worker-not-item): a workspace/lock refusal
    // is never cooled onto the item that hit it (see the dispatch loop below),
    // so it would otherwise be invisible to `spor work --status` — this is
    // the last one this worker hit, cleared at the top of every pass that
    // attempts new candidates, so it reads null once the checkout frees up.
    workspace_wait: null,
    next_poll_at: null,
    stopped_at: null,
    stop_reason: null,
  };
  const skipped = new Map(); // node id -> {reason, kind, until, at}
  let scopeStarvedWarned = false;
  // Which cooldown to drop when the map is full. NOT simply the oldest: a
  // POLICY, SCOPE or DECLINED cooldown only quiets the log — the same page
  // recomputes it for free next poll (a decline verdict is derived purely
  // from `it.findings`, already on the page, task-spor-decline-finding-gates-
  // redispatch) — while a REFUSAL cooldown is the only thing standing between
  // this worker and re-running a dispatch that already failed. The page can
  // now be widened to 200 (bin/spor.js's dispatchableQueuePage) while this map
  // holds 50, so a page of untriaged items would otherwise evict the very
  // refusal that made the page widen, and the refuser would be re-dispatched
  // every other poll instead of once per retryAfterMs. Evict the oldest CHEAP
  // entry, and only fall back to the oldest of any kind when every one of
  // them is load-bearing.
  const CHEAP_SKIPS = new Set(["policy", "scope", "declined"]);
  const evictOneSkip = () => {
    let oldest = null;
    for (const [id, s] of skipped) {
      if (oldest === null) oldest = id;
      if (CHEAP_SKIPS.has(s.kind)) {
        skipped.delete(id);
        return;
      }
    }
    if (oldest !== null) skipped.delete(oldest);
  };
  // Cool an item off: not dispatchable by THIS worker until `until`. Delete
  // before set so re-cooling an item moves it to the END — the map is then
  // ordered oldest-refresh-first, which is what the SKIP_CAP eviction above
  // relies on (a plain re-set keeps the original position, so the item being
  // refused most often would be the first evicted).
  const cool = (id, reason, forMs = retryAfterMs, kind = "refusal") => {
    if (!id) return;
    skipped.delete(id);
    skipped.set(id, { reason, kind, at: new Date(now()).toISOString(), until: now() + Math.max(retryAfterMs, forMs) });
    while (skipped.size > SKIP_CAP) evictOneSkip();
  };
  const publish = (state) => {
    if (state) status.state = state;
    status.updated_at = new Date(now()).toISOString();
    status.skipped = [...skipped.entries()]
      .map(([id, s]) => ({ id, reason: s.reason, kind: s.kind, at: s.at, until: new Date(s.until).toISOString() }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (deps.publish) deps.publish(status);
  };
  const stopping = () => !!control.stopping;
  // Gating slots with a pipeline in flight in THIS process. A pipeline that
  // yields frees its slot (settleGates below) — the journal is parked, not the
  // worker — so every slot here is one a live job holds.
  const gatingInFlight = () => status.gating.length;

  // In-flight gate pipelines, by run. The pipeline is an async job this process
  // owns (unlike a dispatched run, which is a detached process with its own
  // contract), so the loop keeps a handle and polls it at each pass boundary
  // rather than awaiting it inline — a gate that waits a day on a human
  // approval must not stop the worker from harvesting everything else.
  const gateJobs = new Map(); // run_id -> {done, result, error}
  // Stamp a SETTLED verdict onto the RUN RECORD — the final outcome, the one
  // thing about a pipeline the record still carries (the journals hold the
  // rest, stage-projection.js). Optional and best-effort by contract, exactly
  // like the status file: a journal that cannot be written must not stop the
  // gate from running. Never a transitional state: a pipeline that is running
  // is a held lease, one that yielded is a parked journal.
  const markGate = (runId, patch) => {
    if (!deps.markGate || !runId) return null;
    try {
      return deps.markGate(runId, { gate_at: new Date(now()).toISOString(), gate_worker: opts.workerId || null, ...patch });
    } catch {
      /* the verdict still stands; the resume scan re-offers an unsettled run */
      return null;
    }
  };
  const startGate = (slot, record) => {
    const job = { done: false, result: null, error: null, record };
    gateJobs.set(slot.run_id, job);
    // The pipeline claims its lease atomically before its first mutation.
    // An observer must not pre-stamp (and replace) another worker here.
    Promise.resolve()
      .then(() =>
        deps.gate(
          // `resumed` rides only on an adopted pipeline: the pipeline's
          // supersession check (gate-workflow.js) keys on it, and a pipeline
          // this worker starts off its own harvest is called exactly as before.
          { run_id: slot.run_id, node_id: slot.node_id, harness: slot.harness || null, project: slot.project || opts.project || null, ...(slot.attempt ? { attempt: slot.attempt } : {}), ...(slot.resumed ? { resumed: true } : {}) },
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

  // The re-offer cap's escalation (task-spor-work-loop-parked-reoffer-cap),
  // run as the slot's gate job so the settle pass folds it exactly like a
  // pipeline verdict: filed, it reads `blocked` (settled — the resume scan
  // never re-offers it, the node cools, `spor work --regate` is the door back);
  // not filed, it reads as an unsettled `interrupted` again — the journal is
  // still parked, so the scan re-offers it and, the count unchanged, this
  // escalation is tried again.
  const startEscalation = (slot, record, { reason, count }) => {
    const job = { done: false, result: null, error: null, record, escalation: true };
    gateJobs.set(slot.run_id, job);
    const unfiled = (why) => ({ state: "interrupted", reason, escalation_error: String(why || "no response").slice(0, 300) });
    Promise.resolve()
      .then(() => deps.escalateParked({ run_id: slot.run_id, node_id: slot.node_id, project: slot.project || opts.project || null, reason, count, record, worker: opts.workerId || null }))
      .then(
        (r) => {
          job.result =
            r && r.ok && r.id
              ? {
                  state: "blocked",
                  reason: `re-offered ${count} time(s), interrupted identically each time — ${reason}`,
                  escalated_to: r.id,
                  ...(r.demoted != null ? { demoted: !!r.demoted } : {}),
                  ...(r.demote_reason ? { demote_reason: r.demote_reason } : {}),
                }
              : unfiled(r && r.reason);
        },
        (e) => {
          job.result = unfiled(e && e.message ? e.message : e);
        }
      )
      .then(() => {
        job.done = true;
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
      // A pipeline that LOST the settle race (`superseded`: another pipeline
      // for the same run settled the record first) found a verdict the record
      // does not hold. The status surface is read as "what the run record
      // says" (`spor work --status`), so it publishes the RECORD's verdict and
      // head — carried back as `res.settled` — never the loser's, and stamps
      // nothing: the loser owns no field on that record (cross-model review,
      // major finding 4). What the loser found is kept beside it, labeled.
      const superseded = !!(res && res.superseded);
      const truth = superseded ? res.settled || null : null;
      const state = superseded ? (truth && truth.state) || "superseded" : res && res.state ? res.state : "failed";
      const reason = superseded
        ? truth && truth.reason
          ? String(truth.reason).slice(0, 300)
          : null
        : res && res.reason
        ? String(res.reason).slice(0, 300)
        : null;
      // An `interrupted` pipeline settled NOTHING: no fact, no escalation, no
      // demotion, no attestation. Its JOURNAL is parked on its own durable
      // timer (a stop inside a wait, evidence the pass could not yet publish,
      // a reviewer's stated reset — whose `paused_until` IS the timer) and its
      // lease is released, so the slot is FREED here and the resume scan
      // (step 3a, openPipelines) re-offers it — to this worker or the next —
      // once the timer is due. Nothing is stamped on the record (it carries
      // only final outcomes), and there is no cooldown either: nothing refused
      // the node, and its open journal keeps it out of selection. The
      // re-offer cap counts the journal's own consecutive identical yields
      // (task-spor-work-loop-parked-reoffer-cap); an escalation that could
      // not be filed reads as the same interruption and is tried again on the
      // next re-offer.
      if (!superseded && state === "interrupted") {
        const pausedUntil = Number(res && res.paused_until) > now() ? Number(res.paused_until) : 0;
        const pauseIso = pausedUntil ? new Date(pausedUntil).toISOString() : null;
        const held = status.recent.find((r) => r.run_id === g.run_id);
        if (held) {
          held.gate = state;
          held.gate_reason = reason;
          if (pauseIso) held.paused_until = pauseIso;
          else delete held.paused_until;
          if (res && res.gates) held.gates = res.gates;
        }
        const who = g.node_id || g.run_id.slice(0, 8);
        if (job && job.escalation) log(`work: ${who} — the re-offer cap's escalation could not be filed (${(res && res.escalation_error) || "no response"}); the next re-offer tries it again`);
        else if (pauseIso) log(`work: ${who} gates paused until ${pauseIso}${reason ? ` — ${reason}` : ""} — nothing settled; slot freed, re-offered then`);
        else log(`work: ${who} gates interrupted${reason ? ` — ${reason}` : ""} — nothing settled; slot freed, re-offered once its journal is due`);
        continue;
      }
      if (status.gates && status.gates[state] != null) status.gates[state] += 1;
      if (superseded && status.gates && state !== "superseded" && status.gates.superseded != null) status.gates.superseded += 1;
      // The escalation id and whether the item was demoted ride along on the
      // run record: a later `spor work --regate` of this run closes that
      // escalation and restores that status when the re-judgement passes.
      //
      // `gate_escalation_failed` is the third of those: a refusal whose
      // escalation never landed left NOTHING on the graph — no blocker, and
      // (by task-spor-gate-escalation-demote-atomic) no demotion either — so
      // the verdict is settled here but the refusal is unrecorded where anyone
      // but this box can read it. The verdict stays SETTLED deliberately: the
      // resume scan re-runs a whole pipeline (suite, review dispatch, forced
      // fix cycles into the run's own checkout) and offers a run again on
      // every pass, so a non-settled stamp here would re-gate this run in a
      // loop for as long as the graph stayed unwritable. `gate_escalation_pending`
      // is the UNATTENDED recovery door (task-spor-gate-escalation-bounded-
      // auto-retry): the exact args the escalate call needs, so
      // pendingEscalationRetries below can retry ONLY that write — never the
      // whole pipeline — on a backoff, without waiting on a person to run
      // `spor work --regate <run>` (still there, and still the only door once
      // the bounded auto-retry gives up).
      if (!superseded) {
      markGate(g.run_id, {
        gate_state: state,
        ...(reason ? { gate_reason: reason } : {}),
        ...(res && res.escalated_to ? { gate_escalated_to: res.escalated_to, gate_escalation_ids: [res.escalated_to] } : {}),
        ...(res && Array.isArray(res.failing_tests) ? { gate_failing_tests: res.failing_tests } : {}),
        ...(res && res.empty_diff ? { gate_empty_diff: true } : {}),
        ...(res && res.demoted != null ? { gate_demoted: !!res.demoted } : {}),
        ...(res && res.escalation_failed ? { gate_escalation_failed: true } : {}),
        ...(res && res.escalation_retry ? { gate_escalation_pending: res.escalation_retry, gate_escalation_retry_count: 0 } : {}),
        // A park whose demotion did not land (the tracker filed but the
        // rollback's write failed, §10.9) owes it to a later proposal pass —
        // checkProposals retries on this flag and clears it once it lands.
        ...(state === "parked" && res && res.escalated_to && res.demote_reason ? { gate_demote_pending: true } : {}),
        ...(res && Array.isArray(res.rescues) && res.rescues.length ? { gate_rescues: res.rescues.length } : {}),
        // A refused attempt's reading, one vocabulary for every stage
        // (stage-workflow.js refusalSurface).
        ...(refusalSurface(res) ? { gate_refusal: refusalSurface(res) } : {}),
      });
      }
      const entry = status.recent.find((r) => r.run_id === g.run_id);
      if (entry) {
        entry.gate = state;
        entry.gate_reason = reason;
        if (superseded) {
          entry.superseded = true;
          entry.superseded_verdict = { state: (res && res.state) || "failed", head: (res && (res.gate_head || res.head)) || null };
          if (truth && truth.worker) entry.gate_worker = truth.worker;
          if (truth && truth.head) entry.gate_head = truth.head;
          if (truth && truth.attestation) entry.attestation = truth.attestation;
          if (truth && truth.attestation_missing) {
            entry.attestation_missing = true;
            if (truth.attestation_error) entry.attestation_error = String(truth.attestation_error).slice(0, 300);
          }
          if (truth && truth.proposal_attestation_stale) {
            entry.proposal_attestation_stale = true;
            if (truth.proposal_attestation_error) entry.proposal_attestation_error = String(truth.proposal_attestation_error).slice(0, 300);
          }
          if (truth && truth.refusal) entry.refusal = truth.refusal;
        } else {
          // A refused attempt (stage-workflow.js): the same reading the run
          // record carries as `gate_refusal`, rendered by `--status`.
          if (refusalSurface(res)) entry.refusal = refusalSurface(res);
          if (res && res.gates) entry.gates = res.gates;
          if (res && res.escalated_to) entry.escalated_to = res.escalated_to;
          if (res && res.demoted != null) entry.demoted = !!res.demoted;
          if (res && res.demote_reason) entry.demote_reason = String(res.demote_reason).slice(0, 300);
          if (res && res.escalation_failed) entry.escalation_failed = true;
          if (res && Array.isArray(res.rescues) && res.rescues.length) entry.rescues = res.rescues.length;
        // The implementation stage's own verdict when the pipeline settled
        // there (task-spor-factory-implementation-stage-runner): `exhausted`,
        // `escalated`, `declined`, `unroutable` — a refusal that never reached
        // a gate, which `--status` must not render as a gate's.
          if (res && res.stage) entry.stage = String(res.stage).slice(0, 40);
          if (res && res.gates) entry.gates = res.gates;
          if (res && res.attestation) entry.attestation = res.attestation;
          // A promised attestation that is MISSING, or a parked PR whose body
          // could not be refreshed with the bound copy, is part of the
          // verdict's evidence the status surface must show (cross-model
          // review, minor finding 8) — the same stamps `spor runs` renders.
          if (res && res.attestation_missing) {
            entry.attestation_missing = true;
            if (res.attestation_error) entry.attestation_error = String(res.attestation_error).slice(0, 300);
          }
          if (res && res.proposal_attestation_stale) {
            entry.proposal_attestation_stale = true;
            if (res.proposal_attestation_error) entry.proposal_attestation_error = String(res.proposal_attestation_error).slice(0, 300);
          }
          // The head the GATES judged (review finding 6): with an integration
          // stage folded in, `res.head` is the stage's own re-read head and the
          // gated head rides as `gate_head` — the status surface must say what
          // the run record says.
          if (res && (res.gate_head || res.head)) entry.gate_head = res.gate_head || res.head;
          if (res && res.escalated_to) entry.escalated_to = res.escalated_to;
          if (res && res.demoted != null) entry.demoted = !!res.demoted;
          if (res && res.demote_reason) entry.demote_reason = String(res.demote_reason).slice(0, 300);
        }
      }
      // The cooldown follows the RECORD's verdict too: a winner's `failed`
      // cools the node even if the loser found `passed`, and a record whose
      // verdict cannot be read cools it (the safe direction).
      if (state !== "passed" && state !== "superseded" && g.node_id) {
        cool(g.node_id, `gate pipeline ${state}${reason ? ` — ${reason}` : ""}${superseded ? " (settled by another pipeline for this run)" : ""}`, undefined, "gate");
      }
      log(
        superseded
          ? res && res.owner_lost && !(truth && truth.worker)
            ? `work: ${g.node_id || g.run_id.slice(0, 8)} gates ${state} — this pipeline's lease was taken over mid-drive; it wrote nothing more and the pipeline is its current holder's`
            : `work: ${g.node_id || g.run_id.slice(0, 8)} gates ${state}${truth && truth.worker ? ` (settled by ${truth.worker})` : " (settled by another pipeline)"} — this pipeline's '${(res && res.state) || "failed"}' verdict was superseded and is not recorded`
          : `work: ${g.node_id || g.run_id.slice(0, 8)} gates ${state}${reason ? ` — ${reason}` : ""}`
      );
    }
    if (stillGating.length !== status.gating.length) {
      status.gating = stillGating;
      publish();
    }
  };

  publish("polling");
  let misses = 0;
  let passes = 0;
  // The last rejected reload's error text, so a factory that stays broken
  // across many passes logs it once instead of once per poll (the same
  // dedup shape `warned` gives noticeCode-adjacent one-time notices elsewhere
  // in cmdWork) — a NEW rejection (different text) still logs, so a second,
  // different mistake in an already-broken definition is not swallowed.
  let loggedFactoryError = null;

  for (;;) {
    // 0. Reload the factory definition (task-spor-work-reload-factory-
    // definition-per-pass): a long-running worker otherwise keeps judging
    // every item with whatever it booted with, so an operator's fix for a
    // refusal pattern (a rerun count, `isolate`, `serialize`) never reaches a
    // worker that is already running. Cheap — one node read plus a parse,
    // the same door the startup check used — so this runs every pass, no
    // throttle. A clean parse is swapped in by the dep itself (it owns the
    // `factory` binding in bin/spor.js); a rejected one is left exactly as it
    // was, so the worker keeps enforcing the last definition that DID parse
    // rather than ever falling back to running ungated. Optional: a bare
    // worker (no --factory) has no reloadFactory dep and this is a no-op.
    if (deps.reloadFactory) {
      let reload = null;
      try {
        reload = await deps.reloadFactory();
      } catch (e) {
        reload = { ok: false, errors: [e && e.message ? e.message : String(e)] };
      }
      // task-spor-work-factory-reload-extend-to-repo-scope: only a reload dep
      // that explicitly reports scope (an array `repos`, however empty) syncs
      // `repos`/`graph` — cmdWork's does, on every ok reload, though it only
      // recomputes the (expensive) graph load itself when `repos:` actually
      // changed, so this is a cheap reference swap most passes. A dep that
      // never mentions `repos` (a bare worker, or a test double) leaves both
      // exactly as the loop started with — no feature, no behavior change.
      // Absent on a bad reload — the `else` branch below never touches these,
      // so a rejected edit leaves the last scope that DID parse in force,
      // same as `factory` itself.
      if (reload && reload.ok && Array.isArray(reload.repos)) {
        repos = reload.repos;
        graph = reload.graph || null;
      }
      if (reload && status.gates) {
        if (reload.ok) {
          status.gates.factory_revision = reload.revision || status.gates.factory_revision || null;
          status.gates.factory_error = null;
          loggedFactoryError = null;
          if (repos.length) status.repos = repos;
          else delete status.repos;
        } else {
          const msg = (reload.errors && reload.errors[0]) || "factory definition could not be reloaded";
          // Never overwrite the revision that's actually still enforcing with
          // the bad edit's own revision — only fill it in if nothing has been
          // recorded yet (there's no realistic path there given cmdWork's own
          // startup refusal, but an empty field would misread as "unknown"
          // rather than "still on the last good one").
          if (reload.revision) status.gates.factory_revision = status.gates.factory_revision || reload.revision;
          status.gates.factory_error = msg;
          if (loggedFactoryError !== msg) {
            loggedFactoryError = msg;
            log(`work: factory '${opts.factory}' reload rejected — still enforcing the last definition that parsed: ${msg}`);
          }
        }
        publish();
      }
    }

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
            `last run here ended ${outcome.terminal_state || outcome.state || "without a verdict"}` +
              `${outcome.report_node_id ? ` (report ${outcome.report_node_id})` : ""}` +
              `${outcome.terminal_state === "declined" ? ` — ${outcome.declined_reason || "no reason given"}${outcome.finding_node_id ? ` (finding ${outcome.finding_node_id})` : ""}` : ""}`,
            rec.cool_ms || 0,
            "outcome"
          );
        }
        status.recent.unshift(outcome);
        status.recent.length = Math.min(status.recent.length, RECENT_CAP);
        log(
          `work: ${a.node_id || a.run_id.slice(0, 8)} finished — ${outcome.terminal_state || outcome.state || "unknown"}` +
            `${outcome.terminal_state && !outcome.terminal_enforced ? " (unenforced)" : ""}` +
            `${outcome.resolved_by ? ` by ${outcome.resolved_by}` : ""}` +
            `${outcome.terminal_state === "declined" ? `: ${outcome.declined_reason || "no reason given"} — routed to triage${outcome.finding_node_id ? ` as ${outcome.finding_node_id}` : ""}, not gated` : ""}`
        );
        // GATES (task-spor-work-gate-pipeline). A run carrying a CLAIM of
        // completion (shouldGate) is precisely what a factory does not take on
        // trust, so its slot is NOT freed here: it moves from `active` to
        // `gating` and frees when the pipeline settles. Every other outcome is
        // already back in the pool with its report and needs no gate. The
        // cooldown above still stands for a non-resolved run — a gate verdict
        // refreshes it either way when it lands.
        if (deps.gate && a.node_id && shouldGate(outcome, rec.record || rec)) {
          outcome.gate = "running";
          status.gating.push({
            run_id: a.run_id,
            node_id: a.node_id,
            harness: a.harness || null,
            // Carried across the active->gating move, not just held in memory:
            // a killed worker's GATING slot is the majority orphan, and the
            // resume scan can only file that pipeline's facts under the item's
            // own repo if the published slot still says what it was.
            ...(a.project ? { project: a.project } : {}),
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


    // 1a. Renew the pipeline leases this worker is driving — once a pass, so
    //     a pipeline waiting a day on an approval never reads as an orphan to
    //     another worker (stage-projection.js leaseHeld).
    if (deps.renewGates && status.gating.length) {
      try {
        await deps.renewGates(status.gating.map((g) => g.run_id));
      } catch {
        /* a missed renewal is bounded by the lease TTL and the worker's liveness */
      }
    }

    // 1b. Fold in every gate verdict that has landed.
    settleGates();

    // 1c. Check on any propose-mode proposals still parked from an earlier
    // pass (task-spor-integration-propose-mode) — optional, so a bare worker
    // or a local/push factory's loop is byte-identical to before this
    // existed. Consumes no concurrency slot: a parked item already freed its
    // slot when it parked, and this only reads this box's own run journal
    // plus a handful of `gh` calls. Fire-and-forget by contract, same as every
    // other best-effort step here — a failed check just tries again next pass.
    if (deps.checkProposals) {
      try {
        await deps.checkProposals();
      } catch {
        /* the next pass tries again */
      }
    }

    // 1d. Say when the code this worker LOADED has been moved past
    // (task-spor-work-announce-lib-commit-and-notice-main-moved) — optional
    // and fire-and-forget like the step above; a worker that declares no
    // notice is byte-identical. The loop never restarts itself on it: which
    // code a worker runs is the operator's call, this only makes the drift
    // visible in the log instead of discoverable after a pipeline ran stale.
    // The one exception is the operator's own `--restart-on-land`: the notice
    // returns the tip it was moved past, and that latches the drain above —
    // no new work from here on, exit when the in-flight work settles. The
    // latch is in-memory only (nothing durable to reconcile: a restarted
    // worker simply loads the new code), and a later move re-says the notice
    // but cannot un-latch it.
    if (deps.noticeCode) {
      try {
        const moved = await deps.noticeCode();
        if (restartOnLand && moved && !landed) {
          landed = String(moved);
          const inFlight = status.active.length + status.gating.length;
          log(`work: --restart-on-land — taking no new work; exiting ${inFlight ? `once the ${inFlight} run(s)/pipeline(s) in flight settle` : "now"} so a supervisor can restart this worker on the new code`);
        }
      } catch {
        /* the next pass tries again */
      }
    }

    // 1e. Retry a failed gate escalation WRITE — never the pipeline that
    // produced it (task-spor-gate-escalation-bounded-auto-retry). Optional,
    // like the two steps above; a bare worker or one whose factory has never
    // hit a failed escalation write is byte-identical. Consumes no
    // concurrency slot and holds no run open — the pipeline that refused this
    // item already settled and freed its slot; this only reads this box's own
    // run journal and retries the one write that did not land.
    if (deps.retryEscalations) {
      try {
        await deps.retryEscalations();
      } catch {
        /* the next pass tries again */
      }
    }

    // 2. Stop conditions. Draining is deliberate: a stop request stops PICKING
    //    UP work, and the loop then leaves — the in-flight runs are detached
    //    and own their own terminal contract, so waiting on them would only
    //    delay the exit without making anything safer. An in-flight GATE
    //    pipeline is different — it runs in THIS process, so a stop abandons
    //    it; its journal stays open (a workflow asked to stop yields first,
    //    and parks it; a hard kill leaves it running) and its lease lapses
    //    with this process, which is exactly what the next worker's resume
    //    scan adopts (step 3a, openPipelines) — so "re-gates on the next run"
    //    is something the next worker actually does, not a promise nothing
    //    keeps. The resumed pipeline CONTINUES its journal (the facts and the
    //    dispatches already journaled replay, never run twice), and the scan's
    //    busy-node exclusion keeps it from colliding with an agent this
    //    pipeline may have left working.
    if (stopping()) break;
    const quotaReached = max > 0 && status.dispatched >= max;
    // A pipeline that yielded freed its slot (settleGates), so it never holds
    // a winding-down worker open — its parked journal is the next worker's
    // (or this worker's next pass's) to re-offer.
    if (quotaReached && !status.active.length && !gatingInFlight()) break;
    if (opts.once && passes > 0 && !status.active.length && !gatingInFlight()) break;
    if (landed && !status.active.length && !gatingInFlight()) break;

    // 3. Fill the free slots.
    let launchedThisPass = 0;
    // Set when this pass hits a workspace/lock refusal (below) — pacing must
    // retry SOON regardless of what else this worker is following, since the
    // occupant is very often this worker's OWN prior dispatch under
    // `--concurrency` > 1, not a run that will ever show up in `active`/
    // `gating` on its own timeline.
    let workspaceBusyThisPass = false;
    const draining = (opts.once && passes > 0) || !!landed;
    // A gating item still occupies a slot: the worker has not finished with
    // that piece of work until its gates say so. A parked one does not (it
    // takes a slot back when the resume scan re-offers it), though its node
    // stays out of selection while it is parked.
    let free = concurrency - status.active.length - gatingInFlight();
    if (free > 0 && !quotaReached && !draining) {
      // 3a. RESUME open gate pipelines first (task-spor-work-gate-pipeline,
      //     task-spor-delete-loop-resume-machinery-after-workflow-stages).
      //     A worker that was killed or stopped mid-pipeline left a terminal
      //     run standing with an un-judged claim, and a pipeline that yielded
      //     parked its journal and freed its slot; either run is already out
      //     of the queue — no candidate poll would ever bring it back. So a
      //     gate-armed worker adopts every open, due pipeline (openPipelines
      //     over the stage journals) AHEAD of taking new work: finishing what
      //     the box already promised to judge outranks starting something
      //     else, and a resumed pipeline occupies a slot exactly like one this
      //     worker started. Bounded by the free slots, so a backlog is worked
      //     down over passes rather than spawning a pipeline per orphan at
      //     once — and placed under the SAME wind-down guards as a dispatch,
      //     so `--max` and `--once` still mean what they say (a winding-down
      //     worker leaves the open pipelines for the next one, which is exactly
      //     what they are for). One that yielded identically
      //     `parkedReofferMax` times in a row is not re-offered: the re-offer
      //     cap's escalation is filed in its place (startEscalation).
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
          const slot = { run_id: o.run_id, node_id: o.node_id, harness: o.harness || null, project: o.project || null, ...(o.attempt ? { attempt: o.attempt } : {}), started_at: new Date(now()).toISOString(), resumed: true };
          status.gating.push(slot);
          // The verdict lands on a `recent` entry; a resumed run has none from
          // this worker's own harvest, so seed one from the run record.
          status.recent.unshift({ ...outcomeOf(o.record), node_id: o.node_id, at: new Date(now()).toISOString(), gate: "running", resumed: true });
          status.recent.length = Math.min(status.recent.length, RECENT_CAP);
          if (o.escalate && deps.escalateParked) {
            startEscalation(slot, o.record, { reason: o.reason || "", count: o.reoffers });
            log(`work: ${o.node_id} gates interrupted ${o.reoffers} time(s) in a row${o.reason ? ` — ${o.reason}` : ""} — no longer re-offering it; escalating to a person`);
          } else {
            startGate(slot, o.record);
            log(o.reoffers ? `work: ${o.node_id} — re-offering the gate pipeline its interrupted pass left unsettled (run ${String(o.run_id).slice(0, 8)})` : `work: ${o.node_id} — resuming the gate pipeline an earlier worker left unfinished (run ${String(o.run_id).slice(0, 8)})`);
          }
          free -= 1;
          // Published per adoption, not once at the end of the loop: this file
          // is how another worker on this box learns the slot is taken (the
          // lease the pipeline claims is the other half), and every extra
          // moment it lags is more of the read-read window in which both could
          // adopt the same pipeline.
          publish();
        }
      }

      // 3b. Take new work with whatever is left.
      if (free > 0 && !stopping()) {
        // Cleared here, not earlier: this is the one branch that actually
        // attempts new candidates this pass. Resetting it any earlier (e.g.
        // outside the `free > 0` gates above) would wipe a still-relevant
        // "busy" reading on a pass that never re-checked it — a multi-repo or
        // multi-slot worker can have `free === 0` here for reasons unrelated
        // to the workspace refusal a PRIOR pass reported.
        status.workspace_wait = null;
        let items = null;
        try {
          // The cooldowns go WITH the request: the page the queue returns is a
          // fixed size, so a caller that can widen it needs to know which of
          // its items this worker is already sitting out — otherwise an item
          // that refuses deterministically pins the page at its own rank and
          // starves everything below it (the shape the widening exists to
          // fix, one hop deeper).
          items = await deps.candidates({ cooling: (id) => { const s = skipped.get(id); return !!(s && s.until > now()); } });
        } catch {
          items = null; // a dead server backs off; it never takes the worker down (fail-open)
        }
        // Latched once per worker: a scoped worker whose whole page belonged
        // to other repos idles exactly like a worker with an empty queue, and
        // the two need very different operator responses (issue-spor-work-
        // scope-union-factory-mismatch). Counting the scope skips is the only
        // way to tell them apart from outside.
        let scopeSkips = 0;
        // Every skip this pass, for the aggregate below: the individual lines
        // are capped, the COUNT never is.
        const passSkips = [];
        const cands = selectWorkCandidates(items || [], {
          skipped,
          // GATING counts as in flight (review finding 3): the worker has not
          // finished with that node until its pipeline settles, and an
          // unenforced `reported` run has already handed the lease back — so
          // without this a second free slot re-dispatches the very item the
          // first gate is still judging.
          active: new Set([...status.active, ...status.gating].map((a) => a.node_id).filter(Boolean)),
          now: now(),
          accept,
          repos,
          graph,
          selfAgent,
          // A policy skip is NOT silent (dec-spor-work-accept-policy-
          // configurable): it lands in the cooldown map — which the status
          // surface renders with the reason — and on stdout, once per cooldown
          // window rather than once per poll (selectWorkCandidates checks the
          // cooldown before the policy, so a cooling item never re-fires this).
          onSkip: (it, reason, kind) => {
            if (kind === "scope") scopeSkips += 1;
            cool(it.id, reason, retryAfterMs, kind);
            passSkips.push({ reason, kind });
            if (passSkips.length <= SKIP_LOG_CAP) log(`work: skipping ${it.id} — ${reason}`);
          },
        });
        if (passSkips.length > SKIP_LOG_CAP) {
          log(
            `work: ...and ${passSkips.length - SKIP_LOG_CAP} more skipped this pass — ` +
              `${summarizeSkips(passSkips.slice(SKIP_LOG_CAP))} ('spor work --status' lists them, newest first)`
          );
        }
        // The WHOLE page, not merely "nothing to dispatch": items held back
        // because they are already active or cooling are this worker's own
        // business, and saying "every candidate is out of scope" when one was
        // simply in flight would be false.
        if (!scopeStarvedWarned && scopeSkips && scopeSkips === (items || []).length) {
          scopeStarvedWarned = true;
          log(
            `work: every item on this queue page (${scopeSkips}) is outside the factory's repo scope (${repos.join(", ")}) — ` +
              `this worker will idle until in-scope work reaches the top of the page. Narrow the read with --project, or widen the factory's 'repos'.`
          );
        }
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
              // The ITEM's own repo stamp, not this worker's scope token: a
              // gate fact belongs to the repo the work was in, and under a
              // multi-repo factory those differ (review finding 4). Persisted
              // on the slot so a RESUMED pipeline files its facts there too.
              // Only written when there IS one, so an unstamped item's slot —
              // and every slot a bare worker publishes — keeps its old shape.
              ...(item.project ?? item.repo ? { project: item.project ?? item.repo } : {}),
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
            if (isWorkspaceRefusal(reason)) {
              // The refused RESOURCE is this worker's own shared checkout —
              // most often occupied by a run THIS worker already has active
              // under `--concurrency` > 1 with no `dispatch.worktree` — never
              // a fact about `item` (task-spor-work-loop-workspace-refusal-
              // cooldown-on-worker-not-item). Cooling the item onto
              // `work.retryAfterMs` would drain the rest of this page into the
              // same cooldown, one refusal at a time, while the occupying run
              // finishes in seconds. So: leave the item un-cooled (it may well
              // be the very next dispatch once the checkout frees up), stop
              // trying the REST of this pass's candidates — every one of them
              // would contend for the same tree and only re-report the same
              // refusal — and retry the whole page again next poll.
              workspaceBusyThisPass = true;
              status.workspace_wait = { node_id: item.id, reason, at: new Date(now()).toISOString() };
              log(`work: ${item.id} — ${reason} (worker-scoped: not cooling the item; retrying this page next poll)`);
              break;
            }
            cool(item.id, reason, res.retryAfterMs ?? retryAfterMs, res.kind || "refusal");
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
    //    would just leave a finished slot idle. A workspace/lock refusal this
    //    pass is never idle either, even with nothing (yet) in `active` —
    //    there IS a candidate to retry, just not until the occupying launch on
    //    this box clears, which is usually seconds away, not backoff territory.
    const idle = !workspaceBusyThisPass && launchedThisPass === 0 && status.active.length === 0 && gatingInFlight() === 0;
    misses = idle ? misses + 1 : 0;
    if (opts.once && !status.active.length && !gatingInFlight()) break;
    if (landed && !status.active.length && !gatingInFlight()) break;
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
  // Whatever is still gating is abandoned by this exit: its journal stays open
  // and its lease lapses with this process (a worker asked to stop is answered
  // inside the pipeline's waits, which yield), which is what the next worker's
  // resume scan adopts. The slot is left standing in the published status so
  // `--status` says what this worker was holding when it left.
  if (status.gating.length) {
    for (const g of status.gating) {
      // A fix-cycle dispatch is a DETACHED run that outlives this process — the
      // one child a gate pipeline starts and does not itself wait out on this
      // process's behalf. `gate_fix_run_id` is on the run record from the
      // moment the fix was dispatched, so naming it here is what turns
      // "something was abandoned" into "here is the run to go check"
      // (issue-spor-work-stop-abandons-inflight-gates).
      let rec = null;
      try {
        rec = deps.runRecord ? deps.runRecord(g.run_id) : null;
      } catch {
        rec = null;
      }
      const fixNote = rec && rec.gate_fix_run_id ? ` — its fix cycle (run ${String(rec.gate_fix_run_id).slice(0, 8)}) may still be running; 'spor runs' or the next 'spor work' on this box follows it` : "";
      log(`work: ${g.node_id} gate pipeline abandoned by the stop${fixNote}`);
    }
    log(`work: ${status.gating.length} gate pipeline(s) abandoned by the stop — their items stay uncleared, and the next 'spor work' on this box resumes them`);
  }

  status.next_poll_at = null;
  status.stopped_at = new Date(now()).toISOString();
  status.stop_reason =
    control.reason ||
    (max > 0 && status.dispatched >= max
      ? `dispatched ${status.dispatched} item(s) (--max)`
      : opts.once
        ? "one pass (--once)"
        : landed
          ? `the loaded code was moved past (now ${landed}); exited for a restart (--restart-on-land)`
          : "stopped");
  publish("stopped");
  return status;
}

module.exports = {
  WORK_DEFAULTS,
  WORK_ACCEPT_POLICIES,
  runHarvest,
  RECENT_CAP,
  SKIP_CAP,
  nextBackoffMs,
  workDir,
  workerStatusPath,
  writeWorkerStatus,
  readWorkerStatuses,
  selectWorkCandidates,
  classifyWorkItem,
  pageEligible,
  skipClass,
  summarizeSkips,
  SKIP_LOG_CAP,
  recentClass,
  summarizeRecent,
  RECENT_LOG_CAP,
  shouldGate,
  owedByDeadWorkers,
  SLOT_HEARTBEAT_STALE_MS,
  liveWorkerSlots,
  openPipelines,
  pendingEscalationRetries,
  nextEscalationRetryDelay,
  gatingNodeIds,
  refusalReason,
  outcomeOf,
  isWorkspaceRefusal,
  runWorkLoop,
};
