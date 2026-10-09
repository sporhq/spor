"use strict";
// The worker half of PROGRAM RUN REQUESTS (task-spor-chatgpt-run-worker-adapter;
// spor-server PROGRAM-RUN-WORKER.md §2-§7, dec-spor-program-run-worker-bridge).
//
// A person pressing "Start" on a program leaves a durable, server-held run
// request: a program, an admitted cohort of its members and a factory pinned
// at Start. `spor work --serve program` (alias `--program-runs`) is the
// existing pull loop taking its work from ONE such run it owns. This module is
// the SOURCE half of that — the REST client over `/v1/program-runs` and the
// one-run state machine the loop consults once per pass. It never launches
// anything: every member still goes through the loop's one launch door
// (`deps.dispatch` → the dispatcher), so a later execution provider slots in
// behind that door without a second loop (dec-spor-work-execution-provider-
// contract). Nothing here is persisted: a restarted worker is a NEW process
// instance, re-claims the run at the next fence and reconciles its children
// from the server's run read plus the box's own run journal — nothing about a
// launch has to be re-derived from local state this module wrote.
//
// Three leases, three jobs (PROGRAM-RUN-WORKER.md §4). This module holds only
// the PARENT run lease, owned by (worker, machine, instance) — the worker from
// the credential, the machine from os.hostname(), the instance the loop's own
// per-process workerId. Its fence is checked at exactly one child door:
// ADMISSION, the execution open carrying `program_run {run_id, fence,
// instance}` (`binding()` below). After that each child is governed by its own
// execution fence and the task claim lease, exactly as without a run.
//
// Local never implies global (§7): every reason this worker stops or idles is
// a LOCAL reason, reported as an advisory `worker.observed` event and in the
// worker's own status — never a run state. Only the server ends a run
// (completed / drained / cancelled), and it says so on the renew.

const crypto = require("node:crypto");

// The server's vocabularies (spor-server server/program-run-protocol.ts),
// duplicated as data — the worker only ever SENDS a local reason and READS a
// state, and an unknown one is refused by the server rather than guessed at.
const LOCAL_REASONS = Object.freeze([
  "local.signal",
  "local.max",
  "local.once",
  "local.restart_on_land",
  "local.no_capable_member",
  "local.lease_lost",
  "local.factory_unreadable",
  "local.server_unreachable",
]);
const TERMINAL_RUN_STATES = new Set(["completed", "drained", "cancelled"]);
// A refusal that means THIS process no longer controls the run: another
// instance holds it, our fence was advanced past, or our lease lapsed.
const OWNERSHIP_CODES = new Set(["not_owned", "fence_stale", "lease_expired", "already_owned", "lease_live"]);
// An admission refusal that says the run is not admitting right now — the
// worker stops admitting for this pass and learns the new state on its next
// renew. Never a reason to cool the ITEM: the member is fine, the run paused.
const RUN_STATE_CODES = new Set(["run_paused", "run_draining", "run_terminal", "run_not_running", "factory_drift"]);
// The admission open's own refusals that concern the run (the open itself can
// also fail for ordinary execution reasons, which keep their existing path).
const ADMISSION_CODES = new Set([...OWNERSHIP_CODES, ...RUN_STATE_CODES, "not_admitted", "factory_mismatch"]);

// The `serve` sources `spor work` understands. Only `program` is built here;
// the queue and node scopes come later (task-spor-work-serve-source,
// task-spor-server-work-request-scopes) and are refused by name until then.
const SERVE_SCOPES = Object.freeze(["program"]);

// The capability advertisement rides the claim and is stored on the run's
// owner row; the server bounds it at 16KB. Kept well under so a box with a
// long skill/plugin list still claims (the advertisement is a description,
// never a contract — §3).
const MAX_ADVERTISEMENT_BYTES = 12 * 1024;

