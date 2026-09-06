// kernel/execution.js — the pure factory-execution state machine, the CLIENT
// twin of the server's `lib-engine/kernel/execution.js`
// (task-spor-client-execution-store-adapter, the client half of
// dec-spor-hosted-execution-state-server-authoritative; the contract is
// EXECUTION-STATE.md in the sibling spor-server checkout, §8 in particular).
//
// EXECUTION-STATE.md §8 rule 1: a local execution and a hosted one describe
// the same thing. So this file is a port of the server's reducer — the same
// record shape (`spec_version: 1`, the §3 fields), the same content-addressed
// id derivations byte-for-byte, the same §7.3 event vocabulary with the same
// §7.4 idempotency keys, the same fence arithmetic, and the same completion
// boundary predicate. A record written by the local store can be READ by a
// reader of the hosted one, and a hosted record replayed through this reducer
// reproduces itself. When the server's reducer changes, this changes with it.
//
// Like every kernel module it is clock-free, I/O-free and requires no node
// builtins: the sha256 the ids are derived from is INJECTED (`(string) =>
// hex`), exactly as kernel/candidate.js takes it, so the one place that owns
// crypto stays in the shell. Time enters ONLY as recorded event data (`at`,
// `lease_expires_at`): the reducer compares timestamps it was given, it never
// reads one.
//
// Invariants (test/execution-store.test.js):
//   - replay is total: applying the same event sequence to initExecution()
//     reproduces a deepStrictEqual-identical record, and apply() never mutates
//     its input;
//   - every event carries an idempotency key, and a key already recorded is a
//     NO-OP returning the record unchanged with `replayed: true`;
//   - every authoritative transition names a `fence`, refused when stale or
//     when the lease has expired;
//   - definitions are pinned by initExecution and never rewritten by an event.
"use strict";

const EXECUTION_SPEC_VERSION = 1;

// §7.3's vocabulary, in the order a pipeline normally walks it. Anything not on
// this list is refused — a typo must not become a silently-recorded event.
const EVENT_TYPES = Object.freeze([
  "stage.started",
  "stage.observed",
  "candidate.submitted",
  "candidate.superseded",
  "candidate.published",
  "gate.started",
  "gate.settled",
  "rescue.started",
  "integration.started",
  "integration.settled",
  "escalation.filed",
  "completion.written",
]);

// The two LOG-ONLY entry types (§5): outside the vocabulary above, carrying no
// idempotency key, never seen by the reducer — they exist so the log alone can
// reproduce the record (`rebuildFromEvents`).
const LOG_ONLY_TYPES = Object.freeze(["execution.opened", "ownership.changed"]);

// §7.1's coarse stage enum — what the store is authoritative for, beside
// whether the pinned completion boundary has been reached.
const STAGES = Object.freeze(["implementation", "gating", "integration", "completed", "refused"]);

// Where the resolving edge may be written. `gates` = the last gate settled
// passed; `integration` = the candidate landed.
const BOUNDARIES = Object.freeze(["gates", "integration"]);

// The attempt pools §5.3 spends against, carried verbatim on each attempt row.
const POOLS = Object.freeze(["implementation", "retry", "cycle", "rescue"]);

// §4.1's settled/unsettled split for a stage attempt. An unrecognized state
// RESUMES rather than being read as a verdict.
const SETTLED_ATTEMPT_STATES = Object.freeze(["candidate", "no-candidate", "declined", "cancelled", "exhausted"]);

// A gate's settled verdicts. `passed`/`skipped` advance the pipeline; `failed`
// spends a cycle; `infrastructure` is the outage lane and spends the retry
// pool instead of charging the code.
const GATE_STATES = Object.freeze(["passed", "skipped", "failed", "infrastructure"]);

const INTEGRATION_STATES = Object.freeze(["landed", "parked", "failed"]);

// The ownership/boundary refusal codes the server answers with (§7), so a
// caller can branch on the CODE rather than on message text. Local mode's
// engine answers the same words.
const OWNERSHIP_CODES = Object.freeze(["already_owned", "lease_live", "fence_stale", "not_owned", "lease_expired"]);

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------------- content-addressed ids (§3.2) ----------------

// The exact bytes an id is the digest of: the components NUL-joined. An id
// component may not contain NUL, so the join is injective (a naive concat
// would let ("ab","c") and ("a","bc") collide). This is the server's spelling,
// kept byte-for-byte — it is NOT the newline-terminated key kernel/candidate.js
// and the `task-split-` convention use, and it must not be "harmonized" with
// them: a local execution has to mint the id the hosted store would.
function idKey(parts) {
  return parts.map((p) => String(p == null ? "" : p)).join("\u0000");
}

