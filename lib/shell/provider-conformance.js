// shell/provider-conformance.js — the ONE conformance suite every execution
// provider binding must pass (task-spor-execution-provider-conformance-suite,
// constrained-by dec-spor-work-execution-provider-contract). PROVIDERS.md is the
// contract; lib/kernel/provider-contract.js its schemas; this module drives a
// provider through the contract's behavioural promises — the ones a schema
// cannot see — against a scratch home.
//
// A PROVIDER here is anything with `request(msg) -> Promise<response>`, where
// both are the contract's envelopes (PROVIDERS.md §2). That is the shape every
// binding already has on the wire (the subprocess JSON-over-stdio binding sends
// one request line and reads one response line), so the runner drives a stdio
// provider, an HTTP one and an in-process object identically.
// `bindInProcess(impl)` turns an object of per-operation methods into one.
//
// Everything a scenario needs that the contract does NOT carry comes from a
// DRIVER the caller supplies beside the provider:
//
//   attempt(base, behavior) -> attempt spec. `base` is a valid spec the runner
//       derived from the provider's describe(); `behavior` is "complete" (runs
//       to `finished` with a candidate) or "hold" (keeps running until
//       cancelled). Default: `base`, unchanged — fine for "complete", but a
//       provider that cannot be told to hold skips nothing and fails the cancel
//       scenarios, which is the honest answer.
//   candidate(attempt) -> {commit, tree?} the attempt is expected to produce,
//       or null when the driver cannot know in advance (then the manifest is
//       only validated).
//   crash(handle) -> make the provider lose the environment (its host gone,
//       its heartbeat lapsed). Absent: the crash scenario is SKIPPED, reported.
//   environments() -> the number of live (unreleased) environments the
//       provider holds. Absent: the "one environment" halves of the
//       idempotency scenarios rest on the handle alone.
//   pollIntervalMs (0), maxPolls (200) -> how observe is polled.
//   requestTimeoutMs (30000) -> how long one request may go unanswered before
//       the scenario fails naming the op (a wedged provider must not hang the
//       suite; this is a failure, never a LostReply to reconcile).
//
// The worker-side halves the scenarios exercise — persist the key and request
// BEFORE the first send, hold-and-reconcile a lost reply, adopt a recorded
// handle across a restart — are the WORKER's own rules, not a copy of them:
// every scenario opens a real execution in the local execution store
// (lib/shell/execution-store.js) under its scratch home, and `submitHeld` /
// `adoptAttempt` drive `submitAttempt` (lib/shell/provider-attempts.js) over
// that execution record, exactly as `spor work` does
// (task-spor-work-derive-attempt-spec-on-dispatch). A restarted worker is a
// new store instance re-claiming the execution under an advanced fence. The
// one half the execution record has no event for yet — the collected
// manifest, persisted BEFORE release — is kept in an `AttemptJournal` file
// beside it (`collectThenRelease`). `stdioDriver` is
// the driver for any provider reached through the stdio binding
// (lib/shell/providers/stdio.js), which is how `spor provider check` runs it.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pc = require("../kernel/provider-contract");
const candidateKernel = require("../kernel/candidate");
const sat = require("../kernel/satisfiability");

class ConformanceFailure extends Error {
  constructor(scenario, message) {
    super(`provider conformance [${scenario}]: ${message}`);
    this.name = "ConformanceFailure";
    this.scenario = scenario;
  }
}

// A provider-side refusal, thrown by an in-process implementation and turned
// into an `ok: false` envelope by bindInProcess.
class ProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

// The request went out; the reply never came back (a timeout, a dropped
// connection). The worker does not know whether the provider acted on it.
class LostReply extends Error {
  constructor(op) {
    super(`the ${op} reply was lost`);
    this.name = "LostReply";
    this.op = op;
  }
}

// ------------------------------------------------------------------ binding

// impl: { describe(params), submit(params), ... } each returning a result (or a
// promise of one) or throwing ProviderError. Unknown ops answer
// unsupported_operation; a malformed request answers invalid_request.
function bindInProcess(impl) {
  return {
    async request(msg) {
      const id = msg && typeof msg.id === "string" && msg.id ? msg.id : "unknown";
      const fail = (code, message, retryable = false) => ({
        contract_version: pc.CONTRACT_VERSION,
        id,
        ok: false,
        error: { code, message, retryable },
      });
      if (!msg || msg.contract_version !== pc.CONTRACT_VERSION) {
        return fail("contract_version_unsupported", `this provider speaks contract_version ${pc.CONTRACT_VERSION}`);
      }
      const v = pc.validateRequest(msg);
      if (!v.ok) return fail("invalid_request", v.errors.join("; "));
      if (typeof impl[msg.op] !== "function") return fail("unsupported_operation", `${msg.op} is not implemented`);
      try {
        const result = await impl[msg.op](msg.params);
        return { contract_version: pc.CONTRACT_VERSION, id, ok: true, result };
      } catch (err) {
        if (err instanceof ProviderError) return fail(err.code, err.message, err.retryable);
        return fail("internal", String((err && err.message) || err));
      }
    },
  };
}