// The definition tuple a run pins (§6): the factory node's revision and each
// gate's (id, node_id, revision) — inline gates carry no node and no revision,
// exactly as the server's pinFactory spells them, so the two compare by value.
function pinTupleOf(factory) {
  if (!factory) return null;
  const defGates = (factory.definition && Array.isArray(factory.definition.gates) ? factory.definition.gates : []);
  const revOf = new Map(defGates.map((g) => [g.id, g.revision || null]));
  const factoryRevision = (factory.definition && factory.definition.factory && factory.definition.factory.revision) || factory.revision || null;
  return {
    factory_revision: factoryRevision == null ? null : String(factoryRevision),
    gates: (factory.gates || []).map((g) => {
      const ref = g.source && g.source !== "inline" ? String(g.source) : null;
      return { id: String(g.id), node_id: ref, revision: ref ? (revOf.get(g.id) || null) : null };
    }),
  };
}

// Normalize a server pin (which carries pinned_at/by/via and per-gate
// rejudge_on_repin) to the bare tuple, the server's own pinTuple.
function normalizeTuple(p) {
  if (!p) return null;
  return {
    factory_revision: p.factory_revision == null ? null : String(p.factory_revision),
    gates: (Array.isArray(p.gates) ? p.gates : []).map((g) => ({
      id: String(g && g.id),
      node_id: g && g.node_id != null ? String(g.node_id) : null,
      revision: g && g.revision != null ? String(g.revision) : null,
    })),
  };
}

function sameTuple(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(normalizeTuple(a)) === JSON.stringify(normalizeTuple(b));
}

function tupleDigest(t) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeTuple(t))).digest("hex").slice(0, 12);
}

// The run's CURRENT pin: the last entry of factory_pins (the initial pin is
// never rewritten; an adopt appends). The decorated read also echoes `pin`.
function currentPin(run) {
  if (!run) return null;
  if (run.pin) return run.pin;
  const pins = Array.isArray(run.factory_pins) ? run.factory_pins : [];
  return pins.length ? pins[pins.length - 1] : null;
}

// The members the worker may still ADMIT: the server's `remaining` (admitted
// and not done by graph truth) minus any member drain already released. The
// run read computes `remaining` from graph truth; the worker never decides a
// member is done itself.
function admittedRemaining(run) {
  if (!run) return new Set();
  const released = new Set((Array.isArray(run.released) ? run.released : []).map((r) => r && r.node_id).filter(Boolean));
  const remaining = Array.isArray(run.remaining) ? run.remaining : (Array.isArray(run.admitted) ? run.admitted.map((a) => a && a.node_id) : []);
  return new Set(remaining.filter((id) => id && !released.has(id)));
}

// Bound the advertisement: drop the long, descriptive lists first (skills,
// plugins), then the machine block, never the identity fields.
function boundAdvertisement(caps) {
  if (!caps || typeof caps !== "object") return null;
  const fits = (c) => JSON.stringify(c).length <= MAX_ADVERTISEMENT_BYTES;
  if (fits(caps)) return caps;
  const machine = caps.machine ? { ...caps.machine, skills: undefined, plugins: undefined, truncated: true } : undefined;
  let next = { ...caps, ...(machine ? { machine: JSON.parse(JSON.stringify(machine)) } : {}) };
  if (fits(next)) return next;
  next = { ...next, machine: { truncated: true } };
  if (fits(next)) return next;
  const { factory, concurrency, code } = caps;
  return { factory, concurrency, code, truncated: true };
}

// ---- the REST client ----