function sha16(parts, sha256) {
  if (typeof sha256 !== "function") throw new TypeError("execution ids need a sha256(string) => hex function");
  const hex = String(sha256(idKey(parts)) || "");
  if (!/^[0-9a-f]{32,}$/.test(hex)) throw new TypeError("the execution id's sha256 must return a lowercase hex digest");
  return hex.slice(0, 16);
}

// `exec-` + sha256-16 of (tenant, node_id, factory, pipeline_attempt). The
// tenant is part of the address, so two tenants running the same item under
// the same factory never share a record; the pipeline attempt is what lets a
// refused item be re-run without colliding with the refusal's record. The
// LOCAL tenant is the literal `local`, the same word the server falls back to
// for an identity with no org claim.
function executionIdFor({ tenant, node_id, factory, pipeline_attempt }, sha256) {
  return `exec-${sha16([tenant, node_id, factory, pipeline_attempt], sha256)}`;
}

// Byte-compatible with the public candidate contract: repo/node/tree, each
// newline-terminated. Hashing is injected so the client kernel stays portable.
function serverCandidateIdFor({ repo, node_id, tree }, sha256) {
  if (typeof sha256 !== "function") throw new TypeError("candidate ids require sha256");
  const key = `${String(repo || "")}\n${String(node_id || "")}\n${String(tree || "")}\n`;
  return `cand-${sha256(key).slice(0, 16)}`;
}

// The idempotency key for an event that did not bring its own (§5's table).
// Derived from the same shape for EVERY type, so every event is replay-safe.
function derivedEventKey(record, event) {
  const x = record.execution_id;
  switch (event.type) {
    case "candidate.submitted":
    case "candidate.superseded":
      // Both spell "this candidate is now the tip", so both key on the
      // candidate's own content-addressed id: a client that reports one re-pin
      // through both doors records it once.
      return event.candidate && event.candidate.candidate_id ? event.candidate.candidate_id : `${x}:candidate`;
    case "candidate.published":
      return event.candidate_id != null ? `${x}:published:${event.candidate_id}` : null;
    case "gate.started":
      return `${x}:${event.gate_id}:${event.attempt}:started`;
    case "gate.settled":
      return `${x}:${event.gate_id}:${event.attempt}`;
    case "completion.written":
      return `${x}:completion`;
    case "stage.started":
      return `${x}:stage.started:${event.attempt}`;
    case "stage.observed":
      return `${x}:stage.observed:${event.attempt}:${event.state}`;
    case "rescue.started":
      return `${x}:rescue:${event.attempt}`;
    case "integration.started":
      return `${x}:integration:${event.attempt}:started`;
    case "integration.settled":
      return `${x}:integration:${event.attempt}`;
    case "escalation.filed":
      return `${x}:escalation:${event.node_id}`;
    default:
      return null;
  }
}

// The key an event will be recorded under: its own when it brings one, else
// the derived one. What the client stamps on every event it sends (so a
// spooled event replayed after a partition carries the key its first attempt
// carried) and what the local engine suppresses replays against.
function eventKey(record, event) {
  if (!isPlainObject(event)) return null;
  if (event.idempotency_key != null) return String(event.idempotency_key);
  return derivedEventKey(record, event);
}

// ---------------- construction ----------------

function frozenGates(gates) {
  return (gates || []).map((g) => ({
    id: String(g.id),
    node_id: g.node_id != null ? String(g.node_id) : null,
    revision: g.revision != null ? String(g.revision) : null,
    // §2.1 / §3.3: does a verdict on an ANCESTOR of the tip still count toward
    // acceptance? Only an explicit `false` opts a command gate out of the
    // re-judge; everything else (and every agent-review gate, which carries no
    // knob) re-judges a moved tip.
    rejudge_on_repin: g.rejudge_on_repin === false ? false : true,
  }));
}

