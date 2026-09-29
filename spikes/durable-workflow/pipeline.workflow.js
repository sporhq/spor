// spikes/durable-workflow/pipeline.workflow.js — the gate pipeline
// (implement → gates → fix cycle → rescue → integration → completion, WORKERS.md
// §10) written as ONE deterministic workflow function against the harness.
//
// This is the spike's central artifact. Two questions it answers:
//
//   1. Does the pipeline's CONTROL FLOW fit the durable-workflow model — one
//      function re-executed from the top, every side effect keyed and
//      journaled, waits as durable timers and signals? (Yes: see below. The
//      control flow is a few hundred lines; every "resume", "adopt", "park",
//      "re-offer", "orphan", "stale worker", "gate_state", "gate_progress"
//      concept in the shipped runner is absent because the JOURNAL is the
//      progress and the engine's re-execution is the resume.)
//
//   2. What stays bespoke — i.e. what does NOT go away when an engine owns the
//      control flow? Everything behind `ctx.run(...)`: the ACTIVITIES table at
//      the bottom. Each is a side effect on git, the graph or a harness, and
//      each must be idempotent under its key, because the engine only
//      guarantees the RESULT is recorded once, not that the effect ran once.
//      The dispatch activities in particular must ADOPT a run already launched
//      under their key (the shipped runner's adopt-by-name), or a crash in the
//      execute-then-journal window launches a second agent.
//
// The shipped runner's contract is preserved where it is a rule, not a
// mechanism (the spike keeps rules and drops mechanisms):
//   - a fix cycle that moves the head restarts from gate 0; a gate already
//     passed at the CURRENT head stands; cycle caps are cumulative — across
//     restarts AND across the integration stage's re-gate, which re-enters this
//     same function over the same shared state;
//   - only a DEMONSTRATED blocking finding blocks; a verdict that ignores a
//     prior finding counts as changes_requested for the prior set;
//   - an outage (an implementer's or a reviewer's) is never a fix cycle: it
//     spends ONE shared per-pipeline retry pool; a reviewer's stated reset
//     inside pause_max_ms is a durable PAUSE, one beyond it goes to a person;
//   - the rescue lane runs when a gate would otherwise escalate, re-runs the
//     whole list with fresh per-gate cycle budgets and the ledger carried;
//   - a human gate blocks on an approval signal with a durable deadline, and a
//     `blocked` outcome demotes the item like any other refusal (§10.7);
//   - integration: conflict / candidate-suite failure is a fix-cycle event,
//     a lost CAS is retried on its own bound, never charged;
//   - every fact/escalation/attestation id is deterministic — and here the
//     deterministic id IS the effect's dedup key.
"use strict";

const RACE_RETRY_CAP = 3;
const RETRY_POOL_DEFAULT = 3; // the shared `implementation.retry` pool (§5.3): implementer outages + reviewer outages
const REVIEWER_PAUSE_MAX_DEFAULT = 48 * 3600e3;