// ------------------------------------------------------------------ journal

// The suite's durable record of what an attempt's collect answered
// (`collected`) — the one worker-side fact the execution record carries no
// event for (the submit key, request and handle live on the record itself,
// written by provider-attempts.js). Each write is
// a temp file fsynced, renamed over the journal, and the directory fsynced, so
// a reader never sees a torn file and an acknowledged write survives a crash.
// It is deliberately unlocked: one worker instance writes one execution's
// journal at a time (a restarted instance takes over from a dead one), and a
// read-modify-write by two live writers would lose an update — the execution
// record's fence, not this file, is what decides which instance that is.
class AttemptJournal {
  constructor(file) {
    this.file = file;
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  }
  write(key, value) {
    const next = { ...this.read(), [key]: value };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    syncDir(path.dirname(this.file));
    return next;
  }
}

// Make a rename in `dir` durable. Best-effort: a directory cannot be opened
// for fsync on Windows, where the rename is already durable on return.
function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* not supported here */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// --------------------------------------------------------------- the client

// One conversation with a provider on behalf of one scenario: every response
// is checked against the envelope schema, the request id it echoes and the
// op's result schema, and every observe is checked against the state machine.
class Client {
  constructor(provider, scenario, { timeoutMs = 30000 } = {}) {
    this.provider = provider;
    this.scenario = scenario;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.sent = [];
    this.lastState = new Map();
  }
  fail(message) {
    return new ConformanceFailure(this.scenario, message);
  }
  async raw(op, params) {
    const msg = { contract_version: pc.CONTRACT_VERSION, id: `conf-${this.scenario}-${++this.seq}`, op, params };
    this.sent.push(msg);
    let res;
    let timer;
    const ms = this.timeoutMs;
    try {
      res = await Promise.race([
        this.provider.request(msg),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(this.fail(`${op} did not answer within ${ms}ms`)), ms);
        }),
      ]);
    } catch (err) {
      if (err instanceof LostReply || err instanceof ConformanceFailure) throw err;
      throw this.fail(`${op} threw instead of answering an envelope: ${(err && err.message) || err}`);
    } finally {
      clearTimeout(timer);
    }
    const v = pc.validateResponse(res, op);
    if (!v.ok) throw this.fail(`${op} answered an invalid response: ${v.errors.join("; ")}`);
    if (res.id !== msg.id) throw this.fail(`${op} answered id ${JSON.stringify(res.id)} for request ${JSON.stringify(msg.id)}`);
    return res;
  }
  // The op must succeed; its result is returned.
  async call(op, params) {
    const res = await this.raw(op, params);
    if (!res.ok) throw this.fail(`${op} refused: ${res.error.code}: ${res.error.message}`);
    if (op === "observe") this.noteState(params.handle, res.result.state);
    return res.result;
  }
  // The op must FAIL with `code`.
  async refused(op, params, code, why) {
    const res = await this.raw(op, params);
    if (res.ok) throw this.fail(`${why}: ${op} succeeded (${JSON.stringify(res.result)}), expected ${code}`);
    if (res.error.code !== code) throw this.fail(`${why}: ${op} answered ${res.error.code} (${res.error.message}), expected ${code}`);
    return res.error;
  }
  noteState(handle, state) {
    const key = handleKey(handle);
    const prev = this.lastState.get(key);
    if (prev && !pc.observeTransitionAllowed(prev, state)) {
      throw this.fail(`observe moved ${prev} -> ${state}, which the state machine does not allow (PROVIDERS.md §5)`);
    }
    this.lastState.set(key, state);
  }
  submits() {
    return this.sent.filter((m) => m.op === "submit");
  }
}

function handleKey(handle) {
  return `${handle.provider}\u0000${handle.id}`;
}

// --------------------------------------------------- worker-side disciplines

// One attempt's worker-side record: a REAL execution in the local execution
// store, held by one store instance under its fence, plus the file the
// collected manifest is persisted to. `submitting()`/`submitted()` read the
// execution record's provider row (EXECUTION-STATE.md §3/§5 `attempts[].
// provider`) — what a takeover worker would read.
class AttemptRecord {
  constructor({ store, executionId, fence, attempt = 1, file }) {
    this.store = store;
    this.executionId = executionId;
    this.fence = fence;
    this.attempt = attempt;
    this.collectedFile = new AttemptJournal(file);
  }
  async row() {
    const { providerRow } = require("./provider-attempts");
    const r = await this.store.get(this.executionId);
    return r && r.ok ? providerRow(r.execution, this.attempt) : null;
  }
  // What was persisted before the first send: {idempotency_key, request}, or null.
  async submitting() {
    const row = await this.row();
    return row ? { idempotency_key: row.idempotency_key, request: row.request } : null;
  }
  // The handle the record holds, or null.
  async submitted() {
    const row = await this.row();
    return row && row.handle != null ? { handle: row.handle, idempotency_key: row.idempotency_key } : null;
  }
  collected() {
    return this.collectedFile.read().collected || null;
  }
}