// Build the pinned execution record. Every revision the pipeline will enforce is
// captured HERE, at claim time, and no event rewrites one (§7.2) — that is the
// whole mechanism behind "ordinary node edits cannot forge successful
// acceptance": the running execution enforces the definition it pinned, and a
// later edit is picked up only by the NEXT pipeline attempt.
function initExecution(spec, { sha256 } = {}) {
  const pipelineAttempt = spec.pipeline_attempt == null ? 1 : Number(spec.pipeline_attempt);
  const boundary = BOUNDARIES.includes(spec.boundary) ? spec.boundary : "gates";
  const gates = frozenGates(spec.gates);
  const id = executionIdFor({
    tenant: spec.tenant,
    node_id: spec.node_id,
    factory: spec.factory_node_id,
    pipeline_attempt: pipelineAttempt,
  }, sha256);
  return {
    spec_version: EXECUTION_SPEC_VERSION,
    execution_id: id,
    tenant: String(spec.tenant),
    pipeline_attempt: pipelineAttempt,
    item: {
      node_id: String(spec.node_id),
      revision: spec.item_revision != null ? String(spec.item_revision) : null,
      repo: spec.repo != null ? String(spec.repo) : null,
    },
    factory: {
      node_id: String(spec.factory_node_id),
      revision: spec.factory_revision != null ? String(spec.factory_revision) : null,
      gates,
    },
    stage: "implementation",
    attempts: [],
    // Per-gate verdicts, keyed by the PINNED gate id. Seeded from the pinned
    // gate list so the read surface reports every declared gate — including the
    // ones that have not started — rather than only those that have reported.
    // `candidate_id` names the candidate the verdict was settled on (§3.3: "a
    // gate fact records the candidate it judged"); boundaryReached compares it to
    // the tip, so a pass on a superseded tree cannot accept the tree that
    // replaced it.
    gate_results: gates.map((g) => ({ id: g.id, state: null, attempt: 0, settled_at: null, candidate_id: null })),
    // `candidate` is the TIP; `candidates` is the append-only §3.3 chain, oldest
    // first, each entry the §3 object as submitted. A fix cycle that commits
    // re-pins (a new tree is a new candidate), so the chain — not one slot — is
    // what lets the store's candidate track the tree the gates are judging.
    candidate: null,
    candidates: [],
    integration: null,
    escalations: [],
    owner: null,
    completion: { boundary, written_at: null, resolver: null },
    // Set by §6.4's detection: the implementer wrote a resolving edge under
    // `completion.by: controller`. Recorded, never acted on here — remediation
    // is the client's §10.7 demotion, enforcement is the server's write gate.
    premature_resolution: false,
    seq: 0,
    created_at: spec.at != null ? String(spec.at) : null,
    updated_at: spec.at != null ? String(spec.at) : null,
  };
}

// ---------------- derived reads ----------------

// Has the execution reached the boundary at which the resolving edge may be
// written? This is criterion 2's "derive completion only from the pinned
// configured acceptance/landing boundary" expressed as one pure predicate, and
// it is what the server's write gate consults — never a child exit code, never
// the presence of an authored resolver node.
function boundaryReached(record, { historicalReplay = false } = {}) {
  if (!record || record.stage === "refused" || record.released_at) return false;
  if (record.stage === "completed") return true;
  const gatesOk = record.gate_results.length > 0 && record.gate_results.every((g) => gateAccepted(record, g, { historicalReplay }));
  // A factory that declares no gates has nothing to judge the candidate with, so
  // a candidate alone is the acceptance boundary. Declared gates must all settle.
  const accepted = (historicalReplay ? !!record.candidate : candidatePublished(record.candidate)) && (record.gate_results.length === 0 || gatesOk);
  if (record.completion.boundary === "gates") return accepted;
  return accepted && !!(record.integration && record.integration.state === "landed");
}

// Was this gate's verdict settled on the tip candidate? §3.3: acceptance is a
// property of the TIP, and a verdict names the candidate it judged. A settled row
// carrying no candidate_id predates the chain (the single-candidate reducer), so
// the only candidate it could have judged is the one that existed — the tip.
function gateOnTip(record, g) {
  const tip = record && record.candidate;
  if (!tip) return false;
  if (g.candidate_id == null) return !Array.isArray(record.candidates) || record.candidates.length <= 1;
  return String(g.candidate_id) === String(tip.candidate_id);
}

// Does this gate's verdict count toward acceptance? Passed/skipped AND on the
// tip — unless the pinned gate opted out of the re-judge (`rejudge_on_repin:
// false`, §2.1's logged opt-out for a suite the operator accepts standing on an
// ancestor for). An ancestor verdict on any other gate is a pass on a tree the
// pipeline is no longer landing, and does not accept the one it is.
function gateAccepted(record, g, { historicalReplay = false } = {}) {
  if (!(g.state === "passed" || g.state === "skipped")) return false;
  if (gateOnTip(record, g) || (historicalReplay && record.candidate && g.candidate_id == null)) return true;
  const pinned = (record.factory && record.factory.gates || []).find((x) => x.id === g.id);
  return !!pinned && pinned.rejudge_on_repin === false;
}

// Terminal = completed or explicitly released. Refusal retains the execution
// and its hold so the same fenced pipeline can be re-gated.
function isTerminal(record) {
  return !!record && (record.stage === "completed" || !!record.released_at);
}

