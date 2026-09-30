"use strict";
// The work loop's ONE durable outcome door
// (task-spor-extract-work-loop-plan-execute-and-outcome-door).
//
// A run the loop gives up on touches three durable places — the machine-local
// run record, the execution store, and the graph (an execution hold on the
// item, a claim lease on the node) — and those writes used to be separate
// steps spread over pollWorkRuns, releaseIdleLease and dispatchWorkItem, each
// choosing its own order. Two of those orders were wrong in the way that
// matters: a refused dispatch cleared the GRAPH hold first and then ended the
// execution best-effort, and the implementation stage's `unroutable` branch
// never ended the execution at all — either one hands the item back to the
// queue while the authoritative execution still holds it
// (issue-spor-unroutable-dispatch-clears-graph-before-execution).
//
// So every terminal step goes through here, in ONE fixed order per outcome:
//
//   withdrawExecution   an execution that will run nothing (a dispatch refused
//                       before any run record, an implementer that cannot be
//                       re-dispatched):
//                         1. OWE — a debt file naming the exact execution is
//                            written before anything is ended;
//                         2. END the execution in its store under the fence,
//                            and CONFIRM it by an authoritative read (a cached
//                            answer or a failed read is not an ending);
//                         3. only then CLEAR the graph hold, by CAS on that
//                            exact execution id — a hold naming any other
//                            execution is a newer owner and is left alone;
//                         4. retire the debt.
//                       A failed or ambiguous step 2 keeps the hold (and the
//                       debt): the item stays out of the queue until the store
//                       agrees nothing holds it. `reconcileWithdrawals` re-drives
//                       every owed debt from step 2, so an interruption or a lost
//                       acknowledgement between steps converges on a later pass.
//
//   settleIdleStop      a wedged run the idle ceiling stopped: the run is
//                       stopped and its RECORD closed first, then the lease this
//                       dispatch established is handed back — so a crash between
//                       the two leaves a closed record and a held lease (lapsing
//                       at its TTL), never a released lease with no record of why
//                       (issue-spor-idle-stop-never-releases-lease).
//
// Everything that touches a store, the graph or a process is injected, so the
// orders above are testable against fakes.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const executionKernel = require("../kernel/execution.js");

const journalDir = (home) => path.join(home, "journal", "work-outcome");
const sameOrigin = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
// Keyed by origin (server + org) AND execution id, so two tenants sharing a
// SPOR_HOME and an execution id never overwrite each other's debt.
const debtName = (executionId, origin) => `${crypto.createHash("sha256").update(JSON.stringify([origin == null ? null : origin, String(executionId)])).digest("hex").slice(0, 32)}.withdraw.json`;

// The store refusals that say THIS holder can never end the execution: its
// fence was superseded (a takeover), or the execution is gone. Retrying them
// cannot succeed, and the graph hold is left for whoever holds it now. An
// expired lease is in the kernel's set too, but only reaches this rule after
// the re-claim below lost to someone else.
const OWNERSHIP_LOST = new Set([...executionKernel.OWNERSHIP_CODES, "not_found", "forbidden", "unauthorized"]);

function oweWithdrawal(home, debt) {
  const file = path.join(journalDir(home), debtName(debt.execution_id, debt.origin));
  try {
    writeFileAtomic(file, `${JSON.stringify(debt)}\n`, { mkdir: true });
    return { file, owed: true };
  } catch (e) {
    // The order below is what keeps the item safe; the debt only makes a
    // crash between its steps recoverable. An unwritable journal still ends
    // the execution before touching the graph — it just cannot be re-driven.
    return { file: null, owed: false, error: e.message };
  }
}

function retire(file) {
  if (!file) return true;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    return e.code === "ENOENT";
  }
}

