// The provider attempt handle (task-spor-work-attempt-handle-adoption,
// PROVIDERS.md §6; the server half is task-spor-server-execution-attempt-
// handle). Three layers, each with its own oracle:
//   1. the kernel (lib/kernel/execution.js): `attempt.submitting/submitted/
//      observed` ported from the server's reducer — the same derived log keys,
//      the same conflict codes answered after terminal/fence, the same
//      `attempts[].provider` projection, and a record with no provider
//      attempts carrying no `provider` field (byte-identical);
//   2. the stores (lib/shell/execution-store.js): the local engine and the
//      remote adapter both carry the provider's key as
//      `submit_idempotency_key`, never as the log key, and a rebuild from the
//      journal reproduces the record;
//   3. the attempt driver (lib/shell/provider-attempts.js) against the
//      synthetic provider: persist-before-send, a SIGKILL between the submit
//      and the persist, a dropped reply held and reconciled under the
//      persisted key, adoption of a recorded handle, the observe relay, and
//      the orphan classification.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const kernel = require("../lib/kernel/execution.js");
const store = require("../lib/shell/execution-store.js");
const attempts = require("../lib/shell/provider-attempts.js");
const { LostReply, bindInProcess } = require("../lib/shell/provider-conformance.js");
const { createSyntheticImpl } = require("./fixtures/providers/synthetic.js");
const { loadConfig } = require("../lib/config.js");
const { startFakeExecutionServer } = require("./helpers/fake-execution-server.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const T0 = "2026-09-05T10:00:00.000Z";
const T1 = "2026-09-05T10:01:00.000Z";
const T2 = "2026-09-05T10:02:00.000Z";
const T3 = "2026-09-05T10:03:00.000Z";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `spor-attempt-${p}-`));

const SPEC = { tenant: "local", node_id: "task-x", factory_node_id: "factory-t", pipeline_attempt: 1, gates: [{ id: "acceptance" }], boundary: "gates", at: T0 };

function opened() {
  const c = kernel.claim(kernel.initExecution(SPEC, { sha256 }), { worker: "agent-one", machine: "box-1", lease_expires_at: "2026-09-05T20:00:00.000Z", now: T0 });
  assert.equal(c.ok, true);
  return c.record;
}

function applyAll(record, events, seen = new Set()) {
  let cur = record;
  const results = [];
  for (const ev of events) {
    const r = kernel.applyExecutionEvent(cur, ev, { seen });
    results.push(r);
    if (r.ok && !r.replayed) {
      cur = r.record;
      seen.add(r.idempotency_key);
    }
  }
  return { record: cur, seen, results };
}

// ---------------------------------------------------------------- 1. kernel

const HANDLE = { provider: "container", id: "ctr-7f3a", host: "builder-2" };
const SUBMIT_KEY = "exec-x/1/wrk-a1b2:4211:1696850000";
// Every live attempt.submitted follows the attempt.submitting that persisted its
// submit key and request (PROVIDERS.md §6).
const SUBMITTING = { type: "attempt.submitting", attempt: 1, provider: "container", idempotency_key: SUBMIT_KEY, request: { op: "submit" }, at: T0, fence: 1 };

test("kernel: attempt.submitting -> submitted -> observed -> stage.observed round-trips the provider handle", () => {
  const { record, results } = applyAll(opened(), [
    { type: "stage.started", attempt: 1, pool: "implementation", run_id: "run-1", at: T0, fence: 1 },
    { type: "attempt.submitting", attempt: 1, provider: "container", idempotency_key: SUBMIT_KEY, request: { op: "submit" }, at: T0, fence: 1 },
    { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, env: { image: "img:1" }, submitted_at: T1, at: T1, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "running", detail: "harness up", observed_at: T1, at: T1, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "finished", observed_at: T2, at: T2, fence: 1 },
    { type: "stage.observed", attempt: 1, state: "candidate", outcome: "candidate", at: T2, fence: 1 },
  ]);
  for (const r of results) assert.equal(r.ok, true, r.message);
  assert.equal(results[1].idempotency_key, `${record.execution_id}:attempt.submitting:1`);
  assert.equal(results[2].idempotency_key, `${record.execution_id}:attempt.submitted:1`);
  const row = record.attempts[0];
  assert.deepEqual(row.provider, {
    id: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, request: { op: "submit" }, env: { image: "img:1" },
    submitting_at: T0, submitted_at: T1, last_state: "finished", last_observed_at: T2, last_detail: null, observed_seq: 2,
  });
  assert.equal(row.state, "candidate");
  assert.equal(record.stage, "implementation", "no provider event moves the stage");
});