// Is `fence` still the live one, and is the lease unexpired at `now`? Both halves
// matter: a stale fence means someone took over, an expired lease means the owner
// vanished and its writes must stop even before anyone takes over.
function ownershipFence(record, { fence }) {
  const o = record.owner;
  if (!o) return { ok: false, code: "not_owned", message: "execution has no live owner; claim it first" };
  if (Number(fence) !== Number(o.fence)) {
    return {
      ok: false,
      code: "fence_stale",
      message: `fence ${fence} is stale; the execution is held at fence ${o.fence}`,
    };
  }
  return { ok: true };
}

function ownershipLive(record, { fence, now }) {
  const held = ownershipFence(record, { fence });
  if (!held.ok) return held;
  const o = record.owner;
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(o.lease_expires_at)) || Date.parse(o.lease_expires_at) <= Date.parse(now)) {
    return { ok: false, code: "lease_expired", message: `lease expired at ${o.lease_expires_at}` };
  }
  return { ok: true };
}

// ---------------- ownership transitions (fence-bearing, but not events) ----------------
//
// Claim/renew/takeover/release change WHO may write, not WHAT the pipeline has
// done, so they are not part of the §7.3 event vocabulary. They still run
// through the reducer so the fence arithmetic has exactly one home.

// Acquire ownership. A free (or expired, or same-owner) execution is claimable;
// a live lease held by someone else is refused unless `takeover` is set AND the
// lease has expired — an unexpired lease is never stolen, which is the half of
// criterion 2 that keeps two workers off one execution.
function claim(record, { worker, machine, lease_expires_at, now, takeover = false }) {
  if (isTerminal(record)) {
    return { ok: false, code: "execution_terminal", message: `execution is ${record.stage}` };
  }
  const o = record.owner;
  const expired = !o || (o.lease_expires_at != null && Date.parse(o.lease_expires_at) <= Date.parse(now));
  const sameOwner = !!o && o.worker === worker && (o.machine ?? null) === (machine ?? null);
  // An UNEXPIRED lease held by someone else is never stolen — the half of
  // criterion 2 that keeps two workers off one execution. The two refusals are
  // deliberately distinct codes: a plain claim lost a race (`already_owned`,
  // retry later), an explicit takeover asked to break a lease that is still
  // being heartbeated (`lease_live`, the owner is alive — do not).
  if (o && !expired && !sameOwner) {
    if (takeover) {
      return { ok: false, code: "lease_live", message: "cannot take over a live lease", holder: { ...o } };
    }
    return {
      ok: false,
      code: "already_owned",
      message: `execution is owned by ${o.worker} on ${o.machine ?? "(unnamed machine)"} until ${o.lease_expires_at}`,
      holder: { ...o },
    };
  }
  // The fence advances on every ownership ACQUISITION by a different worker (and
  // on an explicit takeover), never on a same-owner re-claim — so a worker that
  // re-claims after a transient network failure keeps the fence its in-flight
  // requests are carrying, while a takeover invalidates the dead worker's fence
  // for good.
  const fence = sameOwner && !takeover ? o.fence : (o ? o.fence : 0) + 1;
  const next = cloneRecord(record);
  next.owner = { worker: String(worker), machine: machine != null ? String(machine) : null, lease_expires_at: String(lease_expires_at), fence };
  next.updated_at = String(now);
  return { ok: true, record: next, fence };
}

// Heartbeat: push the expiry out without touching the fence. Refused on a stale
// fence, so a worker that was taken over cannot resurrect its lease by renewing.
function renew(record, { fence, lease_expires_at, now }) {
  const live = ownershipLive(record, { fence, now });
  if (!live.ok) return live;
  const next = cloneRecord(record);
  next.owner = { ...next.owner, lease_expires_at: String(lease_expires_at) };
  next.updated_at = String(now);
  return { ok: true, record: next, fence: next.owner.fence };
}

// Hand the execution back to the pool. Only the live fence-holder may release —
// a stale owner releasing would hand a takeover holder's execution away.
function release(record, { fence, now }) {
  if (record.stage === "completed") return reject("execution_terminal", "a completed execution cannot be released");
  const live = ownershipLive(record, { fence, now });
  if (!live.ok) return live;
  const next = cloneRecord(record);
  next.owner = null;
  next.released_at = String(now);
  next.updated_at = String(now);
  return { ok: true, record: next };
}

// ---------------- the event reducer ----------------

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function reject(code, message) {
  return { ok: false, code, message };
}

function upsertAttempt(next, event, at) {
  const index = Number(event.attempt);
  let row = next.attempts.find((a) => a.index === index);
  if (!row) {
    row = {
      index,
      pool: POOLS.includes(event.pool) ? event.pool : "implementation",
      stage: event.stage || next.stage,
      run_id: event.run_id != null ? String(event.run_id) : null,
      state: null,
      outcome: null,
      started_at: at,
      finished_at: null,
    };
    next.attempts.push(row);
    next.attempts.sort((a, b) => a.index - b.index);
  }
  return row;
}