// Every call answers {ok, ...} — a refusal with the server's own code (and
// `holder`/`run` when the envelope carries them), a transport failure or 5xx
// as `transient`, and a front door with no such route as `unserved` (an older
// server), so the source can tell "the server said no" from "nobody answered".
function classify(res) {
  if (!res) return { ok: false, transient: true, code: "unreachable", message: "no response" };
  if (res.transport) return { ok: false, transient: true, code: "unreachable", message: res.error || "unreachable" };
  if (res.ok) return { ok: true, ...(res.json || {}) };
  const env = res.json && res.json.error;
  const code = env && env.code ? String(env.code) : null;
  const message = env && env.message ? String(env.message) : `HTTP ${res.status}`;
  if (res.status >= 500 && code !== "unavailable") return { ok: false, transient: true, status: res.status, code: code || "server_error", message };
  if (code === "unavailable") return { ok: false, unserved: true, status: res.status, code, message };
  if ((res.status === 404 || res.status === 405 || res.status === 501) && (!code || /no such route/i.test(message))) {
    return { ok: false, unserved: true, status: res.status, code: code || "not_served", message };
  }
  return {
    ok: false,
    status: res.status,
    code: code || `http_${res.status}`,
    message,
    ...(res.json && res.json.holder ? { holder: res.json.holder } : {}),
    ...(res.json && res.json.run ? { run: res.json.run } : {}),
  };
}

function createProgramRunClient(cfg, { remote, machine, instance, timeoutMs = 6000 } = {}) {
  if (!remote) throw new Error("createProgramRunClient: remote is required");
  const base = "/v1/program-runs";
  const runPath = (id, verb = "") => `${base}/${encodeURIComponent(id)}${verb ? `/${verb}` : ""}`;
  const owner = (body) => ({ machine, instance, ...body });
  const get = async (p) => classify(await remote.get(cfg, p, { timeoutMs }).catch((e) => ({ transport: true, error: e && e.message })));
  const post = async (p, body) => classify(await remote.post(cfg, p, body, { timeoutMs }).catch((e) => ({ transport: true, error: e && e.message })));
  return {
    machine,
    instance,
    listClaimable: (factoryId, { limit = 50 } = {}) => get(`${base}?claimable=true${factoryId ? `&factory=${encodeURIComponent(factoryId)}` : ""}&limit=${limit}`),
    get: (id) => get(runPath(id)),
    pinnedFactory: (id, { pin = "current" } = {}) => get(`${runPath(id, "factory")}?pin=${encodeURIComponent(pin)}`),
    claim: (id, { capabilities = null, ttl_ms = null } = {}) =>
      post(runPath(id, "claim"), owner({ ...(capabilities ? { capabilities } : {}), ...(ttl_ms != null ? { ttl_ms } : {}) })),
    renew: (id, { fence, ttl_ms = null } = {}) => post(runPath(id, "renew"), owner({ fence, ...(ttl_ms != null ? { ttl_ms } : {}) })),
    release: (id, { fence } = {}) => post(runPath(id, "release"), owner({ fence })),
    event: (id, { fence, event } = {}) => post(runPath(id, "events"), owner({ fence, event })),
  };
}

// ---- the one-run source ----