test("kernel: the same handle again replays; a different handle — even under a laundered key — is attempt_handle_conflict", () => {
  const sub = { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, at: T1, fence: 1 };
  const { record, seen } = applyAll(opened(), [SUBMITTING, sub]);
  const dup = kernel.applyExecutionEvent(record, { ...sub, handle: { host: "builder-2", id: "ctr-7f3a", provider: "container" } }, { seen });
  assert.equal(dup.replayed, true);
  assert.equal(kernel.applyExecutionEvent(record, { ...sub, handle: { ...HANDLE, id: "ctr-other" } }, { seen }).code, "attempt_handle_conflict");
  assert.equal(kernel.applyExecutionEvent(record, { ...sub, handle: "ctr-other", idempotency_key: "some-fresh-key" }, { seen }).code, "attempt_handle_conflict");
  assert.equal(kernel.eventKey(record, { ...sub, idempotency_key: "some-fresh-key" }), `${record.execution_id}:attempt.submitted:1`, "eventKey never reads a provider key as the log key");
});

test("kernel: the submit key is persisted once; a new key is refused and submitted must come back under it", () => {
  const ing = { type: "attempt.submitting", attempt: 1, provider: "container", idempotency_key: SUBMIT_KEY, request: { op: "submit" }, at: T0, fence: 1 };
  const { record, seen } = applyAll(opened(), [ing]);
  assert.equal(kernel.applyExecutionEvent(record, ing, { seen }).replayed, true);
  assert.equal(kernel.applyExecutionEvent(record, { ...ing, idempotency_key: "another-key-123" }, { seen }).code, "attempt_handle_conflict");
  assert.equal(kernel.applyExecutionEvent(record, { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: "another-key-123", at: T1, fence: 1 }, { seen }).code, "attempt_handle_conflict");
  assert.equal(record.attempts[0].provider.handle, null);
});

test("kernel: observe needs a handle, journals transitions not polls, and a terminal environment never moves", () => {
  const base = opened();
  assert.equal(kernel.applyExecutionEvent(base, { type: "attempt.observed", attempt: 1, state: "running", at: T1, fence: 1 }).code, "invalid_event");
  const { record, seen, results } = applyAll(base, [
    SUBMITTING,
    { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, at: T1, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "running", at: T1, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "running", at: T2, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "suspended", at: T2, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "running", at: T3, fence: 1 },
    { type: "attempt.observed", attempt: 1, state: "lost", at: T3, fence: 1 },
  ]);
  assert.equal(results[3].replayed, true);
  assert.equal(results[5].replayed, undefined);
  assert.equal(record.attempts[0].provider.observed_seq, 4);
  assert.equal(kernel.applyExecutionEvent(record, { type: "attempt.observed", attempt: 1, state: "running", at: T3, fence: 1 }, { seen }).code, "invalid_event");
});

test("kernel: a fenced-out writer's conflicting submit hears fence_stale, never a handle to adopt; replay is deterministic and a plain record carries no provider", () => {
  const sub = { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, at: T1, fence: 1 };
  const { record, seen } = applyAll(opened(), [SUBMITTING, sub]);
  const c = kernel.claim(record, { worker: "agent-two", machine: "box-2", lease_expires_at: "2026-09-06T23:00:00.000Z", now: "2026-09-06T00:00:00.000Z" });
  assert.equal(c.fence, 2);
  assert.deepEqual(c.record.attempts[0].provider.handle, HANDLE);
  assert.equal(kernel.applyExecutionEvent(c.record, { ...sub, handle: "ctr-other", at: "2026-09-06T00:01:00.000Z" }, { seen }).code, "fence_stale");
  const evs = [{ type: "stage.started", attempt: 1, pool: "implementation", at: T0, fence: 1 }];
  assert.equal("provider" in applyAll(opened(), evs).record.attempts[0], false);
});

// The canonical attempt index and submitted-requires-submitting
// (issue-spor-execution-attempt-event-key-normalization; mirrors the server's
// lib-engine/test/execution.test.js rows for dec-spor-server-execution-attempt-
// index-canonical).

test("kernel: attempt index is canonical before the replay key: 1 and \"01\" are one attempt; a non-integer is refused", () => {
  const sub = { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, env: { image: "img:1" }, at: T1, fence: 1 };
  const { record, seen, results } = applyAll(opened(), [{ ...SUBMITTING, attempt: "01" }, sub]);
  for (const r of results) assert.equal(r.ok, true, r.message);
  assert.equal(results[0].idempotency_key, `${record.execution_id}:attempt.submitting:1`);
  assert.equal(kernel.derivedEventKey(record, { ...sub, attempt: "01" }), `${record.execution_id}:attempt.submitted:1`);
  assert.equal(kernel.eventKey(record, { ...sub, attempt: "01" }), `${record.execution_id}:attempt.submitted:1`);
  // "01" re-sends replay attempt 1's events — never overwrite its env…
  const again = kernel.applyExecutionEvent(record, { ...sub, attempt: "01", env: { image: "img:2" } }, { seen });
  assert.equal(again.replayed, true);
  assert.deepEqual(record.attempts[0].provider.env, { image: "img:1" });
  // …nor inflate observed_seq on a repeated poll.
  const obs = applyAll(record, [
    { type: "attempt.observed", attempt: 1, state: "running", at: T2, fence: 1 },
    { type: "attempt.observed", attempt: "01", state: "running", at: T2, fence: 1 },
    { type: "attempt.observed", attempt: "001", state: "running", at: T3, fence: 1 },
  ], seen);
  assert.deepEqual(obs.results.map((r) => !!r.replayed), [false, true, true]);
  assert.equal(obs.record.attempts[0].provider.observed_seq, 1);
  assert.equal(obs.record.attempts.length, 1);
  for (const bad of [1.5, "1.0", "1e0", "", "0", 0, -1, true, null, " 1"]) {
    const r = kernel.applyExecutionEvent(opened(), { ...SUBMITTING, attempt: bad }, { seen: new Set() });
    assert.equal(r.code, "invalid_event", `attempt ${JSON.stringify(bad)} is refused`);
  }
  assert.deepEqual([1, "01", "7", 0, "1.0", 2.5, true].map(kernel.attemptIndex), [1, 1, 7, null, null, null, null]);
});