// Apply one §7.3 event. Returns {ok:true, record, replayed?} or a typed
// rejection. `seen` is the set of idempotency keys already recorded for this
// execution — the caller (server/execution-store.js) reads it off the durable
// event log, so replay-suppression survives a process restart, not just a retry
// inside one request.
//
// `event.at` is the recorded timestamp; the reducer never reads a clock.
function applyExecutionEvent(record, event, { seen = new Set(), now = null, historicalReplay = false } = {}) {
  if (!event || typeof event !== "object") return reject("invalid_event", "event must be an object");
  if (!EVENT_TYPES.includes(event.type)) {
    return reject("invalid_event", `unknown event type '${event.type}'`);
  }
  const at = event.at != null ? String(event.at) : now != null ? String(now) : null;

  const key = event.idempotency_key != null ? String(event.idempotency_key) : derivedEventKey(record, event);
  if (!key) return reject("invalid_event", `event '${event.type}' has no idempotency key and none could be derived`);
  // Replay: a key already on the durable log is a no-op. This is checked BEFORE
  // ownership so a retry from a worker that has since been fenced out still
  // reads as "already recorded" rather than as a fence error — the retry did not
  // change anything, and reporting a conflict would push a correct client into a
  // spurious recovery path.
  if (seen.has(key)) return { ok: true, record, replayed: true, idempotency_key: key };

  // Terminal BEFORE ownership: a settled execution is settled for everyone, and
  // "this pipeline already completed" is the answer a late writer needs — a
  // fence/lease error would send it into a recovery path for an execution that
  // has nothing left to recover.
  if (isTerminal(record)) {
    return reject("execution_terminal", `execution is ${record.stage}; no further events are accepted`);
  }

  // Every authoritative transition is fenced (criterion 2). No exceptions: an
  // event with no live fence cannot be recorded, so a dead worker's late write
  // never lands after a takeover.
  // Journal rows already passed their admission-time lease check. Their `at`
  // can be an observation clock, so replay must not judge expiry against it.
  // Keep the recorded owner/fence ordering checks even for trusted replay.
  const live = historicalReplay
    ? ownershipFence(record, { fence: event.fence })
    : ownershipLive(record, { fence: event.fence, now: now ?? at });
  if (!live.ok) return live;

  const next = cloneRecord(record);
  const handled = applyByType(next, event, at, { historicalReplay });
  if (!handled.ok) return handled;

  next.seq += 1;
  next.updated_at = at;
  return { ok: true, record: next, idempotency_key: key, seq: next.seq };
}

