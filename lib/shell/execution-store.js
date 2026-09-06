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
//   journal/executions/<tenant>/item/<node_id>.json     { open, executions[] } (local)
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

// The server's own lease bounds (server/executions.js), kept so a local
// execution is leased exactly as a hosted one.
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
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
function outboxPath(home, tenant, id) {
  return path.join(tenantDir(home, tenant), "exec", `${id}.outbox.jsonl`);
}
function itemPath(home, tenant, nodeId) {
  return path.join(tenantDir(home, tenant), "item", `${nodeId}.json`);
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
  const abs = eventsPath(home, tenant, id);
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
    fs.writeFileSync(fd, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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
      record = { ...record, owner: ev.owner ? { ...ev.owner } : null, updated_at: ev.at, ...(ev.released_at ? { released_at: ev.released_at } : {}) };
      continue;
    }
    const r = kernel.applyExecutionEvent(record, ev, { seen, historicalReplay: true });
    if (!r.ok) throw new Error(`execution ${id} cannot replay event ${ev.seq}: ${r.message}`);
    if (!r.replayed) {
      if (ev.seq !== r.seq) throw new Error(`execution ${id} has a non-contiguous event sequence`);
      record = r.record;
      seen.add(String(r.idempotency_key));
    }
  }
  return record;
}

// ---------------- the per-item critical section (in-process) ----------------

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

// ---------------- the LOCAL engine ----------------

