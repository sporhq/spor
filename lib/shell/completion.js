// shell/completion.js — the CONTROLLER-WRITTEN COMPLETION's orchestration
// (task-spor-factory-controller-completion-boundary, FACTORY-IMPLEMENTATION-
// STAGE.md §4.3-§4.5, §6.5). Dependency-injected like gate-runner.js and
// work-loop.js: every door to the graph and to the run journal is a dep, so
// the whole write — the hold, the retype, the CAS, its 409 branches, the debt —
// drives with fakes. bin/spor.js supplies the real doors (makeCompletionDeps).
//
// The deps:
//   readItem(nodeId)  -> {ok, status, type, terminal, execution, executionAt,
//                         revision, raw, inbound: [{by, edge}], resolvedBy}
//                         | {ok:false, reason}   (a failed read is never
//                         evidence of anything — the caller keeps its debt)
//   casWrite({nodeId, revision, raw}) -> {ok, revision}
//                         | {ok:false, conflict:true, reason}  (a moved
//                         revision — the compare-and-swap lost)
//                         | {ok:false, reason}
//   writeNode(id, markdown) -> {ok, reason}   (idempotent on a same-content id)
//   readNode(id)      -> {ok, edges:[{type,to}], status, type} | null
//   addEdge(from, type, to) / removeEdge(from, type, to) -> {ok, reason}
//   completionStatus(type) -> the type's declared completion value ("done")
//   stamp(patch)      -> record | null   (completion_*, gates_state,
//                         integration_state — dispatch-runs stampCompletionState)
//   stampImpl(patch)  -> record | null   (impl_* — stampImplState)
//   now()             -> ms
"use strict";

