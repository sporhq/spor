// kernel/completion.js — the CONTROLLER-WRITTEN COMPLETION's pure half
// (task-spor-factory-controller-completion-boundary, derived-from
// dec-spor-factory-implementation-stage-contract; the contract is
// FACTORY-IMPLEMENTATION-STAGE.md §4.3-§4.5 and §6.5).
//
// Under `completion.by: controller` the implementer never writes the
// resolving edge: it submits a candidate (kernel/candidate.js), the runner
// judges it, and at the DECLARED boundary — the last gate, or the integration
// landing — the runner writes the edge and the terminal status itself. Because
// queue liveness is derived from the resolving EDGE, a pending or refused
// pipeline then releases nothing — not by retracting an edge (this client
// cannot un-release a dependent after a write it did not interpose on) but by
// never having written one, and by the EXECUTION HOLD that keeps a premature
// one inert (resolution.js executionHeld, queue.js isLive).
//
// This file is the vocabulary and the predicates: the execution id, the
// `CANDIDATE:` fixed form, the boundary predicate over the split
// `gates_state`/`integration_state` stamps, the debt derivation of §6.5 (a),
// the premature-resolver rule of §4.5, and the completion resolver node the
// controller writes. No I/O, no clock, no node builtins — every side effect
// (the CAS write, the edge doors, the record stamps) is in shell/completion.js
// and bin/spor.js, and a hash is injected where one is needed.
"use strict";

// The run-record vocabulary this stage adds beside `impl_*` (WORKERS.md §8,
// additive-only). `gates_state` is the settled verdict of the gate LIST alone
// and `integration_state` the integration stage's own — the fold both take
// into ONE `gate_state` is kept for every legacy reader, but `gate_state:
// passed` cannot say WHICH boundary was passed, and the completion predicate
// must (§6.5 (a), the F12 case).
const GATES_STATES = Object.freeze(["passed", "failed", "blocked"]);
const INTEGRATION_STATES = Object.freeze(["running", "landed", "parked", "failed", "refused"]);

// `completion_debt` is ONE string field, never a set of booleans: every
// transition is a single stamp that OVERWRITES it, so there is never a
// clear-one-flag-then-owe-the-next pair of writes (§6.5 (b)).
//   write     the boundary was reached and the edge + status are owed (§4.3)
//   retract   a premature resolving edge is owed its retype (§4.5)
//   withdraw  our edge exists on an item that went `abandoned` under us and is
//             owed its retype back (§4.3's 409 branch)
const COMPLETION_DEBTS = Object.freeze(["write", "retract", "withdraw"]);

// The stage verdicts under which a completion is never written (§4.1's
// settled states minus `candidate`) — the ONE place the completion reads the
// stage's word, kept as a set here rather than requiring kernel/candidate.js's
// list, so a new refusal word added there is also added here on purpose.
const STAGE_REFUSALS = Object.freeze(new Set(["declined", "exhausted", "escalated", "unroutable", "mismatch"]));

const COMPLETION_FIELD_PREFIX = "completion_";
// The two split stamps are not under the prefix (their names are the
// contract's, §6.5), so the record writers name them explicitly.
const SPLIT_STATE_FIELDS = Object.freeze(["gates_state", "integration_state"]);

// The fixed form the implementer's final report OPENS with under controller
// completion (shell/worker-contract.js CANDIDATE_FORM): `CANDIDATE: <resolver
// node id> — <why>`. The runner reads it to link the implementer's own
// account of the change from the completion record; a missing or malformed
// line is NOT a refusal (the candidate is the commit, and the controller
// writes its own resolver regardless), it just leaves that account unlinked.
const CANDIDATE_FORM_RE = /^\s*CANDIDATE:\s*([a-z][a-z0-9-]*)\s*(?:[—–-]+\s*(.*))?\s*$/i;

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Parse the `CANDIDATE:` fixed form off a run's report text — first non-blank
// line only, exactly as `DECLINED:`/`SCOPED:` are read. Returns `{ok:true,
// resolver, reason}` or `{ok:false}`; never throws on junk.
function parseCandidateReport(reportText) {
  const text = String(reportText || "");
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") || "";
  const m = CANDIDATE_FORM_RE.exec(first);
  if (!m) return { ok: false };
  const resolver = String(m[1]).toLowerCase();
  if (!NODE_ID_RE.test(resolver)) return { ok: false };
  return { ok: true, resolver, reason: str(m[2]) };
}