test("kernel: a live attempt.submitted with no prior attempt.submitting is refused; historical replay keeps the legacy row", () => {
  const sub = { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, at: T1, fence: 1 };
  const live = kernel.applyExecutionEvent(opened(), sub, { seen: new Set() });
  assert.equal(live.ok, false);
  assert.equal(live.code, "invalid_event");
  assert.match(live.message, /attempt\.submitting/);
  const legacy = kernel.applyExecutionEvent(opened(), sub, { seen: new Set(), historicalReplay: true });
  assert.equal(legacy.ok, true, legacy.message);
  assert.deepEqual(legacy.record.attempts[0].provider.handle, HANDLE);
  assert.equal(legacy.record.attempts[0].provider.request, null);
});

test("kernel: a journal written before the canonical index replays under its raw keys, and an exact retry of one of its rows replays", () => {
  // The pre-normalization bug, as journaled: "01" submitting, then submitted
  // under 1 AND re-sent under "1.0" (two rows, two raw keys).
  const legacy = [
    { ...SUBMITTING, attempt: "01" },
    { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, env: { image: "img:1" }, at: T1, fence: 1 },
    { type: "attempt.submitted", attempt: "1.0", provider: "container", handle: HANDLE, idempotency_key: SUBMIT_KEY, env: { image: "img:2" }, at: T1, fence: 1 },
  ];
  let record = opened();
  const seen = new Set();
  for (const ev of legacy) {
    const r = kernel.applyExecutionEvent(record, ev, { seen, historicalReplay: true });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.replayed, undefined, "every legacy row is its own journal entry");
    record = r.record;
    seen.add(r.idempotency_key);
  }
  assert.ok(seen.has(`${record.execution_id}:attempt.submitting:01`));
  assert.ok(seen.has(`${record.execution_id}:attempt.submitted:1.0`));
  assert.equal(record.attempts.length, 1);
  // A live exact retry of a raw-keyed row is that row, not a new one.
  const retry = kernel.applyExecutionEvent(record, { ...legacy[0], at: T2 }, { seen });
  assert.equal(retry.replayed, true);
  assert.equal(retry.idempotency_key, `${record.execution_id}:attempt.submitting:01`);
  // A non-integer spelling is history only: live, it is refused.
  assert.equal(kernel.applyExecutionEvent(record, { ...legacy[2], at: T2 }, { seen }).code, "invalid_event");
});

// ---------------------------------------------------------------- 2. stores

test("local store: a provider event is journaled under its canonical attempt index, and the log rebuilds the record", async () => {
  const home = tmp("canon");
  const eng = store.localExecutionEngine({ home, worker: "w", machine: "m", instance: "i1" });
  const o = await eng.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }] });
  const id = o.execution.execution_id;
  assert.equal((await eng.event(id, { fence: o.fence, event: { type: "attempt.submitting", attempt: "01", provider: "synthetic", idempotency_key: SUBMIT_KEY, request: {} } })).ok, true);
  const orphanSubmitted = await eng.event(id, { fence: o.fence, event: { type: "attempt.submitted", attempt: 2, provider: "synthetic", handle: "h2", submit_idempotency_key: SUBMIT_KEY } });
  assert.equal(orphanSubmitted.code, "invalid_event", "a handle with no persisted submit is refused");
  assert.equal((await eng.event(id, { fence: o.fence, event: { type: "attempt.submitted", attempt: "1", provider: "synthetic", handle: "h", submit_idempotency_key: SUBMIT_KEY } })).ok, true);
  const rows = store.readEvents(home, "local", id).filter((e) => kernel.ATTEMPT_PROVIDER_EVENTS.includes(e.type));
  assert.deepEqual(rows.map((e) => [e.attempt, e.idempotency_key]), [
    [1, `${id}:attempt.submitting:1`],
    [1, `${id}:attempt.submitted:1`],
  ]);
  assert.deepStrictEqual(store.rebuildFromEvents(home, "local", id), store.readRecord(home, "local", id));
});