// A conformance Client as the provider CLIENT provider-attempts.js drives
// (its `submit` throws ProviderError for a refusal, anything else for a lost
// reply). A breach the suite detects mid-call (an invalid envelope, a wedged
// op) would otherwise read as a lost reply there and be HELD, so it is kept
// and rethrown by the caller once submitAttempt returns.
function attemptClient(client, providerId) {
  let breach = null;
  const call = async (op, params) => {
    let res;
    try {
      res = await client.raw(op, params);
    } catch (err) {
      if (err instanceof ConformanceFailure && !breach) breach = err;
      throw err;
    }
    if (!res.ok) throw new ProviderError(res.error.code, res.error.message, { retryable: !!res.error.retryable });
    if (op === "observe") client.noteState(params.handle, res.result.state);
    return res.result;
  };
  return {
    id: providerId,
    submit: (params) => call("submit", params),
    observe: (params) => call("observe", params),
    breach: () => breach,
  };
}

// One pass of the worker's submit door (provider-attempts.js submitAttempt)
// over the record: persist the key and request BEFORE the first send, ADOPT a
// recorded handle, RECONCILE a held one under the persisted key.
async function submitOnce(client, record, { key = null, request = null, providerId }) {
  const { submitAttempt } = require("./provider-attempts");
  const c = attemptClient(client, providerId);
  const r = await submitAttempt({ store: record.store, executionId: record.executionId, fence: record.fence, attempt: record.attempt, client: c, key, request });
  if (c.breach()) throw c.breach();
  if (r.refused) throw client.fail(`submit refused: ${r.reason}`);
  if (r.notPersisted || r.orphaned) throw new Error(`provider-conformance: ${r.reason}`);
  return r;
}

// Submit with the key and request persisted BEFORE the first send, and hold on
// a lost reply: re-send the PERSISTED request under the PERSISTED key — never a
// re-derived one — until a reply settles it (PROVIDERS.md §6). The handle is
// on the execution record before this returns. `attempts` bounds the
// reconcile; past it the attempt is still HELD (the throw says so), never
// failed and never resubmitted under a new key.
async function submitHeld(client, record, { attempt, idempotencyKey, providerId }, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const r = await submitOnce(client, record, i === 0 ? { key: idempotencyKey, request: { attempt }, providerId } : { providerId });
    if (r.ok) return { handle: r.handle, existing: r.existing, env: r.env, reconciled: r.reconciled };
  }
  throw new LostReply("submit");
}

// A restarted worker (a new store instance, an advanced fence) adopts what the
// execution record says the previous instance had: a recorded handle is
// adopted as is; a key that was persisted but never answered is reconciled
// first. Either way nothing is submitted under a key the new instance derived
// itself — submitAttempt re-sends only what the record holds.
async function adoptAttempt(client, record, { providerId, attempts = 3 } = {}) {
  if (!(await record.submitting())) return null;
  for (let i = 0; i < attempts; i++) {
    const r = await submitOnce(client, record, { providerId });
    if (r.ok) return { handle: r.handle, reconciled: !!r.reconciled, existing: r.existing };
  }
  throw new LostReply("submit");
}

// Collect, persist the manifest, and only then release (PROVIDERS.md §7):
// release may destroy the only copy of the environment's work.
async function collectThenRelease(client, record, handle) {
  const collected = await client.call("collect", { handle });
  record.collectedFile.write("collected", collected);
  const released = await client.call("release", { handle });
  return { collected, released };
}

// ------------------------------------------------------------- the matcher

// The matcher is the real one (`satisfiesAttempt`,
// lib/kernel/satisfiability.js) unless the caller passes another as `matcher`
// — a test that needs a deliberately permissive one, say. A matcher answers a
// boolean or {ok, reasons|missing}.
function matchVerdict(matcher, caps, attempt) {
  const r = matcher(caps, attempt);
  if (typeof r === "boolean") return { ok: r, missing: [] };
  return { ok: !!(r && r.ok), missing: (r && (r.missing || r.reasons)) || [] };
}

// -------------------------------------------------------------- the context

function hex(input, len = 40) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, len);
}

