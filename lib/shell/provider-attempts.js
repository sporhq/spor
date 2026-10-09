"use strict";
// shell/provider-attempts.js — the worker side of the provider attempt handle
// (task-spor-work-attempt-handle-adoption; PROVIDERS.md §6, EXECUTION-STATE.md
// §3/§5's `attempts[].provider`, dec-spor-server-execution-provider-attempt-
// handle-events).
//
// WHERE an attempt runs is a provider's environment, and the one durable fact
// that lets a restarted or takeover worker find that environment again is the
// execution record. This module is the ONE place a worker writes it, in the
// order the contract fixes:
//
//   1. mint the submit key, then persist `attempt.submitting {provider, key,
//      request}` on the execution record — BEFORE the first send. A store that
//      does not confirm the write means nothing is sent (a spooled-but-
//      unconfirmed event is not on the record a takeover worker reads).
//   2. send `submit` under that key.
//   3. once a handle comes back, persist `attempt.submitted {provider, handle,
//      env}` BEFORE returning to the loop, which only then harvests.
//
// A reply that never came back (a timeout, a dropped connection, a provider
// that died mid-answer) is UNKNOWN ACCEPTANCE: the attempt is HELD — never
// failed, never resubmitted under a new key — and the next pass reconciles it
// by re-sending the PERSISTED request under the PERSISTED key, which a
// conforming provider answers with the existing handle (`existing: true`)
// instead of a second environment. A provider that can answer "what did you
// accept under this key" without being handed the request again (the `local`
// provider reads its run records) offers `lookup(key)`, consulted first.
//
// A record that already carries a handle is ADOPTED: nothing is submitted, the
// recorded handle is the attempt (`submitAttempt` returns it, `observeAttempt`
// relays its state as `attempt.observed`). A record whose provider is not one
// this box runs is ORPHANED: reported, never re-dispatched elsewhere — the
// substitution rule (dec-spor-machine-profile-satisfiability) applied to WHERE.
//
// Everything here is dependency-injected: a `store` (lib/shell/execution-
// store.js's interface — get/event/list) and a provider CLIENT, the uniform
// face `envelopeClient` (a contract-envelope provider: the stdio binding, the
// conformance fixtures) and `inProcessClient` (the `local` provider's impl)
// build. A client's submit/observe THROWS `ProviderError` for a refusal the
// provider answered and anything else for a reply that was lost.

const { ProviderError, LostReply } = require("./provider-conformance.js");
const pc = require("../kernel/provider-contract.js");
const kernel = require("../kernel/execution.js");

// The store answers that mean this process no longer writes the execution.
const OWNERSHIP_GONE = new Set([...kernel.OWNERSHIP_CODES, "execution_terminal"]);

// ------------------------------------------------------------------ clients