test("local store: the provider key is journaled as submit_idempotency_key and the log rebuilds the record", async () => {
  const home = tmp("local");
  const eng = store.localExecutionEngine({ home, worker: "w", machine: "m", instance: "i1" });
  const o = await eng.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }] });
  const id = o.execution.execution_id;
  assert.equal((await eng.event(id, { fence: o.fence, event: { type: "attempt.submitting", attempt: 1, provider: "synthetic", idempotency_key: SUBMIT_KEY, request: { attempt: { node_id: "task-x" } } } })).ok, true);
  const both = await eng.event(id, { fence: o.fence, event: { type: "attempt.submitted", attempt: 1, provider: "synthetic", handle: "h", idempotency_key: SUBMIT_KEY, submit_idempotency_key: "different-key-1" } });
  assert.equal(both.code, "invalid_event", "two disagreeing spellings are refused");
  assert.equal((await eng.event(id, { fence: o.fence, event: { type: "attempt.submitted", attempt: 1, provider: "synthetic", handle: "h", submit_idempotency_key: SUBMIT_KEY } })).ok, true);
  const rows = store.readEvents(home, "local", id).filter((e) => kernel.ATTEMPT_PROVIDER_EVENTS.includes(e.type));
  assert.deepEqual(rows.map((e) => [e.idempotency_key, e.submit_idempotency_key]), [
    [`${id}:attempt.submitting:1`, SUBMIT_KEY],
    [`${id}:attempt.submitted:1`, SUBMIT_KEY],
  ]);
  assert.deepStrictEqual(store.rebuildFromEvents(home, "local", id), store.readRecord(home, "local", id));
});

test("remote adapter: provider events go out as submit_idempotency_key with no log key of the client's", async () => {
  const node = (id) => `---\nid: ${id}\ntype: task\nproject: spor\ntitle: ${id}\nsummary: fixture\ndate: 2026-09-05\nstatus: open\n---\n\nbody\n`;
  const fake = await startFakeExecutionServer({ nodes: { "task-x": node("task-x"), "factory-t": node("factory-t") } });
  try {
    const home = tmp("remote");
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: fake.base, SPOR_TOKEN: "tok-a", SPOR_DISPATCH_AGENT: "agent-a" } });
    const st = store.openExecutionStore(cfg, { home, machine: "box-a" });
    const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" });
    assert.equal(o.ok, true, o.message);
    const r = await st.event(o.execution.execution_id, { fence: o.fence, event: { type: "attempt.submitting", attempt: 1, provider: "synthetic", idempotency_key: SUBMIT_KEY, request: { attempt: {} } } });
    assert.equal(r.ok, true, r.message);
    const sent = fake.state.requests.find((q) => q.path.endsWith("/events")).body.event;
    assert.equal(sent.submit_idempotency_key, SUBMIT_KEY);
    assert.equal("idempotency_key" in sent, false);
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------ 3. the driver

// The synthetic provider as a client, with a count of every submit it was
// sent and two failure knobs: `dropReply` loses the next reply AFTER the
// provider acted on it, `refuseNext` answers a non-retryable refusal.
function syntheticClient(impl = createSyntheticImpl()) {
  const bound = bindInProcess(impl);
  const knobs = { dropReply: 0, sent: [] };
  const provider = {
    async request(msg) {
      if (msg.op === "submit") knobs.sent.push(msg.params.idempotency_key);
      const res = await bound.request(msg);
      if (msg.op === "submit" && knobs.dropReply > 0) {
        knobs.dropReply -= 1;
        throw new Error("connection reset");
      }
      return res;
    },
  };
  return { client: attempts.envelopeClient("synthetic", provider, { timeoutMs: 2000 }), impl, knobs };
}

const REQUEST = { attempt: {
  contract_version: 1, attempt_id: "i1", execution_id: "exec-0123456789abcdef", fence: 1, tenant: "local", node_id: "task-x",
  harness: { id: "codex" }, mcp: [], skills: [], plugins: [], tools: ["git"],
  repos: [{ slug: "spor", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "spor/task-x" }],
  egress: { allow: [] }, secrets: [], spor: { server: "https://api.sporhq.io", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" },
  deadline: "2099-01-01T00:00:00Z", isolation: "container", prompt_bundle_ref: "https://synthetic.spor.invalid/complete/exec-0123456789abcdef/prompt.tar",
} };

async function openLocal(home, instance) {
  const eng = store.localExecutionEngine({ home, worker: "w", machine: "m", instance });
  const o = await eng.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }] });
  assert.equal(o.ok, true, o.message);
  return { eng, id: o.execution.execution_id, fence: o.fence };
}

test("driver: the key and request are persisted BEFORE the send and the handle before it returns", async () => {
  const home = tmp("order");
  const { eng, id, fence } = await openLocal(home, "i1");
  const { client, knobs } = syntheticClient();
  const seenAtSend = [];
  const watched = { ...client, submit: async (p) => { seenAtSend.push(attempts.providerRow((await eng.get(id)).execution, 1)); return client.submit(p); } };
  const key = attempts.mintSubmitKey({ executionId: id, attempt: 1, fence, instance: "i1" });
  const r = await attempts.submitAttempt({ store: eng, executionId: id, fence, client: watched, key, request: REQUEST });
  assert.equal(r.ok, true, r.reason);
  assert.equal(seenAtSend[0].idempotency_key, key, "the key was on the record before the first send");
  assert.equal(seenAtSend[0].handle, null);
  const row = attempts.providerRow((await eng.get(id)).execution, 1);
  assert.deepEqual(row.handle, r.handle);
  assert.deepEqual(knobs.sent, [key]);
});

