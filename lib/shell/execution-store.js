// shell/execution-store.js — the CLIENT adapter for factory execution state
// (task-spor-client-execution-store-adapter; EXECUTION-STATE.md §7-§8 in the
// sibling spor-server checkout is the contract, dec-spor-hosted-execution-
// state-server-authoritative the decision).
//
// The hosted store is a different HOME for one contract, never a different
// contract, so this module is ONE interface with two backings:
//
//   - REMOTE mode drives the server's `/v1/executions` surface: `POST
//     /v1/executions` opens (or idempotently re-reads) the pinned execution
//     and hands back the FENCE; the fenced `:id/{claim,renew,release,events}`
//     verbs move it; the `GET`s read it. Every authoritative transition carries
//     the fence the server handed back — never a fence this client reasoned
//     its way to. The server pins the definition, derives the tenant from the
//     identity, and refuses a resolving edge into an item whose execution has
//     not reached its boundary (§6.1) — the enforcement this client cannot do.
//   - PERSONAL (local) mode keeps a shape-compatible store under
//     `$SPOR_HOME/journal/executions/<tenant>/` — the server's own layout, the
//     same record shape and ids (kernel/execution.js), the same log-before-
//     record discipline — with the tenant the literal `local`. It is the
//     coordination state a single box needs (a resumed worker takes over a
//     dead one's execution by the same fence arithmetic) and it is READABLE
//     by anything that reads the hosted one.
//
// PARTITIONS (§8 rule 3). A remote event that cannot be delivered is spooled
// to a per-execution OUTBOX (`<id>.outbox.jsonl`) BEFORE the attempt — the
// durable local evidence — and replayed in order on the next call; every
// event carries a deterministic idempotency key (kernel/execution.js
// eventKey), so a replay of one the server already recorded is a no-op and
// replay in any order converges. What the client must NOT do while
// partitioned is write the resolving edge on the strength of local state:
// `confirmOwnership` — the check the completion write runs before its
// resolver — flushes the outbox and RENEWS under the fence, and only a
// server (or local engine) that answers `ok` confirms.
//
// The layout, identical to the server's (tenant first, so isolation is a
// filesystem fact):
//
//   journal/executions/<tenant>/exec/<id>.json          the record (remote: the
//                                                       last server-confirmed copy)
//   journal/executions/<tenant>/exec/<id>.events.jsonl  the ordered log (local)
//   journal/executions/<tenant>/exec/<id>.outbox.jsonl  events owed to the server (remote)
//   journal/executions/<tenant>/exec/<id>.outbox.<tag>.jsonl  ...owed by ONE process instance
//   journal/executions/<tenant>/exec/<id>.workflow.jsonl the WORKFLOW JOURNAL (both modes)
//   journal/executions/<tenant>/item/<node_id>.json     { open, executions[] } (local)
//
// THE WORKFLOW JOURNAL (task-spor-gate-pipeline-as-workflow-kernel) is the
// replay kernel's (lib/kernel/workflow.js) persisted step log for the
// execution: every keyed effect result, clock read, timer, signal and await
// the pipeline's workflow function recorded, in order. It is the DRIVER's
// state, not the store's read model — the §7.3 events above stay the
// authoritative projection the server's write gate reads (the workflow's
// effect keys are that vocabulary's idempotency keys), while the journal is
// what a resumed worker re-executes the workflow function over. It lives
// beside the record in BOTH modes because the kernel's entry kinds are not in
// the hosted store's event vocabulary (the server refuses an unknown type),
// and because the box that drives a workflow is the box that resumes it:
// ownership is the execution's fence, which both modes already hold.
//
// `journal/` is machine-local (.gitignored in every graph home), so
// coordination state never enters the graph's commit history.
//
// Zero deps; plain Node. Every clock read and every hash lives here, not in
// the kernel.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const kernel = require("../kernel/execution.js");
const { writeFileAtomic } = require("./atomic-write.js");
const processIdentity = require("./process-identity.js");

// The server's own lease bounds (server/executions.js), kept so a local
// execution is leased exactly as a hosted one.
const DEFAULT_LEASE_TTL_MS = require("../config-keys.js").defaultOf("execution.leaseTtlMs");
const MIN_LEASE_TTL_MS = 60 * 1000;
const MAX_LEASE_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// Path-segment safety, the server's own rule: no separators, no dot
// segments, bounded length. A caller that supplies anything else gets a typed
// refusal, never a traversal.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validSegment(s) {
  return typeof s === "string" && SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function nowIso() {
  return new Date().toISOString();
}

function clampTtl(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_TTL_MS;
  return Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, Math.floor(n)));
}

function expiryFrom(now, ttlMs) {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// ---------------- paths ----------------

function executionsDir(home) {
  return path.join(home, "journal", "executions");
}
function tenantDir(home, tenant) {
  return path.join(executionsDir(home), tenant);
}
function recordPath(home, tenant, id) {
  return path.join(tenantDir(home, tenant), "exec", `${id}.json`);
}
function eventsPath(home, tenant, id) {
  return path.join(tenantDir(home, tenant), "exec", `${id}.events.jsonl`);
}
// `tag` names the PROCESS INSTANCE that owes the events (outboxTag); an
// instance-less adapter keeps the one shared `<id>.outbox.jsonl`.
function outboxPath(home, tenant, id, tag = null) {
  return path.join(tenantDir(home, tenant), "exec", tag ? `${id}.outbox.${tag}.jsonl` : `${id}.outbox.jsonl`);
}
const outboxTag = (instance) => sha256(String(instance)).slice(0, 16);
// The box's durable TAKEOVER LEDGER for `id`: one line per fence an instance
// acquired here ({fence, at, instance, machine}), written just after the
// grant. It is what dates a fence's loss after every process that saw it is
// gone, so adoption can tell a dead holder's backlog from its post-loss
// writes (issue-spor-execution-outbox-unlocked-rmw-and-adoption-cutoff).
function takeoverPath(home, tenant, id) {
  return path.join(tenantDir(home, tenant), "exec", `${id}.takeovers.jsonl`);
}
function itemPath(home, tenant, nodeId) {
  return path.join(tenantDir(home, tenant), "item", `${nodeId}.json`);
}
function workflowJournalPath(home, tenant, id, { stage = null } = {}) {
  return path.join(tenantDir(home, tenant), "exec", `${id}${stage ? `.${stage}` : ""}.workflow.jsonl`);
}

// ---------------- reads (fresh per call) ----------------

// A missing file is the normal empty state. A PRESENT but unreadable one is
// NOT read as absent: "no pipeline is running" and "a pipeline is running and
// we lost its record" are different facts, and the caller that asks the
// question must fail closed. So a parse failure throws.
function readJsonFile(abs, label) {
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(`${label} at ${abs} is unreadable: ${String((e && e.message) || e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} at ${abs} is corrupt: ${String((e && e.message) || e)}`);
  }
}

function readRecord(home, tenant, id) {
  if (!validSegment(tenant) || !validSegment(id)) return null;
  const events = readEvents(home, tenant, id);
  if (events.length) return rebuildFromEvents(home, tenant, id, events);
  if (fs.existsSync(eventsPath(home, tenant, id)) || fs.existsSync(recordPath(home, tenant, id))) {
    throw new Error(`execution ${id} has no authoritative genesis journal`);
  }
  return null;
}

// Remote records are explicitly only server-confirmed materialized caches.
function readCachedRecord(home, tenant, id) {
  return readJsonFile(recordPath(home, tenant, id), "execution cache");
}

function readJsonl(abs, label, { framed = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error(`${label} at ${abs} is unreadable: ${String((e && e.message) || e)}`);
  }
  const out = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Local authoritative logs tolerate only an unframed final fragment.
      // The remote outbox retains its existing best-effort reader.
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      if (framed) throw new Error(`${label} at ${abs} is corrupt at line ${index + 1}`);
    }
  }
  return out;
}

// The ordered event log, oldest first.
function readEvents(home, tenant, id) {
  if (!validSegment(tenant) || !validSegment(id)) return [];
  return readJsonl(eventsPath(home, tenant, id), `execution event log for ${id}`, { framed: true });
}

// The idempotency keys already durably recorded — read from the LOG, not the
// record, so suppression survives a restart.
function seenKeys(home, tenant, id) {
  const seen = new Set();
  for (const ev of readEvents(home, tenant, id)) if (ev && ev.idempotency_key) seen.add(String(ev.idempotency_key));
  return seen;
}

function readItem(home, tenant, nodeId) {
  if (!validSegment(tenant) || !validSegment(nodeId)) return null;
  return readJsonFile(itemPath(home, tenant, nodeId), "execution item pointer");
}

// The live execution for a work item in this tenant partition, or null.
function openExecutionFor(home, tenant, nodeId) {
  const ptr = readItem(home, tenant, nodeId);
  if (!ptr || !ptr.open) return null;
  const record = readRecord(home, tenant, ptr.open);
  if (!record) throw new Error(`execution item pointer names missing execution ${ptr.open}`);
  return kernel.isTerminal(record) ? null : record;
}