const completion = require("../kernel/completion.js");

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// Set (or, with `null`, remove) ONE flat frontmatter key on a node's raw
// bytes, leaving every other line — and the body — byte-for-byte. In-place
// when the key exists (so the file's own ordering is kept), appended before
// `edges:` otherwise (a flat key after the edge block would be read as part
// of it by a hand editor, though the parser does not mind). Returns null when
// the frontmatter cannot be located.
function setFrontmatterKey(raw, key, value) {
  const m = FM_RE.exec(String(raw || ""));
  if (!m) return null;
  const body = m[2];
  const lines = m[1].split("\n");
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
  const idx = lines.findIndex((l) => re.test(l));
  if (value == null) {
    if (idx === -1) return `---\n${lines.join("\n")}\n---\n${body}`;
    lines.splice(idx, 1);
    return `---\n${lines.join("\n")}\n---\n${body}`;
  }
  const line = `${key}: ${value}`;
  if (idx !== -1) lines[idx] = line;
  else {
    const edges = lines.findIndex((l) => /^edges:\s*$/.test(l));
    if (edges === -1) lines.push(line);
    else lines.splice(edges, 0, line);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

// The same give-up reading the kernel's derivation uses: the reader's
// registry-backed `giveUp` when supplied, else the literal word.
function gaveUp(item) {
  return item && item.giveUp != null ? !!item.giveUp : String((item && item.status) || "").toLowerCase() === "abandoned";
}

function heldBy(item) {
  return item && typeof item.execution === "string" && item.execution.trim() !== "" ? item.execution.trim() : null;
}

function isoNow(deps) {
  return new Date(deps.now ? deps.now() : Date.now()).toISOString();
}

// H1: stamp the execution hold on the ITEM, before any dispatch (§4.2). The
// guards, in order: the item carries no live resolving edge (a non-empty
// snapshot means it is not gateable), and no `execution:` of a DIFFERENT
// execution (two executions never hold one item; a foreign hold is taken over
// only through `spor release --execution` / `--regate`, never by a fresh
// claim); a hold naming OUR execution (a resume) is re-stamped idempotently.
// A CAS that loses is H2 — no hold, no launch. Returns the claim pins the run
// record's `impl_claim` is built from.
async function stampHold({ nodeId, executionId, deps }) {
  const item = await deps.readItem(nodeId);
  if (!item || !item.ok) return { ok: false, kind: "read", reason: (item && item.reason) || `${nodeId} could not be read` };
  const holder = heldBy(item);
  if (holder && holder !== executionId) {
    return { ok: false, kind: "foreign-hold", reason: `${nodeId} is held by execution ${holder}${item.executionAt ? ` since ${item.executionAt}` : ""} — a second execution never holds one item; end it with 'spor release ${nodeId} --execution ${holder}' or resume the worker that started it` };
  }
  const inbound = Array.isArray(item.inbound) ? item.inbound : [];
  if (!holder && inbound.length) {
    return { ok: false, kind: "not-gateable", reason: `${nodeId} already carries a live resolving edge from ${inbound.map((r) => r.by).join(", ")} — it is not gateable, nothing to implement` };
  }
  const at = isoNow(deps);
  const pins = {
    execution_id: executionId,
    claimed_at: at,
    revision: item.revision || null,
    resolving_snapshot: inbound.map((r) => ({ by: r.by, edge: r.edge })),
    status_snapshot: item.status || "",
  };
  if (holder === executionId) return { ok: true, restamped: true, pins: { ...pins, claimed_at: item.executionAt || at } };
  let raw = setFrontmatterKey(item.raw, "execution", executionId);
  raw = raw && setFrontmatterKey(raw, "execution_at", at);
  if (!raw) return { ok: false, kind: "read", reason: `${nodeId}: its frontmatter could not be located to stamp the hold` };
  const wrote = await deps.casWrite({ nodeId, revision: item.revision, raw });
  if (!wrote || !wrote.ok) return { ok: false, kind: wrote && wrote.conflict ? "conflict" : "write", reason: (wrote && wrote.reason) || `${nodeId}: the hold could not be written` };
  return { ok: true, restamped: false, pins: { ...pins, revision: wrote.revision || pins.revision } };
}

// Clear the hold ALONE on a fresh revision — the I2/unroutable branch (a
// dispatch refused before any run record), §4.3's withdraw branch, and the
// person's door (`spor release --execution`). Only a hold naming THIS
// execution is cleared unless `force` (the person's door names it
// explicitly); an item with no hold is a no-op.
async function clearHold({ nodeId, executionId, deps, force = false, releasedBy = null }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await deps.readItem(nodeId);
    if (!item || !item.ok) return { ok: false, reason: (item && item.reason) || `${nodeId} could not be read` };
    const holder = heldBy(item);
    if (!holder) return { ok: true, cleared: false, note: `${nodeId} carries no execution hold` };
    if (holder !== executionId && !force) return { ok: false, reason: `${nodeId} is held by execution ${holder}, not ${executionId}` };
    let raw = setFrontmatterKey(item.raw, "execution", null);
    raw = raw && setFrontmatterKey(raw, "execution_at", null);
    if (raw && releasedBy) raw = setFrontmatterKey(raw, "execution_released_by", releasedBy);
    if (!raw) return { ok: false, reason: `${nodeId}: its frontmatter could not be located` };
    const wrote = await deps.casWrite({ nodeId, revision: item.revision, raw });
    if (wrote && wrote.ok) return { ok: true, cleared: true, holder, note: `${nodeId}: execution ${holder} released` };
    if (!(wrote && wrote.conflict)) return { ok: false, reason: (wrote && wrote.reason) || `${nodeId}: the hold could not be cleared` };
  }
  return { ok: false, reason: `${nodeId}: the hold-clear lost the compare-and-swap three times` };
}

// P1 / at submission (§4.5): every inbound resolving edge whose source the
// claim did not see is PREMATURE — retyped `resolves` -> `relates-to` on its
// source node (evidence, never deleted) — and a terminal status written under
// the hold is rolled back to the claim's snapshot. Both are evidence repair:
// under the hold neither retired anything. Runs only while the item still
// carries OUR hold. The retract is a durable debt (`completion_debt:
// retract`) so a crash between detection and the rewrite is re-driven, and
// it reconciles first: an edge already gone is `skipped`, an item that went
// `abandoned` is left alone (the completion write's withdraw branch decides).
async function retractPremature({ record, deps, log = () => {}, item: preRead = null, restoreStatus = true }) {
  const claim = record.impl_claim;
  const nodeId = record.node_id;
  const item = preRead || (await deps.readItem(nodeId));
  if (!item || !item.ok) return { ok: false, retry: true, reason: (item && item.reason) || `${nodeId} could not be read` };
  if (heldBy(item) !== claim.execution_id) return { ok: true, retyped: [], note: "not held by this execution" };
  if (gaveUp(item)) return { ok: true, retyped: [], note: "the item was abandoned under the hold — left for the completion write's withdraw branch" };
  const own = record.completion_resolver || completion.completionResolverId(nodeId, record.impl_candidate && record.impl_candidate.candidate_id);
  const premature = completion.prematureResolvers(item.inbound, claim.resolving_snapshot, { ownResolver: own });
  // `restoreStatus: false` is the completion write's call (§4.3's 409 branch):
  // at the boundary a person's terminal status is a decision this pipeline
  // does not reverse — the CAS then writes only the hold-clear.
  const statusMoved = restoreStatus && !!item.terminal && String(item.status || "").toLowerCase() !== String(claim.status_snapshot || "").toLowerCase();
  if (!premature.length && !statusMoved) return { ok: true, retyped: [] };
  // OWE FIRST. Only when no OTHER debt is on the field: `write` already
  // implies this pass (it re-reads and retypes before its CAS), and the field
  // holds exactly one debt (§6.5).
  if (!record.completion_debt) deps.stamp({ completion_debt: "retract" });
  const retyped = [];
  let failed = null;
  for (const p of premature) {
    const removed = await deps.removeEdge(p.by, p.edge, nodeId);
    if (!removed || !removed.ok) {
      failed = `the premature ${p.edge} edge from ${p.by} could not be retyped (${(removed && removed.reason) || "no response"})`;
      continue;
    }
    const added = await deps.addEdge(p.by, "relates-to", nodeId);
    if (!added || !added.ok) {
      failed = `the premature ${p.edge} edge from ${p.by} was removed but its relates-to twin could not be written (${(added && added.reason) || "no response"})`;
      continue;
    }
    retyped.push(p.by);
    log(`work: ${nodeId} — premature ${p.edge} edge from ${p.by} retyped as relates-to (the item is held by execution ${claim.execution_id}; the controller writes the completion)`);
  }
  if (retyped.length) {
    const seen = new Set([...(Array.isArray(record.completion_premature) ? record.completion_premature : []), ...retyped]);
    deps.stamp({ completion_premature: [...seen] });
    record.completion_premature = [...seen];
  }
  if (statusMoved) {
    // The status restore is a CAS on the item like step 2 — the hold is kept.
    const fresh = await deps.readItem(nodeId);
    if (fresh && fresh.ok && heldBy(fresh) === claim.execution_id && fresh.terminal && !gaveUp(fresh)) {
      const raw = setFrontmatterKey(fresh.raw, "status", claim.status_snapshot || null);
      const wrote = raw ? await deps.casWrite({ nodeId, revision: fresh.revision, raw }) : null;
      if (wrote && wrote.ok) log(`work: ${nodeId} — status '${fresh.status}' written under the hold rolled back to '${claim.status_snapshot || "(none)"}'`);
      else failed = `the status '${fresh.status}' written under the hold could not be rolled back (${(wrote && wrote.reason) || "no response"})`;
    }
  }
  if (failed) return { ok: false, retry: true, retyped, reason: failed };
  if ((record.completion_debt || "retract") === "retract") {
    deps.stamp({ completion_debt: null });
    record.completion_debt = null;
  }
  return { ok: true, retyped };
}

// Our completion resolver, as it reads on the graph right now.
async function readOwnResolver({ record, deps }) {
  const id = record.completion_resolver || completion.completionResolverId(record.node_id, record.impl_candidate && record.impl_candidate.candidate_id);
  const node = await deps.readNode(id);
  if (!node || !node.ok) return { id, exists: false, resolvesEdge: false };
  const edges = Array.isArray(node.edges) ? node.edges : [];
  return { id, exists: true, resolvesEdge: edges.some((e) => e && e.type === "resolves" && e.to === record.node_id) };
}

// §4.3's withdraw branch: our `resolves` edge is retyped back to `relates-to`
// on OUR resolver (a person dropped the work, or another execution now holds
// the item), and a hold naming our execution is cleared alone. The debt
// settles as `withdrawn`.
// `touchItem: false` is the different-execution branch: the item is another
// execution's to complete and NOTHING on it is written — only our own
// resolver is retyped.
async function withdrawCompletion({ record, deps, log = () => {}, why, touchItem = true }) {
  const nodeId = record.node_id;
  const own = await readOwnResolver({ record, deps });
  if (own.resolvesEdge) {
    const removed = await deps.removeEdge(own.id, "resolves", nodeId);
    if (!removed || !removed.ok) return { ok: false, retry: true, reason: `our resolves edge on ${own.id} could not be withdrawn (${(removed && removed.reason) || "no response"})` };
    const added = await deps.addEdge(own.id, "relates-to", nodeId);
    if (!added || !added.ok) return { ok: false, retry: true, reason: `our resolves edge on ${own.id} was removed but its relates-to twin could not be written (${(added && added.reason) || "no response"})` };
  }
  if (touchItem) {
    const cleared = await clearHold({ nodeId, executionId: record.impl_claim.execution_id, deps });
    if (!cleared.ok) return { ok: false, retry: true, reason: cleared.reason };
  }
  deps.stamp({ completion_debt: null, completion_withdrawn_at: isoNow(deps), completion_note: why });
  log(`work: ${nodeId} — completion withdrawn: ${why}`);
  return { ok: true, settled: "withdrawn" };
}

// The completion write (§4.3), in the forced order: the resolver (with its
// `resolves` edge — written INTO the node, one validated write, so step 1 is
// the node's creation; idempotent on a re-drive) and then ONE compare-and-swap
// `put_node` of the ITEM writing the terminal status AND removing the hold —
// the moment it lands the hold is gone, our edge counts, and dependents are
// released. The seed completion gate refuses a terminal status with no
// resolver, so status-first cannot land; and `set_status` is deliberately not
// used — it is a read-modify-write with no revision echo, exactly the
// check-then-write window the CAS closes.
//
// `facts` are the gate/merge fact ids the pipeline filed (linked from the
// record); `boundary` names which one was reached. Returns {ok, settled:
// "written"|"consumed"|"withdrawn"|"released"} or {ok:false, retry, reason}
// with the `write` debt left owed for the next pass.
async function writeCompletion({ record, deps, log = () => {}, facts = [], boundary = null, date = null }) {
  const claim = record.impl_claim;
  const nodeId = record.node_id;
  const executionId = claim.execution_id;
  const after = boundary || (claim.completion && claim.completion.after) || "gates";
  // OWE FIRST (§6.5 (b)): `write` is stamped before step 1 is attempted and
  // cleared only after a re-read shows both the edge and the status landed.
  if (record.completion_debt !== "write") {
    deps.stamp({ completion_debt: "write" });
    record.completion_debt = "write";
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Step 0: re-read and reconcile against settled state (§6.5 (d)).
    const item = await deps.readItem(nodeId);
    if (!item || !item.ok) return { ok: false, retry: true, reason: (item && item.reason) || `${nodeId} could not be read — the completion stays owed` };
    const holder = heldBy(item);
    const own = await readOwnResolver({ record, deps });
    if (gaveUp(item)) {
      return own.resolvesEdge || holder === executionId
        ? withdrawCompletion({ record, deps, log, why: `${nodeId} was abandoned by a person under the execution — a gate never reverses that` })
        : consume({ record, deps, log, why: `${nodeId} reads abandoned and carries neither our edge nor our hold` });
    }
    if (holder && holder !== executionId) {
      return withdrawCompletion({ record, deps, log, touchItem: false, why: `${nodeId} is now held by execution ${holder} — its own completion write decides` });
    }
    if (!holder) {
      if (item.terminal) {
        return consume({ record, deps, log, why: `${nodeId} already reads '${item.status}' with the hold released${own.resolvesEdge ? " and our edge present" : item.resolvedBy ? ` — resolved by ${item.resolvedBy}` : ""}` });
      }
      // The hold is gone and the item is open: a person ended our execution
      // explicitly. The item is no longer ours to complete.
      if (own.resolvesEdge) return withdrawCompletion({ record, deps, log, why: `${nodeId}'s execution was released by a person before the completion landed` });
      deps.stamp({ completion_debt: null, completion_withdrawn_at: isoNow(deps), completion_note: "the execution was released by a person before the completion landed; nothing written" });
      log(`work: ${nodeId} — execution ${executionId} was released before the completion landed; nothing written`);
      return { ok: true, settled: "released" };
    }
    // Held by us. P1's rule first: any resolving edge added since the claim is
    // premature and is retyped as evidence before ours is written.
    const retract = await retractPremature({ record, deps, log, item, restoreStatus: false });
    if (!retract.ok) return { ok: false, retry: true, reason: retract.reason };
    // Step 1: the resolver, with its `resolves` edge, content-addressed to the
    // candidate. Idempotent: a same-content id is skipped, and an existing node
    // without the edge (a hand-edited one) gets the edge added.
    const resolverId = own.id;
    if (!own.exists) {
      const built = completion.buildCompletionResolver({
        id: resolverId,
        nodeId,
        candidate: record.impl_candidate || null,
        executionId,
        boundary: after,
        project: record.item_repo || record.project || null,
        date: date || isoNow(deps).slice(0, 10),
        factory: claim.factory && claim.factory.node_id,
        facts,
        implementerResolver: (record.impl_candidate && record.impl_candidate.resolver && record.impl_candidate.resolver.node) || null,
        premature: Array.isArray(record.completion_premature) ? record.completion_premature : [],
      });
      const wrote = await deps.writeNode(built.id, built.markdown);
      if (!wrote || !wrote.ok) return { ok: false, retry: true, reason: `the completion resolver ${resolverId} could not be written (${(wrote && wrote.reason) || "no response"})` };
      deps.stamp({ completion_resolver: resolverId });
      record.completion_resolver = resolverId;
    } else if (!own.resolvesEdge) {
      const added = await deps.addEdge(resolverId, "resolves", nodeId);
      if (!added || !added.ok) return { ok: false, retry: true, reason: `the resolves edge could not be added to ${resolverId} (${(added && added.reason) || "no response"})` };
    }
    // Step 2: the compare-and-swap — terminal status + hold removed, one
    // write, on the revision step 0 read.
    const completionStatus = deps.completionStatus(item.type) || "done";
    let raw = setFrontmatterKey(item.raw, "status", completionStatus);
    raw = raw && setFrontmatterKey(raw, "execution", null);
    raw = raw && setFrontmatterKey(raw, "execution_at", null);
    if (!raw) return { ok: false, retry: false, reason: `${nodeId}: its frontmatter could not be located` };
    const wrote = await deps.casWrite({ nodeId, revision: item.revision, raw });
    if (wrote && wrote.ok) {
      const at = isoNow(deps);
      deps.stamp({ completion_debt: null, completion_written_at: at, completion_boundary: after, completion_resolver: resolverId });
      if (record.impl_candidate) {
        deps.stampImpl({ impl_candidate: { ...record.impl_candidate, resolver: { ...(record.impl_candidate.resolver || {}), node: resolverId, written: true, resolves_edge: true } } });
      }
      log(`work: ${nodeId} — completed at the '${after}' boundary by ${resolverId} (execution ${executionId}; status ${completionStatus}, hold cleared)`);
      return { ok: true, settled: "written", resolver: resolverId };
    }
    if (!(wrote && wrote.conflict)) return { ok: false, retry: true, reason: `${nodeId}: the completion write failed (${(wrote && wrote.reason) || "no response"}) — still owed` };
    // A 409: re-read and branch (the loop head does exactly that).
    log(`work: ${nodeId} — the completion compare-and-swap lost (revision moved); re-reading`);
  }
  return { ok: false, retry: true, reason: `${nodeId}: the completion compare-and-swap lost four times — left owed for the next pass` };
}

async function consume({ record, deps, log = () => {}, why }) {
  deps.stamp({ completion_debt: null, completion_consumed_at: isoNow(deps), completion_note: why });
  log(`work: ${record.node_id} — completion consumed without writing: ${why}`);
  return { ok: true, settled: "consumed" };
}

// The per-pass reconciliation (§6.5 (a)): for a controller record whose
// completion is not settled, re-derive the debt from the record's settled
// fields plus the graph and act on it — never on the flag alone. Returns what
// it did, or null when nothing was owed.
async function reconcileCompletion({ record, deps, log = () => {}, facts = [], landedFactPresent = false }) {
  if (!completion.isControllerRecord(record)) return null;
  if (record.completion_written_at || record.completion_withdrawn_at || record.completion_consumed_at) return null;
  const item = await deps.readItem(record.node_id);
  if (!item || !item.ok) return { ok: false, retry: true, reason: (item && item.reason) || `${record.node_id} could not be read` };
  const own = await readOwnResolver({ record, deps });
  const debt = completion.deriveCompletionDebt({ record, item, own, landedFactPresent });
  if (!debt) {
    if (record.completion_debt) deps.stamp({ completion_debt: null });
    return null;
  }
  // The field holds ONE debt, the derived one: a stale word (a `write` left by
  // a crashed pass beside a `retract` the graph now shows) is overwritten in
  // one stamp before the debt is worked, never cleared-then-owed.
  if (record.completion_debt !== debt) {
    deps.stamp({ completion_debt: debt });
    record.completion_debt = debt;
  }
  if (debt === "write") return { debt, ...(await writeCompletion({ record, deps, log, facts, landedFactPresent })) };
  if (debt === "withdraw") return { debt, ...(await withdrawCompletion({ record, deps, log, why: `${record.node_id} was abandoned by a person while our edge stood` })) };
  return { debt, ...(await retractPremature({ record, deps, log, item })) };
}

module.exports = {
  setFrontmatterKey,
  stampHold,
  clearHold,
  retractPremature,
  writeCompletion,
  withdrawCompletion,
  reconcileCompletion,
  readOwnResolver,
};