function applyByType(next, event, at, { historicalReplay = false } = {}) {
  switch (event.type) {
    case "stage.started": {
      if (event.attempt == null) return reject("invalid_event", "stage.started requires an attempt index");
      const row = upsertAttempt(next, event, at);
      row.state = "dispatched";
      row.run_id = event.run_id != null ? String(event.run_id) : row.run_id;
      next.stage = "implementation";
      return { ok: true };
    }
    case "stage.observed": {
      if (event.attempt == null) return reject("invalid_event", "stage.observed requires an attempt index");
      const row = upsertAttempt(next, event, at);
      row.state = event.state != null ? String(event.state) : row.state;
      if (event.outcome != null) row.outcome = String(event.outcome);
      if (event.run_id != null) row.run_id = String(event.run_id);
      // A settled attempt state closes the row. `exhausted` is the pool-spent
      // terminal: nothing is left to dispatch, so the pipeline refuses rather
      // than sitting in `implementation` forever with no owner able to advance it.
      if (SETTLED_ATTEMPT_STATES.includes(row.state)) {
        row.finished_at = at;
        if (row.state === "exhausted") next.stage = "refused";
      }
      return { ok: true };
    }
    case "candidate.submitted":
    case "candidate.superseded":
      return pinCandidate(next, event, at, { historicalReplay });
    case "candidate.published": {
      // §3.4: the publisher stamps the portable reference after the pin (the
      // submission is complete only once the reference verified), so the
      // reference arrives as its own event and lands on the chain entry it names
      // — the tip or an ancestor. The published object is immutable and keyed by
      // candidate_id (first published wins), which is why the idempotency key is
      // `<execution_id>:published:<candidate_id>` and a second publish of the
      // same candidate is a replay, never a re-point.
      if (event.candidate_id == null) return reject("invalid_event", "candidate.published requires the candidate_id it published");
      const id = String(event.candidate_id);
      const entry = chainOf(next).find((c) => String(c.candidate_id) === id);
      if (!entry) return reject("unknown_candidate", `candidate '${id}' is not on this execution's chain`);
      if (event.reference != null && typeof event.reference !== "object") {
        return reject("invalid_event", "candidate.published reference must be an object");
      }
      // The reference timestamp wins when supplied; normalize once before both
      // validation and persistence so a contradictory top-level marker cannot
      // replace the value we actually checked.
      if (historicalReplay) {
        // The source939 development writer kept a top-level clock as advisory
        // metadata; it never overwrote the reference clock with that value.
        // Preserve its accepted publication/republication history verbatim.
        if (event.reference != null) entry.reference = { ...event.reference };
        entry.published_at = event.published_at != null ? String(event.published_at) : at;
        if (event.verified_at != null) entry.verified_at = String(event.verified_at);
        if (next.candidate && String(next.candidate.candidate_id) === id) next.candidate = { ...entry };
        return { ok: true };
      }
      const reference = { ...(event.reference || {}), verified_at: event.reference?.verified_at ?? event.verified_at };
      if (!validVerificationTime(reference.verified_at)) return reject("invalid_event", "publication requires a valid verification timestamp");
      if (entry.reference?.verified_at) {
        if (JSON.stringify(entry.reference) !== JSON.stringify(reference)) return reject("candidate_conflict", "the first published reference is immutable");
      }
      // Even an equal-reference event is journaled with a new sequence. Stamp
      // its publication metadata just as replay will, retaining the first ref.
      entry.reference = reference;
      entry.published_at = event.published_at != null ? String(event.published_at) : at;
      entry.verified_at = reference.verified_at;
      if (next.candidate && String(next.candidate.candidate_id) === id) next.candidate = { ...entry };
      return { ok: true };
    }
    case "gate.started": {
      const g = gateRow(next, event.gate_id);
      if (!g) return reject("unknown_gate", `gate '${event.gate_id}' is not in this execution's pinned gate list`);
      if (!(historicalReplay ? next.candidate : candidatePublished(next.candidate))) return reject("no_candidate", "gates cannot run before a candidate is published");
      if (!historicalReplay || event.admission_version !== undefined) {
        g.state = null;
        g.candidate_id = null;
      }
      g.attempt = Number(event.attempt) || g.attempt + 1;
      next.stage = "gating";
      return { ok: true };
    }
    case "gate.settled": {
      const g = gateRow(next, event.gate_id);
      if (!g) return reject("unknown_gate", `gate '${event.gate_id}' is not in this execution's pinned gate list`);
      if (!GATE_STATES.includes(event.state)) {
        return reject("invalid_event", `gate state must be one of ${GATE_STATES.join("|")}`);
      }
      if (!(historicalReplay ? next.candidate : candidatePublished(next.candidate))) return reject("no_candidate", "a gate cannot settle before a candidate is published");
      if (!historicalReplay && chainOf(next).length > 1 && event.candidate_id == null) return reject("invalid_event", "gate.settled requires the candidate_id judged after a re-pin");
      // The verdict names the candidate it judged (§3.3). A settle that does not
      // say judged the tip — a fix cycle re-pins BEFORE its gate re-judges, so
      // the tip at settle time is the tree the gate ran on. One that names a
      // candidate off the chain judged a tree this execution never pinned.
      let judged = next.candidate.candidate_id != null ? String(next.candidate.candidate_id) : null;
      if (event.candidate_id != null) {
        judged = String(event.candidate_id);
        if (!chainOf(next).some((c) => String(c.candidate_id) === judged)) {
          return reject("unknown_candidate", `candidate '${judged}' is not on this execution's chain`);
        }
      }
      g.state = event.state;
      g.attempt = Number(event.attempt) || g.attempt;
      g.settled_at = at;
      g.candidate_id = judged;
      // A failed gate does NOT refuse the pipeline here: §4.2 spends a cycle or
      // a rescue first, and only the client knows what its pools have left. The
      // refusal arrives as an explicit escalation.filed + stage.observed, so the
      // server never guesses that a fix cycle was unavailable.
      return { ok: true };
    }
    case "rescue.started": {
      if (!next.candidate) return reject("no_candidate", "rescue runs against a candidate");
      next.stage = "gating";
      return { ok: true };
    }
    case "integration.started": {
      if (!boundaryReachedForGates(next, { historicalReplay })) {
        return reject("gates_unsettled", "integration cannot start before every pinned gate has settled passed/skipped");
      }
      next.integration = { state: "running", attempt: Number(event.attempt) || 1, at, ref: null, commit: null };
      next.stage = "integration";
      return { ok: true };
    }
    case "integration.settled": {
      if (!next.integration) return reject("invalid_event", "integration.settled with no integration in flight");
      const state = String(event.state || "");
      if (!["landed", "parked", "failed"].includes(state)) {
        return reject("invalid_event", "integration state must be landed|parked|failed");
      }
      next.integration = {
        ...next.integration,
        state,
        at,
        ref: event.ref != null ? String(event.ref) : null,
        commit: event.commit != null ? String(event.commit) : null,
      };
      // A failed land leaves the pipeline in `integration`; §4.2 sends it back to
      // a fix cycle or to refusal, and the client says which via the next event.
      return { ok: true };
    }
    case "escalation.filed": {
      if (!event.node_id) return reject("invalid_event", "escalation.filed requires the escalation node id");
      next.escalations.push({ node_id: String(event.node_id), reason: event.reason != null ? String(event.reason) : null, at });
      // An escalation that the client marks terminal refuses the pipeline. A
      // non-terminal escalation (an armed human gate's approval item) leaves it
      // live and awaiting.
      if (event.terminal === true) next.stage = "refused";
      return { ok: true };
    }
    case "completion.written": {
      if (!boundaryReached(next, { historicalReplay })) {
        return reject(
          "boundary_not_reached",
          `completion boundary '${next.completion.boundary}' has not been reached`,
        );
      }
      next.completion = {
        ...next.completion,
        written_at: at,
        resolver: event.resolver != null ? String(event.resolver) : null,
      };
      next.stage = "completed";
      return { ok: true };
    }
    default:
      return reject("invalid_event", `unhandled event type '${event.type}'`);
  }
}

