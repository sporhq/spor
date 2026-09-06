"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");

const journalDir = home => path.join(home, "journal", "person-force-release");
const originKey = origin => crypto.createHash("sha256").update(JSON.stringify(origin)).digest("hex");
const receiptMatches = (record, debt) => record && record.execution_id === debt.execution_id && record.item?.node_id === debt.node_id && record.released_at &&
  record.force_release?.request_id === debt.request.request_id && record.force_release.reason === debt.request.reason && record.force_release.expected_revision === debt.request.expected_revision;

// Recovery can only read an acknowledged receipt and clear its EXACT graph
// hold. It never calls forceRelease, claims an owner, or replays person authority.
async function finishCleanup({ file, debt, store, origin, clearHold }) {
  if (originKey(origin) !== originKey(debt.origin)) return { ok: false, pending: true, reason: "release cleanup belongs to a different graph or credential" };
  const read = await store.get(debt.execution_id);
  if (!read.ok || read.cached || !receiptMatches(read.execution, debt)) return { ok: false, pending: true, reason: "force release is not authoritatively acknowledged; cleanup remains owed" };
  const receipt = read.execution.force_release;
  const cleared = await clearHold({ nodeId: debt.node_id, executionId: debt.execution_id, releasedBy: `${receipt.person}@${receipt.at}: ${receipt.reason}` });
  if (!cleared.ok) return { ok: false, pending: true, reason: `execution released, graph cleanup remains owed: ${cleared.reason}` };
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") return { ok: false, pending: true, reason: "execution released, cleanup receipt could not be retired" }; }
  return { ok: true, released: true, execution: read.execution, cleared: !!cleared.cleared };
}

async function reconcilePersonReleaseCleanups({ home, store, origin, clearHold, nodeId = null, executionId = null }) {
  let names;
  try { names = fs.readdirSync(journalDir(home)); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const results = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}-[a-zA-Z0-9_-]{1,128}\.json$/.test(n))) {
    const file = path.join(journalDir(home), name);
    const debt = JSON.parse(fs.readFileSync(file, "utf8"));
    if ((nodeId && debt.node_id !== nodeId) || (executionId && debt.execution_id !== executionId) || originKey(origin) !== originKey(debt.origin)) continue;
    results.push(await finishCleanup({ file, debt, store, origin, clearHold }));
  }
  return results;
}

async function personForceRelease({ home, store, origin, nodeId, executionId, reason, clearHold, requestId = crypto.randomUUID() }) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) return { ok: false, reason: "--force requires --reason with 1-2000 characters" };
  reason = reason.trim();
  const observed = await store.get(executionId);
  if (!observed.ok || observed.cached) return { ok: false, reason: "cannot inspect authoritative execution state; nothing released" };
  if (observed.execution.item?.node_id !== nodeId) return { ok: false, reason: "execution belongs to a different item" };
  const prior = observed.execution.force_release;
  // An explicit repeat authenticates again at the server's person-only door;
  // a cached receipt or an agent reading it cannot authorize the operation.
  if (prior && prior.reason !== reason) return { ok: false, reason: "execution was released with a different reason; use its original release reason for cleanup" };
  // An explicit retry reuses the persisted intent, including after a lost
  // response that did not apply. Recovery itself never submits this intent.
  if (!prior) {
    let names = [];
    try { names = fs.readdirSync(journalDir(home)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const name of names.filter(n => /^[a-f0-9]{64}-[a-zA-Z0-9_-]{1,128}\.json$/.test(n))) {
      const saved = JSON.parse(fs.readFileSync(path.join(journalDir(home), name), "utf8"));
      if (saved.node_id === nodeId && saved.execution_id === executionId && originKey(saved.origin) === originKey(origin) && saved.request.reason === reason && saved.request.expected_revision === observed.execution.release_revision) {
        requestId = saved.request.request_id; break;
      }
    }
  }
  const request = { node_id: nodeId, reason, request_id: prior?.request_id || requestId, expected_revision: prior?.expected_revision || observed.execution.release_revision };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.request_id || "") || !/^[a-f0-9]{64}$/.test(request.expected_revision || "")) return { ok: false, reason: "execution has no valid release precondition" };
  const debt = { version: 1, node_id: nodeId, execution_id: executionId, origin, request };
  const file = path.join(journalDir(home), `${originKey(origin)}-${request.request_id}.json`);
  // Owe cleanup before the network request. This intent contains no token and
  // is NEVER an instruction for unattended force-release retries.
  const existing = fs.existsSync(file);
  if (!existing) writeFileAtomic(file, `${JSON.stringify(debt)}\n`, { mkdir: true });
  else if (fs.readFileSync(file, "utf8").trim() !== JSON.stringify(debt)) return { ok: false, reason: "release cleanup intent conflicts with the existing receipt" };
  let released;
  try { released = await store.forceRelease(executionId, request); }
  catch { released = { ok: false, transport: true }; }
  if (!released.ok && !released.transport && !released.transient) {
    if (!existing) fs.unlinkSync(file);
    return { ok: false, reason: released.message || released.code || "force release refused" };
  }
  return finishCleanup({ file, debt, store, origin, clearHold });
}

module.exports = { personForceRelease, reconcilePersonReleaseCleanups };