// The execution id (§7.1): `exec-` + the first 16 hex of sha256 over the
// tenant (the server base URL, or `local`), the item, the factory and the
// claim time — one per (item, factory, pipeline attempt). The claim time is
// what makes a fresh claim a fresh execution; a RESUMED pipeline never
// recomputes it (the record pins it in `impl_claim.execution_id`).
function executionKey({ tenant, nodeId, factoryId, claimedAt }) {
  return `${str(tenant) || "local"}\n${str(nodeId)}\n${str(factoryId)}\n${str(claimedAt)}\n`;
}

function executionIdFor(parts, sha256) {
  if (typeof sha256 !== "function") throw new TypeError("executionIdFor needs a sha256(string) => hex function");
  const hex = String(sha256(executionKey(parts)) || "");
  if (!/^[0-9a-f]{32,}$/.test(hex)) throw new TypeError("executionIdFor's sha256 must return a lowercase hex digest");
  return `exec-${hex.slice(0, 16)}`;
}

// A record created by a stage launch under controller completion. A record
// with no `impl_claim` is a LEGACY run and reads as `completion.by: agent`
// (§6.5): it wrote its own resolver, `shouldGate` gates it as before, and
// §10.7 demotes it on a refusal.
function isControllerRecord(record) {
  const claim = record && record.impl_claim;
  return !!(isPlainObject(claim) && isPlainObject(claim.completion) && claim.completion.by === "controller");
}

// The pinned boundary the completion write waits for (§6.5 (a)) — read off
// the CLAIM, never off the factory node (an edit mid-pipeline changes nothing)
// and never off `gate_state` alone: `gate_state: passed` with `after:
// integration` and an integration still running must derive NOTHING (F12).
//
// `landedFactPresent` is the caller's evidence for a `parked` proposal — the
// landed `art-merge-…` fact checkProposals writes once the PR merges (§10.9).
function boundaryReached(record, { landedFactPresent = false } = {}) {
  if (!isControllerRecord(record)) return false;
  const after = record.impl_claim.completion.after === "gates" ? "gates" : "integration";
  if (after === "gates") return record.gates_state === "passed";
  if (record.integration_state === "landed") return true;
  return record.integration_state === "parked" && !!landedFactPresent;
}

// Which inbound resolving edges onto the item are PREMATURE (§4.5): any whose
// source is not in the claim-time snapshot, whoever wrote it. `inbound` is
// `[{by, edge}]` (resolution.js inboundResolvers, or the schema hook's
// `execution_hold.inert_resolvers`); `snapshot` is `impl_claim.resolving_
// snapshot` (normally empty — a non-empty one meant the item was not gateable
// and H1 was refused). Our OWN completion resolver is never premature.
function prematureResolvers(inbound, snapshot, { ownResolver = null } = {}) {
  const seen = new Set((Array.isArray(snapshot) ? snapshot : []).map((s) => (isPlainObject(s) ? s.by : s)).filter(Boolean));
  const out = [];
  for (const r of Array.isArray(inbound) ? inbound : []) {
    if (!isPlainObject(r) || !r.by) continue;
    if (r.edge !== "resolves" && r.edge !== "answers") continue;
    if (seen.has(r.by)) continue;
    if (ownResolver && r.by === ownResolver) continue;
    out.push({ by: r.by, edge: r.edge });
  }
  return out;
}