function gateRow(record, gateId) {
  return record.gate_results.find((g) => g.id === String(gateId));
}

// The §3.3 chain, oldest first. A record from before the chain existed carries
// only `candidate`; read that as a one-entry chain so every path below works on
// it, and so `candidates` is materialized the first time such a record moves.
function chainOf(next) {
  if (!Array.isArray(next.candidates)) next.candidates = next.candidate ? [{ ...next.candidate }] : [];
  return next.candidates;
}

// candidate.submitted / candidate.superseded: make `event.candidate` the tip.
//
// The client re-pins on EVERY run that commits under the pipeline (§3.3: a fix
// cycle, a rescue amend, an integration fix cycle — a new tree is a new
// candidate), so one slot that refused a second id left the store's candidate
// lagging the tree the gates were actually judging
// (issue-spor-server-execution-store-single-candidate-conflicts-with-repin). The
// chain is the fix, and it is guarded rather than open:
//   - the SAME id again is §3.2's same-tree re-submission: `commits_seen` grows,
//     the pinned commit and reference do not ("first published wins");
//   - a DIFFERENT id must name the current tip in `supersedes`. That is what
//     distinguishes a re-pin (the chain advances, prior verdicts fall off the
//     tip and must be re-judged) from a fork — a second candidate that knows
//     nothing of the first, or one built on an ancestor the chain already left
//     behind — which stays `candidate_conflict`, exactly as before;
//   - nothing supersedes a LANDED candidate: after integration.settled `landed`
//     the tree on the trusted ref is fixed, and a re-pin would make the record
//     name a tip that is not what landed.
function pinCandidate(next, event, at, { historicalReplay = false } = {}) {
  const c = event.candidate;
  if (!c || typeof c !== "object") return reject("invalid_event", `${event.type} requires a candidate object`);
  if (!c.commit || !c.tree) return reject("invalid_event", "a candidate must pin both commit and tree");
  if (!historicalReplay && c.reference?.verified_at != null && !validVerificationTime(c.reference.verified_at)) {
    return reject("invalid_event", "candidate verification timestamp must be valid");
  }
  const chain = chainOf(next);
  const tip = next.candidate;
  if (!historicalReplay && (!tip || String(tip.candidate_id) !== String(c.candidate_id)) && chain.some((entry) => String(entry.candidate_id) === String(c.candidate_id))) {
    return reject("candidate_conflict", "a candidate ID already on the chain cannot become a new tip");
  }
  if (tip && String(tip.candidate_id) === String(c.candidate_id)) {
    const seen = Array.isArray(tip.commits_seen) ? tip.commits_seen.slice() : [];
    if (String(c.commit) !== String(tip.commit) && !seen.includes(String(c.commit))) seen.push(String(c.commit));
    const merged = { ...tip, commits_seen: seen };
    next.candidate = merged;
    const i = chain.findIndex((x) => String(x.candidate_id) === String(c.candidate_id));
    if (i >= 0) chain[i] = { ...merged };
    else chain.push({ ...merged });
  } else {
    if (tip) {
      if (next.integration && next.integration.state === "landed") {
        return reject("candidate_conflict", `integration already landed candidate ${tip.candidate_id}; nothing supersedes a landed candidate`);
      }
      const supersedes = c.supersedes != null ? String(c.supersedes) : event.supersedes != null ? String(event.supersedes) : null;
      if (supersedes !== String(tip.candidate_id)) {
        return reject(
          "candidate_conflict",
          supersedes == null
            ? `execution already holds candidate ${tip.candidate_id}; a re-pin must name it in 'supersedes'`
            : `execution's tip is ${tip.candidate_id}, not ${supersedes}; a re-pin must supersede the current tip`,
        );
      }
    }
    if (tip && (!historicalReplay || event.admission_version !== undefined)) {
      // Old source939 repins kept in-flight integration and null bindings;
      // marked new admissions invalidate them identically on replay.
      for (const g of next.gate_results) if (g.candidate_id == null && g.state != null) g.candidate_id = tip.candidate_id;
      next.integration = null;
    }
    const entry = { ...c, supersedes: tip ? String(tip.candidate_id) : c.supersedes != null ? String(c.supersedes) : null };
    next.candidate = entry;
    chain.push({ ...entry });
  }
  if (event.premature_resolution === true) next.premature_resolution = true;
  const row = next.attempts.find((a) => a.index === Number(c.provenance && c.provenance.attempt));
  if (row) {
    row.state = "candidate";
    row.outcome = "candidate";
    row.finished_at = row.finished_at || at;
  }
  // A re-pin sends the pipeline back through the gates (§3.3: acceptance is a
  // property of the tip; §4.2 G3/N4: fix cycle → re-pin → re-judge), including
  // from a failed or parked integration. It never restarts the gate LIST — the
  // verdicts keep their rows and simply fall off the tip.
  next.stage = "gating";
  return { ok: true };
}