// Everything a scenario reads: the client, the provider's described
// capabilities, attempt minting, the journal home, polling.
class Ctx {
  constructor(provider, scenario, opts) {
    this.provider = provider;
    this.scenario = scenario;
    this.opts = opts;
    this.driver = opts.driver || {};
    this.matcher = opts.matcher || sat.satisfiesAttempt;
    this.client = this.newClient(provider);
    this.minted = 0;
    this._caps = null;
    this._providerId = null;
    this.records = new Map(); // execution id -> AttemptRecord
  }
  fail(message) {
    return new ConformanceFailure(this.scenario, message);
  }
  newClient(provider) {
    return new Client(provider, this.scenario, { timeoutMs: this.driver.requestTimeoutMs || 30000 });
  }
  async caps() {
    if (!this._caps) {
      const d = await this.client.call("describe", {});
      this._caps = d.capabilities;
      this._providerId = d.provider_id;
    }
    return this._caps;
  }
  async providerId() {
    await this.caps();
    return this._providerId;
  }
  // The scenario's scratch execution-store home.
  storeHome() {
    return path.join(this.opts.home, "provider-conformance", this.scenario);
  }
  // A store instance as one worker process (`instance`) sees it.
  engine(instance) {
    const { localExecutionEngine } = require("./execution-store");
    return localExecutionEngine({ home: this.storeHome(), tenant: "conformance", worker: "conf-worker", machine: "conformance", instance });
  }
  // OPEN (or, for a later instance, re-claim under an advanced fence) the
  // execution for `nodeId` and bind an AttemptRecord to it.
  async openRecord(nodeId, instance) {
    const store = this.engine(instance);
    const opened = await store.open({ node_id: nodeId, factory: "factory-conformance", gates: [] });
    if (!opened.ok || !Number.isInteger(opened.fence)) {
      throw new Error(`provider-conformance: the scratch execution store did not open ${nodeId} for ${instance}: ${opened.code || "?"}: ${opened.message || JSON.stringify(opened)}`);
    }
    const id = opened.execution.execution_id;
    const record = new AttemptRecord({
      store,
      executionId: id,
      fence: opened.fence,
      file: path.join(this.storeHome(), "collected", `${id}.json`),
    });
    this.records.set(id, record);
    return record;
  }
  // The record the minting instance holds for an attempt's execution.
  journal(executionId) {
    const r = this.records.get(executionId);
    if (!r) throw new Error(`provider-conformance: no execution ${executionId} was opened by this scenario`);
    return r;
  }
  // A RESTARTED worker: a new instance re-claims the attempt's execution
  // (the fence advances) and reads its record back from the store.
  async restart(attempt, instance) {
    return this.openRecord(attempt.node_id, instance);
  }
  // A fresh, valid attempt for `behavior`, satisfying the described
  // capabilities under the real matcher: it names a profile, the delivery
  // modes the provider offers (it carries no secrets, so any serves), no
  // optional lifecycle operation (cancel is a required op, never asked for),
  // and a repo the provider can check out — one it names, else (`*`) one with
  // a url to clone from — pinned to a full commit and a branch.
  // `instance`/`fence` model the claiming worker (§4.1).
  async attempt(behavior = "complete", { instance = "conf-worker-a" } = {}) {
    const caps = await this.caps();
    const n = ++this.minted;
    // A real execution per attempt (its own item, so one attempt row each),
    // claimed by `instance`: the id and fence are the store's, never minted here.
    const nodeId = `task-conformance-${this.scenario}-${n}`;
    const record = await this.openRecord(nodeId, instance);
    const exec = record.executionId;
    const fence = record.fence;
    const maxMs = Number.isInteger(caps.max_deadline_ms) ? caps.max_deadline_ms : 30 * 60 * 1000;
    const offeredRepos = Array.isArray(caps.repos) ? caps.repos : [];
    // A slug the attempt schema accepts; a provider offering only unusable
    // ones is then refused by the matcher (naming repos), not blamed on the driver.
    const slug = offeredRepos.find((r) => typeof r === "string" && /^[a-z0-9][a-z0-9-]*$/.test(r)) || "conformance";
    const repo = { slug, commit: hex(`repo\u0000${exec}`), branch: `spor/task-conformance-${this.scenario}` };
    if (!offeredRepos.includes(slug) && offeredRepos.includes("*")) repo.url = `https://conformance.spor.invalid/${slug}.git`;
    // A profile the provider does not deny: a provider that opts out of
    // `profile-conformance` is still offered an attempt it can accept.
    const denied = new Set(Array.isArray(caps.deny) ? caps.deny : []);
    let profile = "profile-conformance";
    for (let i = 2; denied.has(profile); i++) profile = `profile-conformance-${i}`;
    const base = {
      contract_version: pc.CONTRACT_VERSION,
      attempt_id: `${instance}:${fence}`,
      execution_id: exec,
      fence,
      tenant: "conformance",
      node_id: nodeId,
      profile,
      harness: { id: (caps.harnesses && caps.harnesses[0]) || "claude-code" },
      mcp: [],
      skills: [],
      plugins: [],
      tools: [],
      repos: [repo],
      egress: { allow: [] },
      secrets: [],
      secret_delivery: [...(caps.secret_delivery || [])],
      lifecycle: [],
      spor: { server: "https://spor.invalid", token_ref: `spor-attempt-token://${exec}/${fence}` },
      deadline: new Date(Date.now() + Math.min(maxMs, 30 * 60 * 1000)).toISOString(),
      isolation: caps.isolation[0],
      prompt_bundle_ref: `https://conformance.spor.invalid/${exec}/prompt.tar`,
    };
    const attempt = this.driver.attempt ? this.driver.attempt(base, behavior) : base;
    const v = pc.validate("attempt-spec", attempt);
    if (!v.ok) throw new Error(`provider-conformance: the driver's ${behavior} attempt is not a valid attempt spec: ${v.errors.join("; ")}`);
    return attempt;
  }
  keyFor(attempt) {
    return `${attempt.execution_id}/${attempt.fence}/${attempt.attempt_id}`;
  }
  async environments() {
    return this.driver.environments ? this.driver.environments() : null;
  }
  async sleep() {
    const ms = this.driver.pollIntervalMs || 0;
    await new Promise((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));
  }
  // Poll observe until `want(state)` holds; every state seen is checked
  // against the state machine, and a terminal state that is not wanted fails.
  async pollUntil(handle, want, label) {
    const max = this.driver.maxPolls || 200;
    let last = null;
    for (let i = 0; i < max; i++) {
      last = await this.client.call("observe", { handle });
      if (want(last.state)) return last;
      if (pc.TERMINAL_OBSERVE_STATES.includes(last.state)) {
        throw this.fail(`waiting for ${label}, the environment settled ${last.state} instead${last.detail ? ` (${last.detail})` : ""}`);
      }
      await this.sleep();
    }
    throw this.fail(`waiting for ${label}, still ${last && last.state} after ${max} observes`);
  }
  async submitted(behavior) {
    const attempt = await this.attempt(behavior);
    const journal = this.journal(attempt.execution_id);
    const result = await submitHeld(this.client, journal, { attempt, idempotencyKey: this.keyFor(attempt), providerId: await this.providerId() });
    return { attempt, journal, handle: result.handle, result };
  }
  // Best-effort teardown so one scenario's environment does not leak into the
  // next one's environment count.
  async cleanup(handle) {
    if (!handle) return;
    try {
      await this.client.raw("release", { handle });
    } catch {
      /* the scenario's own verdict stands */
    }
  }
}