test("driver: a store that cannot persist the key means nothing is sent", async () => {
  const home = tmp("nopersist");
  const { eng, id, fence } = await openLocal(home, "i1");
  const { client, knobs } = syntheticClient();
  const refusing = { ...eng, event: async () => ({ ok: false, code: "transport", message: "offline", deferred: true }) };
  const r = await attempts.submitAttempt({ store: refusing, executionId: id, fence, client, key: "exec-x/a1/1/i1", request: REQUEST });
  assert.equal(r.notPersisted, true);
  assert.deepEqual(knobs.sent, []);
});

test("driver: a SIGKILL between the submit and the persist — the restarted instance reconciles under the persisted key, one environment", async () => {
  const home = tmp("sigkill");
  const { client, impl, knobs } = syntheticClient();
  const first = await openLocal(home, "i1");
  // The first worker dies the instant the provider accepted: its handle write
  // never happens.
  const dying = { ...first.eng, event: async (eid, args) => {
    if (args.event.type === "attempt.submitted") throw Object.assign(new Error("SIGKILL"), { killed: true });
    return first.eng.event(eid, args);
  } };
  const key = attempts.mintSubmitKey({ executionId: first.id, attempt: 1, fence: first.fence, instance: "i1" });
  const died = await attempts.submitAttempt({ store: dying, executionId: first.id, fence: first.fence, client, key, request: REQUEST });
  assert.equal(died.ok, false);
  assert.equal(attempts.providerRow((await first.eng.get(first.id)).execution, 1).handle, null, "the handle never reached the record");
  assert.equal(impl.fixture.environments(), 1);
  // The restarted worker: a new instance, so the open re-claims under a new fence.
  const second = await openLocal(home, "i2");
  assert.ok(second.fence > first.fence, "a new instance advances the fence");
  const r = await attempts.submitAttempt({ store: second.eng, executionId: second.id, fence: second.fence, client, key: attempts.mintSubmitKey({ executionId: second.id, attempt: 1, fence: second.fence, instance: "i2" }), request: { attempt: { ...REQUEST.attempt, attempt_id: "i2" } } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.reconciled, true);
  assert.equal(r.existing, true);
  assert.equal(impl.fixture.environments(), 1, "exactly one environment exists");
  assert.deepEqual(knobs.sent, [key, key], "the re-send carried the PERSISTED key, never the new instance's");
  // And a third look adopts the now-recorded handle without sending anything.
  const again = await attempts.submitAttempt({ store: second.eng, executionId: second.id, fence: second.fence, client, key: "ignored-key-xyz", request: REQUEST });
  assert.equal(again.adopted, true);
  assert.deepEqual(knobs.sent, [key, key]);
});

test("driver: a dropped submit reply is acceptance unknown — held, then reconciled by key with no second environment", async () => {
  const home = tmp("dropped");
  const { eng, id, fence } = await openLocal(home, "i1");
  const { client, impl, knobs } = syntheticClient();
  knobs.dropReply = 1;
  const key = attempts.mintSubmitKey({ executionId: id, attempt: 1, fence, instance: "i1" });
  const held = await attempts.submitAttempt({ store: eng, executionId: id, fence, client, key, request: REQUEST });
  assert.equal(held.ok, false);
  assert.equal(held.held, true);
  assert.equal(held.acceptance, "unknown");
  assert.equal(attempts.providerRow((await eng.get(id)).execution, 1).handle, null, "nothing is marked failed or submitted");
  const r = await attempts.submitAttempt({ store: eng, executionId: id, fence, client, key: "a-fresh-key-the-caller-minted", request: REQUEST });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.existing, true, "the provider answered with the environment it already had");
  assert.deepEqual(knobs.sent, [key, key]);
  assert.equal(impl.fixture.environments(), 1);
});

test("driver: a non-retryable refusal is reported refused; observe relays transitions and stops at a terminal state", async () => {
  const home = tmp("observe");
  const { eng, id, fence } = await openLocal(home, "i1");
  const { client } = syntheticClient();
  const refused = await attempts.submitAttempt({ store: eng, executionId: id, fence: fence, attempt: 2, client, key: "exec-x/a2/1/i1", request: { attempt: { ...REQUEST.attempt, isolation: "vm" } } });
  assert.equal(refused.refused, true);
  assert.equal(refused.code, "unsatisfiable");
  const ok = await attempts.submitAttempt({ store: eng, executionId: id, fence, client, key: "exec-x/a1/1/i1", request: REQUEST });
  assert.equal(ok.ok, true);
  const states = [];
  for (let i = 0; i < 5; i += 1) states.push((await attempts.observeAttempt({ store: eng, executionId: id, fence, client })).state);
  assert.deepEqual(states, ["provisioning", "running", "finished", "finished", "finished"]);
  const row = attempts.providerRow((await eng.get(id)).execution, 1);
  assert.equal(row.last_state, "finished");
  assert.equal(row.observed_seq, 3);
});