// The debt a controller record OWES, re-derived from settled state rather
// than read off the flag (§6.5 (a)/(d): the flag is an accelerator for the
// common pass; the derivation is the record of last resort, and every pass
// RE-READS before acting). Inputs:
//   record   the run record (impl_claim, impl_state, gates_state,
//            integration_state, gate_state, completion_debt)
//   item     the item as re-read: {status, execution, terminal (bool — the
//            status is terminal for the type), inbound: [{by, edge}]}; null
//            when it could not be read (then nothing is derived: an
//            unreachable graph is not evidence)
//   own      our completion resolver as re-read: {id, resolvesEdge: bool}
//            (null when it does not exist yet)
//   landedFactPresent  checkProposals' evidence for a parked proposal
// Returns one of COMPLETION_DEBTS or null. Precedence: a record whose
// gate_state is `superseded` owes nothing (someone landed the item by hand);
// `withdraw` (a person dropped the work) beats `write`; `retract` is owed
// beside either and is reported only when neither of those is — the caller
// runs the retype on its own pass anyway (P1), so this keeps ONE debt on the
// field, as §6.5 requires.
function deriveCompletionDebt({ record, item, own = null, landedFactPresent = false } = {}) {
  if (!isControllerRecord(record) || !item) return null;
  if (record.gate_state === "superseded") return null;
  const ours = record.impl_claim.execution_id || null;
  const heldByUs = !!ours && str(item.execution) === ours;
  const status = str(item.status).toLowerCase();
  const ownEdge = !!(own && own.resolvesEdge);
  // A GIVE-UP status: the reader supplies `giveUp` from the registry's
  // non-resolving partition (resolution.isGiveUpStatus — the same predicate
  // queue.isLive reads, so the two halves never flap); a reader without a
  // registry falls back to the literal word.
  const gaveUp = item.giveUp != null ? !!item.giveUp : status === "abandoned";
  // withdraw: a person ABANDONED the item under us — the person's door (§4.5).
  // Owed whenever our edge stands on it OR our hold still does: the hold must
  // not outlive the work it was holding, or the abandoned item never leaves
  // the queue and its dependents stay blocked behind a decision nobody will
  // reverse.
  if (gaveUp && (ownEdge || heldByUs)) return "withdraw";
  // write: the boundary is reached, the stage did not settle AGAINST a
  // candidate, and the item is not already terminal-and-released. The gates
  // judged a pinned TREE; whether its portable reference verified (the
  // publisher's `candidate` settle, task-spor-factory-candidate-portable-
  // reference) is not what the completion waits on — a refusal of the stage
  // (declined/exhausted/escalated/unroutable/mismatch) is.
  const stageOk = !STAGE_REFUSALS.has(str(record.impl_state));
  if (stageOk && boundaryReached(record, { landedFactPresent })) {
    const settled = !heldByUs && str(item.execution) === "" && item.terminal && (ownEdge || (Array.isArray(item.inbound) && item.inbound.length > 0));
    if (!settled && !gaveUp) return "write";
    if (!settled && gaveUp) return ownEdge ? "withdraw" : null;
  }
  // retract: our hold stands and a resolving edge appeared from a source the
  // claim did not see.
  if (heldByUs && prematureResolvers(item.inbound, record.impl_claim.resolving_snapshot, { ownResolver: own && own.id }).length) return "retract";
  return null;
}

// The completion resolver's deterministic id: content-addressed to the
// candidate it completes (§4.3 step 1 — "a node this pipeline created and
// owns"), so a re-driven write after a crash lands on the SAME node, and a
// re-pinned candidate gets its own. `candidateId` is `cand-<16 hex>`; the
// stem is the item's id minus its type prefix, bounded like the gate facts'.
function completionResolverId(nodeId, candidateId) {
  const stem =
    String(nodeId || "item")
      .replace(/^[a-z]+-/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 30)
      .replace(/-+$/, "") || "item";
  const cand = String(candidateId || "").replace(/^cand-/, "").slice(0, 12) || "none";
  return `art-completion-${stem}-${cand}`;
}

function oneLine(text, cap) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