function sameHandle(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A collected manifest is judged as a FOREIGN candidate: the worker did not
// mint it. The manifest schema already refuses any file:// locator (it must be
// fetchable off the environment), so `foreign` is the second lock on the same
// door: should that rule ever relax, a file:// reference here still needs a
// declared store, and the suite declares none.
function checkManifest(ctx, manifest, attempt) {
  if (manifest.attempt_id !== attempt.attempt_id || manifest.execution_id !== attempt.execution_id || manifest.fence !== attempt.fence) {
    throw ctx.fail(
      `manifest names attempt ${manifest.attempt_id}/${manifest.execution_id}/${manifest.fence}, ` +
        `but the attempt submitted was ${attempt.attempt_id}/${attempt.execution_id}/${attempt.fence}`,
    );
  }
  const slugs = (attempt.repos || []).map((r) => r.slug);
  if (!slugs.includes(manifest.candidate.repo)) {
    throw ctx.fail(`manifest candidate repo ${JSON.stringify(manifest.candidate.repo)} is not a repo the attempt named (${slugs.join(", ")})`);
  }
  const why = candidateKernel.referenceRefusal(manifest.candidate.reference, { foreign: true });
  if (why) throw ctx.fail(`manifest candidate reference refused: ${why}`);
  const expected = ctx.driver.candidate ? ctx.driver.candidate(attempt) : null;
  if (expected) {
    if (manifest.candidate.commit !== expected.commit) {
      throw ctx.fail(`manifest candidate commit ${manifest.candidate.commit} is not the ${expected.commit} the attempt produced`);
    }
    if (expected.tree && manifest.candidate.tree !== expected.tree) {
      throw ctx.fail(`manifest candidate tree ${manifest.candidate.tree} is not the ${expected.tree} the attempt produced`);
    }
  }
}

// ------------------------------------------------------------- the scenarios

const SCENARIOS = [
  {
    name: "describe",
    title: "describe answers a valid capability set for contract_version 1",
    async run(ctx) {
      const r = await ctx.client.call("describe", {});
      if (r.contract_version !== pc.CONTRACT_VERSION) throw ctx.fail(`describe reports contract_version ${r.contract_version}`);
      ctx._caps = r.capabilities;
    },
  },
  {
    name: "idempotent-submit",
    title: "two submits under one idempotency key yield one handle and one environment; a different attempt under it is a conflict",
    async run(ctx) {
      const attempt = await ctx.attempt("complete");
      const key = ctx.keyFor(attempt);
      const before = await ctx.environments();
      const first = await ctx.client.call("submit", { attempt, idempotency_key: key });
      try {
        const second = await ctx.client.call("submit", { attempt, idempotency_key: key });
        if (!sameHandle(first.handle, second.handle)) {
          throw ctx.fail(`a second submit under the same idempotency key returned a different handle (${JSON.stringify(first.handle)} then ${JSON.stringify(second.handle)}) — a re-send must return the SAME environment`);
        }
        if (second.existing !== true) throw ctx.fail("a re-submit under an accepted key must answer existing: true");
        if (first.existing === true) throw ctx.fail("the first submit under a fresh key answered existing: true");
        const after = await ctx.environments();
        if (before !== null && after - before !== 1) {
          throw ctx.fail(`two submits under one key left ${after - before} new environments, expected exactly 1`);
        }
        const other = { ...attempt, attempt_id: `${attempt.attempt_id}-other` };
        await ctx.client.refused("submit", { attempt: other, idempotency_key: key }, "idempotency_conflict", "a different attempt under an accepted key");
      } finally {
        await ctx.cleanup(first.handle);
      }
    },
  },
  {
    name: "lost-submit-reply",
    title: "a submit whose reply is lost is held and reconciled under the persisted key, never resubmitted under a new one",
    async run(ctx, provider) {
      let dropped = false;
      let persistedAtSend = null;
      const attempt = await ctx.attempt("complete");
      const journal = ctx.journal(attempt.execution_id);
      const lossy = {
        async request(msg) {
          if (msg.op === "submit" && persistedAtSend === null) persistedAtSend = (await journal.submitting()) || false;
          const res = await provider.request(msg);
          if (msg.op === "submit" && !dropped) {
            dropped = true;
            throw new LostReply("submit");
          }
          return res;
        },
      };
      ctx.client.provider = lossy;
      const before = await ctx.environments();
      const key = ctx.keyFor(attempt);
      const result = await submitHeld(ctx.client, journal, { attempt, idempotencyKey: key, providerId: await ctx.providerId() });
      try {
        if (!persistedAtSend || persistedAtSend.idempotency_key !== key) {
          throw ctx.fail("the idempotency key and request were not persisted before the first submit was sent");
        }
        const sends = ctx.client.submits();
        if (sends.length !== 2) throw ctx.fail(`expected the lost submit plus one reconcile, saw ${sends.length} submits`);
        if (JSON.stringify(sends[0].params) !== JSON.stringify(sends[1].params)) {
          throw ctx.fail("the reconcile re-sent a different request than the one persisted");
        }
        if (result.existing !== true) throw ctx.fail("the reconcile of a submit the provider had accepted must answer existing: true");
        const after = await ctx.environments();
        if (before !== null && after - before !== 1) throw ctx.fail(`a lost reply plus its reconcile left ${after - before} new environments, expected exactly 1`);
        const rec = await journal.submitted();
        if (!rec || !sameHandle(rec.handle, result.handle)) throw ctx.fail("the reconciled handle was not recorded on the execution record");
      } finally {
        await ctx.cleanup(result.handle);
      }
    },
  },
  {
    name: "observe-collect",
    title: "observe reaches finished and collect returns a manifest naming the attempt and its candidate",
    async run(ctx) {
      const { attempt, handle } = await ctx.submitted("complete");
      try {
        const done = await ctx.pollUntil(handle, (s) => s === "finished", "finished");
        if (!done.exit) throw ctx.fail("a finished observe must carry the harness exit");
        const collected = await ctx.client.call("collect", { handle });
        if (!collected.manifest) throw ctx.fail(`a completed attempt collected no manifest (${collected.no_candidate && collected.no_candidate.reason})`);
        checkManifest(ctx, collected.manifest, attempt);
        const again = await ctx.client.call("collect", { handle });
        if (JSON.stringify(again.manifest) !== JSON.stringify(collected.manifest)) {
          throw ctx.fail("collect is not stable before release — a second collect answered a different manifest");
        }
      } finally {
        await ctx.cleanup(handle);
      }
    },
  },
  {
    name: "manifest-before-release",
    title: "the result manifest is persisted before release, and survives it",
    async run(ctx, provider) {
      let atRelease;
      const { attempt, journal, handle } = await ctx.submitted("complete");
      ctx.client.provider = {
        async request(msg) {
          if (msg.op === "release" && atRelease === undefined) atRelease = journal.collected();
          return provider.request(msg);
        },
      };
      let collected;
      try {
        await ctx.pollUntil(handle, (s) => s === "finished", "finished");
        ({ collected } = await collectThenRelease(ctx.client, journal, handle));
      } catch (err) {
        await ctx.cleanup(handle);
        throw err;
      }
      if (!atRelease) throw ctx.fail("release was sent before the collected manifest was persisted");
      if (JSON.stringify(atRelease) !== JSON.stringify(collected)) throw ctx.fail("the persisted manifest is not the one collect answered");
      const survived = journal.collected();
      const v = pc.validate("collect-result", survived);
      if (!v.ok) throw ctx.fail(`the persisted manifest does not validate after release: ${v.errors.join("; ")}`);
      if (!survived.manifest) throw ctx.fail("the persisted collect carries no manifest");
      checkManifest(ctx, survived.manifest, attempt);
    },
  },
  {
    name: "cancel-graceful",
    title: "cancel without force moves to stopping and leaves a collect window",
    // cancel is a REQUIRED operation (PROVIDERS.md §3), so this runs whether or
    // not the provider lists it under lifecycle — only force-cancel is gated.
    async run(ctx) {
      const { handle } = await ctx.submitted("hold");
      try {
        await ctx.pollUntil(handle, (s) => s === "running", "running");
        const r = await ctx.client.call("cancel", { handle, force: false });
        if (r.state !== "stopping") throw ctx.fail(`a graceful cancel of a running environment answered ${r.state}, expected stopping (the collect window)`);
        ctx.client.noteState(handle, r.state);
        const collected = await ctx.client.call("collect", { handle });
        const v = pc.validate("collect-result", collected);
        if (!v.ok) throw ctx.fail(`collect inside the window answered an invalid result: ${v.errors.join("; ")}`);
        const end = await ctx.pollUntil(handle, (s) => pc.TERMINAL_OBSERVE_STATES.includes(s), "a terminal state after cancel");
        if (end.state === "lost") throw ctx.fail("a gracefully cancelled environment settled lost");
      } finally {
        await ctx.cleanup(handle);
      }
    },
  },
  {
    name: "cancel-force",
    title: "cancel with force kills the environment outright — no stopping window",
    async run(ctx) {
      const caps = await ctx.caps();
      if (!caps.lifecycle.includes("force-cancel")) return { skipped: "the provider does not advertise lifecycle 'force-cancel'" };
      const { handle } = await ctx.submitted("hold");
      try {
        await ctx.pollUntil(handle, (s) => s === "running", "running");
        const r = await ctx.client.call("cancel", { handle, force: true });
        if (!pc.TERMINAL_OBSERVE_STATES.includes(r.state)) throw ctx.fail(`a forced cancel answered ${r.state}, expected a terminal state`);
        ctx.client.noteState(handle, r.state);
        const o = await ctx.client.call("observe", { handle });
        if (o.state !== r.state) throw ctx.fail(`after a forced cancel answered ${r.state}, observe reports ${o.state}`);
      } finally {
        await ctx.cleanup(handle);
      }
    },
  },
  {
    name: "release-idempotent",
    title: "release is idempotent: releasing a released handle succeeds",
    async run(ctx) {
      const before = await ctx.environments();
      const { journal, handle } = await ctx.submitted("complete");
      await ctx.pollUntil(handle, (s) => s === "finished", "finished");
      await collectThenRelease(ctx.client, journal, handle);
      await ctx.client.call("release", { handle });
      const after = await ctx.environments();
      if (before !== null && after !== before) throw ctx.fail(`after release ${after - before} environments remain`);
    },
  },
  {
    name: "crash-lost",
    title: "a provider crash mid-attempt surfaces lost",
    async run(ctx) {
      if (!ctx.driver.crash) return { skipped: "the driver has no crash() hook" };
      const { handle } = await ctx.submitted("hold");
      try {
        await ctx.pollUntil(handle, (s) => s === "running", "running");
        await ctx.driver.crash(handle);
        await ctx.pollUntil(handle, (s) => s === "lost", "a crashed environment to surface lost");
      } finally {
        await ctx.cleanup(handle);
      }
    },
  },
  {
    name: "refuse-unsatisfiable",
    title: "an attempt the described capabilities do not satisfy is refused by the matcher before any submit",
    async run(ctx) {
      const caps = await ctx.caps();
      const ok = await ctx.attempt("complete");
      const base = matchVerdict(ctx.matcher, caps, ok);
      if (!base.ok) throw ctx.fail(`the matcher refuses even the attempt derived from describe(): ${base.missing.join(", ")}`);
      const unoffered = pc.ISOLATION_KINDS.find((k) => !caps.isolation.includes(k));
      const bad = unoffered
        ? { ...ok, isolation: unoffered }
        : { ...ok, tools: [...ok.tools, "spor-conformance-absent-tool"] };
      const verdict = matchVerdict(ctx.matcher, caps, bad);
      if (verdict.ok) throw ctx.fail(`the matcher accepted an attempt asking for ${unoffered ? `isolation ${unoffered}` : "an absent tool"} the provider does not offer`);
      const sent = await submitMatched(ctx.client, ctx.matcher, caps, ctx.journal(bad.execution_id), bad, ctx.keyFor(bad), await ctx.providerId());
      if (sent.submitted) throw ctx.fail("an unsatisfiable attempt was submitted");
      if (ctx.client.submits().length) throw ctx.fail("a submit reached the provider for an attempt the matcher refused");
    },
  },
  {
    name: "adopt-new-instance",
    title: "a restarted worker adopts by the persisted request; attempt_id stays the submitting instance's",
    async run(ctx, provider) {
      // Instance A submits; its reply is lost and it dies holding.
      const attempt = await ctx.attempt("complete", { instance: "conf-worker-a" });
      const key = ctx.keyFor(attempt);
      const journal = ctx.journal(attempt.execution_id);
      const providerId = await ctx.providerId();
      let dropped = false;
      ctx.client.provider = {
        async request(msg) {
          const res = await provider.request(msg);
          if (msg.op === "submit" && !dropped) {
            dropped = true;
            throw new LostReply("submit");
          }
          return res;
        },
      };
      const held = await submitOnce(ctx.client, journal, { key, request: { attempt }, providerId });
      if (held.ok || !held.held) throw ctx.fail(`a lost submit reply was not held (${JSON.stringify(held)})`);
      // Instance B: a new client, a new store instance re-claiming the
      // execution under an advanced fence, the record read back from the store.
      const b = ctx.newClient(provider);
      const recordB = await ctx.restart(attempt, "conf-worker-b");
      if (!(recordB.fence > attempt.fence)) throw new Error(`provider-conformance: the restarted instance did not advance the fence (${attempt.fence} -> ${recordB.fence})`);
      const reDerived = { ...attempt, attempt_id: `conf-worker-b:${recordB.fence}`, fence: recordB.fence, spor: { ...attempt.spor, token_ref: `spor-attempt-token://${attempt.execution_id}/${recordB.fence}` } };
      await b.refused("submit", { attempt: reDerived, idempotency_key: key }, "idempotency_conflict", "a restarted instance re-deriving the attempt under the persisted key");
      const adopted = await adoptAttempt(b, recordB, { providerId });
      if (!adopted || !adopted.reconciled) throw ctx.fail("the restarted instance did not reconcile the held submit");
      if (adopted.existing !== true) throw ctx.fail("the reconcile under the persisted key did not return the existing environment");
      const rec = await recordB.submitting();
      if (!rec || rec.request.attempt.attempt_id !== attempt.attempt_id) throw ctx.fail("the execution record does not hold the submitting instance's request");
      const handle = adopted.handle;
      try {
        // A second restart (instance C) finds the handle recorded and adopts
        // it without any submit at all.
        const c = ctx.newClient(provider);
        const again = await adoptAttempt(c, await ctx.restart(attempt, "conf-worker-c"), { providerId });
        if (again.reconciled || !sameHandle(again.handle, handle)) throw ctx.fail("a recorded handle was not adopted as is");
        if (c.submits().length) throw ctx.fail("adopting a recorded handle sent a submit");
        await ctx.pollUntil(handle, (s) => s === "finished", "finished");
        const collected = await c.call("collect", { handle });
        if (!collected.manifest) throw ctx.fail("the adopted attempt collected no manifest");
        // Pinned (PROVIDERS.md §4.1/§6): attempt_id is the SUBMITTING
        // instance's, carried by the environment across the restart — not the
        // adopter's.
        checkManifest(ctx, collected.manifest, attempt);
      } finally {
        await ctx.cleanup(handle);
      }
    },
  },
];

// The submit door the worker takes: the matcher runs over the described
// capabilities FIRST, and a refused attempt is never sent (the assignment is
// left intact; nothing is substituted). Returns {submitted, verdict, result?}.
async function submitMatched(client, matcher, caps, journal, attempt, idempotencyKey, providerId) {
  const verdict = matchVerdict(matcher, caps, attempt);
  if (!verdict.ok) return { submitted: false, verdict };
  const result = await submitHeld(client, journal, { attempt, idempotencyKey, providerId });
  return { submitted: true, verdict, result };
}

// The DRIVER for a provider reached through the stdio binding
// (lib/shell/providers/stdio.js, PROVIDERS.md §12) — what `spor provider check`
// runs any declared provider under. Nothing here is provider-specific, so the
// conventions are the binding's, documented in §12.5: a "hold" attempt names a
// `/hold/` segment in its prompt_bundle_ref, every repo carries a url (so a
// provider offering `repos: ["*"]` can match), and `crash` kills the provider
// PROCESS — which makes crash-lost a check of the binding's lost-on-crash
// semantics for every provider. No candidate is predicted and no environment
// is counted: the manifest is validated, the idempotency halves rest on the
// handle. Polls are paced so one request's timeout bounds the whole wait.
function stdioDriver(binding, { timeoutMs = 30000 } = {}) {
  return {
    attempt: (base, behavior) => ({
      ...base,
      repos: base.repos.map((r) => ({ ...r, url: r.url || `https://conformance.spor.invalid/${r.slug}.git` })),
      prompt_bundle_ref: `https://conformance.spor.invalid/${behavior}/${base.execution_id}/prompt.tar`,
    }),
    crash: () => binding.crash(),
    pollIntervalMs: 100,
    maxPolls: Math.max(50, Math.ceil(timeoutMs / 100)),
    requestTimeoutMs: timeoutMs + 1000,
  };
}

// Run one scenario by name. Throws ConformanceFailure (naming the scenario)
// on a breach; returns {skipped?}.
async function runScenario(provider, name, opts = {}) {
  if (!opts.home) throw new Error("provider-conformance: opts.home (a scratch directory) is required");
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`provider-conformance: unknown scenario ${name}`);
  const ctx = new Ctx(provider, name, opts);
  try {
    return (await s.run(ctx, provider)) || {};
  } catch (err) {
    if (err instanceof ConformanceFailure) throw err;
    if (err instanceof LostReply) throw ctx.fail(`unhandled lost reply: ${err.message}`);
    throw err;
  }
}

// Run every scenario (or `opts.only`); never throws on a breach — the report
// carries one row per scenario: {name, title, ok, skipped?, error?}.
async function runConformance(provider, opts = {}) {
  const names = opts.only || SCENARIOS.map((s) => s.name);
  const results = [];
  for (const name of names) {
    const s = SCENARIOS.find((x) => x.name === name);
    try {
      const r = await runScenario(provider, name, opts);
      results.push({ name, title: s.title, ok: true, ...(r.skipped ? { skipped: r.skipped } : {}) });
    } catch (err) {
      results.push({ name, title: s ? s.title : name, ok: false, error: String((err && err.message) || err) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = {
  SCENARIOS,
  SCENARIO_NAMES: Object.freeze(SCENARIOS.map((s) => s.name)),
  runConformance,
  runScenario,
  bindInProcess,
  submitHeld,
  adoptAttempt,
  AttemptRecord,
  collectThenRelease,
  submitMatched,
  stdioDriver,
  AttemptJournal,
  ConformanceFailure,
  ProviderError,
  LostReply,
};