test("driver: an attempt recorded under a provider this box does not run is classified orphaned, and the driver refuses to submit over it", async () => {
  const home = tmp("orphan");
  const { eng, id, fence } = await openLocal(home, "i1");
  await eng.event(id, { fence, event: { type: "attempt.submitting", attempt: 1, provider: "container", submit_idempotency_key: SUBMIT_KEY, request: {} } });
  await eng.event(id, { fence, event: { type: "attempt.submitted", attempt: 1, provider: "container", handle: HANDLE, submit_idempotency_key: SUBMIT_KEY } });
  const listed = await eng.list({});
  const rows = attempts.classifyProviderAttempts(listed.executions, { configured: ["local"] });
  assert.deepEqual(rows.map((r) => [r.node_id, r.provider, r.disposition]), [["task-x", "container", "orphaned"]]);
  assert.deepEqual(attempts.classifyProviderAttempts(listed.executions, { configured: ["container"] }).map((r) => r.disposition), ["adopt"]);
  const { client, knobs } = syntheticClient();
  const r = await attempts.submitAttempt({ store: eng, executionId: id, fence, client, key: "exec-x/a1/1/i1", request: REQUEST });
  assert.equal(r.orphaned, true);
  assert.deepEqual(knobs.sent, []);
  const swept = await attempts.sweepProviderAttempts({ store: eng, configured: ["local"] });
  assert.deepEqual(swept.orphaned.map((o) => o.node_id), ["task-x"]);
});

test("driver: a stale fence holder is refused AT adoption — nothing adopted, and the store's renew is the fenced step", async () => {
  const home = tmp("stale-adopt");
  const { client, knobs } = syntheticClient();
  const first = await openLocal(home, "i1");
  const key = attempts.mintSubmitKey({ executionId: first.id, attempt: 1, fence: first.fence, instance: "i1" });
  assert.equal((await attempts.submitAttempt({ store: first.eng, executionId: first.id, fence: first.fence, client, key, request: REQUEST })).ok, true);
  // A takeover: a second instance re-claims and advances the fence.
  const second = await openLocal(home, "i2");
  assert.ok(second.fence > first.fence);
  // The first instance reads the same record (the handle is on it) but its
  // fence is gone: it is refused at adoption, not at its next observe.
  const stale = await attempts.submitAttempt({ store: first.eng, executionId: first.id, fence: first.fence, client, key: "ignored-key-xyz", request: REQUEST });
  assert.equal(stale.ok, false);
  assert.equal(stale.held, true);
  assert.equal(stale.fenced, true);
  assert.equal(stale.code, "fence_stale");
  assert.equal(stale.ownershipLost, true);
  assert.equal(stale.handle, undefined, "a fenced-out caller is handed no handle to follow");
  // The live holder still adopts.
  const adopted = await attempts.submitAttempt({ store: second.eng, executionId: second.id, fence: second.fence, client, key: "ignored-key-xyz", request: REQUEST });
  assert.equal(adopted.adopted, true, adopted.reason);
  assert.deepEqual(knobs.sent, [key], "neither look re-sent anything");
});

test("driver: a stale fence holder is refused before a RECONCILE re-send, and an unconfirmable renew sends nothing", async () => {
  const home = tmp("stale-reconcile");
  const { client, knobs } = syntheticClient();
  knobs.dropReply = 1;
  const first = await openLocal(home, "i1");
  const key = attempts.mintSubmitKey({ executionId: first.id, attempt: 1, fence: first.fence, instance: "i1" });
  assert.equal((await attempts.submitAttempt({ store: first.eng, executionId: first.id, fence: first.fence, client, key, request: REQUEST })).acceptance, "unknown");
  const offline = { ...first.eng, renew: async () => ({ ok: false, code: "transport", message: "offline" }) };
  const unconfirmed = await attempts.submitAttempt({ store: offline, executionId: first.id, fence: first.fence, client, key, request: REQUEST });
  assert.equal(unconfirmed.fenced, true);
  assert.equal(unconfirmed.ownershipLost, false);
  await openLocal(home, "i2");
  const stale = await attempts.submitAttempt({ store: first.eng, executionId: first.id, fence: first.fence, client, key, request: REQUEST });
  assert.equal(stale.code, "fence_stale");
  assert.deepEqual(knobs.sent, [key], "no re-send under a fence that could not be confirmed");
});

test("driver: a lost reply surfaces as a LostReply-shaped hold, never a refusal", async () => {
  const lost = { id: "x", submit: async () => { throw new LostReply("submit"); }, observe: async () => ({ state: "running" }) };
  const home = tmp("lost");
  const { eng, id, fence } = await openLocal(home, "i1");
  const r = await attempts.submitAttempt({ store: eng, executionId: id, fence, client: lost, key: "exec-x/a1/1/i1", request: REQUEST });
  assert.equal(r.held, true);
  assert.equal(r.refused, undefined);
});