// The personal-mode twin of server/executions.js over the store above: the
// same open/claim/renew/release/event doors with the same codes, the tenant
// fixed to `local`, the definition pinned by `pinRead` (a caller-supplied read
// of the local graph: `(nodeId) => {revision, repo} | null`), and the worker
// principal the caller names (this box's `dispatch.agent`, else the user).
function localExecutionEngine({ home, tenant = "local", worker = "local", machine = null, now = nowIso, ttlMs = DEFAULT_LEASE_TTL_MS, pinRead = null }) {
  const t = validSegment(tenant) ? tenant : "local";
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
    return withItemLock(`${t}/${nodeId}`, async () => {
      const at = now();
      const existing = openExecutionFor(home, t, nodeId);
      if (existing) {
        if (existing.factory.node_id !== factoryId) {
          return fail("execution_open", `item '${nodeId}' already has a live execution under factory '${existing.factory.node_id}'`, { execution: existing });
        }
        const mine = existing.owner && existing.owner.worker === worker && (existing.owner.machine ?? null) === (machine ?? null);
        return { ok: true, replayed: true, execution: kernel.decorate(existing), ...(mine ? { fence: existing.owner.fence } : {}) };
      }
      const ptr = readItem(home, t, nodeId);
      const pipelineAttempt = (ptr && Array.isArray(ptr.executions) ? ptr.executions.length : 0) + 1;
      const id = kernel.executionIdFor({ tenant: t, node_id: nodeId, factory: factoryId, pipeline_attempt: pipelineAttempt }, sha256);
      let opening = readRecord(home, t, id);
      if (opening) {
        // An initial open can crash after its log but before its view/pointer.
        // Recover the original pin before consulting today's graph definition.
        if (!opening.owner && !kernel.isTerminal(opening)) {
          const claimed = kernel.claim(opening, { worker, machine, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
          if (!claimed.ok) return claimed;
          opening = claimed.record;
          writeRecord(home, t, opening, ownershipEvent(opening, at, opening.owner));
        } else writeRecord(home, t, opening);
        writeItemPointer(home, t, nodeId, { open: kernel.isTerminal(opening) ? null : id, add: id });
        const mine = owns(opening);
        return { ok: true, replayed: true, execution: kernel.decorate(opening), ...(mine ? { fence: opening.owner.fence } : {}) };
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
      const claimed = kernel.claim(record, { worker, machine, lease_expires_at: expiryFrom(at, clampTtl(args.ttl_ms || ttlMs)), now: at });
      if (!claimed.ok) return claimed;
      record = claimed.record;
      appendEventLine(home, t, record.execution_id, { type: "execution.opened", execution_id: record.execution_id, seq: 0, at, spec });
      appendEventLine(home, t, record.execution_id, { type: "ownership.changed", execution_id: record.execution_id, seq: 0, at, owner: record.owner });
      writeRecord(home, t, record);
      writeItemPointer(home, t, nodeId, { open: record.execution_id, add: record.execution_id });
      return { ok: true, execution: kernel.decorate(record), fence: record.owner.fence };
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
    return withItemLock(`${t}/${peek.item.node_id}`, async () => {
      const record = readRecord(home, t, executionId);
      if (!record) return fail("not_found", `no such execution '${executionId}'`);
      return fn({ record, at: now() });
    }).catch((e) => fail("conflict", String(e.message || e)));
  }

  const owns = (record) => !!record.owner && record.owner.worker === worker && (record.owner.machine ?? null) === (machine ?? null);
  const ownershipRefusal = (record) => fail("already_owned", "execution belongs to another worker or machine", { holder: record.owner || null });
  const ownershipEvent = (record, at, owner) => ({ type: "ownership.changed", execution_id: record.execution_id, seq: record.seq, at, owner, ...(record.released_at ? { released_at: record.released_at } : {}) });

  return {
    mode: "local",
    tenant: t,
    worker,
    open,
    claim: (id, { takeover = false, ttl_ms = null } = {}) =>
      withExecution(id, async ({ record, at }) => {
        const r = kernel.claim(record, { worker, machine, lease_expires_at: expiryFrom(at, clampTtl(ttl_ms || ttlMs)), now: at, takeover: takeover === true });
        if (!r.ok) return r;
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, r.record.owner));
        return { ok: true, execution: kernel.decorate(r.record), fence: r.fence };
      }),
    renew: (id, { fence, ttl_ms = null } = {}) =>
      withExecution(id, async ({ record, at }) => {
        const r = kernel.renew(record, { fence, lease_expires_at: expiryFrom(at, clampTtl(ttl_ms || ttlMs)), now: at });
        if (!r.ok) return { ...r, holder: record.owner || null };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, r.record.owner));
        return { ok: true, execution: kernel.decorate(r.record), fence: r.fence };
      }),
    release: (id, { fence } = {}) =>
      withExecution(id, async ({ record, at }) => {
        if (record.released_at) return { ok: true, replayed: true, execution: kernel.decorate(record) };
        const r = kernel.release(record, { fence, now: at });
        if (!r.ok) return { ...r, holder: record.owner || null };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, ownershipEvent(r.record, at, null));
        if (kernel.isTerminal(r.record) && readItem(home, t, record.item.node_id)?.open === record.execution_id) writeItemPointer(home, t, record.item.node_id, { open: null, add: record.execution_id });
        return { ok: true, execution: kernel.decorate(r.record) };
      }),
    event: (id, { fence, event } = {}) =>
      withExecution(id, async ({ record, at }) => {
        const ev = { ...(event || {}) };
        ev.at = ev.at != null ? String(ev.at) : at;
        ev.fence = fence;
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
        if (r.replayed) return { ok: true, replayed: true, execution: kernel.decorate(record), idempotency_key: r.idempotency_key };
        if (!owns(record)) return ownershipRefusal(record);
        writeRecord(home, t, r.record, { ...ev, execution_id: record.execution_id, seq: r.seq, idempotency_key: r.idempotency_key });
        if (kernel.isTerminal(r.record) && readItem(home, t, record.item.node_id)?.open === record.execution_id) writeItemPointer(home, t, record.item.node_id, { open: null, add: record.execution_id });
        return { ok: true, execution: kernel.decorate(r.record), seq: r.seq, idempotency_key: r.idempotency_key };
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
      return { ok: true, execution: kernel.decorate(rec) };
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
// it), the caller is told ownership is gone, and nothing further is sent.
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
function remoteExecutionAdapter(cfg, remote, { home, tenant = "remote", machine = require("node:os").hostname(), timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
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
  const get = (p) => remote.get(cfg, p, { timeoutMs });

  // ---- the outbox ----
  const readOutbox = (id) => readJsonl(outboxPath(home, t, id), `execution outbox for ${id}`);
  const writeOutbox = (id, lines) => {
    const abs = outboxPath(home, t, id);
    if (!lines.length) {
      try {
        fs.rmSync(abs, { force: true });
      } catch {
        /* best effort */
      }
      return;
    }
    writeFileAtomic(abs, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mkdir: true });
  };
  const spool = (id, event) => {
    const abs = outboxPath(home, t, id);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fd = fs.openSync(abs, "a", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ event, queued_at: nowIso() })}\n`);
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

  // Replay what is owed, in order, stopping at the first thing that has to
  // wait. Returns {ok, replayed, pending, ownership?, code?}.
  async function reconcile(id, { fence } = {}) {
    let lines;
    try {
      lines = readOutbox(id);
    } catch (e) {
      return fail("outbox_unreadable", String((e && e.message) || e), { replayed: 0, pending: -1 });
    }
    let replayed = 0;
    while (lines.length) {
      const head = lines[0];
      const r = await send(id, fence, keyed(id, head.event));
      if (r.ok) {
        replayed += 1;
        lines.shift();
        writeOutbox(id, lines);
        continue;
      }
      if (r.klass === "rejected") {
        log(`execution ${id}: a spooled ${head.event && head.event.type} event was refused permanently by the server (${r.code}: ${r.message}) — dropped`);
        lines.shift();
        writeOutbox(id, lines);
        continue;
      }
      if (r.klass === "terminal") {
        log(`execution ${id}: the server reports it terminal (${r.message}); ${lines.length} spooled event(s) can no longer land — dropped`);
        writeOutbox(id, []);
        return { ok: true, replayed, pending: 0, terminal: true };
      }
      if (r.klass === "ownership") return { ok: false, replayed, pending: lines.length, ownership: false, code: r.code, message: r.message, holder: r.holder || null };
      return { ok: false, replayed, pending: lines.length, transient: true, code: r.code, message: r.message };
    }
    return { ok: true, replayed, pending: 0 };
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
      return answer(await post("/v1/executions", body));
    },
    claim: async (id, { takeover = false, ttl_ms = null, machine = null, worker = null } = {}) =>
      answer(await post(`/v1/executions/${encodeURIComponent(id)}/claim`, { ...(takeover ? { takeover: true } : {}), ...(ttl_ms != null ? { ttl_ms } : {}), ...(machine != null ? { machine } : {}), ...(worker != null ? { worker } : {}) })),
    renew: async (id, { fence, ttl_ms = null } = {}) => answer(await post(`/v1/executions/${encodeURIComponent(id)}/renew`, { fence, ...(ttl_ms != null ? { ttl_ms } : {}) })),
    release: async (id, { fence } = {}) => answer(await post(`/v1/executions/${encodeURIComponent(id)}/release`, { fence })),
    // OWE FIRST: the event is spooled before the attempt, and un-spooled only
    // once the server answered for it (recorded or replayed). An event that
    // cannot be delivered is then exactly what the next call replays, in order
    // and ahead of anything newer — the reducer's own ordering rules (a gate
    // cannot settle before its candidate, integration cannot start before the
    // gates) hold across the partition because nothing is sent out of order.
    event: async (id, { fence, event } = {}) => {
      const ev = keyed(id, event);
      try {
        spool(id, ev);
      } catch (e) {
        return fail("outbox_unwritable", `the execution outbox could not be written (${String((e && e.message) || e)})`);
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
    outbox: (id) => {
      try {
        return readOutbox(id);
      } catch {
        return [];
      }
    },
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
function openExecutionStore(cfg, { home, mode = null, tenant = null, worker = null, machine = require("node:os").hostname(), ttlMs = null, timeoutMs = null, pinRead = null, log = () => {}, remote = null } = {}) {
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
    const adapter = remoteExecutionAdapter(cfg, rem, { home, tenant: tn, machine, timeoutMs: timeout, log });
    return withOwnershipCheck({ ...adapter, ttlMs: ttl, worker, machine });
  }
  const engine = localExecutionEngine({ home, tenant: tenant || "local", worker: worker || "local", machine, ttlMs: ttl, pinRead });
  return withOwnershipCheck({ ...engine, ttlMs: ttl, machine });
}

// `confirmOwnership(id, fence)`: the check the completion write runs before
// its resolving edge (§8 rule 3). Everything owed is flushed first — a
// resolver written while gate verdicts are still spooled would be refused by
// the server's boundary gate anyway — then the lease is RENEWED under the
// fence, and only an `ok` confirms. A transport failure is "cannot confirm",
// never "probably still mine".
function withOwnershipCheck(store) {
  return {
    ...store,
    // The adapter binds the machine on every mutation; the worker principal
    // is the identity's (remote) or the engine's (local).
    open: (args) => store.open({ ...(store.machine != null && store.mode === "remote" ? { machine: store.machine } : {}), ...(args || {}) }),
    confirmOwnership: async (id, fence) => {
      const rec = await store.reconcile(id, { fence });
      if (!rec.ok) {
        return { ok: false, confirmed: false, reason: rec.ownership === false ? `ownership lost (${rec.code}: ${rec.message})` : `${rec.pending} event(s) still owed to the execution store (${rec.message || rec.code})`, ownership: rec.ownership !== false, pending: rec.pending };
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
  itemPath,
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
};