// The completion record the controller writes (§4.3 step 1): an `artifact`
// carrying the `resolves` edge onto the item, naming the candidate it
// completes (id, commit, tree), the boundary, the execution, every gate/merge
// fact the pipeline filed (`relates-to`), and — when the implementer named it
// in its `CANDIDATE:` line — the implementer's own resolver node
// (`relates-to`, never `resolves`: that node's edge stays provenance).
//
// Byte-stable for the same inputs (the local `writeGateNode` door dedups on
// content, `date:` excepted), so a re-driven write is idempotent.
function buildCompletionResolver({ id, nodeId, candidate, executionId, boundary, project, date, factory, facts = [], implementerResolver = null, premature = [] }) {
  const cand = isPlainObject(candidate) ? candidate : {};
  const short = (s) => String(s || "").slice(0, 12) || "?";
  const links = [...new Set([...(Array.isArray(facts) ? facts : []), implementerResolver].filter((x) => x && x !== nodeId))];
  const summary = oneLine(
    `Completed ${nodeId}: candidate ${cand.candidate_id || "cand-?"} (commit ${short(cand.commit)}, tree ${short(cand.tree)}) passed every declared gate` +
      (boundary === "integration" ? " and landed on the integration target" : "") +
      `; the factory controller wrote this completion at the '${boundary}' boundary.`,
    460
  );
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Completion — ${oneLine(nodeId, 60)} (${cand.candidate_id || "candidate"})`,
    `summary: ${summary}`,
    `date: ${date}`,
    ...(cand.candidate_id ? [`candidate_id: ${cand.candidate_id}`] : []),
    ...(cand.commit ? [`candidate_commit: ${cand.commit}`] : []),
    ...(cand.tree ? [`candidate_tree: ${cand.tree}`] : []),
    ...(executionId ? [`execution_id: ${executionId}`] : []),
    `completion_boundary: ${boundary}`,
    ...(premature.length ? ["premature_resolution: true"] : []),
    "edges:",
    `  - {type: resolves, to: ${nodeId}}`,
    ...links.map((l) => `  - {type: relates-to, to: ${l}}`),
    "---",
    "",
    `The factory controller${factory ? ` (factory \`${factory}\`)` : ""} completed ${nodeId} at its \`${boundary}\` boundary`,
    `(execution \`${executionId || "?"}\`). The item was HELD from the claim until this write: no resolving edge and no`,
    "terminal status retired it while its gates were pending, so its dependents were released by this",
    "completion and by nothing before it (dec-spor-factory-implementation-stage-contract, §4.3).",
    "",
    `Candidate: \`${cand.candidate_id || "?"}\` — commit \`${cand.commit || "?"}\`, tree \`${cand.tree || "?"}\`` +
      (cand.branch ? ` on \`${cand.branch}\`` : "") +
      (cand.supersedes ? ` (supersedes \`${cand.supersedes}\`)` : "") +
      ".",
    ...(implementerResolver ? ["", `The implementer's own account of the change is \`${implementerResolver}\` (linked, never resolving: the`, "completion is the controller's to write)."] : []),
    ...(premature.length
      ? ["", `A premature resolution was recorded and retyped as evidence during the pipeline: ${premature.map((p) => `\`${p}\``).join(", ")}.`]
      : []),
    ...(facts.length ? ["", `Gate and merge facts: ${facts.map((f) => `\`${f}\``).join(", ")}.`] : []),
    "",
    "This is the completion record, not a gate outcome: it is the one write that retires the item.",
    "",
  ];
  return { id, markdown: lines.join("\n") };
}

module.exports = {
  GATES_STATES,
  INTEGRATION_STATES,
  COMPLETION_DEBTS,
  STAGE_REFUSALS,
  COMPLETION_FIELD_PREFIX,
  SPLIT_STATE_FIELDS,
  CANDIDATE_FORM_RE,
  parseCandidateReport,
  executionKey,
  executionIdFor,
  isControllerRecord,
  boundaryReached,
  prematureResolvers,
  deriveCompletionDebt,
  completionResolverId,
  buildCompletionResolver,
};