// The state machine the loop consults once per pass (`pass()`), holding at
// most ONE owned run (§2: one owned run per process; an operator wanting two
// runs in parallel runs two workers). Deps:
//   client        createProgramRunClient (or a fake with the same methods)
//   factoryId     the factory this worker is armed with; only runs pinned to
//                 it are claimed (the listing is filtered by it too)
//   capabilities  (run) -> the advertisement object for the claim
//   eligible      async (run) -> {ok, reason?, localReason?}: the LOCAL filter
//                 (§3) — the server never decides a machine can do work
//   cooldownMs    how long a run this worker refused, or gave up on as having
//                 no capable member here, is left for other machines
function createRunSource({ client, factoryId, capabilities = () => null, eligible = null, log = () => {}, now = () => Date.now(), cooldownMs = 10 * 60 * 1000, ttlMs = null } = {}) {
  if (!client) throw new Error("createRunSource: client is required");
  let owned = null; // {run_id, fence, run, unreachable, holdReason, lastLocal}
  let lastLocal = null; // {reason, detail, at} — the latest local reason, kept across ownership
  let listFailed = false;
  const cooling = new Map(); // run_id -> {until, reason}
  const drifted = new Set(); // `${run_id}:${fence}:${digest}` already reported
  const serverSawNone = new Set(); // same keys the SERVER re-read and found no drift for
  const said = new Set(); // one-shot log lines

  const sayOnce = (key, line) => {
    if (said.has(key)) return;
    said.add(key);
    log(line);
  };
  const noteLocal = (reason, detail = null) => {
    lastLocal = { reason, detail: detail ? String(detail).slice(0, 300) : null, at: new Date(now()).toISOString() };
  };
  const cool = (runId, reason) => {
    cooling.set(runId, { until: now() + cooldownMs, reason });
  };
  const isCooling = (runId) => {
    const c = cooling.get(runId);
    if (!c) return false;
    if (c.until > now()) return true;
    cooling.delete(runId);
    return false;
  };

  // Drop ownership WITHOUT a release: the server already took it away (or
  // ended the run), so a release would only be refused.
  const forget = (why) => {
    if (!owned) return;
    log(`work: program run ${owned.run_id} — ${why}`);
    owned = null;
  };

  // An ownership refusal on any fenced call: this process no longer controls
  // the run (a takeover after our lease lapsed, a stale fence). It keeps NO
  // authority over new children; its in-flight children keep their own
  // execution leases (§4) and are not touched here.
  const lost = (code, message) => {
    noteLocal("local.lease_lost", `${code}: ${message || ""}`);
    forget(`lost the run lease (${code}${message ? `: ${message}` : ""}) — no longer admitting its members; in-flight children keep their own execution leases`);
  };

  // Best-effort advisory event (§7): local reasons are never run state, and a
  // failure to report one changes nothing. Keyed per (instance, fence, reason)
  // so a retried report is a server-side replay, never a second event.
  async function observe(reason, detail = null) {
    if (!LOCAL_REASONS.includes(reason)) throw new Error(`unknown local reason '${reason}'`);
    noteLocal(reason, detail);
    if (!owned) return { ok: false, code: "not_owned" };
    const r = await client.event(owned.run_id, {
      fence: owned.fence,
      event: { type: "worker.observed", idempotency_key: `${client.instance}:${owned.fence}:${reason}`, local_reason: reason, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) },
    });
    if (!r.ok && OWNERSHIP_CODES.has(r.code)) lost(r.code, r.message);
    else if (!r.ok && r.code === "run_terminal") forget(`the server ended it (${r.message})`);
    return r;
  }

  // Release the parent lease (NOT terminal on the server: it only clears the
  // owner so another worker may claim at once, keeping the fence counter).
  // `reason` is the local reason reported first; a `local.no_capable_member`
  // release also cools the run here so this worker does not re-claim it on
  // its next pass.
  async function release(reason = null, detail = null) {
    if (!owned) return { ok: true, released: false };
    if (reason) await observe(reason, detail);
    if (!owned) return { ok: true, released: false };
    const id = owned.run_id;
    const r = await client.release(id, { fence: owned.fence });
    if (reason === "local.no_capable_member") cool(id, detail || "no capable member on this machine");
    log(`work: program run ${id} — released${reason ? ` (${reason}${detail ? `: ${detail}` : ""})` : ""}${r.ok ? "" : ` — the release was not confirmed (${r.code}: ${r.message}); the lease lapses on its own`}; the run keeps its global state`);
    owned = null;
    return { ...r, released: true };
  }

  async function renew() {
    const r = await client.renew(owned.run_id, { fence: owned.fence, ...(ttlMs ? { ttl_ms: ttlMs } : {}) });
    if (r.ok) {
      if (owned.unreachable) log(`work: program run ${owned.run_id} — the server answers again`);
      owned.unreachable = false;
      owned.run = r.run || owned.run;
      if (r.fence != null) owned.fence = r.fence;
      owned.holdReason = null;
      return;
    }
    if (r.code === "run_terminal") {
      const state = (r.run && r.run.state) || "terminal";
      forget(`the server ended the run (${state}) — back to polling for another`);
      return;
    }
    if (OWNERSHIP_CODES.has(r.code)) {
      lost(r.code, r.message);
      return;
    }
    if (r.code === "not_found") {
      forget(`the server no longer knows it (${r.message})`);
      return;
    }
    // Anything else — a transport failure, a 5xx, a store `conflict`, an
    // auth blip — keeps the claim (the lease is still ours until it lapses;
    // forgetting it would hide the run from every worker for a whole TTL)
    // but admits nothing: a child opened against a run whose state we cannot
    // read could land in a run that was paused or drained meanwhile.
    if (!owned.unreachable) log(`work: program run ${owned.run_id} — cannot renew (${r.code}: ${r.message}); admitting nothing until the server answers`);
    owned.unreachable = true;
    noteLocal("local.server_unreachable", `${r.code}: ${r.message}`);
  }

  async function acquire() {
    const r = await client.listClaimable(factoryId);
    if (!r.ok) {
      if (!listFailed) log(`work: cannot list claimable program runs (${r.code}: ${r.message}); polling again next pass`);
      listFailed = true;
      if (r.transient || r.unserved) noteLocal("local.server_unreachable", r.message);
      return;
    }
    if (listFailed) log("work: program run listing reads again");
    listFailed = false;
    const runs = Array.isArray(r.runs) ? r.runs : [];
    for (const run of runs) {
      if (!run || !run.run_id) continue;
      if (TERMINAL_RUN_STATES.has(run.state)) continue;
      if (factoryId && run.factory && run.factory.node_id !== factoryId) continue;
      if (isCooling(run.run_id)) continue;
      if (eligible) {
        let verdict;
        try {
          verdict = await eligible(run);
        } catch (e) {
          verdict = { ok: false, reason: `the local filter threw: ${e && e.message ? e.message : String(e)}` };
        }
        if (!verdict || !verdict.ok) {
          const why = (verdict && verdict.reason) || "not runnable here";
          cool(run.run_id, why);
          if (verdict && verdict.localReason) noteLocal(verdict.localReason, why);
          log(`work: not claiming program run ${run.run_id} (${run.program_id || "?"}) — ${why}`);
          continue;
        }
      }
      const caps = boundAdvertisement(capabilities(run));
      const c = await client.claim(run.run_id, { ...(caps ? { capabilities: caps } : {}), ...(ttlMs ? { ttl_ms: ttlMs } : {}) });
      if (c.ok) {
        owned = { run_id: run.run_id, fence: c.fence, run: c.run || run, unreachable: false, holdReason: null };
        log(`work: claimed program run ${run.run_id} for program ${owned.run.program_id || "?"} at fence ${c.fence} — ${admittedRemaining(owned.run).size} admitted member(s) remain; state ${owned.run.state}`);
        return;
      }
      if (OWNERSHIP_CODES.has(c.code)) {
        const h = c.holder;
        sayOnce(`held:${run.run_id}:${h ? `${h.worker}:${h.machine}:${h.instance}` : ""}`, `work: program run ${run.run_id} is controlled by ${h ? `${h.worker} on ${h.machine}` : "another worker"} — not claiming it`);
        continue;
      }
      if (c.transient || c.unserved) {
        log(`work: could not claim program run ${run.run_id} (${c.code}: ${c.message}); polling again next pass`);
        noteLocal("local.server_unreachable", c.message);
        return;
      }
      cool(run.run_id, `${c.code}: ${c.message}`);
      log(`work: claim of program run ${run.run_id} refused (${c.code}: ${c.message}) — leaving it`);
    }
  }

  // Once per loop pass: renew what we own (learning its state, admitted set
  // and any server-side end), else look for one to claim.
  async function pass() {
    if (owned) await renew();
    if (!owned) await acquire();
    return view();
  }

  // The `admitting` predicate (§7 rule 4): the run is `running`, this worker
  // can read it, and nothing local (drift seen on reload, an admission refusal
  // this pass) holds admissions back. It gates FRESH dispatch only — the
  // resume of parked pipelines, harvest and gates continue through pause and
  // drain so a run can reach `drained`.
  function admitting() {
    return !!(owned && owned.run && owned.run.state === "running" && !owned.unreachable && !owned.holdReason);
  }

  function view() {
    return {
      owned: !!owned,
      run: owned ? owned.run : null,
      run_id: owned ? owned.run_id : null,
      program_id: owned && owned.run ? owned.run.program_id || null : null,
      fence: owned ? owned.fence : null,
      admitting: admitting(),
      remaining: owned ? admittedRemaining(owned.run) : new Set(),
    };
  }

  // The admission binding the execution open carries (§5).
  function binding() {
    if (!owned) return null;
    return { run_id: owned.run_id, fence: owned.fence, instance: String(client.instance) };
  }

  // An admission open refused for a RUN reason (the open's other refusals
  // keep their ordinary path). Returns true when the code was the run's.
  function admissionRefused(code, message) {
    if (!owned || !ADMISSION_CODES.has(code)) return false;
    if (OWNERSHIP_CODES.has(code)) {
      lost(code, message);
      return true;
    }
    if (RUN_STATE_CODES.has(code)) {
      owned.holdReason = `${code}${message ? `: ${message}` : ""}`;
      log(`work: program run ${owned.run_id} is not admitting (${owned.holdReason}) — no fresh dispatch until the next renew reads it running`);
      return true;
    }
    return false; // not_admitted / factory_mismatch: the item's own refusal
  }

  // Factory drift (§6), detected early on the worker's per-pass reload: the
  // reloaded definition's tuple differs from the run's current pin. Reported
  // ONCE per (run, fence, target) as `drift.observed` — the server re-reads the
  // factory itself and pauses the run on drift it sees — and admissions stop
  // here immediately. Returns true when the tuple drifted.
  async function checkPin(tuple) {
    if (!owned) return false;
    const pin = currentPin(owned.run);
    const clearHold = () => {
      if (owned.holdReason && owned.holdReason.startsWith("factory_changed")) owned.holdReason = null;
    };
    if (!pin || !tuple || sameTuple(tuple, pin)) {
      clearHold();
      return false;
    }
    const key = `${owned.run_id}:${owned.fence}:${tupleDigest(tuple)}`;
    // The worker's word is a trigger, not evidence (§6): the server re-reads
    // the factory itself. Where it found NO drift, a local mismatch is this
    // client's reading of the tuple, and holding admissions on it would stall
    // a run nobody is ever asked to adopt — so the server's verdict wins.
    if (serverSawNone.has(key)) {
      clearHold();
      return false;
    }
    owned.holdReason = `factory_changed: ${String(pin.factory_revision || "?").slice(0, 12)} -> ${String(tuple.factory_revision || "?").slice(0, 12)}`;
    if (!drifted.has(key)) {
      drifted.add(key);
      log(`work: program run ${owned.run_id} — the factory changed since it was pinned (${owned.holdReason}); in-flight children finish on their own pins, and no new member is admitted until a person adopts the new definition`);
      const r = await client.event(owned.run_id, { fence: owned.fence, event: { type: "drift.observed", idempotency_key: `${client.instance}:${owned.fence}:drift:${tupleDigest(tuple)}` } });
      if (!r.ok && OWNERSHIP_CODES.has(r.code)) lost(r.code, r.message);
      else if (!r.ok && r.code === "run_terminal") forget(`the server ended it (${r.message})`);
      else if (!r.ok) drifted.delete(key); // retried on the next reload
      else {
        if (r.run) owned.run = r.run;
        // A REPLAYED report (the first reply was lost) carries no `drifted`
        // verdict; the run it returns does: the server pauses a running run on
        // drift it sees itself, so a run still `running` after our report
        // means it saw none.
        const sawNone = r.drifted === false || (r.drifted === undefined && !!r.run && r.run.state === "running");
        if (sawNone) {
          serverSawNone.add(key);
          log(`work: program run ${owned.run_id} — the server re-read the factory and sees NO drift from its pin; trusting it over this worker's own tuple reading (${owned.holdReason}) and admitting again`);
          clearHold();
          return false;
        }
      }
    }
    return !!owned && !!owned.holdReason;
  }

  // Hold admissions for this pass for a LOCAL reason (a definition this
  // worker cannot read right now); the next successful renew clears it and
  // the caller re-applies it if the reason still stands.
  function hold(reason) {
    if (owned) owned.holdReason = String(reason);
  }

  function status() {
    return {
      scope: "program",
      run_id: owned ? owned.run_id : null,
      program_id: owned && owned.run ? owned.run.program_id || null : null,
      state: owned && owned.run ? owned.run.state || null : null,
      fence: owned ? owned.fence : null,
      admitting: admitting(),
      ...(owned && owned.holdReason ? { holding: owned.holdReason } : {}),
      ...(owned && owned.run && owned.run.blocked ? { blocked: owned.run.blocked } : {}),
      remaining: owned ? admittedRemaining(owned.run).size : null,
      local_reason: lastLocal,
      cooling: [...cooling.entries()].filter(([, c]) => c.until > now()).map(([run_id, c]) => ({ run_id, reason: c.reason, until: new Date(c.until).toISOString() })),
    };
  }

  return { pass, view, admitting, binding, admissionRefused, checkPin, hold, observe, release, status, owned: () => (owned ? { ...owned } : null) };
}