// Steps 2-4 for one owed withdrawal. Returns `{ok, pending, ...}`: `pending`
// means the debt is still owed (kept on disk for the next pass).
async function finishWithdrawal({ file, debt: owed, openStore, clearHold }) {
  let debt = owed;
  const nodeId = debt.node_id;
  const executionId = debt.execution_id;
  let terminated = null;
  if (debt.store) {
    let store = null;
    try {
      store = openStore(debt);
    } catch (e) {
      return { ok: false, pending: true, reason: `the execution store could not be opened (${e.message}); the hold on ${nodeId} is kept` };
    }
    const end = async (fence) => {
      try {
        return await store.terminate(executionId, { fence, reason: debt.reason || null });
      } catch (e) {
        return { ok: false, transport: true, message: e.message };
      }
    };
    let t = await end(debt.fence);
    if (t && !t.ok && t.code === "lease_expired" && typeof store.claim === "function") {
      // The lease lapsed while the withdrawal was owed (a crash, an outage
      // longer than the TTL) and NOBODY holds the execution: take it back —
      // an ordinary claim, which wins only over an expired lease and advances
      // the fence — and end it under the new fence. Leaving it would strand
      // the item: the hold keeps it out of the queue, so no worker would ever
      // come back to take the execution over. A claim that loses (someone
      // else took it over meanwhile) falls through to the ownership rule.
      let claimed = null;
      try {
        claimed = await store.claim(executionId, {});
      } catch (e) {
        claimed = { ok: false, transport: true, message: e.message };
      }
      if (claimed && claimed.ok && claimed.fence != null) {
        // The debt now owes the withdrawal under the NEW fence: a transient
        // failure below must be re-driven under it, never under the one the
        // claim just superseded (which would read as a takeover).
        debt = { ...debt, fence: claimed.fence };
        if (file) {
          try {
            writeFileAtomic(file, `${JSON.stringify(debt)}\n`, { mkdir: true });
          } catch {
            /* the old fence is re-claimed the same way next pass */
          }
        }
        t = await end(claimed.fence);
      } else if (claimed && !claimed.ok) t = claimed;
    }
    let read = null;
    try {
      read = await store.get(executionId);
    } catch (e) {
      read = { ok: false, transport: true, message: e.message };
    }
    const ended = !!(read && read.ok && !read.cached && read.execution && read.execution.terminal);
    if (!ended) {
      // Someone else's fence now owns the execution (or it is gone): nothing
      // this debt can end, and the hold is theirs. Retire the debt and say so.
      const code = (t && t.code) || (read && read.code) || null;
      if (t && !t.ok && !t.transport && !t.transient && (t.ownership === false || OWNERSHIP_LOST.has(code))) {
        retire(file);
        return { ok: false, pending: false, retained: true, reason: `execution ${executionId} is no longer this worker's to end (${code}: ${t.message || ""}); the hold on ${nodeId} is left for its owner — a person can run 'spor release ${nodeId} --execution ${executionId}'` };
      }
      return { ok: false, pending: true, reason: `execution ${executionId} could not be confirmed ended (${(t && (t.code || t.message)) || "no answer"}); the hold on ${nodeId} is kept and the withdrawal is re-driven next pass` };
    }
    terminated = true;
  }
  let cleared = null;
  try {
    cleared = await clearHold({ nodeId, executionId });
  } catch (e) {
    cleared = { ok: false, reason: e.message };
  }
  if (!cleared || !cleared.ok) {
    if (cleared && cleared.foreign) {
      // A NEWER hold (another execution) sits on the item: preserved.
      retire(file);
      return { ok: true, pending: false, terminated, cleared: false, preserved: cleared.holder || true, note: cleared.reason };
    }
    return { ok: false, pending: true, terminated, reason: `execution ${executionId} ended, but its hold on ${nodeId} could not be cleared (${(cleared && cleared.reason) || "no answer"}); re-driven next pass` };
  }
  if (!retire(file)) return { ok: true, pending: true, terminated, cleared: !!cleared.cleared, reason: "the withdrawal debt could not be retired; the next pass re-checks it" };
  return { ok: true, pending: false, terminated, cleared: !!cleared.cleared };
}

// The door for "this execution will run nothing": OWE, then end, then clear.
// `debt`: {node_id, execution_id, fence, store (mode, or null for a pre-adapter
// claim that opened no store), reason, origin}. `openStore(debt)` reopens the
// store the claim opened; `clearHold({nodeId, executionId})` is the exact-
// execution graph CAS (completion.js clearHold), whose refusal on a different
// holder carries `foreign: true`.
async function withdrawExecution({ home, debt, openStore, clearHold }) {
  const owed = oweWithdrawal(home, { version: 1, owed_at: new Date().toISOString(), ...debt });
  const result = await finishWithdrawal({ file: owed.file, debt, openStore, clearHold });
  return owed.owed ? result : { ...result, unowed: owed.error };
}

// Re-drive every withdrawal still owed on this box whose origin (graph +
// credential) is the current one. A debt from another origin is left for a
// worker bound to it; recovery never clears a hold naming a newer execution,
// because step 3 is the same exact-id CAS the first attempt used.
async function reconcileWithdrawals({ home, origin, openStore, clearHold }) {
  let names;
  try {
    names = fs.readdirSync(journalDir(home));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const results = [];
  for (const name of names.filter((n) => /^[a-f0-9]{32}\.withdraw\.json$/.test(n))) {
    const file = path.join(journalDir(home), name);
    let debt = null;
    try {
      debt = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // a torn or unreadable debt is left for a person, never guessed at
    }
    if (!debt || !debt.node_id || !debt.execution_id || !sameOrigin(debt.origin, origin)) continue;
    results.push({ node_id: debt.node_id, execution_id: debt.execution_id, ...(await finishWithdrawal({ file, debt, openStore, clearHold })) });
  }
  return results;
}

// The door for a wedged run the idle ceiling stops: stop + close the record,
// THEN release the lease. `stopIdleRun(record, {idleMs, quietAt, outcome})`
// returns `{record, stopped}`; `releaseLease(closed, {ended, outcome})` returns
// the record as stamped. The run counts as ENDED only when something of ours
// was signalled and nothing answers any more — "we sent SIGTERM" is not
// enough to believe the checkout is free.
async function settleIdleStop({ record, idleMs, quietAt, outcome, stopIdleRun, releaseLease }) {
  const { record: closed, stopped } = await stopIdleRun(record, { idleMs, quietAt, outcome });
  const ended = !!((stopped.child || stopped.supervisor || stopped.group) && !stopped.alive);
  const released = await releaseLease(closed, { ended, outcome });
  return { closed, stopped, ended, record: released };
}

module.exports = { withdrawExecution, reconcileWithdrawals, finishWithdrawal, settleIdleStop, journalDir, debtName, OWNERSHIP_LOST };