// A contract-envelope provider (`request(msg) -> response`) as a client. An
// `ok: false` envelope is the provider's answer (ProviderError); a throw or a
// request that outlives `timeoutMs` is a lost reply (LostReply).
function envelopeClient(id, provider, { timeoutMs = 30000 } = {}) {
  let seq = 0;
  const call = async (op, params) => {
    const msg = { contract_version: pc.CONTRACT_VERSION, id: `attempt-${op}-${++seq}`, op, params };
    let timer;
    let res;
    try {
      res = await Promise.race([
        provider.request(msg),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LostReply(op)), timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
    } catch (e) {
      throw e instanceof LostReply ? e : Object.assign(new LostReply(op), { cause: e });
    } finally {
      clearTimeout(timer);
    }
    if (!res || typeof res !== "object") throw new LostReply(op);
    if (!res.ok) {
      const e = res.error || {};
      throw new ProviderError(String(e.code || "internal"), String(e.message || `${op} refused`), { retryable: !!e.retryable });
    }
    return res.result;
  };
  return {
    id,
    submit: (params) => call("submit", params),
    observe: (params) => call("observe", params),
  };
}

// An in-process provider impl (lib/shell/providers/local.js) as a client.
// Its refusals are already ProviderErrors; any other throw is read as a LOST
// reply — the safe side, since a launch that threw after it spawned may have
// left an environment behind.
function inProcessClient(id, impl) {
  const wrap = (op) => async (params) => {
    try {
      return await impl[op](params);
    } catch (e) {
      if (e && e.name === "ProviderError") throw e;
      throw Object.assign(new LostReply(op), { cause: e });
    }
  };
  return {
    id,
    submit: wrap("submit"),
    observe: wrap("observe"),
    ...(typeof impl.lookup === "function" ? { lookup: (key) => impl.lookup({ idempotency_key: key }) } : {}),
  };
}

// --------------------------------------------------------------- the record

function providerRow(execution, attempt) {
  const row = execution && Array.isArray(execution.attempts) ? execution.attempts.find((a) => a.index === Number(attempt)) : null;
  return row && row.provider ? row.provider : null;
}

// The submit key, minted ONCE for the attempt about to be submitted
// (PROVIDERS.md §6: from execution_id, fence and attempt_id). Only ever used
// for a FIRST submit — every re-send reads the persisted one back, because a
// restarted worker is a new instance under a new fence, and a key re-derived
// from its own identity would be a new key, which is a new environment.
function mintSubmitKey({ executionId, attempt, fence, instance }) {
  return `${executionId}/a${Number(attempt)}/${fence}/${instance || "worker"}`;
}

async function readExecution(store, executionId) {
  const r = await store.get(executionId);
  return r && r.ok && r.execution ? r.execution : null;
}

// A store write counts as PERSISTED only when the store answered for it: a
// recorded event or a replay of one already recorded. A spooled (deferred)
// remote event is durable on this box but not on the record a takeover worker
// on another box would read, so it does not count.
async function persist(store, executionId, fence, event) {
  let r;
  try {
    r = await store.event(executionId, { fence, event });
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  if (r && r.ok) return { ok: true };
  return { ok: false, code: r && r.code, reason: `${(r && r.code) || "store"}: ${(r && r.message) || "the store did not confirm the write"}${r && r.deferred ? " (spooled, not yet on the record)" : ""}` };
}

// A fenced write BEFORE acting on what the record already holds (adopting its
// handle, or re-sending its persisted submit): a renew of the lease under this
// caller's fence. The record read that found the row is not proof of ownership
// — a stale fence holder reads the same record — so without this a fenced-out
// worker would follow (or re-send for) an attempt a takeover now owns, and be
// refused only at its next `attempt.observed`. A store that cannot confirm the
// renew (fenced out, expired, offline) means nothing is acted on.
async function confirmFence(store, executionId, fence) {
  let r;
  try {
    r = typeof store.renew === "function" ? await store.renew(executionId, { fence, ...(store.ttlMs != null ? { ttl_ms: store.ttlMs } : {}) }) : { ok: false, code: "unsupported", message: "the store has no renew door" };
  } catch (e) {
    r = { ok: false, message: String((e && e.message) || e) };
  }
  if (r && r.ok) return { ok: true };
  const code = (r && r.code) || "store";
  return { ok: false, code, ownershipLost: OWNERSHIP_GONE.has(code), reason: `${code}: ${(r && r.message) || "the store did not confirm the renew"}` };
}

function settledSubmit(result, providerId, { adopted = false, reconciled = false } = {}) {
  return { ok: true, providerId, handle: result.handle, env: result.env || null, existing: !!result.existing, adopted, reconciled };
}

// ------------------------------------------------------------------ submit

// Submit (or reconcile, or adopt) attempt `attempt` of `executionId` through
// `client`. `request` is the PERSISTABLE submit params minus the key (plain
// JSON: `{attempt: <spec>}`); `augment(params)` adds what must not be
// persisted at send time (the `local` provider's live launch block). Returns:
//   {ok: true, handle, env, existing, adopted, reconciled}
//   {ok: false, held: true, acceptance: "unknown", reason}  reply lost — HOLD
//   {ok: false, held: true, handle, reason}                 accepted, the
//                                                           handle not persisted
//   {ok: false, refused: true, code, reason}                the provider said no
//   {ok: false, notPersisted: true, reason}                 nothing was sent
//   {ok: false, orphaned: true, providerId, reason}         the record names a
//                                                           provider not this one
//   {ok: false, held: true, fenced: true, code, reason}     the record holds a
//                                                           row but this caller's
//                                                           fence could not be
//                                                           confirmed — nothing
//                                                           adopted or re-sent
async function submitAttempt({ store, executionId, fence, attempt = 1, client, key, request, augment = null, log = () => {} }) {
  const execution = await readExecution(store, executionId);
  if (!execution) return { ok: false, notPersisted: true, reason: `execution ${executionId} could not be read; nothing was sent` };
  const row = providerRow(execution, attempt);
  if (row && row.id !== client.id) {
    return { ok: false, orphaned: true, providerId: row.id, handle: row.handle || null, reason: `attempt ${attempt} of ${executionId} was submitted through provider '${row.id}', not '${client.id}'` };
  }
  // Acting on a recorded row (adopt or reconcile) is fenced first.
  if (row) {
    const fenced = await confirmFence(store, executionId, fence);
    if (!fenced.ok) {
      return { ok: false, held: true, fenced: true, ownershipLost: fenced.ownershipLost, code: fenced.code, reason: `attempt ${attempt} of ${executionId} is recorded, but fence ${fence} could not be confirmed (${fenced.reason}); nothing adopted or re-sent` };
    }
  }
  // ADOPT: a recorded handle IS the attempt. Nothing is submitted.
  if (row && row.handle != null) {
    return { ok: true, providerId: row.id, handle: row.handle, env: row.env || null, existing: true, adopted: true, reconciled: false };
  }
  let submitKey = key;
  let params = request;
  const reconciling = !!row;
  if (reconciling) {
    // RECONCILE: the previous submit's key and request were persisted but no
    // handle ever was (a lost reply, or a worker that died between the send
    // and the persist). Re-send exactly those — never what this caller minted.
    submitKey = row.idempotency_key;
    params = row.request || {};
  } else {
    const wrote = await persist(store, executionId, fence, {
      type: "attempt.submitting", attempt, provider: client.id, submit_idempotency_key: submitKey, request: params,
    });
    if (!wrote.ok) return { ok: false, notPersisted: true, reason: `the submit key could not be persisted on ${executionId} (${wrote.reason}); nothing was sent` };
  }
  let result = null;
  if (reconciling && client.lookup) {
    try {
      result = (await client.lookup(submitKey)) || null;
    } catch {
      result = null; // a lookup that cannot answer falls through to the re-send
    }
  }
  if (!result) {
    const sendParams = { ...JSON.parse(JSON.stringify(params)), idempotency_key: submitKey };
    try {
      result = await client.submit(augment ? augment(sendParams) : sendParams);
    } catch (e) {
      if (e && e.name === "ProviderError" && !e.retryable) {
        return { ok: false, refused: true, code: e.code, reason: `${client.id} refused the submit: ${e.code}: ${e.message}` };
      }
      log(`attempt ${attempt} of ${executionId}: the ${client.id} submit reply was lost (${(e && e.message) || e}) — acceptance unknown; holding under key ${submitKey}`);
      return { ok: false, held: true, acceptance: "unknown", key: submitKey, reason: `the ${client.id} submit reply was lost; acceptance is unknown and the attempt is held for reconcile under its persisted key` };
    }
  }
  if (!result || result.handle == null) {
    return { ok: false, held: true, acceptance: "unknown", key: submitKey, reason: `${client.id} answered the submit with no handle; the attempt is held for reconcile` };
  }
  const wrote = await persist(store, executionId, fence, {
    type: "attempt.submitted", attempt, provider: client.id, handle: result.handle, submit_idempotency_key: submitKey,
    ...(result.env && typeof result.env === "object" && !Array.isArray(result.env) ? { env: result.env } : {}),
  });
  if (!wrote.ok) {
    return { ok: false, held: true, handle: result.handle, env: result.env || null, key: submitKey, reason: `${client.id} accepted the attempt but its handle could not be persisted (${wrote.reason}); held for reconcile under its key` };
  }
  return settledSubmit(result, client.id, { adopted: reconciling, reconciled: reconciling });
}

// ----------------------------------------------------------------- observe

// One observe of an adopted/submitted attempt, relayed onto the record as
// `attempt.observed` (a repeat of the last state is a replay the store
// absorbs). Evidence only — never a task outcome (PROVIDERS.md §5). A handle
// the provider no longer knows is recorded `lost`; a lost reply records
// nothing and is retried next pass. A terminal environment is not observed
// again.
async function observeAttempt({ store, executionId, fence, attempt = 1, client, execution = null }) {
  const rec = execution || (await readExecution(store, executionId));
  const row = providerRow(rec, attempt);
  if (!row || row.handle == null) return { ok: false, reason: "no submitted handle to observe" };
  if (kernel.OBSERVE_TERMINAL_STATES.includes(row.last_state)) return { ok: true, state: row.last_state, settled: true };
  let view;
  try {
    view = await client.observe({ handle: row.handle });
  } catch (e) {
    if (e && e.name === "ProviderError" && e.code === "unknown_handle") view = { state: "lost", detail: `the provider no longer knows the handle: ${e.message}` };
    else return { ok: false, transient: true, reason: String((e && e.message) || e) };
  }
  const state = view && typeof view.state === "string" ? view.state : null;
  if (!state) return { ok: false, reason: "the observe answered no state" };
  const wrote = await persist(store, executionId, fence, { type: "attempt.observed", attempt, state, ...(view.detail != null ? { detail: String(view.detail) } : {}) });
  return { ok: true, state, recorded: wrote.ok, ...(wrote.ok ? {} : { code: wrote.code, reason: wrote.reason }), ...(view.exit ? { exit: view.exit } : {}) };
}

// -------------------------------------------------------------------- scan

// Classify every LIVE execution's provider attempts against the providers
// this box runs. Pure. One entry per attempt row that went through a provider:
//   adopt      a handle is recorded and its provider runs here
//   reconcile  only the submit key is recorded (acceptance unknown)
//   orphaned   the provider is not configured here — reported, never
//              re-dispatched elsewhere
//   settled    the environment already reported a terminal state
//
// An attempt whose persisted request names the MACHINE it was submitted from
// (`request.machine` — the `local` provider's environments and its key ->
// handle table live on that box alone) is orphaned on every other box: a
// worker elsewhere cannot see the run and must never re-send its key.
function foreignMachine(p, machine) {
  const m = p && p.request && typeof p.request === "object" ? p.request.machine : null;
  return machine != null && m != null && String(m) !== String(machine);
}

function classifyProviderAttempts(executions, { configured = [], machine = null } = {}) {
  const here = new Set(configured);
  const out = [];
  for (const ex of executions || []) {
    if (!ex || kernel.isTerminal(ex)) continue;
    for (const row of ex.attempts || []) {
      const p = row && row.provider;
      if (!p) continue;
      const base = { execution_id: ex.execution_id, node_id: ex.item && ex.item.node_id, attempt: row.index, provider: p.id, handle: p.handle == null ? null : p.handle, key: p.idempotency_key || null, last_state: p.last_state || null };
      let disposition;
      if (kernel.OBSERVE_TERMINAL_STATES.includes(p.last_state)) disposition = "settled";
      else if (!here.has(p.id) || foreignMachine(p, machine)) disposition = "orphaned";
      else disposition = p.handle != null ? "adopt" : "reconcile";
      out.push({ ...base, disposition });
    }
  }
  return out;
}

// The per-pass sweep the work loop runs (`deps.providerAttempts`):
//   - every attempt this PROCESS owns (`owned`: execution id -> {fence,
//     attempt, client, node_id}, filled by the dispatch door as it submits or
//     adopts) is observed and relayed as `attempt.observed`, and — while its
//     environment is not terminal and the loop is not already following it as
//     a run — reported BUSY so the loop never dispatches its node again;
//   - every live execution the store lists is classified, and an attempt
//     whose provider is not configured here is reported ORPHANED (its node is
//     kept out of dispatch on this box and surfaced in `spor work --status`).
// Never claims an execution itself: adoption is the dispatch door's, under
// the fence a fresh claim hands it.
async function sweepProviderAttempts({ store, owned = new Map(), configured = [], machine = null, log = () => {}, list = null }) {
  const busy = new Set();
  for (const [executionId, a] of [...owned.entries()]) {
    // A handle the provider returned but the record never took (the
    // `attempt.submitted` write failed and the launch went ahead) is persisted
    // here, before anything is observed — the record is what a successor reads.
    if (a.handle != null && a.key) {
      const rec = await readExecution(a.store || store, executionId);
      const row = providerRow(rec, a.attempt);
      if (row && row.handle == null) {
        const wrote = await persist(a.store || store, executionId, a.fence, { type: "attempt.submitted", attempt: a.attempt, provider: row.id, handle: a.handle, submit_idempotency_key: row.idempotency_key, ...(a.env && typeof a.env === "object" && !Array.isArray(a.env) ? { env: a.env } : {}) });
        if (!wrote.ok) log(`work: attempt ${a.attempt} of ${executionId} — its handle is still not on the record (${wrote.reason}); retried next pass`);
      }
    }
    const r = await observeAttempt({ store: a.store || store, executionId, fence: a.fence, attempt: a.attempt, client: a.client });
    // A terminal environment is done being followed; an attempt whose
    // execution this process no longer owns (a takeover advanced the fence,
    // or it ended) is the new owner's to relay.
    if ((r.ok && kernel.OBSERVE_TERMINAL_STATES.includes(r.state)) || (r.recorded === false && OWNERSHIP_GONE.has(r.code))) {
      owned.delete(executionId);
      continue;
    }
    if (!r.ok && !r.transient) log(`work: attempt ${a.attempt} of ${executionId} — observe not relayed (${r.reason})`);
    if (a.node_id) busy.add(a.node_id);
  }
  let executions = [];
  try {
    const listed = list ? await list() : await store.list({ limit: 200 });
    executions = listed && listed.ok && Array.isArray(listed.executions) ? listed.executions : [];
  } catch {
    executions = [];
  }
  const orphaned = classifyProviderAttempts(executions, { configured, machine }).filter((e) => e.disposition === "orphaned");
  return { busy: [...busy], orphaned };
}

module.exports = {
  envelopeClient,
  inProcessClient,
  providerRow,
  mintSubmitKey,
  submitAttempt,
  observeAttempt,
  classifyProviderAttempts,
  foreignMachine,
  sweepProviderAttempts,
};