// The run-scoped admitted set: every admitted member (done ones included, so
// the program standing can count them) minus any member drain released.
function admittedIds(run) {
  if (!run) return new Set();
  const released = new Set((Array.isArray(run.released) ? run.released : []).map((r) => r && r.node_id).filter(Boolean));
  const ids = Array.isArray(run.admitted) ? run.admitted.map((a) => (a && typeof a === "object" ? a.node_id : a)) : [...admittedRemaining(run)];
  return new Set(ids.filter((id) => id && !released.has(id)));
}

// Narrow a program snapshot (work-program.js) to an owned run's admitted
// cohort: candidates = queue eligibility ∩ program closure ∩ admitted cohort
// (∩ machine scope, which the loop's own selection applies). Mutates and
// returns the snapshot, like the loop's other program annotations.
function scopeSnapshotToRun(snap, run) {
  if (!snap || !Array.isArray(snap.members)) return snap;
  const admitted = admittedIds(run);
  snap.members = snap.members.filter((m) => m && admitted.has(m.id));
  return snap;
}

// The loop's launch door under a serve source: the SAME dispatch, carrying
// the run's admission binding, with the run's own refusals turned into
// `stopAdmitting` (the loop stops admitting this pass and does not cool the
// member — the member is fine, the run is not admitting). `dispatch(item,
// binding)` is the ordinary launch door; nothing here launches anything.
function admitThrough(source, dispatch) {
  return async (item) => {
    const binding = source.binding();
    if (!binding) return { ok: false, stopAdmitting: true, reason: "no program run is owned any more" };
    const res = await dispatch(item, binding);
    // Only the admission door's own refusal code (`admission_code`) is read
    // as the run's: an execution-level refusal about this one item keeps its
    // ordinary path, whatever code it happens to carry.
    if (res && !res.ok && res.admission_code && source.admissionRefused(res.admission_code, res.message)) return { ...res, stopAdmitting: true };
    return res;
  };
}

// The local stop reason a loop exit maps to (§7). A program-scoped stop code
// never arises in serve mode (the loop never concludes a run itself).
function localReasonForStop(stopCode, { max = false } = {}) {
  if (stopCode === "signal") return "local.signal";
  if (stopCode === "restart-on-land") return "local.restart_on_land";
  if (stopCode === "drained") return max ? "local.max" : "local.once";
  return null;
}

module.exports = {
  LOCAL_REASONS,
  TERMINAL_RUN_STATES,
  OWNERSHIP_CODES,
  RUN_STATE_CODES,
  ADMISSION_CODES,
  SERVE_SCOPES,
  MAX_ADVERTISEMENT_BYTES,
  pinTupleOf,
  normalizeTuple,
  sameTuple,
  currentPin,
  admittedRemaining,
  admittedIds,
  scopeSnapshotToRun,
  admitThrough,
  boundAdvertisement,
  classify,
  createProgramRunClient,
  createRunSource,
  localReasonForStop,
};