// Opening recovery must search by item, since a crashed genesis may name a
// different factory from the request. A corrupt journal is never absence.
function executionHistoryForItem(home, tenant, nodeId) {
  let names;
  try { names = fs.readdirSync(path.join(tenantDir(home, tenant), "exec")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const ids = new Set(names.flatMap((name) => name.endsWith(".events.jsonl") ? [name.slice(0, -13)] : name.endsWith(".json") ? [name.slice(0, -5)] : []));
  const history = [];
  for (const id of ids) {
    const record = readRecord(home, tenant, id);
    if (record?.item?.node_id === nodeId) history.push(record);
  }
  return history.sort((a, b) => a.pipeline_attempt - b.pipeline_attempt || a.execution_id.localeCompare(b.execution_id));
}

function tenants(home) {
  try {
    return fs.readdirSync(executionsDir(home)).filter(validSegment);
  } catch {
    return [];
  }
}

function sortAndSlice(rows, limit) {
  rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return rows.slice(0, Math.max(0, Number(limit) || 0));
}

// Every execution in a tenant, newest-updated first, bounded by `limit`.
function listExecutions(home, tenant, { nodeId = null, stage = null, limit = 100, authoritative = true } = {}) {
  if (!validSegment(tenant)) return [];
  let names;
  try {
    names = fs.readdirSync(path.join(tenantDir(home, tenant), "exec"));
  } catch {
    return [];
  }
  const rows = [];
  const ids = new Set(names.flatMap((name) => {
    if (name.endsWith(".json")) return [name.slice(0, -".json".length)];
    if (authoritative && name.endsWith(".events.jsonl")) return [name.slice(0, -".events.jsonl".length)];
    return [];
  }));
  for (const id of ids) {
    let rec = null;
    try {
      rec = authoritative ? readRecord(home, tenant, id) : readCachedRecord(home, tenant, id);
    } catch {
      continue; // a corrupt record must not blind the whole listing
    }
    if (!rec || !rec.execution_id) continue;
    if (nodeId && !(rec.item && rec.item.node_id === nodeId)) continue;
    if (stage && rec.stage !== stage) continue;
    rows.push(rec);
  }
  return sortAndSlice(rows, limit);
}

// ---------------- writes (atomic + durable) ----------------

// Append one event line, fsynced before returning — the record of last
// resort, so it lands BEFORE the materialized view.
function appendEventLine(home, tenant, id, event) {
  appendJsonlLine(eventsPath(home, tenant, id), event);
}

// One durable JSONL append, shared by the event log and the workflow journal:
// framing repaired first, the line fsynced before the call returns.
function appendJsonlLine(abs, entry) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Repair framing before appending: retain a complete unframed row, discard
  // only a torn final fragment. Otherwise a new durable row would join it.
  if (fs.existsSync(abs)) {
    const bytes = fs.readFileSync(abs);
    if (bytes.length && bytes[bytes.length - 1] !== 10) {
      const boundary = bytes.lastIndexOf(10) + 1;
      let complete = false;
      try { JSON.parse(bytes.subarray(boundary).toString("utf8")); complete = true; } catch {}
      if (complete) fs.appendFileSync(abs, "\n");
      else fs.truncateSync(abs, boundary);
    }
  }
  const fd = fs.openSync(abs, "a", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------- the workflow journal ----------------

// The replay kernel's step log for an execution, oldest first. Read framed:
// a torn final fragment is discarded (the kernel's `persist` fsyncs each
// line, so a fragment is a crash mid-write of an entry the workflow never
// acted on), while a corrupt interior line throws — a journal with a hole in
// it cannot be replayed and must not be read as a shorter one.
// `stage` names a PER-STAGE journal beside the execution's own
// (`<id>.<stage>.workflow.jsonl`): the integration stage is rewritten as its
// own workflow function ahead of the whole pipeline
// (task-spor-integration-stage-as-workflow-function), and its journal must
// not occupy the file the one-pipeline workflow will open under its own
// version header later — a stage journal there would read as a version
// mismatch and force a fresh attempt on every pipeline that ever integrated.
function readWorkflowJournal(home, tenant, id, { stage = null } = {}) {
  if (!validSegment(tenant) || !validSegment(id) || (stage != null && !validSegment(stage))) return [];
  return readJsonl(workflowJournalPath(home, tenant, id, { stage }), `workflow journal for ${id}${stage ? ` (${stage})` : ""}`, { framed: true });
}

function appendWorkflowEntry(home, tenant, id, entry, { stage = null } = {}) {
  if (!validSegment(tenant)) throw new Error(`invalid tenant segment '${tenant}'`);
  if (!validSegment(id)) throw new Error(`invalid execution id '${id}'`);
  if (stage != null && !validSegment(stage)) throw new Error(`invalid workflow stage '${stage}'`);
  if (!entry || typeof entry !== "object" || typeof entry.kind !== "string") throw new TypeError("a workflow journal entry is an object with a `kind`");
  appendJsonlLine(workflowJournalPath(home, tenant, id, { stage }), entry);
}

// What a driver hands the kernel: the journal as read from disk plus the
// `persist` the Execution calls after every append. The array is the SAME
// one the Execution appends to, so after a run `journal` on this handle is
// the durable state and a fresh handle re-reads the identical sequence.
function openWorkflowJournal(home, tenant, id, { stage = null } = {}) {
  const journal = readWorkflowJournal(home, tenant, id, { stage });
  return {
    id,
    tenant,
    stage,
    path: workflowJournalPath(home, tenant, id, { stage }),
    journal,
    persist: (entry) => appendWorkflowEntry(home, tenant, id, entry, { stage }),
  };
}

// The same handle over an ARBITRARY path: a gated run with no execution behind
// it (a legacy record, an agent-completion factory, a pre-adapter claim) keeps
// its stage journals beside its run record (agent-dispatch-runner.js
// runPaths().workflows) rather than running over an in-memory journal that a
// killed worker could never resume
// (task-spor-delete-loop-resume-machinery-after-workflow-stages). Framed read,
// fsynced append — the identical contract to the execution-keyed journal, so a
// driver cannot tell the two apart.
function openWorkflowJournalAt(abs, { stage = null, label = null } = {}) {
  if (typeof abs !== "string" || !abs) throw new TypeError("a workflow journal path is a non-empty string");
  if (stage != null && !validSegment(stage)) throw new Error(`invalid workflow stage '${stage}'`);
  const journal = readJsonl(abs, label || `workflow journal at ${abs}`, { framed: true });
  return {
    id: null,
    tenant: null,
    stage,
    path: abs,
    journal,
    persist: (entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.kind !== "string") throw new TypeError("a workflow journal entry is an object with a `kind`");
      appendJsonlLine(abs, entry);
    },
  };
}

// Persist a record and, when the event is present, append it FIRST: a crash
// between the two leaves an event with no view (repairable by replay), never a
// view of an event nobody recorded.
function writeRecord(home, tenant, record, event = null) {
  if (!validSegment(tenant)) throw new Error(`invalid tenant segment '${tenant}'`);
  if (!validSegment(record.execution_id)) throw new Error(`invalid execution id '${record.execution_id}'`);
  if (event) appendEventLine(home, tenant, record.execution_id, event);
  writeFileAtomic(recordPath(home, tenant, record.execution_id), `${JSON.stringify(record, null, 2)}\n`, { mkdir: true });
}

function writeItemPointer(home, tenant, nodeId, { open, add = null }) {
  if (!validSegment(tenant) || !validSegment(nodeId)) throw new Error("invalid item path segment");
  const prev = readItem(home, tenant, nodeId) || { node_id: nodeId, open: null, executions: [] };
  const executions = Array.isArray(prev.executions) ? prev.executions.slice() : [];
  if (add && !executions.includes(add)) executions.push(add);
  const next = { node_id: nodeId, open: open || null, executions };
  writeFileAtomic(itemPath(home, tenant, nodeId), `${JSON.stringify(next, null, 2)}\n`, { mkdir: true });
  return next;
}

// Replay the durable log over a fresh record — the repair path for a torn
// view, and the parity oracle the tests assert.
function rebuildFromEvents(home, tenant, id, events = readEvents(home, tenant, id)) {
  const genesis = events[0];
  const spec = genesis && genesis.spec;
  if (!genesis || genesis.type !== "execution.opened" || !spec || typeof spec !== "object" || Array.isArray(spec)
      || spec.tenant !== tenant || !NODE_ID_RE.test(spec.node_id || "") || !NODE_ID_RE.test(spec.factory_node_id || "")
      || !Number.isSafeInteger(spec.pipeline_attempt) || spec.pipeline_attempt < 1 || !Array.isArray(spec.gates)
      || !kernel.BOUNDARIES.includes(spec.boundary) || !Number.isFinite(Date.parse(spec.at))) {
    throw new Error(`execution ${id} has missing or malformed genesis`);
  }
  let record = kernel.initExecution(spec, { sha256 });
  if (record.execution_id !== id || genesis.execution_id !== id || genesis.seq !== 0) throw new Error(`execution ${id} has inconsistent genesis identity`);
  const seen = new Set();
  for (const ev of events.slice(1)) {
    if (!ev || typeof ev !== "object" || ev.execution_id !== id || ev.type === "execution.opened") throw new Error(`execution ${id} has an invalid journal row`);
    if (ev.type === "ownership.changed") {
      if (ev.seq !== record.seq) throw new Error(`execution ${id} has a non-contiguous ownership sequence`);
      record = { ...record, owner: ev.owner ? { ...ev.owner } : null, updated_at: ev.at, ...(ev.released_at ? { released_at: ev.released_at } : {}), ...(ev.force_release ? { force_release: ev.force_release } : {}) };
      continue;
    }
    const r = kernel.applyExecutionEvent(record, ev, { seen, historicalReplay: true });
    if (!r.ok) throw new Error(`execution ${id} cannot replay event ${ev.seq}: ${r.message}`);
    if (r.replayed) throw new Error(`execution ${id} has a duplicate event key in its journal`);
    {
      if (ev.seq !== r.seq) throw new Error(`execution ${id} has a non-contiguous event sequence`);
      record = r.record;
      seen.add(String(r.idempotency_key));
    }
  }
  return record;
}

// ---------------- the per-item critical section ----------------

const _itemLocks = new Map();

function withItemLock(key, fn) {
  const prev = _itemLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => {}, () => {});
  _itemLocks.set(key, tail);
  tail.then(() => {
    if (_itemLocks.get(key) === tail) _itemLocks.delete(key);
  });
  return next;
}

// Serialize local transactions across processes as well as handles. The
// filesystem lock retains exclusion until the callback settles, including
// future asynchronous transaction callbacks.
function withLocalItemLock(home, tenant, nodeId, fn) {
  const file = itemPath(home, tenant, nodeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withItemLock(file, async () => {
    const held = await require("./local-execution-lock.js").withLocalExecutionLock(file, fn);
    if (!held.ok) return fail("conflict", "local execution item is locked; retry after the current mutation");
    return held.value;
  });
}

// The same two-level lock around every rewrite of an execution's OUTBOX files
// (all instances' files for `id` in the partition share one lock,
// `<id>.outbox.lock`): a spool, a replay's un-spool, an adoption and a
// forfeit's hand-back are each a read-modify-write of a file another process
// may be rewriting, and an unserialized pair drops a line. The wait is
// BOUNDED (`budget`: the lock's attempts x waitMs, ~5s by default); a lock
// that cannot be had in it throws an error tagged `outboxLocked` — the caller
// reports the outbox unwritable, never writes past (and event() reports the
// event UNSPOOLED, so its caller keeps it and retries).
function withOutboxLock(home, tenant, id, fn, budget = {}) {
  const file = path.join(tenantDir(home, tenant), "exec", `${id}.outbox`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withItemLock(file, async () => {
    const held = await require("./local-execution-lock.js").withLocalExecutionLock(file, fn, budget);
    if (!held.ok) throw Object.assign(new Error(`the execution outbox for ${id} is locked by another process (${held.reason})`), { outboxLocked: true });
    return held.value;
  });
}

// ---------------- the LOCAL engine ----------------

// The personal-mode twin of server/executions.js over the store above: the
// same open/claim/renew/release/event doors with the same codes, the tenant
// fixed to `local`, the definition pinned by `pinRead` (a caller-supplied read
// of the local graph: `(nodeId) => {revision, repo} | null`), and the worker
// principal the caller names (this box's `dispatch.agent`, else the user).
// `instance` is the calling PROCESS (issue-spor-execution-fence-shared-by-
// same-agent-processes): within one (worker, machine) owner a different
// instance re-claims through the kernel and advances the fence, and a re-open
// echoes the fence only to the same instance — the server's rule, keyed the
// same way. Null keeps the pair-only behavior.
function localExecutionEngine({ home, tenant = "local", worker = "local", machine = null, instance = null, now = nowIso, ttlMs = DEFAULT_LEASE_TTL_MS, pinRead = null, person = null }) {
  const t = validSegment(tenant) ? tenant : "local";
  const decorate = record => ({ ...kernel.decorate(record), release_revision: sha256(kernel.releaseStateKey(record)) });
  const pin = ({ nodeId, factoryId, gates }) => {
    const read = (id) => {
      if (!pinRead || !id) return null;
      try {
        return pinRead(id);
      } catch {
        return null;
      }
    };
    const item = read(nodeId);
    const factory = read(factoryId);
    return {
      item_revision: item && item.revision != null ? String(item.revision) : null,
      factory_revision: factory && factory.revision != null ? String(factory.revision) : null,
      repo: item && item.repo != null ? String(item.repo) : null,
      gates: (gates || []).map((g) => {
        const gNode = g && g.node_id ? read(String(g.node_id)) : null;
        return { id: String(g.id), node_id: g && g.node_id != null ? String(g.node_id) : null, revision: gNode && gNode.revision != null ? String(gNode.revision) : null, rejudge_on_repin: g.rejudge_on_repin !== false };
      }),
    };
  };

  async function open(args) {
    const nodeId = String(args.node_id || "");
    const factoryId = String(args.factory || "");
    if (!NODE_ID_RE.test(nodeId) || !validSegment(nodeId)) return fail("invalid_node", "node_id must be a node id");
    if (!NODE_ID_RE.test(factoryId) || !validSegment(factoryId)) return fail("invalid_node", "factory must be a node id");
    const boundary = kernel.BOUNDARIES.includes(args.boundary) ? args.boundary : "gates";
    return withLocalItemLock(home, t, nodeId, () => {
      const at = now();
      let existing = openExecutionFor(home, t, nodeId);
      const history = executionHistoryForItem(home, t, nodeId);
      const live = history.filter((r) => !kernel.isTerminal(r));
      if (live.length > 1) return fail("conflict", `item '${nodeId}' has multiple unfinished execution journals`);
      existing = existing || live[0] || null;
      for (const row of history) {
        const ptr = readItem(home, t, nodeId);
        if (!ptr?.executions?.includes(row.execution_id) || ptr.open !== (existing?.execution_id || null)) {
          writeItemPointer(home, t, nodeId, { open: existing?.execution_id || null, add: row.execution_id });
        }
      }
      if (existing) {
        if (existing.factory.node_id !== factoryId) {
          return fail("execution_open", `item '${nodeId}' already has a live execution under factory '${existing.factory.node_id}'`, { execution: existing });
        }
        if (!existing.owner) {
          const claimed = kernel.claim(existing, { worker, machine, instance, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
          if (!claimed.ok) return claimed;
          existing = claimed.record;
          writeRecord(home, t, existing, ownershipEvent(existing, at, existing.owner));
        }
        // A second PROCESS of the live (worker, machine) owner re-opening is a
        // re-claim by a different instance: the fence advances and the earlier
        // process is fenced out, rather than being echoed the fence that
        // process is still writing with.
        if (owns(existing) && !sameInstance(existing) && !kernel.isTerminal(existing)) {
          const claimed = kernel.claim(existing, { worker, machine, instance, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
          if (!claimed.ok) return claimed;
          existing = claimed.record;
          writeRecord(home, t, existing, ownershipEvent(existing, at, existing.owner));
        }
        const mine = owns(existing) && sameInstance(existing);
        return { ok: true, replayed: true, execution: decorate(existing), ...(mine ? { fence: existing.owner.fence } : {}) };
      }
      const ptr = readItem(home, t, nodeId);
      const pipelineAttempt = (ptr && Array.isArray(ptr.executions) ? ptr.executions.length : 0) + 1;
      const id = kernel.executionIdFor({ tenant: t, node_id: nodeId, factory: factoryId, pipeline_attempt: pipelineAttempt }, sha256);
      let opening = readRecord(home, t, id);
      if (opening) {
        // An initial open can crash after its log but before its view/pointer.
        // Recover the original pin before consulting today's graph definition.
        if (!kernel.isTerminal(opening) && (!opening.owner || (owns(opening) && !sameInstance(opening)))) {
          const claimed = kernel.claim(opening, { worker, machine, instance, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
          if (!claimed.ok) return claimed;
          opening = claimed.record;
          writeRecord(home, t, opening, ownershipEvent(opening, at, opening.owner));
        } else writeRecord(home, t, opening);
        writeItemPointer(home, t, nodeId, { open: kernel.isTerminal(opening) ? null : id, add: id });
        const mine = owns(opening) && sameInstance(opening);
        return { ok: true, replayed: true, execution: decorate(opening), ...(mine ? { fence: opening.owner.fence } : {}) };
      }
      const pinned = pin({ nodeId, factoryId, gates: args.gates });
      const spec = {
        tenant: t,
        node_id: nodeId,
        factory_node_id: factoryId,
        pipeline_attempt: pipelineAttempt,
        item_revision: pinned.item_revision,
        factory_revision: pinned.factory_revision,
        repo: args.repo != null ? String(args.repo) : pinned.repo,
        gates: pinned.gates,
        boundary,
        at,
      };
      let record = kernel.initExecution(spec, { sha256 });
      const claimed = kernel.claim(record, { worker, machine, instance, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
      if (!claimed.ok) return claimed;
      record = claimed.record;
      appendEventLine(home, t, record.execution_id, { type: "execution.opened", execution_id: record.execution_id, seq: 0, at, spec });
      appendEventLine(home, t, record.execution_id, { type: "ownership.changed", execution_id: record.execution_id, seq: 0, at, owner: record.owner });
      writeRecord(home, t, record);
      writeItemPointer(home, t, nodeId, { open: record.execution_id, add: record.execution_id });
      return { ok: true, execution: decorate(record), fence: record.owner.fence };
    }).catch((e) => fail("conflict", String(e.message || e)));
  }

  async function withExecution(id, fn) {
    const executionId = String(id || "");
    if (!validSegment(executionId)) return fail("invalid_node", "execution_id is not a valid execution id");
    let peek;
    try {
      peek = readRecord(home, t, executionId);
    } catch (e) {
      return fail("conflict", String((e && e.message) || e));
    }
    if (!peek) return fail("not_found", `no such execution '${executionId}'`);
    return withLocalItemLock(home, t, peek.item.node_id, () => {
      const record = readRecord(home, t, executionId);
      if (!record) return fail("not_found", `no such execution '${executionId}'`);
      return fn({ record, at: now() });
    }).catch((e) => fail("conflict", String(e.message || e)));
  }

  // The owner KEY is the (worker, machine) pair — renew/release/events check
  // only that; the instance decides whether a re-claim or re-open keeps the
  // fence, and the fence is what refuses the earlier process's writes.
  const owns = (record) => !!record.owner && record.owner.worker === worker && (record.owner.machine ?? null) === (machine ?? null);
  const sameInstance = (record) => !!record.owner && (record.owner.instance ?? null) === (instance ?? null);
  const ownershipRefusal = (record) => fail("already_owned", "execution belongs to another worker or machine", { holder: record.owner || null });
  const ownershipEvent = (record, at, owner) => ({ type: "ownership.changed", execution_id: record.execution_id, seq: record.seq, at, owner, ...(record.released_at ? { released_at: record.released_at } : {}) });

  return {
    mode: "local",
    tenant: t,
    worker,
    open,
    claim: (id, { takeover = false, ttl_ms = null } = {}) =>
      withExecution(id, ({ record, at }) => {
        const r = kernel.claim(record, { worker, machine, instance, lease_expires_at: expiryFrom(at, clampTtl(ttl_ms || ttlMs)), now: at, takeover: takeover === true });
        if (!r.ok) return r;
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, r.record.owner));
        return { ok: true, execution: decorate(r.record), fence: r.fence };
      }),
    renew: (id, { fence, ttl_ms = null } = {}) =>
      withExecution(id, ({ record, at }) => {
        const r = kernel.renew(record, { fence, lease_expires_at: expiryFrom(at, clampTtl(ttl_ms || ttlMs)), now: at });
        if (!r.ok) return { ...r, holder: record.owner || null };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, r.record.owner));
        return { ok: true, execution: decorate(r.record), fence: r.fence };
      }),
    release: (id, { fence } = {}) =>
      withExecution(id, ({ record, at }) => {
        if (record.released_at) return { ok: true, replayed: true, execution: decorate(record) };
        const r = kernel.release(record, { fence, now: at });
        if (!r.ok) return { ...r, holder: record.owner || null };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, null));
        if (kernel.isTerminal(r.record) && readItem(home, t, record.item.node_id)?.open === record.execution_id) writeItemPointer(home, t, record.item.node_id, { open: null, add: record.execution_id });
        return { ok: true, execution: decorate(r.record) };
      }),
    forceRelease: (id, args = {}) => {
      if (!person) return Promise.resolve(fail("forbidden", "force release requires a constructor-bound local person"));
      return withExecution(id, ({ record, at }) => {
        const r = kernel.forceRelease(record, { nodeId: args.node_id, person, reason: args.reason, requestId: args.request_id, expectedRevision: args.expected_revision, revision: sha256(kernel.releaseStateKey(record)), now: at });
        if (!r.ok) return r;
        if (r.replayed) return { ok: true, replayed: true, execution: decorate(record) };
        writeRecord(home, t, r.record, { ...ownershipEvent(r.record, at, null), force_release: r.record.force_release });
        if (readItem(home, t, record.item.node_id)?.open === record.execution_id) writeItemPointer(home, t, record.item.node_id, { open: null, add: record.execution_id });
        return { ok: true, execution: decorate(r.record) };
      });
    },
    event: (id, { fence, event } = {}) =>
      withExecution(id, ({ record, at }) => {
        const ev = { ...(event || {}) };
        ev.at = ev.at != null ? String(ev.at) : at;
        ev.fence = fence;
        // Store-owned admission metadata separates historical restart semantics
        // from newly accepted restarts. A caller cannot select the old fold.
        if (["gate.started", "candidate.submitted", "candidate.superseded"].includes(ev.type)) ev.admission_version = 2;
        // Persist the same normalized publication that the server accepts.
        // Otherwise replay cannot distinguish new discordant timestamps from
        // historical source records whose top-level clock was only advisory.
        if (ev.type === "candidate.published") {
          ev.reference = { ...(ev.reference || {}), verified_at: ev.reference?.verified_at ?? ev.verified_at };
          ev.verified_at = ev.reference.verified_at;
        }
        const seen = seenKeys(home, t, record.execution_id);
        const r = kernel.applyExecutionEvent(record, ev, { seen, now: at });
        if (!r.ok) return { ...r, holder: record.owner || null };
        if (r.replayed) return { ok: true, replayed: true, execution: decorate(record), idempotency_key: r.idempotency_key };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, { ...ev, execution_id: record.execution_id, seq: r.seq, idempotency_key: r.idempotency_key });
        if (kernel.isTerminal(r.record) && readItem(home, t, record.item.node_id)?.open === record.execution_id) writeItemPointer(home, t, record.item.node_id, { open: null, add: record.execution_id });
        return { ok: true, execution: decorate(r.record), seq: r.seq, idempotency_key: r.idempotency_key };
      }),
    get: async (id) => {
      if (!validSegment(String(id || ""))) return fail("invalid_node", "execution_id is not a valid execution id");
      let rec;
      try {
        rec = readRecord(home, t, id);
      } catch (e) {
        return fail("conflict", String((e && e.message) || e));
      }
      if (!rec) return fail("not_found", `no such execution '${id}'`);
      return { ok: true, execution: decorate(rec) };
    },
    list: async ({ node_id = null, stage = null, limit = 50 } = {}) => {
      const rows = listExecutions(home, t, { nodeId: node_id, stage, limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
      return { ok: true, executions: rows.map(kernel.decorate), count: rows.length };
    },
    events: async (id, { limit = 500 } = {}) => {
      if (!validSegment(String(id || ""))) return fail("invalid_node", "execution_id is not a valid execution id");
      try {
        if (!readRecord(home, t, id)) return fail("not_found", `no such execution '${id}'`);
        const all = readEvents(home, t, id);
        return { ok: true, events: all.slice(0, Math.min(2000, Math.max(1, Number(limit) || 500))), count: all.length };
      } catch (e) { return fail("conflict", String(e.message || e)); }
    },
    // Local mode has no partition to reconcile after; the outbox is always empty.
    reconcile: async () => ({ ok: true, replayed: 0, pending: 0 }),
    outbox: () => [],
  };
}

// ---------------- the REMOTE adapter ----------------

// Refusal codes that mean "this holder no longer owns the execution": the
// event is kept as evidence (a later re-claim under a fresh fence may replay
// it), the caller is told ownership is gone, and nothing further is sent — an
// instance-bearing process that records a sticky `fence_stale` loss then
// forfeits its own spool (withOwnershipCheck).
const OWNERSHIP_LOST = new Set(kernel.OWNERSHIP_CODES);
// Refusal codes that are permanent for the EVENT — the server's state will
// never accept it, so re-sending is spend without a return. Dropped, logged.
const EVENT_REJECTED = new Set(["invalid_event", "unknown_gate", "unknown_candidate", "candidate_conflict", "no_candidate", "gates_unsettled", "boundary_not_reached", "invalid_node"]);

function errorOf(r) {
  const e = r && r.json && r.json.error && typeof r.json.error === "object" ? r.json.error : null;
  return {
    code: (e && e.code) || (r && r.json && r.json.code) || (r && r.status === 404 ? "not_found" : "http_error"),
    message: (e && e.message) || (r && r.json && r.json.message) || `HTTP ${r && r.status}`,
    holder: (e && e.holder) || (r && r.json && r.json.holder) || null,
  };
}

// The remote half. `tenant` is only a LABEL for the local cache/outbox
// partition (the server derives the real tenant from the identity and never
// reads it from the body); it defaults to the active org, else `remote`.
function remoteExecutionAdapter(cfg, remote, { home, tenant = "remote", machine = require("node:os").hostname(), instance = null, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {}, outboxLock = {} }) {
  const t = validSegment(tenant) ? tenant : "remote";

  // Keep the last server-confirmed copy beside the outbox: the offline read
  // for `spor executions`, and the record the idempotency keys derive from.
  // It is filed under the record's OWN tenant (the server's partition, on the
  // record) so the local copy sits exactly where a hosted reader would look;
  // the label is only the fallback for a record that carries none.
  const partitionOf = (execution) => (execution && validSegment(String(execution.tenant || "")) ? String(execution.tenant) : t);
  const cache = (execution) => {
    if (!execution || !validSegment(String(execution.execution_id || ""))) return;
    try {
      writeFileAtomic(recordPath(home, partitionOf(execution), execution.execution_id), `${JSON.stringify(execution, null, 2)}\n`, { mkdir: true });
    } catch {
      /* the cache is a convenience; the server is the record */
    }
  };
  const cached = (id) => {
    for (const part of [t, ...tenants(home).filter((x) => x !== t)]) {
      try {
        const rec = readCachedRecord(home, part, id);
        if (rec) return rec;
      } catch {
        /* a corrupt cached copy is no copy */
      }
    }
    return null;
  };

  const answer = (r) => {
    if (!r) return fail("transport", "no response", { transport: true });
    if (r.transport) return fail("transport", `offline — ${r.error}`, { transport: true });
    if (r.ok && r.json && r.json.ok) {
      if (r.json.execution) cache(r.json.execution);
      return r.json;
    }
    if (r.ok) return fail("http_error", r.jsonError ? `unreadable body (${r.jsonError})` : "unexpected body", { status: r.status });
    const e = errorOf(r);
    // A server that does not serve the surface at all (an older version — the
    // route 404s with no `error` envelope naming it) or one with no execution
    // store configured (503 unavailable): the caller decides whether to fall
    // back to the local store. Marked so it can tell that from a refusal.
    const unserved = r.status === 503 && e.code === "unavailable";
    // An older server's router answers a route it does not have with the
    // standard envelope (`404 not_found: no such route`); a served `open`
    // names the node it could not find instead. A bare 404 body (no
    // envelope at all) is a front door with no such route either.
    const absent = r.status === 404 && (!(r.json && r.json.error) || (e.code === "not_found" && /^no such route$/i.test(String(e.message).trim())));
    return fail(e.code, e.message, { status: r.status, holder: e.holder, ...(r.status === 401 || r.status === 403 ? { ownership: false } : {}), ...(r.status >= 500 || unserved ? { transient: true } : {}), ...(unserved || absent ? { unserved: true } : {}) });
  };

  // Bind every mutation, including outbox replay, to this adapter's machine.
  // Never copy a holder machine out of a cached remote execution.
  const post = (p, body) => remote.post(cfg, p, { ...body, machine }, { timeoutMs });
  // The process instance rides ONLY the two ownership-acquiring doors (open,
  // claim) — the server keys the fence on it there and nowhere else — and is
  // always this adapter's own, never a holder's copied out of a record.
  const owning = (body) => (instance != null ? { ...body, instance: String(instance) } : body);
  const get = (p) => remote.get(cfg, p, { timeoutMs });

  // ---- the outbox ----
  // Keyed by PROCESS INSTANCE (issue-spor-execution-sticky-loss-gaps-open-
  // and-outbox): an instance-bearing adapter spools into its OWN file and
  // replays only what it owes, so a second process of the same owner that
  // fenced this one out never sends this one's events under its own fence.
  // What another instance's file holds is ADOPTED (adoptOwed) only when its
  // owner is provably gone from this box, only by a holder whose fence the
  // server still names, and only the lines queued before the fence they were
  // written under was lost — a dead predecessor's partition backlog, never a
  // live loser's (or a dead one's) stale-fence writes. A loser drops its own
  // lines the moment its loss is recorded (forfeit). Every rewrite of any of
  // these files runs under the execution's outbox lock (withOutboxLock), so a
  // spool, a replay, an adoption and a forfeit never lose each other's lines
  // (issue-spor-execution-outbox-unlocked-rmw-and-adoption-cutoff).
  const ownTag = instance != null ? outboxTag(instance) : null;
  let author = null;
  const by = () => {
    if (!author) {
      const ident = processIdentity.mintIdentity();
      author = { instance: String(instance), machine: machine ?? null, pid: ident.pid, ticks: ident.ticks };
    }
    return author;
  };
  const locked = (id, fn) => withOutboxLock(home, t, id, fn, outboxLock);
  const readOutbox = (id) => readJsonl(outboxPath(home, t, id, ownTag), `execution outbox for ${id}`);
  // Every outbox file for `id` in this partition: the shared (instance-less)
  // one first, then each instance's.
  const outboxFiles = (id) => {
    const prefix = `${id}.outbox.`;
    let names = [];
    try {
      names = fs.readdirSync(path.join(tenantDir(home, t), "exec"));
    } catch {
      names = [];
    }
    const tagged = names.filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl") && n !== `${prefix}jsonl`).sort();
    return [`${prefix}jsonl`, ...tagged].map((n) => path.join(tenantDir(home, t), "exec", n));
  };
  const writeOutbox = (id, lines) => {
    const abs = outboxPath(home, t, id, ownTag);
    if (!lines.length) {
      try {
        fs.rmSync(abs, { force: true });
      } catch {
        /* best effort */
      }
      return;
    }
    // Every line of an instance's file names the file's OWNER (`held_by`)
    // beside its author (`by`): a file can come to hold only lines adopted
    // from a gone predecessor, and its own liveness must still be judgeable.
    const stamped = ownTag ? lines.map((l) => ({ ...l, held_by: by() })) : lines;
    writeFileAtomic(abs, stamped.map((l) => JSON.stringify(l)).join("\n") + "\n", { mkdir: true });
  };
  // Each line records the FENCE it was written under, so adoption can date
  // the line against that fence's loss in the takeover ledger.
  const spool = (id, event, fence) => {
    const abs = outboxPath(home, t, id, ownTag);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fd = fs.openSync(abs, "a", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ event, queued_at: nowIso(), ...(Number.isInteger(fence) ? { fence } : {}), ...(ownTag ? { by: by() } : {}) })}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  // Stamp the deterministic idempotency key on an event before it leaves, so
  // the spooled copy and every retry carry the one its first attempt would
  // have — the key does not depend on record state beyond the execution id.
  const keyed = (id, event) => {
    if (!event || event.idempotency_key != null) return event;
    const key = kernel.derivedEventKey({ execution_id: id }, event);
    return key ? { ...event, idempotency_key: key } : event;
  };

  // Send one event under the fence. Returns the server's answer, or a typed
  // failure classified for the outbox: `transient` (keep, retry later),
  // `ownership` (keep; this holder is fenced out), `terminal` (drop all),
  // `rejected` (drop this one).
  const send = async (id, fence, event) => {
    const r = answer(await post(`/v1/executions/${encodeURIComponent(id)}/events`, { fence, event }));
    if (r.ok) return r;
    if (r.transport || r.transient || r.status === 429) return { ...r, klass: "transient" };
    if (OWNERSHIP_LOST.has(r.code)) return { ...r, klass: "ownership" };
    if (r.code === "execution_terminal") return { ...r, klass: "terminal" };
    if (EVENT_REJECTED.has(r.code) || r.status === 422 || r.status === 400) return { ...r, klass: "rejected" };
    // 401/403 after the client's own refresh, 404 (the execution is gone from
    // the server — cross-tenant or purged): nothing this holder can replay.
    if (r.status === 401 || r.status === 403 || r.code === "not_found") return { ...r, klass: "ownership" };
    return { ...r, klass: "transient" };
  };

  // A line's identity across a rewrite (which adds `held_by`).
  const lineId = (l) => {
    const { held_by: _held, ...rest } = l || {};
    return JSON.stringify(rest);
  };
  // Un-spool ONE line the server answered for: re-read under the lock and
  // remove its first occurrence, so a line spooled (or adopted) since the read
  // that chose it is never overwritten by a stale in-memory copy.
  const dropLine = (id, line) => {
    const want = lineId(line);
    const lines = readOutbox(id);
    const at = lines.findIndex((l) => lineId(l) === want);
    if (at < 0) return;
    lines.splice(at, 1);
    writeOutbox(id, lines);
  };

  // The takeover ledger (takeoverPath): every fence an instance acquired on
  // this box, and when. Read best-effort — an unreadable ledger dates nothing,
  // which only ever withholds an adoption.
  const noteAcquired = (id, fence, at) => {
    if (!ownTag || !validSegment(String(id)) || !Number.isInteger(Number(fence))) return;
    appendJsonlLine(takeoverPath(home, t, id), { fence: Number(fence), at: new Date(at).toISOString(), instance: String(instance), machine: machine ?? null });
  };
  const readLedger = (id) => {
    try {
      return readJsonl(takeoverPath(home, t, id), `execution takeover ledger for ${id}`);
    } catch {
      return [];
    }
  };
  // When was fence `f` lost — epoch ms of the grant of fence f+1, or null when
  // that grant was not recorded on this box (a takeover elsewhere, a ledger
  // write that never landed): then no line written under `f` can be proven
  // to predate the loss, and none is adopted. Fence numbers never repeat
  // within one execution — a release is terminal and a terminal execution is
  // never re-claimed — so fence f+1 has at most one grant.
  const lossOf = (ledger, f) => {
    const at = ledger.filter((e) => e && Number(e.fence) === f + 1).map((e) => Date.parse(e.at)).filter(Number.isFinite);
    return at.length ? Math.min(...at) : null;
  };

  // Judge every OTHER outbox file for `id` (never this instance's own): who
  // holds it, and which of its lines this instance may adopt. `state` is
  // `shared` (the instance-less file, adopted wholesale), `adoptable` (its
  // owner is provably gone from this machine), `live` (its owner is a live
  // process here), `unknown` (another machine, no pid, or unreadable) or
  // `stranded` (its owner is gone, but a line of it was written under a fence
  // whose loss this box's ledger cannot date — a takeover elsewhere, a ledger
  // write that never landed — so it can be proven neither owed nor stale:
  // the file is left exactly as it is, never adopted and never deleted, and
  // reported for a person to judge;
  // issue-spor-execution-event-lost-on-outbox-lock-contention).
  const strandedNoted = new Set();
  const surveyOthers = (id) => {
    const since = ACQUIRED_AT.get(fenceKey(instance, id));
    const own = ownTag ? outboxPath(home, t, id, ownTag) : null;
    const ledger = readLedger(id);
    const out = [];
    for (const abs of outboxFiles(id)) {
      if (abs === own) continue;
      const shared = abs === outboxPath(home, t, id);
      let lines;
      try {
        lines = readJsonl(abs, `execution outbox for ${id}`);
      } catch {
        if (fs.existsSync(abs)) out.push({ abs, shared, owner: null, state: "unknown", lines: [], keep: [] });
        continue;
      }
      if (!lines.length) continue;
      if (shared) {
        out.push({ abs, shared, owner: null, state: "shared", lines, keep: lines });
        continue;
      }
      // Liveness is the FILE's owner's — the instance its tag names — never
      // whichever author happens to be first: an owner that adopted a dead
      // predecessor's backlog carries those lines ahead of its own.
      const tag = path.basename(abs).slice(`${id}.outbox.`.length, -".jsonl".length);
      const who = lines.flatMap((l) => (l ? [l.held_by, l.by] : [])).find((x) => x && x.instance != null && outboxTag(x.instance) === tag) || null;
      let state = "unknown";
      if (who && (who.machine ?? null) === (machine ?? null) && Number.isInteger(who.pid)) {
        state = processIdentity.isOurProcess(who.pid, who.ticks).reallyAlive ? "live" : "adoptable";
      }
      // A line is owed only if it was queued before the fence it was written
      // under was lost (the ledger), and before this instance's own grant.
      // A line from before fences were stamped is dated by the grant alone.
      // A line queued after this instance's grant is provably post-loss. One
      // whose own fence's loss is missing from the ledger is UNDATABLE, and
      // one undatable line strands the whole file: adopting the rest would
      // replay later lines ahead of a possibly-owed earlier one.
      let keep = [];
      if (state === "adoptable" && since != null) {
        const undatable = (l) => {
          const q = Date.parse(l && l.queued_at);
          return q < since && Number.isInteger(l.fence) && lossOf(ledger, l.fence) == null;
        };
        if (lines.some(undatable)) {
          state = "stranded";
          if (!strandedNoted.has(abs)) {
            strandedNoted.add(abs);
            log(`execution ${id}: ${path.basename(abs)} (a gone process's outbox, ${lines.length} line(s)) holds event(s) written under a fence whose loss this box's takeover ledger cannot date — left stranded, neither adopted nor deleted; see \`spor executions ${id}\``);
          }
        } else {
          keep = lines.filter((l) => {
            const q = Date.parse(l && l.queued_at);
            if (!(q < since)) return false;
            return !Number.isInteger(l.fence) || q < lossOf(ledger, l.fence);
          });
        }
      }
      out.push({ abs, shared, owner: who, state, lines, keep, dated: since != null });
    }
    return out;
  };
  // A gone holder's file is adopted only by an instance that has a grant to
  // date it against; without one, the file is left whole for one that does.
  const adopts = (s) => s.state === "shared" || (s.state === "adoptable" && s.dated);

  // Move what other writers owe into this instance's own file, ahead of its
  // own lines (they are older). The merged file is written BEFORE a source is
  // removed, so a crash between them leaves a duplicate the idempotency keys
  // absorb, never a lost line. Runs under the outbox lock. Instance-less
  // adapters adopt nothing.
  const adoptOwed = (id) => {
    if (!ownTag) return;
    const adopted = surveyOthers(id).filter(adopts);
    if (!adopted.length) return;
    for (const a of adopted) {
      if (a.keep.length < a.lines.length) log(`execution ${id}: ${a.lines.length - a.keep.length} event(s) a gone process spooled after its fence was lost were written under a stale fence — dropped`);
    }
    writeOutbox(id, [...adopted.flatMap((a) => a.keep), ...readOutbox(id)]);
    for (const a of adopted) {
      try {
        fs.rmSync(a.abs, { force: true });
      } catch {
        /* best effort — the lines now live in this instance's file */
      }
    }
  };
  const anyToAdopt = (id) => !!ownTag && surveyOthers(id).some(adopts);

  // Replay what is owed, in order, stopping at the first thing that has to
  // wait. Returns {ok, replayed, pending, ownership?, code?}.
  async function reconcile(id, { fence } = {}) {
    // Adopt only while this instance's fence is CURRENT: a loser that has not
    // yet learned of its loss would otherwise move a dead predecessor's
    // backlog into its own (live) file, where the real holder cannot reach
    // it. The check is a read, made only when there is something to adopt;
    // a server naming a NEWER fence is this instance's loss, and one that
    // cannot be read leaves the backlog where it is for a later pass.
    try {
      if (fence != null && (await locked(id, () => anyToAdopt(id)))) {
        const cur = answer(await get(`/v1/executions/${encodeURIComponent(id)}`));
        const o = cur.ok && cur.execution ? cur.execution.owner : null;
        if (o && Number(o.fence) === Number(fence) && (o.instance == null || String(o.instance) === String(instance))) {
          await locked(id, () => adoptOwed(id));
        } else if (o && Number(o.fence) > Number(fence)) {
          let pending = 0;
          try {
            pending = readOutbox(id).length;
          } catch {
            pending = -1;
          }
          return { ok: false, replayed: 0, pending, ownership: false, code: "fence_stale", message: `the execution is held at fence ${o.fence}; fence ${fence} is stale`, holder: o };
        }
      }
    } catch (e) {
      return fail("outbox_unreadable", String((e && e.message) || e), { replayed: 0, pending: -1 });
    }
    let replayed = 0;
    for (;;) {
      let lines;
      try {
        lines = await locked(id, () => readOutbox(id));
      } catch (e) {
        return fail("outbox_unreadable", String((e && e.message) || e), { replayed, pending: -1 });
      }
      if (!lines.length) return { ok: true, replayed, pending: 0 };
      const head = lines[0];
      const r = await send(id, fence, keyed(id, head.event));
      if (r.ok || r.klass === "rejected") {
        if (r.ok) replayed += 1;
        else log(`execution ${id}: a spooled ${head.event && head.event.type} event was refused permanently by the server (${r.code}: ${r.message}) — dropped`);
        try {
          await locked(id, () => dropLine(id, head));
        } catch (e) {
          return fail("outbox_unwritable", String((e && e.message) || e), { replayed, pending: lines.length });
        }
        continue;
      }
      if (r.klass === "terminal") {
        log(`execution ${id}: the server reports it terminal (${r.message}); ${lines.length} spooled event(s) can no longer land — dropped`);
        try {
          await locked(id, () => writeOutbox(id, []));
        } catch {
          /* nothing more can land; a later replay is refused the same way */
        }
        return { ok: true, replayed, pending: 0, terminal: true };
      }
      if (r.klass === "ownership") return { ok: false, replayed, pending: lines.length, ownership: false, code: r.code, message: r.message, holder: r.holder || null };
      return { ok: false, replayed, pending: lines.length, transient: true, code: r.code, message: r.message };
    }
  }

  return {
    mode: "remote",
    tenant: t,
    open: async (args) => {
      const body = {
        node_id: args.node_id,
        factory: args.factory,
        gates: (args.gates || []).map((g) => ({ id: String(g.id), ...(g.node_id ? { node_id: String(g.node_id) } : {}) })),
        boundary: args.boundary,
        ...(args.repo != null ? { repo: args.repo } : {}),
        ...(args.machine != null ? { machine: args.machine } : {}),
        ...(args.worker != null ? { worker: args.worker } : {}),
        ...(args.ttl_ms != null ? { ttl_ms: args.ttl_ms } : {}),
      };
      return answer(await post("/v1/executions", owning(body)));
    },
    claim: async (id, { takeover = false, ttl_ms = null, machine = null, worker = null } = {}) =>
      answer(await post(`/v1/executions/${encodeURIComponent(id)}/claim`, owning({ ...(takeover ? { takeover: true } : {}), ...(ttl_ms != null ? { ttl_ms } : {}), ...(machine != null ? { machine } : {}), ...(worker != null ? { worker } : {}) }))),
    renew: async (id, { fence, ttl_ms = null } = {}) => answer(await post(`/v1/executions/${encodeURIComponent(id)}/renew`, { fence, ...(ttl_ms != null ? { ttl_ms } : {}) })),
    release: async (id, { fence } = {}) => answer(await post(`/v1/executions/${encodeURIComponent(id)}/release`, { fence })),
    forceRelease: async (id, body) => answer(await post(`/v1/executions/${encodeURIComponent(id)}/force-release`, body)),
    // OWE FIRST: the event is spooled before the attempt, and un-spooled only
    // once the server answered for it (recorded or replayed). An event that
    // cannot be delivered is then exactly what the next call replays, in order
    // and ahead of anything newer — the reducer's own ordering rules (a gate
    // cannot settle before its candidate, integration cannot start before the
    // gates) hold across the partition because nothing is sent out of order.
    event: async (id, { fence, event } = {}) => {
      const ev = keyed(id, event);
      try {
        await locked(id, () => spool(id, ev, fence != null && Number.isInteger(Number(fence)) ? Number(fence) : null));
      } catch (e) {
        // NOT spooled: nothing durable holds the event, so the failure says so
        // (`unspooled`) and the caller must keep it and re-send it — the
        // reporter holds it in memory and retries ahead of anything newer.
        return fail("outbox_unwritable", `the execution outbox could not be written; the event was NOT spooled (${String((e && e.message) || e)})`, { unspooled: true, transient: true, ...(e && e.outboxLocked ? { locked: true } : {}) });
      }
      const rec = await reconcile(id, { fence });
      if (rec.terminal) return fail("execution_terminal", "the execution is terminal on the server; the event was dropped", { terminal: true });
      if (!rec.ok) {
        return fail(rec.code || "deferred", rec.message || "deferred", {
          deferred: true,
          pending: rec.pending,
          ...(rec.ownership === false ? { ownership: false, holder: rec.holder } : { transient: true }),
        });
      }
      // `replayed` counts the events owed from BEFORE this call that landed
      // ahead of it — the partition's backlog, not this event itself.
      return { ok: true, execution: cached(id), deferred: false, replayed: Math.max(0, rec.replayed - 1) };
    },
    reconcile,
    // Everything in any outbox file for `id` on this box, whichever instance
    // spooled it — the raw view (a loser's never-landing lines included).
    outbox: (id) =>
      outboxFiles(id).flatMap((abs) => {
        try {
          return readJsonl(abs, `execution outbox for ${id}`);
        } catch {
          return [];
        }
      }),
    // What may yet be sent for `id` from this box — the attempt keys a
    // successor must not mint again: this instance's own lines, the shared
    // file, and every other file's lines EXCEPT a gone holder's dated
    // post-loss writes, which adoption drops and so never land. A LIVE
    // loser's lines still count: once it exits, its pre-loss backlog is
    // adopted and replayed, and a key minted over it would replay as a no-op.
    // Over-counting only skips an attempt number; under-counting loses a
    // verdict. Instance-less adapters owe the shared file.
    owed: (id) => {
      let own = [];
      try {
        own = readOutbox(id);
      } catch {
        own = [];
      }
      if (!ownTag) return own;
      return [...surveyOthers(id).flatMap((s) => (s.state === "adoptable" && s.dated ? s.keep : s.lines)), ...own];
    },
    // Per-file view for `spor executions`: which process holds each outbox
    // file and whether its lines will be replayed, so a stranded file is
    // visible rather than only ever GC'd. `own` is this instance's file.
    outboxReport: (id) => {
      const rows = [];
      if (ownTag) {
        let own = [];
        try {
          own = readOutbox(id);
        } catch {
          own = [];
        }
        if (own.length) rows.push({ file: outboxPath(home, t, id, ownTag), state: "own", owner: by(), lines: own.length });
      }
      for (const s of surveyOthers(id)) rows.push({ file: s.abs, state: s.state, owner: s.owner, lines: s.lines.length });
      return rows;
    },
    noteAcquired,
    // This instance LOST `id` for good (withOwnershipCheck): what it still
    // owes can never land under its fence, and no successor may send it under
    // theirs. Instance-less adapters keep the shared file as evidence.
    // Only this instance's OWN lines are dropped: what it adopted from a gone
    // predecessor (or the shared file) goes back to its author's file, where
    // the real holder's adoption will find it. Under the outbox lock, so a
    // hand-back never races an adopter removing the file it writes into.
    forfeit: (id) =>
      !ownTag
        ? 0
        : locked(id, () => {
            let owed = [];
            try {
              owed = readOutbox(id);
            } catch {
              owed = [];
            }
            const mine = (l) => !!(l && l.by && l.by.instance != null && outboxTag(l.by.instance) === ownTag);
            const back = new Map(); // destination path -> adopted lines, in order
            for (const l of owed) {
              if (mine(l)) continue;
              const dest = l && l.by && l.by.instance != null ? outboxPath(home, t, id, outboxTag(l.by.instance)) : outboxPath(home, t, id);
              if (!back.has(dest)) back.set(dest, []);
              const { held_by: _held, ...line } = l;
              back.get(dest).push(line);
            }
            for (const [dest, lines] of back) {
              // The adopted lines are older than anything their file gained since.
              writeFileAtomic(dest, [...lines, ...readJsonl(dest, `execution outbox for ${id}`)].map((l) => JSON.stringify(l)).join("\n") + "\n", { mkdir: true });
            }
            writeOutbox(id, []);
            const dropped = owed.filter(mine).length;
            if (dropped) log(`execution ${id}: this process lost the execution; ${dropped} event(s) it still owed were spooled under a stale fence — dropped`);
            return dropped;
          }),
    get: async (id) => {
      const r = answer(await get(`/v1/executions/${encodeURIComponent(id)}`));
      if (r.ok || !r.transport) return r;
      const c = cached(id);
      return c ? { ok: true, execution: kernel.decorate(c), cached: true, transport: true } : r;
    },
    list: async ({ node_id = null, stage = null, limit = 50 } = {}) => {
      const q = new URLSearchParams();
      if (node_id) q.set("node_id", node_id);
      if (stage) q.set("stage", stage);
      if (limit) q.set("limit", String(limit));
      const r = answer(await get(`/v1/executions${q.toString() ? `?${q}` : ""}`));
      if (r.ok || !r.transport) return r;
      const rows = [];
      for (const part of [t, ...tenants(home).filter((x) => x !== t)]) rows.push(...listExecutions(home, part, { nodeId: node_id, stage, limit: 200, authoritative: false }));
      const page = rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, Math.min(200, Math.max(1, Number(limit) || 50)));
      return { ok: true, executions: page.map(kernel.decorate), count: page.length, cached: true, transport: true };
    },
    events: async (id, { limit = 500 } = {}) => answer(await get(`/v1/executions/${encodeURIComponent(id)}/events?limit=${encodeURIComponent(String(limit))}`)),
    cached,
  };
}

// ---------------- the unified handle ----------------

// The one door bin/spor.js opens. `mode` follows the config unless forced
// (a remote box whose server does not serve the surface falls back to the
// local engine and STAMPS that on the claim, so a resume opens the same one).
function openExecutionStore(cfg, { home, mode = null, tenant = null, worker = null, machine = require("node:os").hostname(), instance = null, ttlMs = null, timeoutMs = null, pinRead = null, person = null, log = () => {}, remote = null, outboxLock = {} } = {}) {
  const resolvedMode = mode || (cfg && typeof cfg.mode === "function" ? cfg.mode() : "local");
  const cfgNum = (key, fallback) => {
    if (!cfg || typeof cfg.get !== "function") return fallback;
    const v = Number(cfg.get(key, fallback));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const ttl = clampTtl(ttlMs || cfgNum("execution.leaseTtlMs", DEFAULT_LEASE_TTL_MS));
  const timeout = timeoutMs || cfgNum("execution.timeoutMs", DEFAULT_TIMEOUT_MS);
  if (resolvedMode === "remote") {
    const rem = remote || require("../remote.js");
    const tn = tenant || (cfg && typeof cfg.tenant === "function" && cfg.tenant() && cfg.tenant().org) || "remote";
    const adapter = remoteExecutionAdapter(cfg, rem, { home, tenant: tn, machine, instance, timeoutMs: timeout, log, outboxLock });
    return withOwnershipCheck({ ...adapter, ttlMs: ttl, worker, machine, instance }, { scope: `${home}\0remote\0${adapter.tenant}` });
  }
  const engine = localExecutionEngine({ home, tenant: tenant || "local", worker: worker || "local", machine, instance, ttlMs: ttl, pinRead, person });
  return withOwnershipCheck({ ...engine, ttlMs: ttl, machine, instance }, { scope: `${home}\0local\0${engine.tenant}` });
}

// THE LOSS IS STICKY FOR THE LIFE OF THE PROCESS (issue-spor-execution-fence-
// shared-by-same-agent-processes, the merge gate's livelock finding). The
// kernel admits a DIFFERENT instance of the same (worker, machine) owner
// against a live lease and advances the fence — that is what lets a restarted
// process take over the execution its dead predecessor held. But two LIVE
// processes of one owner would then fence each other out every pass: A's write
// is refused `fence_stale`, A's next pass re-claims (advancing the fence past
// B), B's next write is refused, B re-claims... So once THIS instance is
// refused `fence_stale` on a fence it still believed current, the execution is
// recorded as handed to the other holder, and every later claim through any
// store this instance opens is refused locally, with no store traffic: the
// winner owns it, nothing is released or failed on its behalf. A RESTARTED
// process is a new instance with no loss record, so takeover after a crash is
// unchanged (the kernel rule is byte-identical with spor-server's).
// Keyed by instance so two simulated processes in one test runtime stay apart.
//
// The loss covers every door that could hand the fence back
// (issue-spor-execution-sticky-loss-gaps-open-and-outbox): a re-OPEN of the
// item names no execution id, but the kernel re-claims a live execution of
// the same (worker, machine) for a different instance just as a claim does,
// so the loss is also recorded against the (item, factory) pair that opens
// it, and refused there until the lost execution is terminal (only then can
// an open address a NEW pipeline attempt). And what this instance still owed
// the server is dropped with the loss (the remote adapter's forfeit), so the
// winner — who shares this box's outbox directory — never replays it.
const FENCED_OUT = new Map(); // `${instance}\0${id}` -> the fence this instance lost
const HELD_FENCE = new Map(); // `${instance}\0${id}` -> the highest fence this instance acquired
const ACQUIRED_AT = new Map(); // `${instance}\0${id}` -> epoch ms just AFTER the grant of that fence
const ITEM_OF = new Map(); // `${instance}\0${id}` -> `${node_id}\0${factory}` the execution opens under
const LOST_ITEM = new Map(); // `${instance}\0${scope}\0${node_id}\0${factory}` -> {id, fence} lost there
const fenceKey = (instance, id) => `${instance == null ? "" : String(instance)}\0${String(id)}`;
const itemKey = (execution) => (execution && execution.item && execution.item.node_id && execution.factory && execution.factory.node_id ? `${execution.item.node_id}\0${execution.factory.node_id}` : null);

// Has the process instance `instance` lost execution `id` to another holder?
// (The fence it lost at, or null.)
function fencedOut(instance, id) {
  if (instance == null) return null;
  const k = fenceKey(instance, id);
  return FENCED_OUT.has(k) ? FENCED_OUT.get(k) : null;
}

// `confirmOwnership(id, fence)`: the check the completion write runs before
// its resolving edge (§8 rule 3). Everything owed is flushed first — a
// resolver written while gate verdicts are still spooled would be refused by
// the server's boundary gate anyway — then the lease is RENEWED under the
// fence, and only an `ok` confirms. A transport failure is "cannot confirm",
// never "probably still mine".
//
// An instance-LESS store (a legacy caller, the person's force-release door)
// names no process, so it records no loss and refuses nothing.
// `scope` names the store (home, mode, partition) an item key is opened in.
function withOwnershipCheck(raw, { scope = "" } = {}) {
  const tracked = raw.instance != null;
  const key = (id) => fenceKey(raw.instance, id);
  const lostItemKey = (pair) => `${String(raw.instance)}\0${scope}\0${pair}`;
  const handedOff = (id, fence) => ({ ok: false, code: "fence_stale", ownership: false, handed_off: true, holder: null, message: `this process lost execution ${id} at fence ${fence} to another holder and never re-claims it (a restarted process may take it over)` });
  // The grant is stamped AFTER the answer arrives, never before the request:
  // a predecessor's event queued while the request was in flight was still
  // written under a live fence, and must not be dated past the takeover. The
  // stamp also lands in the store's durable takeover ledger (noteAcquired),
  // so a later process can date THIS fence's loss after this one is gone.
  const acquired = async (id, r) => {
    if (tracked && r && id != null) {
      const k = key(id);
      const pair = itemKey(r.execution);
      if (pair) ITEM_OF.set(k, pair);
      if (r.ok && r.fence != null && !(HELD_FENCE.get(k) >= Number(r.fence))) {
        const at = Date.now();
        HELD_FENCE.set(k, Number(r.fence));
        ACQUIRED_AT.set(k, at);
        if (typeof raw.noteAcquired === "function") {
          try {
            raw.noteAcquired(id, Number(r.fence), at);
          } catch {
            /* best effort — an undated fence only ever withholds an adoption */
          }
        }
      }
    }
    return r;
  };
  // A `fence_stale` refusal of a fence OLDER than one this instance has since
  // acquired is our own superseded reporter, not a loss to someone else.
  const watch = async (id, fence, r) => {
    if (tracked && r && !r.ok && r.code === "fence_stale" && fence != null && !(Number(fence) < (HELD_FENCE.get(key(id)) ?? -Infinity))) {
      FENCED_OUT.set(key(id), Number(fence));
      let pair = ITEM_OF.get(key(id)) || null;
      if (!pair) {
        try {
          const cur = await raw.get(id);
          pair = itemKey(cur && cur.execution);
        } catch {
          pair = null;
        }
      }
      if (pair) LOST_ITEM.set(lostItemKey(pair), { id: String(id), fence: Number(fence) });
      if (typeof raw.forfeit === "function") {
        try {
          await raw.forfeit(id);
        } catch {
          /* best effort — the loss itself is recorded */
        }
      }
    }
    return r;
  };
  const store = {
    ...raw,
    open: async (args = {}) => {
      const pair = tracked && args.node_id && args.factory ? `${args.node_id}\0${args.factory}` : null;
      const lost = pair ? LOST_ITEM.get(lostItemKey(pair)) : null;
      if (lost) {
        let cur = null;
        try {
          cur = await raw.get(lost.id);
        } catch {
          cur = null;
        }
        if (!(cur && cur.ok && cur.execution && kernel.isTerminal(cur.execution))) return handedOff(lost.id, lost.fence);
      }
      const r = await raw.open(args);
      return acquired(r && r.execution && r.execution.execution_id, r);
    },
    claim: async (id, args) => {
      const lost = tracked ? fencedOut(raw.instance, id) : null;
      if (lost != null) return handedOff(id, lost);
      return acquired(id, await raw.claim(id, args));
    },
    renew: async (id, args = {}) => watch(id, args.fence, await raw.renew(id, args)),
    release: async (id, args = {}) => watch(id, args.fence, await raw.release(id, args)),
    event: async (id, args = {}) => watch(id, args.fence, await raw.event(id, args)),
    reconcile: async (id, args = {}) => watch(id, args.fence, await raw.reconcile(id, args)),
  };
  return {
    ...store,
    // The adapter binds the machine on every mutation; the worker principal
    // is the identity's (remote) or the engine's (local).
    open: (args) => store.open({ ...(store.machine != null && store.mode === "remote" ? { machine: store.machine } : {}), ...(args || {}) }),
    confirmOwnership: async (id, fence) => {
      const rec = await store.reconcile(id, { fence });
      if (!rec.ok) {
        return { ok: false, confirmed: false, reason: rec.ownership === false ? `ownership lost (${rec.code}: ${rec.message})` : `${rec.pending} event(s) still owed to the execution store (${rec.message || rec.code})`, ownership: rec.ownership !== false, pending: rec.pending, ...(rec.code ? { code: rec.code } : {}) };
      }
      const r = await store.renew(id, { fence, ttl_ms: store.ttlMs });
      if (r.ok) return { ok: true, confirmed: true, execution: r.execution, fence: r.fence };
      return { ok: false, confirmed: false, reason: `${r.code}: ${r.message}`, ownership: r.ownership !== false && !OWNERSHIP_LOST.has(r.code) && r.code !== "execution_terminal" && r.code !== "not_found", holder: r.holder || null, code: r.code, transport: !!r.transport };
    },
    // End an execution that will produce nothing further under this pipeline
    // (a hold refused after the open, a person's release, a withdrawn
    // completion): the pool-spent terminal is the one non-escalation door to
    // `refused`, which frees the item pointer so the next attempt — and the
    // server's resolving-edge gate — start fresh. Best effort.
    terminate: async (id, { fence, attempt = 1, outcome = "cancelled", reason = null } = {}) => {
      const observed = await store.event(id, { fence, event: { type: "stage.observed", attempt, state: "exhausted", outcome, ...(reason ? { reason } : {}) } });
      return observed.ok ? store.release(id, { fence }) : observed;
    },
  };
}

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  SEGMENT_RE,
  validSegment,
  sha256,
  clampTtl,
  executionsDir,
  recordPath,
  eventsPath,
  outboxPath,
  takeoverPath,
  itemPath,
  workflowJournalPath,
  readJsonl,
  appendJsonlLine,
  readWorkflowJournal,
  appendWorkflowEntry,
  openWorkflowJournal,
  openWorkflowJournalAt,
  readRecord,
  readEvents,
  seenKeys,
  readItem,
  openExecutionFor,
  tenants,
  listExecutions,
  writeRecord,
  appendEventLine,
  writeItemPointer,
  rebuildFromEvents,
  localExecutionEngine,
  remoteExecutionAdapter,
  openExecutionStore,
  fencedOut,
};