// The gates half of boundaryReached, split out because integration.started needs
// it before a candidate could possibly have satisfied the full boundary.
function validVerificationTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function candidatePublished(candidate) {
  // Existing journals accepted nonempty markers before timestamp validation.
  // Preserve their recorded acceptance without inventing a replacement clock.
  // New pin/publication events validate strictly; only trusted journal rebuild
  // opts into historicalReplay when folding those already accepted events.
  return typeof candidate?.reference?.verified_at === "string" && candidate.reference.verified_at.length > 0;
}

function boundaryReachedForGates(record, { historicalReplay = false } = {}) {
  if (!(historicalReplay ? record.candidate : candidatePublished(record.candidate))) return false;
  if (record.gate_results.length === 0) return true;
  return record.gate_results.every((g) => gateAccepted(record, g, { historicalReplay }));
}


function decorate(record) {
  return record ? { ...record, boundary_reached: boundaryReached(record), terminal: isTerminal(record) } : null;
}

// Replay a durable log (oldest first) over a fresh record — the repair path
// for a torn materialized view, and the parity oracle: the record on disk (or
// the one the server returns) must equal the record its log reproduces.
// Pure: the caller reads the lines; this only folds them. Returns null when
// the log carries no genesis.
function rebuildFromEvents(events, { sha256 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const genesis = list.find((e) => e && e.type === "execution.opened");
  if (!genesis || !isPlainObject(genesis.spec)) return null;
  let record = initExecution(genesis.spec, { sha256 });
  const seen = new Set();
  for (const ev of list) {
    if (!ev || ev.type === "execution.opened") continue;
    if (ev.type === "ownership.changed") {
      record = { ...record, owner: ev.owner ? { ...ev.owner } : null, ...(ev.released_at ? { released_at: ev.released_at } : {}), updated_at: ev.at };
      continue;
    }
    const r = applyExecutionEvent(record, ev, { seen, historicalReplay: true });
    if (r.ok && !r.replayed) {
      record = r.record;
      seen.add(String(r.idempotency_key));
    }
  }
  return record;
}

module.exports = {
  EXECUTION_SPEC_VERSION,
  EVENT_TYPES,
  LOG_ONLY_TYPES,
  STAGES,
  BOUNDARIES,
  POOLS,
  GATE_STATES,
  INTEGRATION_STATES,
  SETTLED_ATTEMPT_STATES,
  OWNERSHIP_CODES,
  idKey,
  executionIdFor,
  serverCandidateIdFor,
  derivedEventKey,
  eventKey,
  initExecution,
  applyExecutionEvent,
  boundaryReached,
  gateOnTip,
  gateAccepted,
  isTerminal,
  ownershipLive,
  decorate,
  claim,
  renew,
  release,
  rebuildFromEvents,
};