// ------------------------------------------------- 4. the CLI wiring (bin/spor.js)
// dispatchWorkItem under `completion.by: controller`: the attempt driver rides
// the launch door (ctx.submitAttempt), a re-dispatch of a held item ADOPTS the
// recorded attempt instead of launching, a provider this box does not run is
// held and never re-dispatched, and unknown acceptance holds the execution
// rather than withdrawing it.
{
  const spor = require("../bin/spor.js");
  const gatesKernel = require("../lib/kernel/gates.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const attemptSpecKernel = require("../lib/kernel/attempt-spec.js");

  const nodeFile = (id, type, extra = "") => `---\nid: ${id}\ntype: ${type}\nproject: spor\ntitle: Title of ${id}\nsummary: Summary of ${id}.\ndate: 2026-09-06\nstatus: open\n${extra}---\n\nBody.\n`;
  function graphHome() {
    const dir = tmp("wiring");
    fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nodes", "task-x.md"), nodeFile("task-x", "task"));
    const cfg = loadConfig({ cwd: dir, env: { SPOR_HOME: dir, XDG_CONFIG_HOME: dir, SPOR_MODE: "local" } });
    const { factory, errors } = gatesKernel.parseFactory(["```json", JSON.stringify({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } }), "```"].join("\n"), { id: "factory-t" });
    assert.deepEqual(errors, []);
    factory.id = "factory-t";
    return { dir, cfg, factory };
  }
  // A launch door that submits through ctx.submitAttempt with a fake local
  // impl: `submit` writes a run record carrying the provider_attempt stamp
  // (what the real local provider does) and hands back its handle.
  function fakeDoor(home, { lose = false } = {}) {
    const calls = { door: 0, submits: [] };
    const impl = {
      async submit({ attempt, idempotency_key: key }) {
        calls.submits.push(key);
        if (lose) throw new Error("socket hang up");
        const runId = `run-${calls.submits.length}`;
        const p = dispatchRuns.runPaths(home, runId);
        fs.mkdirSync(path.dirname(p.record), { recursive: true });
        const publicAttempt = { ...attempt };
        delete publicAttempt.local;
        fs.writeFileSync(p.record, JSON.stringify({ run_id: runId, node_id: "task-x", harness: "fake", launch_mode: "supervised-jsonl", state: "running", provider_attempt: { provider: "local", idempotency_key: key, attempt: publicAttempt } }));
        return { handle: { provider: "local", id: runId }, accepted_at: T0, existing: false, env: { run_id: runId, paths: { record: p.record } } };
      },
    };
    const cmdDispatch = async (fcfg, { values }, ctx) => {
      calls.door += 1;
      // The real door hands the DERIVED spec (lib/kernel/attempt-spec.js);
      // the driver binds the execution and validates it against the schema.
      const attempt = attemptSpecKernel.deriveAttemptSpec({
        nodeId: values.node, harness: "fake", repos: [{ slug: "spor", commit: "a".repeat(40), branch: "main" }],
        server: "file:///tmp/spor-nodes", now: Date.parse(T0), defaultRunMaxMs: 3600000,
      });
      const r = await ctx.submitAttempt({ providerId: "local", impl, attempt, augment: (p) => ({ ...p, attempt: { ...p.attempt, local: { live: true } } }) });
      if (!(r.ok || (r.held && r.handle != null))) return 1;
      ctx.onLaunch({ run_id: r.handle.id, harness: "fake", launch_mode: "supervised-jsonl", node_id: values.node, record_path: dispatchRuns.runPaths(home, r.handle.id).record });
      return 0;
    };
    return { calls, cmdDispatch };
  }
  const executionOf = async (cfg, home) => {
    const st = store.openExecutionStore(cfg, { home, mode: "local" });
    const listed = await st.list({});
    return listed.executions[0];
  };

  test("wiring: the controller dispatch persists submitting then submitted around the launch, and a re-dispatch ADOPTS the recorded run without launching", async () => {
    const { dir, cfg, factory } = graphHome();
    const lines = [];
    const door = fakeDoor(dir);
    const first = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, log: (l) => lines.push(l), cmdDispatch: door.cmdDispatch });
    assert.equal(first.ok, true, lines.join("\n"));
    const ex = await executionOf(cfg, dir);
    const row = attempts.providerRow(ex, 1);
    assert.deepEqual(row.handle, { provider: "local", id: "run-1" });
    assert.equal(row.idempotency_key, door.calls.submits[0]);
    assert.equal(row.request.attempt.execution_id, ex.execution_id, "the persisted request carries the execution identity");
    assert.equal("local" in row.request.attempt, false, "the live launch block is never persisted");
    assert.deepEqual(attemptSpecKernel.attemptSpecErrors(row.request.attempt), [], "the persisted request is a complete, valid attempt spec");
    assert.equal(row.request.attempt.spor.token_ref, `spor-attempt-token://${ex.execution_id}/1`);
    const second = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, log: (l) => lines.push(l), cmdDispatch: door.cmdDispatch });
    assert.equal(second.ok, true, lines.join("\n"));
    assert.equal(second.adopted, true);
    assert.equal(second.run.run_id, "run-1");
    assert.equal(door.calls.door, 1, "the launch door was not reached again");
    assert.ok(lines.some((l) => /adopted the live local attempt/.test(l)));
  });

  test("wiring: an execution whose attempt runs under a provider this box does not run is held, not withdrawn, and never reaches the launch door", async () => {
    const { dir, cfg, factory } = graphHome();
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: dir });
    assert.equal(held.ok, true, held.reason);
    const st = spor.openExecutionStoreFor(cfg, { home: dir, mode: "local" });
    const wrote = await st.event(held.executionId, { fence: held.fence, event: { type: "attempt.submitting", attempt: 1, provider: "container", submit_idempotency_key: SUBMIT_KEY, request: {} } });
    assert.equal(wrote.ok, true, wrote.message);
    const door = fakeDoor(dir);
    const r = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, cmdDispatch: door.cmdDispatch });
    assert.equal(r.ok, false);
    assert.equal(r.orphaned, true);
    assert.match(r.reason, /provider 'container'/);
    assert.equal(door.calls.door, 0);
    assert.match(fs.readFileSync(path.join(dir, "nodes", "task-x.md"), "utf8"), /^execution: exec-/m, "the hold stands");
    const swept = await spor.providerAttemptSweep(cfg, { home: dir });
    assert.deepEqual(swept.orphaned.map((o) => [o.node_id, o.provider]), [["task-x", "container"]]);
  });

  test("wiring: a `local` submit key persisted on ANOTHER box is orphaned here — never re-sent, never launched", async () => {
    const { dir, cfg, factory } = graphHome();
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: dir });
    const st = spor.openExecutionStoreFor(cfg, { home: dir, mode: "local" });
    const wrote = await st.event(held.executionId, { fence: held.fence, event: { type: "attempt.submitting", attempt: 1, provider: "local", submit_idempotency_key: SUBMIT_KEY, request: { attempt: {}, machine: "some-other-box" } } });
    assert.equal(wrote.ok, true, wrote.message);
    const door = fakeDoor(dir);
    const r = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, cmdDispatch: door.cmdDispatch });
    assert.equal(r.orphaned, true);
    assert.match(r.reason, /some-other-box/);
    assert.equal(door.calls.door, 0);
    const swept = await spor.providerAttemptSweep(cfg, { home: dir });
    assert.deepEqual(swept.orphaned.map((o) => o.provider), ["local"]);
  });

  test("wiring: a handle whose `attempt.submitted` write failed is re-persisted by the next sweep", async () => {
    const home = tmp("repersist");
    const eng = store.localExecutionEngine({ home, worker: "w", machine: "m", instance: "i1" });
    const o = await eng.open({ node_id: "task-x", factory: "factory-t", gates: [] });
    const id = o.execution.execution_id;
    await eng.event(id, { fence: o.fence, event: { type: "attempt.submitting", attempt: 1, provider: "synthetic", submit_idempotency_key: SUBMIT_KEY, request: {} } });
    const client = { id: "synthetic", observe: async () => ({ state: "running" }) };
    const owned = new Map([[id, { fence: o.fence, attempt: 1, client, node_id: "task-x", handle: { provider: "synthetic", id: "syn-9" }, key: SUBMIT_KEY }]]);
    const swept = await attempts.sweepProviderAttempts({ store: eng, owned, configured: ["synthetic"] });
    assert.deepEqual(swept.busy, ["task-x"]);
    const row = attempts.providerRow((await eng.get(id)).execution, 1);
    assert.deepEqual(row.handle, { provider: "synthetic", id: "syn-9" });
    assert.equal(row.last_state, "running", "and the observe was relayed after it");
  });

  test("wiring: a lost submit reply holds the execution (no withdraw); the next dispatch re-sends under the PERSISTED key", async () => {
    const { dir, cfg, factory } = graphHome();
    const lost = fakeDoor(dir, { lose: true });
    const r = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, cmdDispatch: lost.cmdDispatch });
    assert.equal(r.ok, false);
    assert.equal(r.held, true);
    assert.match(r.reason, /acceptance is unknown/);
    assert.match(fs.readFileSync(path.join(dir, "nodes", "task-x.md"), "utf8"), /^execution: exec-/m, "the hold stands");
    const ex = await executionOf(cfg, dir);
    assert.equal(kernel.isTerminal(ex), false, "the execution was not ended");
    const persistedKey = attempts.providerRow(ex, 1).idempotency_key;
    const ok = fakeDoor(dir);
    const again = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: dir, cmdDispatch: ok.cmdDispatch });
    assert.equal(again.ok, true);
    assert.deepEqual(ok.calls.submits, [persistedKey]);
    assert.deepEqual(attempts.providerRow(await executionOf(cfg, dir), 1).handle, { provider: "local", id: "run-1" });
  });
}