// `state` is the per-pipeline memory shared with a re-entry (the integration
// stage's re-gate): per-gate ledgers and cycles, rescues used, the retry pool,
// the facts and escalations written so far. A top-level call creates it; a
// re-gate passes the parent's in, so nothing is granted afresh by re-entry.
function gatePipeline(ctx, { item, factory }, state = null) {
  const runId = item.run_id;
  const nodeId = item.node_id;
  const K = (...parts) => [runId, ...parts].join("/"); // one stable key namespace per (re-)entry
  const gates = factory.gates || [];
  const S = state || { memory: new Map(), rescues: 0, retries: 0, facts: [], escalations: [] };
  const retryPool = (factory.retry && factory.retry.attempts != null) ? factory.retry.attempts : RETRY_POOL_DEFAULT;
  // Per-gate memory that survives restarts of the gate list: the finding
  // ledger and the fix cycles spent. In the shipped runner this is
  // `gate_progress` on the run record, saved before each fix dispatch and
  // reloaded on resume. Here it is an ordinary variable: replay rebuilds it by
  // re-executing the same deterministic code over the same journal.
  const mem = (gate) => {
    if (!S.memory.has(gate.id)) S.memory.set(gate.id, { cycles: 0, ledger: [], rescueBase: 0, passedAt: null });
    return S.memory.get(gate.id);
  };
  let pass = 0; // how many times the gate list has started from gate 0 in THIS entry
  let head = null;
  let change = null;

  // ---- the implementation stage (optional; §10.16) ----
  if (factory.implementation) {
    const budget = factory.implementation.attempts || 1;
    let attempt = 0; // every dispatch (keys) — outages included
    let spent = 0; // dispatches charged to `budget` — code outcomes only
    for (;;) {
      attempt++;
      const run = ctx.run(K("impl", attempt, "dispatch"), "dispatchImplementer", { nodeId, attempt });
      const ended = ctx.awaitSignal(K("impl", attempt, "ended"), `run:${run.run_id}`);
      const outcome = ended.payload;
      if (outcome.state === "candidate") break;
      if (outcome.state === "infrastructure") {
        // An outage spends the shared retry pool, never the attempt budget.
        if (S.retries >= retryPool) return escalate(`implementer unavailable: retry pool (${retryPool}) spent`, { state: "escalated" });
        S.retries++;
        const now = ctx.now(K("impl", attempt, "now"));
        ctx.sleepUntil(K("impl", attempt, "backoff"), now + (factory.implementation.retry_backoff_ms || 60000));
        continue;
      }
      if (++spent >= budget) return escalate(`implementation ${outcome.state} after ${spent} attempt(s)`, { state: "exhausted" });
    }
  }

  // ---- the gate list, restarted from gate 0 whenever the head moves ----
  gateList: for (;;) {
    pass++;
    change = ctx.run(K("pass", pass, "read-change"), "readChange", { nodeId });
    if (!change.ok) return escalate(`the change under judgement could not be read: ${change.reason}`, { state: "failed" });
    head = change.head;
    if (change.empty) return escalate("the deliverable was not code (empty diff against the trusted ref)", { state: "failed" });
    ctx.run(K("pass", pass, "pin"), "pinCandidate", { nodeId, head, tree: change.tree, stage: pass === 1 && !state ? "implementation" : "fix" });

    for (const gate of gates) {
      const m = mem(gate);
      // A gate already passed at THIS head stands (a restart re-judges only
      // what the fix could have changed — the shipped rule; the engine makes
      // "already judged at this head" a journal lookup, not a record field).
      if (m.passedAt === head) continue;

      const verdict = judgeGate(gate, m);
      if (verdict.passed) {
        m.passedAt = head;
        continue;
      }
      if (verdict.moved) continue gateList; // a fix cycle committed: the head moved, restart from gate 0
      if (verdict.blocked) {
        // §10.7: an unanswered approval is not one — the item is demoted, the
        // approval item (already filed, still open) is the blocker.
        ctx.run(K("demote"), "demote", { nodeId, blocker: verdict.blocker });
        return settle("blocked", verdict.reason);
      }

      // refused: fix cycles spent (or an unretried refusal). The rescue lane
      // runs once per declared attempt before a person is asked.
      if (factory.rescue && S.rescues < factory.rescue.attempts && !verdict.noRescue) {
        S.rescues++;
        const n = S.rescues;
        const rescue = ctx.run(K("rescue", n, "dispatch"), "dispatchRescue", { nodeId, head, refused: gate.id, ledger: m.ledger, attempt: n });
        const ended = ctx.awaitSignal(K("rescue", n, "ended"), `run:${rescue.run_id}`);
        fact(ctx.run(K("rescue", n, "fact"), "writeFact", { id: `art-rescue-${nodeId}-${shortRun(item.run_id)}-x${n}`, diagnosis: ended.payload.diagnosis }));
        // fresh fix-cycle budget per gate, ledger carried, cycle index continues
        for (const g of gates) mem(g).rescueBase = mem(g).cycles;
        continue gateList;
      }
      return escalate(verdict.reason, { state: "failed", gate: gate.id });
    }
    break;
  }

  // ---- integration (optional; §10.9) ----
  if (factory.integration) {
    const integ = factory.integration;
    let cycles = 0;
    let races = 0;
    for (;;) {
      const attempt = cycles + races + 1;
      const built = ctx.run(K("integration", attempt, "build"), "buildCandidate", { head, targetRef: integ.targetRef, strategy: integ.strategy });
      let failure = null;
      if (!built.ok) failure = { kind: "conflict", detail: built.reason };
      else {
        const suite = ctx.run(K("integration", attempt, "suite"), "runSuite", { dir: built.dir, command: integ.command, head: built.candidateSha });
        if (!suite.passed) failure = { kind: "suite", detail: suite.failedFiles };
      }
      if (failure) {
        if (cycles >= integ.cycles) return escalate(`integration ${failure.kind} after ${cycles} fix cycle(s)`, { state: "failed" });
        cycles++;
        const fix = ctx.run(K("integration", attempt, "fix"), "dispatchFix", { nodeId, gate: "integration", cycle: cycles, detail: failure });
        ctx.awaitSignal(K("integration", attempt, "fix-ended"), `run:${fix.run_id}`);
        // The fix moved the head: hand it back through the real gate list
        // (deps.regate in the shipped runner) — here, literally re-enter this
        // function under a child key namespace, over the SAME shared state, with
        // only the gate list declared (no implementer, no integration, no
        // completion), so caps stay cumulative and the ledger is carried.
        const regate = gatePipeline(ctx, { item: { ...item, run_id: `${runId}#regate${cycles}` }, factory: { ...factory, implementation: null, integration: null, completion: null } }, S);
        if (regate.state !== "passed") return regate;
        head = regate.head;
        continue;
      }
      const landed = ctx.run(K("integration", attempt, "land"), "landCAS", { candidateSha: built.candidateSha, expectedBase: built.baseSha, targetRef: integ.targetRef, mode: integ.mode });
      if (landed.lost) {
        if (++races > RACE_RETRY_CAP) return escalate("integration lost the CAS race past its retry cap", { state: "failed" });
        continue; // rebuild against the new tip — nobody's mistake, not charged
      }
      fact(ctx.run(K("integration", "fact"), "writeFact", { id: `art-merge-${nodeId}-${shortRun(runId)}`, verdict: "landed", head, landed: landed.sha }));
      break;
    }
  }

  // ---- controller completion at the declared boundary (§10.13) ----
  if (factory.completion && factory.completion.by === "controller") {
    const resolver = `art-completion-${nodeId}-${shortRun(runId)}`;
    ctx.run(K("completion", "resolver"), "writeFact", { id: resolver, resolves: nodeId, head });
    const cas = ctx.run(K("completion", "put"), "writeCompletion", { nodeId, resolver, status: "done" });
    if (!cas.ok) return escalate(`completion CAS refused: ${cas.reason}`, { state: "failed" });
  }
  // A re-entry attests nothing: the attestation is one per run and the parent writes it.
  if (!state) fact(ctx.run(K("attestation"), "writeFact", { id: `art-attest-${nodeId}-${shortRun(runId)}`, head, facts: S.facts.map((f) => f.id) }));
  return settle("passed", null);

  // ------------------------------------------------------------------
  function fact(f) { S.facts.push(f); return f; }

  function judgeGate(gate, m) {
    if (gate.kind === "command") return judgeCommand(gate, m);
    if (gate.kind === "agent-review") return judgeReview(gate, m);
    if (gate.kind === "human") return judgeHuman(gate, m);
    return { refused: true, reason: `unknown gate kind ${gate.kind}`, noRescue: true };
  }

  // The key for a gate's judgement at this pass. `pass` is in the key so a
  // restart re-runs the suite (the head moved), and a replay finds the recorded
  // result (the head did not).
  function gk(gate, ...p) { return K("gate", gate.id, "pass", pass, ...p); }

  function judgeCommand(gate, m) {
    if (anyMatch(gate.protectedPaths, change.paths)) {
      return { refused: true, reason: `${gate.id}: the change touched a protected path`, noRescue: true };
    }
    let result = null;
    const attempts = [];
    for (let rerun = 0; rerun <= (gate.reruns || 0); rerun++) {
      result = ctx.run(gk(gate, "run", rerun), "runSuite", { gate: gate.id, command: gate.command, head, trustedRef: factory.trustedRef, protectedPaths: gate.protectedPaths || [] });
      attempts.push(result);
      if (result.passed) break;
    }
    return settleVerdict(gate, m, result.passed ? { pass: true } : { pass: false, detail: result.failedFiles, evidence: attempts });
  }

  function judgeReview(gate, m) {
    for (let n = 1; ; n++) {
      const review = ctx.run(gk(gate, "review", n, "dispatch"), "dispatchReview", { nodeId, gate: gate.id, head, ledger: m.ledger, cycle: m.cycles, profile: gate.profile });
      const ended = ctx.awaitSignal(gk(gate, "review", n, "ended"), `run:${review.run_id}`);
      const out = ended.payload;
      if (out.state === "infrastructure") {
        // The reviewer's backend was out. Never a fix cycle: the pause is free,
        // the review after it spends the shared retry pool. A stated reset
        // inside pause_max_ms is a durable timer; one beyond it is a person's
        // call; none is the fixed backoff.
        const now = ctx.now(gk(gate, "outage", n, "now"));
        if (out.reset_at != null && out.reset_at - now > (gate.pauseMaxMs || REVIEWER_PAUSE_MAX_DEFAULT)) {
          return settleVerdict(gate, m, { pass: false, verdict: "infrastructure", detail: `reviewer reset at ${out.reset_at} is beyond pause_max_ms`, refuse: true, noRescue: true });
        }
        if (S.retries >= retryPool) {
          return settleVerdict(gate, m, { pass: false, verdict: "infrastructure", detail: `reviewer unavailable: retry pool (${retryPool}) spent`, refuse: true, noRescue: true });
        }
        S.retries++;
        ctx.sleepUntil(gk(gate, "outage", n, "pause"), out.reset_at != null ? out.reset_at : now + 30000 * n);
        continue;
      }
      if (out.state !== "report") {
        // unreadable / no report — a FAILURE, never a pass; the prior set is carried
        return settleVerdict(gate, m, { pass: false, detail: `no readable verdict (${out.state})` });
      }
      const fold = foldFindings(m.ledger, out.findings || [], m.cycles);
      m.ledger = fold.ledger;
      if (fold.blocking.length === 0) return settleVerdict(gate, m, { pass: true, advisory: fold.advisory });
      return settleVerdict(gate, m, { pass: false, detail: fold.blocking.map((f) => f.id) });
    }
  }

  function judgeHuman(gate, m) {
    if (!anyMatch(gate.riskPaths, change.paths)) return { passed: true };
    const approvalId = `task-approval-${nodeId}-${shortRun(item.run_id)}-${gate.id}`;
    ctx.run(gk(gate, "approval-item"), "fileEscalation", { id: approvalId, blocks: nodeId, requires: ["human"], why: `${gate.id} armed on ${change.paths.join(", ")}` });
    const now = ctx.now(gk(gate, "approval-now"));
    const answer = ctx.awaitSignal(gk(gate, "approval"), `approval:${approvalId}`, { deadlineAt: now + (gate.approvalTimeoutMs || 24 * 3600e3) });
    if (answer.timeout) return { blocked: true, blocker: approvalId, reason: `${gate.id}: no approval within the timeout (${approvalId} still open)` };
    if (answer.payload.approved) return { passed: true };
    return { refused: true, reason: `${gate.id}: approval refused`, noRescue: true };
  }

  // Record the fact (every gate outcome is one, §10.6), then decide:
  // pass / fix cycle / refuse.
  function settleVerdict(gate, m, r) {
    const factId = `art-gate-${gate.id}-${nodeId}-${shortRun(runId)}-p${pass}-${String(head).slice(0, 8)}`;
    fact(ctx.run(gk(gate, "fact"), "writeFact", { id: factId, gate: gate.id, verdict: r.pass ? "passed" : (r.verdict || "failed"), head, detail: r.detail || null, evidence: r.evidence || null }));
    if (r.pass) return { passed: true };
    if (r.refuse) return { refused: true, reason: `${gate.id}: ${r.detail}`, noRescue: !!r.noRescue };
    const spentThisLane = m.cycles - m.rescueBase;
    if (spentThisLane >= (gate.cycles || 0)) {
      return { refused: true, reason: `${gate.id} failed at ${head} with fix cycles spent (${m.cycles})` };
    }
    m.cycles++;
    const fix = ctx.run(gk(gate, "fix", m.cycles, "dispatch"), "dispatchFix", { nodeId, gate: gate.id, cycle: m.cycles, detail: r.detail, ledger: m.ledger });
    ctx.awaitSignal(gk(gate, "fix", m.cycles, "ended"), `run:${fix.run_id}`);
    return { moved: true }; // the next pass re-reads the head; if the fix committed nothing the same head is re-judged
  }

  function escalate(reason, extra) {
    const id = `task-gate-escalation-${nodeId}-${shortRun(item.run_id)}`;
    S.escalations.push(ctx.run(K("escalation"), "fileEscalation", { id, blocks: nodeId, requires: ["human"], why: reason }));
    ctx.run(K("demote"), "demote", { nodeId, blocker: id });
    return settle(extra.state || "failed", reason);
  }

  function settle(st, reason) {
    return { state: st, reason, head, facts: S.facts.map((f) => f.id), escalations: S.escalations.map((e) => e.id), passes: pass, rescues: S.rescues, retries: S.retries };
  }
}

// The stateful review protocol's fold, reduced to the rule: prior findings
// not answered are carried as still open; a blocking finding blocks only with
// a non-empty string of evidence; everything else is advisory.
function foldFindings(ledger, findings, cycle) {
  const out = ledger.map((f) => ({ ...f }));
  const answered = new Set();
  for (const f of findings) {
    const id = f.id || `f${out.length + 1}`;
    answered.add(id);
    const prior = out.find((x) => x.id === id);
    const blocking = f.severity === "blocking" && typeof f.evidence === "string" && f.evidence.trim() !== "" && (cycle === 0 || f.introduced_by_fix === true || (prior && prior.open));
    const entry = { id, file: f.file, severity: f.severity, blocking, open: f.status !== "resolved", evidence: f.evidence || null };
    if (prior) Object.assign(prior, entry);
    else out.push(entry);
  }
  // a prior open blocking finding the verdict ignored stays open (counts as changes_requested)
  for (const f of out) if (!answered.has(f.id) && f.open && f.blocking) f.carried = true;
  return {
    ledger: out,
    blocking: out.filter((f) => f.open && f.blocking),
    advisory: out.filter((f) => f.open && !f.blocking),
  };
}

// Minimal glob (`**` any depth, `*` one segment) — the real matcher is
// lib/kernel/coupling.js / gates.js; this only has to be honest enough for the
// spike's protected-path and risk-path rules to be about paths, not strings.
function globRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${esc}$`);
}
function anyMatch(globs, paths) {
  return (globs || []).some((g) => { const re = globRe(g); return (paths || []).some((p) => re.test(p)); });
}

function shortRun(runId) {
  return String(runId).replace(/[^a-z0-9]/gi, "").slice(0, 8);
}

// The ACTIVITIES — what stays bespoke. Each name below is a side effect on
// git, the graph, or a harness process, invoked with a stable key. The engine
// journals the RESULT under the key; the activity must make the EFFECT
// idempotent under the same key (deterministic node ids + if_exists: skip with
// read-back; git CAS; the server's idempotency_key; a dispatch name adopted on
// re-run). That table is the honest size of what no engine removes.
const ACTIVITIES = Object.freeze([
  ["readChange", "git: head/base/paths against the trusted ref; dirty/gone/empty detection"],
  ["pinCandidate", "candidate chain: content-addressed on the tree, supersedes on a moved tree, publish"],
  ["runSuite", "git worktree at the head with protected paths forced to the trusted copy; run the command; failing-file evidence (or push a candidate ref and read a CI run)"],
  ["dispatchReview", "spor dispatch --read-only under the gate's profile; harness flags dropped; ADOPTED BY NAME on re-run"],
  ["dispatchFix", "spor dispatch --force --no-worktree into the run's checkout with the ledger; ADOPTED BY NAME on re-run"],
  ["dispatchRescue", "the rescue lane dispatch: worker posture translated by meaning; ADOPTED BY NAME on re-run"],
  ["dispatchImplementer", "the implementation-stage dispatch with the worker contract prompt; ADOPTED BY NAME on re-run"],
  ["writeFact", "art-gate/art-rescue/art-merge/art-completion/art-attest node under a deterministic id, if_exists: skip + read-back content comparison"],
  ["fileEscalation", "requires:[human] item under a deterministic id carrying blocks -> the work item"],
  ["demote", "§10.7: roll the item's completion status back to open while its resolving edge stands"],
  ["buildCandidate", "merge(target_ref, branch) in a throwaway worktree, protected paths forced, per strategy"],
  ["landCAS", "git update-ref old->new / push whose non-fast-forward rejection is the CAS; gh pr create in propose mode"],
  ["writeCompletion", "the one CAS put_node of the item writing the terminal status and clearing the hold; server-side fence check"],
  // signals, not activities — external events the workflow awaits:
  ["signal run:<id>", "a dispatched run's terminal report (the supervisor's), incl. termination class + reset hint"],
  ["signal approval:<id>", "a person's resolving edge / refusal on the approval item"],
]);

module.exports = { gatePipeline, foldFindings, anyMatch, ACTIVITIES, RACE_RETRY_CAP, RETRY_POOL_DEFAULT };
