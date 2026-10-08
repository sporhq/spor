// THE CLIENT EXECUTION STORE ADAPTER (task-spor-client-execution-store-adapter;
// EXECUTION-STATE.md §8 in spor-server is the contract). Layers, each with
// its own oracle:
//   1. the kernel (lib/kernel/execution.js): the content-addressed ids pinned
//      against the literal the SERVER's reducer mints, replay determinism and
//      non-mutation, idempotency suppression, fencing, the boundary;
//   2. the local store (lib/shell/execution-store.js): the server's layout,
//      log-before-record, the item pointer, rebuild parity, a second worker;
//   3. the remote adapter against a node:http fake of `/v1/executions` driven
//      by the same engine — the REQUEST BODIES are the oracle: the fence on
//      every transition, the outbox on a partition, replay in order on
//      reconnect, idempotent re-delivery, a takeover refusing the resolving
//      edge through the completion write's fence check;
//   4. the CLI wiring (bin/spor.js): a remote claim opening the hosted
//      execution and stamping the store on the claim, the unserved fallback
//      to the local store, the legacy no-op.
// No live graph, no model call; the only network is loopback to the fake.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const kernel = require("../lib/kernel/execution.js");
const completionKernel = require("../lib/kernel/completion.js");
const store = require("../lib/shell/execution-store.js");
const completionShell = require("../lib/shell/completion.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const gates = require("../lib/kernel/gates.js");
const { loadConfig } = require("../lib/config.js");
const spor = require("../bin/spor.js");
const { startFakeExecutionServer } = require("./helpers/fake-execution-server.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const T0 = "2026-09-06T12:00:00.000Z";
const later = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `spor-exec-${p}-`));

const SPEC = {
  tenant: "local",
  node_id: "task-x",
  factory_node_id: "factory-t",
  pipeline_attempt: 1,
  item_revision: "r-item",
  factory_revision: "r-factory",
  repo: "spor",
  gates: [{ id: "acceptance", node_id: "gate-acc", revision: "r-gate" }, { id: "review", node_id: null, revision: null }],
  boundary: "gates",
  at: T0,
};
const CAND = { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40), provenance: { attempt: 1 }, reference: { kind: "git", commit: "b".repeat(40), verified_at: T0 } };

function itemNode(id, { status = "open", extra = "", edges = [] } = {}) {
  return `---
id: ${id}
type: task
project: spor
title: Title of ${id}
summary: Standalone summary for ${id} used by the execution-store tests.
date: 2026-09-01
status: ${status}
${extra}${edges.length ? `edges:\n${edges.map((e) => `  - {type: ${e[0]}, to: ${e[1]}}`).join("\n")}\n` : ""}---
Body of ${id}.
`;
}

function factoryOf(payload) {
  const { factory, errors } = gates.parseFactory(["```json", JSON.stringify(payload), "```"].join("\n"), { id: "factory-t" });
  assert.deepEqual(errors, []);
  factory.id = "factory-t";
  return factory;
}

// ---------- 1. the kernel ----------

test("kernel: the execution id is the server's — exec- plus 16 hex of the NUL-joined (tenant, node_id, factory, pipeline_attempt), pinned against the literal spor-server's reducer mints", () => {
  const id = kernel.executionIdFor({ tenant: "local", node_id: "task-x", factory: "factory-t", pipeline_attempt: 1 }, sha256);
  assert.equal(id, "exec-4da6d4763543a301"); // lib-engine/kernel/execution.js executionId(), spor-server bdad326
  assert.equal(kernel.executionIdFor({ tenant: "acme", node_id: "task-x", factory: "factory-t", pipeline_attempt: 2 }, sha256), "exec-9b6183dbe0bab598");
  assert.equal(id, `exec-${sha256("local\u0000task-x\u0000factory-t\u00001").slice(0, 16)}`);
  assert.notEqual(id, kernel.executionIdFor({ tenant: "acme", node_id: "task-x", factory: "factory-t", pipeline_attempt: 1 }, sha256), "the tenant is part of the address");
  assert.notEqual(id, kernel.executionIdFor({ tenant: "local", node_id: "task-x", factory: "factory-t", pipeline_attempt: 2 }, sha256), "a re-run is a fresh execution");
  // kernel/completion.js spells the same derivation for the claim's inputs.
  assert.equal(completionKernel.executionIdFor({ tenant: "local", nodeId: "task-x", factoryId: "factory-t", pipelineAttempt: 1 }, sha256), id);
  assert.equal(kernel.serverCandidateIdFor({ repo: "spor", node_id: "t", tree: "d" }, sha256), "cand-e7cf9ec8926e36d5");
  assert.throws(() => kernel.executionIdFor({ tenant: "x", node_id: "y", factory: "z", pipeline_attempt: 1 }), /sha256/);
});

test("kernel: initExecution pins the definition and seeds every declared gate; replay is total and apply never mutates its input", () => {
  const rec = kernel.initExecution(SPEC, { sha256 });
  assert.equal(rec.spec_version, 1);
  assert.equal(rec.execution_id, "exec-4da6d4763543a301");
  assert.deepEqual(rec.factory.gates, SPEC.gates.map(g => ({ ...g, rejudge_on_repin: true })));
  assert.deepEqual(rec.gate_results, [{ id: "acceptance", state: null, attempt: 0, settled_at: null, candidate_id: null }, { id: "review", state: null, attempt: 0, settled_at: null, candidate_id: null }]);
  assert.equal(rec.stage, "implementation");
  assert.equal(kernel.boundaryReached(rec), false);
  const c = kernel.claim(rec, { worker: "agent-a", machine: "box", lease_expires_at: later(900), now: T0 });
  assert.equal(c.fence, 1);
  const evs = [
    { type: "stage.started", attempt: 1, run_id: "run-1", fence: 1, at: later(1) },
    { type: "candidate.submitted", candidate: CAND, fence: 1, at: later(2) },
    { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed", fence: 1, at: later(3) },
    { type: "gate.settled", gate_id: "review", attempt: 1, state: "skipped", fence: 1, at: later(4) },
    { type: "completion.written", resolver: "art-completion-x", fence: 1, at: later(5) },
  ];
  const fold = (start) => {
    let r = start;
    const seen = new Set();
    for (const e of evs) {
      const before = JSON.stringify(r);
      const x = kernel.applyExecutionEvent(r, e, { seen });
      assert.equal(x.ok, true, `${e.type}: ${x.message}`);
      assert.equal(JSON.stringify(r), before, "apply never mutates its input");
      r = x.record;
      seen.add(x.idempotency_key);
    }
    return r;
  };
  const a = fold(c.record);
  const b = fold(kernel.claim(kernel.initExecution(SPEC, { sha256 }), { worker: "agent-a", machine: "box", lease_expires_at: later(900), now: T0 }).record);
  assert.deepEqual(a, b, "replay reproduces an identical record");
  assert.equal(a.stage, "completed");
  assert.equal(a.seq, 5);
  assert.equal(kernel.isTerminal(a), true);
  assert.equal(a.attempts[0].state, "candidate");
  assert.equal(a.attempts[0].run_id, "run-1");
  // The log-only entries reproduce the record through rebuildFromEvents.
  const log = [{ type: "execution.opened", spec: SPEC }, { type: "ownership.changed", owner: c.record.owner, at: T0 }, ...evs.map((e, i) => ({ ...e, execution_id: a.execution_id, seq: i + 1, idempotency_key: kernel.eventKey(a, e) }))];
  assert.deepEqual(kernel.rebuildFromEvents(log, { sha256 }), a);
});

test("kernel: a seen idempotency key is a no-op even from a fenced-out worker; a stale fence, an expired lease and a terminal execution are typed refusals; the boundary is one predicate", () => {
  let rec = kernel.claim(kernel.initExecution({ ...SPEC, boundary: "integration" }, { sha256 }), { worker: "agent-a", machine: null, lease_expires_at: later(900), now: T0 }).record;
  const seen = new Set();
  const submit = { type: "candidate.submitted", candidate: CAND, fence: 1, at: later(1) };
  let r = kernel.applyExecutionEvent(rec, submit, { seen });
  seen.add(r.idempotency_key);
  rec = r.record;
  assert.equal(r.idempotency_key, CAND.candidate_id, "the candidate's own id is its key");
  // Replay from a stale fence: still "already recorded".
  const replay = kernel.applyExecutionEvent(rec, { ...submit, fence: 99 }, { seen });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record, rec);
  // Stale fence on a NEW event.
  assert.equal(kernel.applyExecutionEvent(rec, { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed", fence: 2, at: later(2) }, { seen }).code, "fence_stale");
  // Expired lease.
  assert.equal(kernel.applyExecutionEvent(rec, { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed", fence: 1, at: later(901) }, { seen }).code, "lease_expired");
  // A different candidate is a conflict, not a replay.
  assert.equal(kernel.applyExecutionEvent(rec, { type: "candidate.submitted", candidate: { ...CAND, candidate_id: "cand-9999888877776666", tree: "c".repeat(40) }, fence: 1, at: later(2) }, { seen }).code, "candidate_conflict");
  // Integration before the gates settle.
  assert.equal(kernel.applyExecutionEvent(rec, { type: "integration.started", attempt: 1, fence: 1, at: later(2) }, { seen }).code, "gates_unsettled");
  for (const g of ["acceptance", "review"]) {
    r = kernel.applyExecutionEvent(rec, { type: "gate.settled", gate_id: g, attempt: 1, state: "passed", fence: 1, at: later(3) }, { seen });
    seen.add(r.idempotency_key);
    rec = r.record;
  }
  assert.equal(kernel.boundaryReached(rec), false, "under `integration` the gates alone are not the boundary");
  assert.equal(kernel.applyExecutionEvent(rec, { type: "completion.written", resolver: "art-x", fence: 1, at: later(4) }, { seen }).code, "boundary_not_reached");
  rec = kernel.applyExecutionEvent(rec, { type: "integration.started", attempt: 1, fence: 1, at: later(4) }, { seen }).record;
  rec = kernel.applyExecutionEvent(rec, { type: "integration.settled", attempt: 1, state: "landed", commit: "d".repeat(40), fence: 1, at: later(5) }, { seen }).record;
  assert.equal(kernel.boundaryReached(rec), true);
  assert.equal(kernel.decorate(rec).boundary_reached, true);
  // Takeover: a live lease is never stolen; an expired one advances the fence.
  assert.equal(kernel.claim(rec, { worker: "agent-b", lease_expires_at: later(2000), now: later(6) }).code, "already_owned");
  assert.equal(kernel.claim(rec, { worker: "agent-b", lease_expires_at: later(2000), now: later(6), takeover: true }).code, "lease_live");
  const taken = kernel.claim(rec, { worker: "agent-b", lease_expires_at: later(2000), now: later(901) });
  assert.equal(taken.fence, 2);
  assert.equal(kernel.renew(taken.record, { fence: 1, lease_expires_at: later(3000), now: later(902) }).code, "fence_stale", "the fenced-out worker cannot resurrect its lease");
  // A refusal retains the hold for re-gating; only explicit release ends it.
  const refused = kernel.applyExecutionEvent(taken.record, { type: "escalation.filed", node_id: "task-gate-x", terminal: true, fence: 2, at: later(903) }, { seen }).record;
  assert.equal(refused.stage, "refused");
  assert.equal(kernel.applyExecutionEvent(refused, { type: "completion.written", resolver: "art-x", fence: 2, at: later(904) }, { seen }).code, "boundary_not_reached");
  assert.equal(kernel.isTerminal(refused), false);
  assert.equal(kernel.boundaryReached(refused), false);
  assert.equal(kernel.applyExecutionEvent(refused, { type: "bogus", fence: 2 }, { seen }).code, "invalid_event");
});

// ---------- 2. the local store ----------

test("local store: the server's layout under journal/executions/<tenant>/, the event log lands before the record, the item pointer clears on a terminal event, and the log rebuilds the record byte-for-byte", async () => {
  const home = tmp("local");
  const st = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", pinRead: (id) => ({ revision: `rev-${id}`, repo: "spor" }) });
  assert.equal(st.mode, "local");
  assert.equal(st.tenant, "local");
  const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance", node_id: "gate-acc" }], boundary: "gates" });
  assert.equal(o.ok, true);
  assert.equal(o.fence, 1);
  const id = o.execution.execution_id;
  assert.equal(id, "exec-4da6d4763543a301", "the same id the hosted store would mint for tenant `local`");
  assert.equal(o.execution.item.revision, "rev-task-x");
  assert.deepEqual(o.execution.factory.gates, [{ id: "acceptance", node_id: "gate-acc", revision: "rev-gate-acc", rejudge_on_repin: true }]);
  assert.ok(fs.existsSync(path.join(home, "journal", "executions", "local", "exec", `${id}.json`)));
  assert.ok(fs.existsSync(path.join(home, "journal", "executions", "local", "exec", `${id}.events.jsonl`)));
  assert.deepEqual(store.readItem(home, "local", "task-x"), { node_id: "task-x", open: id, executions: [id] });
  assert.deepEqual(store.readEvents(home, "local", id).map((e) => e.type), ["execution.opened", "ownership.changed"]);
  // An idempotent re-open by the same worker echoes the fence.
  const again = await st.open({ node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" });
  assert.equal(again.replayed, true);
  assert.equal(again.fence, 1);
  // A different factory on a live item is a conflict.
  assert.equal((await st.open({ node_id: "task-x", factory: "factory-other", gates: [], boundary: "gates" })).code, "execution_open");
  let r = await st.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } });
  assert.equal(r.ok, true);
  r = await st.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } });
  assert.equal(r.replayed, true, "a re-sent event is suppressed off the durable log");
  assert.equal((await st.event(id, { fence: 2, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } })).code, "fence_stale");
  r = await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } });
  assert.equal(r.execution.boundary_reached, true);
  assert.equal((await st.confirmOwnership(id, 1)).confirmed, true);
  assert.equal((await st.confirmOwnership(id, 2)).confirmed, false);
  r = await st.event(id, { fence: 1, event: { type: "completion.written", resolver: "art-c" } });
  assert.equal(r.execution.terminal, true);
  assert.deepEqual(store.readItem(home, "local", "task-x"), { node_id: "task-x", open: null, executions: [id] });
  assert.deepEqual(store.rebuildFromEvents(home, "local", id), store.readRecord(home, "local", id), "the log reproduces the record");
  assert.equal((await st.events(id)).count, 6);
  // The next open is pipeline attempt 2 under a fresh id; another worker cannot claim it live.
  const second = await st.open({ node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" });
  assert.equal(second.execution.pipeline_attempt, 2);
  assert.notEqual(second.execution.execution_id, id);
  const other = store.openExecutionStore(null, { home, mode: "local", worker: "agent-b" });
  assert.equal((await other.claim(second.execution.execution_id)).code, "already_owned");
  assert.equal((await other.open({ node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" })).fence, undefined, "a replayed open echoes no fence to a non-owner");
  assert.equal((await st.list({ node_id: "task-x" })).count, 2);
  assert.equal((await st.list({ stage: "completed" })).count, 1);
  // Terminate: the pool-spent terminal frees the pointer.
  const ended = await st.terminate(second.execution.execution_id, { fence: second.fence, reason: "hold refused" });
  assert.equal(ended.execution.stage, "refused");
  assert.equal(store.readItem(home, "local", "task-x").open, null);
  // Local reads recover a corrupt materialized view from the authoritative log.
  fs.writeFileSync(store.recordPath(home, "local", id), "{not json");
  assert.equal((await st.get(id)).execution.stage, "completed");
  assert.equal(store.readRecord(home, "local", id).stage, "completed");
});

// ---------- 3. the remote adapter against the fake ----------

function remoteCfg(dir, base, token = "tok-a") {
  return loadConfig({ cwd: dir, env: { SPOR_HOME: dir, XDG_CONFIG_HOME: dir, SPOR_SERVER: base, SPOR_TOKEN: token, SPOR_DISPATCH_AGENT: "agent-a" } });
}

test("remote adapter: open, claim, renew, release and every event ride the fence the server handed back; reads fall back to the last confirmed copy when the server is unreachable", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("remote");
    const cfg = remoteCfg(home, fake.base);
    const st = store.openExecutionStore(cfg, { home, machine: "box-a" });
    assert.equal(st.mode, "remote");
    const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates", repo: "spor", machine: "box-a" });
    assert.equal(o.ok, true, o.message);
    assert.equal(o.fence, 1);
    const id = o.execution.execution_id;
    assert.equal(id, kernel.executionIdFor({ tenant: "acme", node_id: "task-x", factory: "factory-t", pipeline_attempt: 1 }, sha256), "the server's tenant is part of the id");
    assert.equal(o.execution.owner.worker, "agent-a", "the principal is derived from the identity");
    assert.deepEqual(fake.state.requests[0], { method: "POST", path: "/v1/executions", bearer: "tok-a", body: { node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates", repo: "spor", machine: "box-a" } });
    assert.ok(fs.existsSync(store.recordPath(home, "acme", id)), "the confirmed copy is cached under the org partition");
    let r = await st.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.deferred, false);
    r = await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } });
    assert.equal(r.ok, true);
    const posted = fake.state.requests.filter((q) => q.path.endsWith("/events") && q.method === "POST");
    assert.deepEqual(posted.map((q) => q.body.fence), [1, 1], "every event carries the fence");
    assert.equal(posted[0].body.event.idempotency_key, CAND.candidate_id, "the client stamps the deterministic key");
    assert.equal(posted[1].body.event.idempotency_key, `${id}:acceptance:1`);
    assert.equal((await st.renew(id, { fence: 1 })).ok, true);
    assert.deepEqual(fake.state.requests[fake.state.requests.length - 1].body, { fence: 1, machine: "box-a" });
    assert.equal((await st.renew(id, { fence: 7 })).code, "fence_stale");
    const c = await st.confirmOwnership(id, 1);
    assert.equal(c.confirmed, true);
    assert.equal((await st.get(id)).execution.boundary_reached, true);
    assert.equal((await st.list({ node_id: "task-x" })).count, 1);
    assert.equal((await st.events(id)).events.filter((e) => e.type === "gate.settled").length, 1);
    // Unreachable: the read answers from the cached copy and says so.
    fake.state.down = true;
    const off = await st.get(id);
    assert.equal(off.ok, true);
    assert.equal(off.cached, true);
    assert.equal(off.execution.execution_id, id);
    assert.equal((await st.confirmOwnership(id, 1)).confirmed, false, "a transport failure never confirms");
    fake.state.down = false;
    assert.equal((await st.release(id, { fence: 1 })).ok, true);
    assert.equal((await st.renew(id, { fence: 1 })).code, "not_owned");
  } finally {
    await fake.close();
  }
});

test("remote adapter, a partition: events owed during the outage are spooled to the outbox in order, replayed ahead of the next event on reconnect, and a re-delivery of one the server already recorded is a no-op — replay converges", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("partition");
    const cfg = remoteCfg(home, fake.base);
    const st = store.openExecutionStore(cfg, { home });
    const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }, { id: "review" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await st.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // The partition.
    fake.state.down = true;
    const d1 = await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } });
    assert.equal(d1.ok, false);
    assert.equal(d1.deferred, true);
    assert.equal(d1.transient, true);
    assert.equal(d1.pending, 1);
    const d2 = await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "review", attempt: 1, state: "passed" } });
    assert.equal(d2.pending, 2);
    const owed = st.outbox(id);
    assert.deepEqual(owed.map((l) => l.event.gate_id), ["acceptance", "review"], "the durable local evidence, in order");
    assert.ok(owed.every((l) => l.event.idempotency_key), "each spooled event carries its key");
    assert.equal((await st.confirmOwnership(id, 1)).confirmed, false, "nothing confirms while events are owed and the store is unreachable");
    // Reconnect: the next event replays what is owed FIRST, in order.
    fake.state.down = false;
    const before = fake.state.requests.length;
    const c = await st.event(id, { fence: 1, event: { type: "completion.written", resolver: "art-completion-x" } });
    assert.equal(c.ok, true, c.message);
    assert.equal(c.replayed, 2);
    const sent = fake.state.requests.slice(before).filter((q) => q.method === "POST").map((q) => `${q.body.event.type}${q.body.event.gate_id ? `:${q.body.event.gate_id}` : ""}`);
    assert.deepEqual(sent, ["gate.settled:acceptance", "gate.settled:review", "completion.written"]);
    assert.deepEqual(st.outbox(id), [], "the outbox is empty once the server answered for every line");
    assert.equal(fake.record(id).stage, "completed");
    // Re-delivering a recorded event (a crash between the server's answer and
    // the un-spool) is idempotent: replayed, never a second row.
    const rr = await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "review", attempt: 1, state: "passed" } });
    assert.equal(rr.ok, true);
    assert.equal(fake.record(id).seq, 4, "no second row for a replayed key");
    assert.equal(fake.events(id).filter((e) => e.type === "gate.settled").length, 2);
  } finally {
    await fake.close();
  }
});

test("remote adapter, ownership lost: a takeover of an expired lease fences the first worker out — its spooled events are kept as evidence, confirmOwnership refuses, and the completion write does NOT write the resolving edge", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("takeover");
    const a = store.openExecutionStore(remoteCfg(home, fake.base, "tok-a"), { home });
    const b = store.openExecutionStore(remoteCfg(tmp("takeover-b"), fake.base, "tok-b"), { home: tmp("takeover-b-home") });
    const o = await a.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await a.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // A's box drops off; its gate verdict is spooled.
    fake.state.down = true;
    assert.equal((await a.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } })).deferred, true);
    fake.state.down = false;
    // B cannot take a LIVE lease...
    assert.equal((await b.claim(id, {})).code, "already_owned");
    assert.equal((await b.claim(id, { takeover: true })).code, "lease_live");
    // ...but once it expired, B's plain claim advances the fence.
    fake.expireLease(id);
    const taken = await b.claim(id, {});
    assert.equal(taken.ok, true);
    assert.equal(taken.fence, 2);
    // A's replay is refused as fence_stale; the evidence stays spooled.
    const c = await a.confirmOwnership(id, 1);
    assert.equal(c.confirmed, false);
    assert.equal(c.ownership, false);
    assert.match(c.reason, /fence_stale/);
    assert.equal(a.outbox(id).length, 1, "the owed event is kept, not dropped");
    // The completion write, through lib/shell/completion.js with the store's
    // door: the fence check runs before the resolver and refuses.
    const writes = [];
    const record = { run_id: "run-1", node_id: "task-x", impl_claim: { execution_id: id, completion: { by: "controller", after: "gates" }, resolving_snapshot: [], status_snapshot: "open", store: "remote", fence: 1 }, impl_state: "candidate", impl_candidate: CAND, gates_state: "passed" };
    const deps = {
      readItem: async () => ({ ok: true, status: "open", type: "task", terminal: false, execution: id, executionAt: T0, revision: "r1", raw: itemNode("task-x", { extra: `execution: ${id}\n` }), inbound: [], resolvedBy: null, giveUp: false }),
      casWrite: async () => {
        writes.push("cas");
        return { ok: true, revision: "r2" };
      },
      writeNode: async (nid) => {
        writes.push(`node:${nid}`);
        return { ok: true };
      },
      readNode: async () => null,
      addEdge: async () => ({ ok: true }),
      removeEdge: async () => ({ ok: true }),
      completionStatus: () => "done",
      stamp: () => null,
      stampImpl: () => null,
      now: () => Date.now(),
      execution: { confirm: () => a.confirmOwnership(id, 1), completed: async () => {}, ended: async () => {} },
    };
    const w = await completionShell.writeCompletion({ record, deps, facts: [], boundary: "gates" });
    assert.equal(w.ok, false);
    assert.equal(w.retry, true);
    assert.match(w.reason, /execution fence could not be confirmed/);
    assert.deepEqual(writes, [], "no resolver, no CAS: the resolving edge is never written on local state alone");
    // B, the live owner, finishes the pipeline under fence 2.
    assert.equal((await b.event(id, { fence: 2, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } })).ok, true);
    assert.equal((await b.confirmOwnership(id, 2)).confirmed, true);
  } finally {
    await fake.close();
  }
});

test("remote adapter: a permanent refusal of one spooled event drops that event and keeps replaying; a terminal execution drops the rest", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("rejected");
    const logs = [];
    const st = store.openExecutionStore(remoteCfg(home, fake.base), { home, log: (l) => logs.push(l) });
    const o = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    fake.state.down = true;
    await st.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } });
    await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "scoping", attempt: 1, state: "failed" } }); // not a pinned gate
    await st.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" } });
    fake.state.down = false;
    const r = await st.reconcile(id, { fence: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.replayed, 2);
    assert.equal(r.pending, 0);
    assert.ok(logs.some((l) => /unknown_gate/.test(l) && /dropped/.test(l)), logs.join("\n"));
    assert.equal(fake.record(id).gate_results[0].state, "passed");
    // Terminal: anything still owed can never land.
    assert.equal((await st.event(id, { fence: 1, event: { type: "completion.written", resolver: "art-x" } })).ok, true);
    fake.state.down = true;
    await st.event(id, { fence: 1, event: { type: "stage.observed", attempt: 1, state: "running" } });
    fake.state.down = false;
    const t = await st.reconcile(id, { fence: 1 });
    assert.equal(t.terminal, true);
    assert.deepEqual(st.outbox(id), []);
  } finally {
    await fake.close();
  }
});

// ---------- 4. the CLI wiring ----------

test("bin/spor.js, remote mode: claimExecutionHold opens the hosted execution, names the store, the tenant, the attempt and the fence on the claim, and the hold on the item carries the server's id; a second worker's claim is refused while the lease is live", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("cli-remote");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
    const lines = [];
    const held = await spor.claimExecutionHold(cfg, { id: "task-x", project: "spor" }, factory, { home, log: (l) => lines.push(l) });
    assert.equal(held.ok, true, held.reason);
    assert.equal(held.store, "remote");
    assert.equal(held.fence, 1);
    const claim = held.recordFields.impl_claim;
    assert.equal(claim.execution_id, kernel.executionIdFor({ tenant: "acme", node_id: "task-x", factory: "factory-t", pipeline_attempt: 1 }, sha256));
    assert.equal(claim.store, "remote");
    assert.equal(claim.tenant, "acme");
    assert.equal(claim.pipeline_attempt, 1);
    assert.equal(claim.worker, "agent-a");
    assert.deepEqual(claim.gates, ["acceptance"]);
    assert.match(fake.state.nodes.get("task-x"), new RegExp(`^execution: ${claim.execution_id}$`, "m"), "the item's hold names the server's id");
    const opened = fake.state.requests.find((q) => q.method === "POST" && q.path === "/v1/executions");
    assert.deepEqual(opened.body, { node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates", repo: "spor", machine: os.hostname(), instance: spor.executionInstance() });
    assert.ok(fake.state.requests.some((q) => q.path.endsWith("/events") && q.body.event.type === "stage.started" && q.body.fence === 1), "stage.started rides the fence");
    assert.match(lines.join("\n"), /remote store, fence 1/);
    // Another worker: the server refuses, so does the claim.
    const other = remoteCfg(tmp("cli-remote-b"), fake.base, "tok-b");
    const second = await spor.claimExecutionHold(other, { id: "task-x" }, factory, { home: tmp("cli-remote-b-home") });
    assert.equal(second.ok, false);
    assert.equal(second.kind, "foreign-hold");
    assert.match(second.reason, /agent-a/);
    // The reporter for the record: a resume re-claims under the same fence;
    // the completion deps confirm; `spor executions` reads it back.
    const record = { run_id: "run-1", node_id: "task-x", ...held.recordFields };
    const p = dispatchRuns.runPaths(home, "run-1");
    fs.mkdirSync(path.dirname(p.record), { recursive: true });
    fs.writeFileSync(p.record, JSON.stringify(record));
    const reporter = spor.executionReporter(cfg, record, { home, log: (l) => lines.push(l) });
    assert.ok(reporter);
    const resumed = await reporter.resume();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.fence, 1);
    assert.ok(spor.LIVE_EXECUTIONS.has(reporter.id));
    await spor.renewLiveExecutions();
    assert.ok(fake.state.requests.filter((q) => q.path.endsWith("/renew")).length >= 1, "the heartbeat renews");
    // The gate-deps seams: a pinned candidate and a recorded fact report.
    const wrapped = spor.reportingGateDeps({ pinCandidate: async () => ({ ok: true, change: "created", candidate: CAND }), recordFact: async () => ({ ok: true }), escalate: async () => ({ ok: true, id: "task-gate-x" }) }, reporter);
    await wrapped.pinCandidate({});
    await wrapped.gateEvidenceRecorded({ id: "art-gate-1", markdown: "", nodeId: "task-x", gate: { id: "acceptance", kind: "command" }, verdict: "passed" });
    await wrapped.gateEvidenceRecorded({ id: "art-gate-2", markdown: "", nodeId: "task-x", gate: { id: "scoping", kind: "scoping" }, verdict: "scoped" }); // synthetic: not reported
    const types = fake.state.requests.filter((q) => q.path.endsWith("/events") && q.method === "POST").map((q) => `${q.body.event.type}${q.body.event.gate_id ? `:${q.body.event.gate_id}` : ""}`);
    assert.deepEqual(types, ["stage.started", "candidate.submitted", "candidate.published", "gate.settled:acceptance"]);
    const rec = fake.record(reporter.id);
    assert.equal(rec.boundary_reached, undefined);
    assert.equal(kernel.boundaryReached(rec), true);
    const confirmed = await reporter.confirm();
    assert.equal(confirmed.confirmed, true);
    await wrapped.escalate({ gate: { id: "acceptance" } });
    assert.equal(fake.record(reporter.id).escalations[0].node_id, "task-gate-x");
    assert.equal(fake.record(reporter.id).stage, "gating", "a gate escalation leaves the execution live: the item stays held under it");
    reporter.leave();
    assert.ok(!spor.LIVE_EXECUTIONS.has(reporter.id));
    // The read verb.
    const { spawnSync } = require("node:child_process");
    const cli = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "spor.js"), "executions", reporter.id], { env: { ...process.env, SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: fake.base, SPOR_TOKEN: "tok-a", SPOR_DISPATCH_AGENT: "agent-a" }, cwd: home, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp(`^${reporter.id}  gating \\(boundary reached\\)`, "m"));
    assert.match(cli.stdout, /gate acceptance: passed \(attempt 1\)/);
    assert.ok(cli.stdout.includes(`owner agent-a on ${os.hostname()}`), cli.stdout);
    const list = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "spor.js"), "executions", "--node", "task-x", "--json"], { env: { ...process.env, SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: fake.base, SPOR_TOKEN: "tok-a" }, cwd: home, encoding: "utf8" });
    assert.equal(JSON.parse(list.stdout).count, 1);
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

test("bin/spor.js, remote mode against a server that does not serve /v1/executions: the claim falls back to the machine-local store, stamps `store: local`, and the hold refused after an open ends the execution so the item pointer is freed", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "task-held": itemNode("task-held", { extra: "execution: exec-someone-else\n" }), "factory-t": itemNode("factory-t") } });
  try {
    fake.state.unserved = true;
    const home = tmp("cli-unserved");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true", rejudge_on_repin: false }], completion: { by: "controller" } });
    const lines = [];
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home, log: (l) => lines.push(l) });
    assert.equal(held.ok, true, held.reason);
    assert.equal(held.store, "local");
    assert.equal(held.recordFields.impl_claim.store, "local");
    assert.equal(held.recordFields.impl_claim.tenant, "local");
    assert.ok(lines.some((l) => /does not serve \/v1\/executions/.test(l)), lines.join("\n"));
    assert.equal(store.readItem(home, "local", "task-x").open, held.executionId);
    assert.equal(store.readRecord(home, "local", held.executionId).factory.gates[0].rejudge_on_repin, false, "parsed command opt-out survives CLI local pin mapping");
    // The real older server's route-miss carries the standard envelope; it
    // falls back the same way (a served open's not_found names a node).
    fake.state.unserved = false;
    fake.state.unservedEnveloped = true;
    const home2 = tmp("cli-unserved-2");
    const held2 = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: home2 });
    assert.equal(held2.ok, true, held2.reason);
    assert.equal(held2.store, "local");
    fake.state.unservedEnveloped = false;
    // A SERVED open that cannot find the item is a refusal, never a fallback —
    // even when the node's own id carries the word.
    const missing = await spor.claimExecutionHold(cfg, { id: "task-edge-route-miss" }, factory, { home: tmp("cli-missing") });
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, "store");
    assert.match(missing.reason, /not_found/);
    fake.state.unserved = true;
    // A foreign hold on the item (a stale execution id from elsewhere): the
    // execution opened for it is ended rather than left holding the pointer.
    const refused = await spor.claimExecutionHold(cfg, { id: "task-held" }, factory, { home });
    assert.equal(refused.ok, false);
    assert.equal(refused.kind, "foreign-hold");
    assert.equal(store.readItem(home, "local", "task-held").open, null, "the pointer is freed");
    assert.equal(store.listExecutions(home, "local", { nodeId: "task-held" })[0].stage, "refused");
    // A server that is merely UNREACHABLE is a refusal, never a fallback.
    fake.state.unserved = false;
    fake.state.down = true;
    const off = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: tmp("cli-off") });
    assert.equal(off.ok, false);
    assert.equal(off.kind, "store");
    assert.match(off.reason, /offline/);
  } finally {
    await fake.close();
  }
});

test("reporter: a review gate's `reviewer-unavailable` verdict settles in the store as the infrastructure outage it is, never a skipped report", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("reviewer-unavailable");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "review", kind: "agent-review", profile: "profile-r", reviewer_retries: 1 }], completion: { by: "controller", after: "gates" } });
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home });
    assert.equal(held.ok, true, held.reason);
    const record = { run_id: "run-ru", node_id: "task-x", ...held.recordFields };
    const p = dispatchRuns.runPaths(home, "run-ru");
    fs.mkdirSync(path.dirname(p.record), { recursive: true });
    fs.writeFileSync(p.record, JSON.stringify(record));
    const reporter = spor.executionReporter(cfg, record, { home });
    assert.equal((await reporter.resume()).ok, true);
    await reporter.candidateSubmitted(CAND);
    const sent = await reporter.gateSettled("review", "reviewer-unavailable");
    assert.ok(!sent || !sent.skipped, "the settlement is sent, not skipped as an unknown verdict");
    assert.equal(fake.record(reporter.id).gate_results[0].state, "infrastructure");
    reporter.leave();
  } finally {
    await fake.close();
  }
});

test("reporter: attempt keys advance on every settlement of one gate and every integration pass — offline too — so a fix-cycle pass or a re-gate's landing is never dropped as a replay of the first attempt's key", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("attempts");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller", after: "integration" }, integration: { target_ref: "main", strategy: "merge", command: "true" } });
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home });
    assert.equal(held.ok, true, held.reason);
    const record = { run_id: "run-1", node_id: "task-x", ...held.recordFields };
    const p = dispatchRuns.runPaths(home, "run-1");
    fs.mkdirSync(path.dirname(p.record), { recursive: true });
    fs.writeFileSync(p.record, JSON.stringify(record));
    const reporter = spor.executionReporter(cfg, record, { home });
    assert.equal((await reporter.resume()).ok, true);
    await reporter.candidateSubmitted(CAND);
    // Offline: a failure, then (after a fix cycle) a pass of the SAME gate.
    fake.state.down = true;
    await reporter.gateSettled("acceptance", "failed");
    await reporter.gateSettled("acceptance", "passed");
    const spooled = reporter.store.outbox(reporter.id).map((l) => l.event.idempotency_key);
    assert.deepEqual(spooled, [`${reporter.id}:acceptance:1`, `${reporter.id}:acceptance:2`], "two settlements, two keys, even with no server answer between them");
    reporter.leave();
    // The worker dies inside the partition. A SUCCESSOR pass (an orphan
    // resume) starts once the server is back: it seeds its counters from the
    // spooled backlog as well as the server's record, drains the backlog at
    // resume, and its own verdict lands under a fresh key behind it.
    fake.state.down = false;
    const successor = spor.executionReporter(cfg, record, { home });
    assert.equal((await successor.resume()).ok, true);
    assert.deepEqual(successor.store.outbox(successor.id), [], "the backlog is drained at resume");
    assert.equal(fake.record(successor.id).gate_results[0].attempt, 2);
    await successor.gateSettled("acceptance", "passed");
    assert.equal(fake.record(successor.id).gate_results[0].attempt, 3, "the successor's verdict is attempt 3, never a replay of 1");
    // A landing that failed, then a second pass that lands.
    await successor.integrationStarted();
    await successor.integrationSettled("failed");
    await successor.integrationStarted();
    await successor.integrationSettled("landed", { commit: "d".repeat(40) });
    const rec = fake.record(successor.id);
    assert.equal(rec.gate_results[0].state, "passed");
    assert.equal(rec.integration.state, "landed");
    assert.equal(rec.integration.attempt, 2);
    assert.equal(kernel.boundaryReached(rec), true);
    // A NEW pass (a re-gate on the same record) seeds from the server's record.
    const again = spor.executionReporter(cfg, record, { home });
    await again.resume();
    await again.gateSettled("acceptance", "passed");
    const keys = fake.events(successor.id).filter((e) => e.type === "gate.settled").map((e) => e.idempotency_key);
    assert.deepEqual(keys, [`${successor.id}:acceptance:1`, `${successor.id}:acceptance:2`, `${successor.id}:acceptance:3`, `${successor.id}:acceptance:4`]);
    successor.leave();
    again.leave();
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

// The pipeline's activities re-execute when their result never reached the
// journal: a re-sent verdict (gateEvidenceRecorded) or integration start
// (integrationStart) carries the journaled identity as its idempotency key, so
// the store records it ONCE instead of as a fresh attempt
// (issue-spor-slice5-leave-not-idempotent-and-regate-stamps-unowned).
test("reporter: a gate verdict or integration start re-sent under the same journaled key is recorded once", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("replay-keys");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller", after: "integration" }, integration: { target_ref: "main", strategy: "merge", command: "true" } });
    const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home });
    assert.equal(held.ok, true, held.reason);
    const record = { run_id: "run-1", node_id: "task-x", ...held.recordFields };
    const p = dispatchRuns.runPaths(home, "run-1");
    fs.mkdirSync(path.dirname(p.record), { recursive: true });
    fs.writeFileSync(p.record, JSON.stringify(record));
    const reporter = spor.executionReporter(cfg, record, { home });
    assert.equal((await reporter.resume()).ok, true);
    await reporter.candidateSubmitted(CAND);
    await reporter.gateSettled("acceptance", "passed", { key: "art-gate-x-1" });
    const settledAt = fake.record(reporter.id).gate_results[0].settled_at;
    await reporter.gateSettled("acceptance", "passed", { key: "art-gate-x-1" });
    // A successor pass (a crash, then the activity replayed) too.
    reporter.leave();
    const successor = spor.executionReporter(cfg, record, { home });
    assert.equal((await successor.resume()).ok, true);
    await successor.gateSettled("acceptance", "passed", { key: "art-gate-x-1" });
    const gates = fake.events(successor.id).filter((e) => e.type === "gate.settled");
    assert.equal(gates.length, 1, "one verdict, one event");
    assert.equal(fake.record(successor.id).gate_results[0].attempt, 1);
    assert.equal(fake.record(successor.id).gate_results[0].settled_at, settledAt, "the replay did not move the settle time");
    await successor.integrationStarted({ key: "run-1/pipeline/a0/integration/start" });
    await successor.integrationStarted({ key: "run-1/pipeline/a0/integration/start" });
    assert.equal(fake.events(successor.id).filter((e) => e.type === "integration.started").length, 1, "one start, one event");
    assert.equal(fake.record(successor.id).integration.attempt, 1);
    // The deduped start still advanced the local label; the settle carries its
    // own journaled key, so a LATER attempt's settle cannot land on a key this
    // one spent (review finding on the sweep).
    await successor.integrationSettled("failed", { key: "run-1/pipeline/a0/integration/stamp" });
    await successor.integrationSettled("failed", { key: "run-1/pipeline/a0/integration/stamp" });
    assert.equal(fake.events(successor.id).filter((e) => e.type === "integration.settled").length, 1, "one settle, one event");
    const later = spor.executionReporter(cfg, record, { home });
    assert.equal((await later.resume()).ok, true);
    await later.integrationStarted({ key: "run-1/pipeline/a1/integration/start" });
    await later.integrationSettled("landed", { commit: "d".repeat(40), key: "run-1/pipeline/a1/integration/stamp" });
    assert.equal(fake.record(successor.id).integration.state, "landed", "the later attempt's landing is recorded, not dropped as a replay");
    later.leave();
    // A different journaled identity is a new verdict.
    await successor.gateSettled("acceptance", "failed", { key: "art-gate-x-2" });
    assert.equal(fake.events(successor.id).filter((e) => e.type === "gate.settled").length, 2);
    successor.leave();
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

test("legacy and pre-adapter records report nothing: no impl_claim, or an impl_claim without a store, yields no reporter and byte-identical completion deps", () => {
  const cfg = loadConfig({ cwd: os.tmpdir(), env: { SPOR_HOME: tmp("legacy") } });
  assert.equal(spor.executionReporter(cfg, { run_id: "r", node_id: "task-x" }), null);
  assert.equal(spor.executionReporter(cfg, { run_id: "r", node_id: "task-x", impl_claim: { execution_id: "exec-old", completion: { by: "controller", after: "gates" } } }), null);
  assert.equal(spor.executionReporter(cfg, { run_id: "r", node_id: "task-x", impl_claim: { execution_id: "exec-old", store: "local", completion: { by: "agent", after: "gates" } } }), null);
  const deps = spor.makeCompletionDeps(cfg, { home: tmp("legacy-deps"), runId: null, execution: spor.executionCompletionDeps(null) });
  assert.equal("execution" in deps, false, "no store door on a legacy record");
  const plain = { pinCandidate: async () => 1 };
  assert.equal(spor.reportingGateDeps(plain, null), plain, "the deps object is untouched without a reporter");
});

// The per-process INSTANCE inside the (worker, machine) owner
// (issue-spor-execution-fence-shared-by-same-agent-processes). The parity
// vector is the server's lib-engine/test/execution.test.js case verbatim, so
// the client port and the hosted reducer agree on the fence arithmetic.
test("kernel parity: a re-claim by a different process instance of the same (worker, machine) advances the fence; an instance-less claim records none", () => {
  const LATE = later(3600);
  const T1 = later(1);
  const rec = kernel.claim(kernel.initExecution(SPEC, { sha256 }), { worker: "agent-one", machine: "box", instance: "p1", lease_expires_at: LATE, now: T0 }).record;
  assert.equal(rec.owner.instance, "p1");
  assert.equal(kernel.claim(rec, { worker: "agent-one", machine: "box", instance: "p1", lease_expires_at: LATE, now: T1 }).fence, 1, "a same-instance re-claim keeps the fence");
  const second = kernel.claim(rec, { worker: "agent-one", machine: "box", instance: "p2", lease_expires_at: LATE, now: T1 });
  assert.equal(second.ok, true, "a second instance of the live owner pair is admitted");
  assert.equal(second.fence, 2);
  assert.equal(second.record.owner.instance, "p2");
  const ghost = kernel.applyExecutionEvent(second.record, { type: "stage.started", attempt: 1, at: T1, fence: 1 }, {});
  assert.equal(ghost.code, "fence_stale", "the first process's writes are refused");
  assert.equal(kernel.claim(second.record, { worker: "agent-two", machine: "box", instance: "p3", lease_expires_at: LATE, now: T1 }).code, "already_owned", "the instance never admits a different owner pair");
  const legacy = kernel.claim(kernel.initExecution(SPEC, { sha256 }), { worker: "agent-one", machine: "box", lease_expires_at: LATE, now: T0 }).record;
  assert.equal("instance" in legacy.owner, false);
  assert.equal(kernel.claim(legacy, { worker: "agent-one", machine: "box", lease_expires_at: LATE, now: T1 }).fence, 1, "no instance on either side keeps the pair-only behavior");
});

test("local store: a second process instance of the same (worker, machine) re-opens at a NEW fence, the first's writes are refused, and only the same instance is echoed its fence", async () => {
  const home = tmp("instance-local");
  const pinRead = (id) => ({ revision: `rev-${id}`, repo: "spor" });
  const p1 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p1", pinRead });
  const p2 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p2", pinRead });
  const args = { node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" };
  const first = await p1.open(args);
  assert.equal(first.fence, 1);
  const id = first.execution.execution_id;
  assert.equal(first.execution.owner.instance, "p1");
  assert.equal((await p1.open(args)).fence, 1, "a same-instance re-open is echoed its fence");
  const second = await p2.open(args);
  assert.equal(second.ok, true, second.message);
  assert.equal(second.fence, 2, "a different instance re-opening advances the fence");
  assert.equal(second.execution.owner.instance, "p2");
  assert.equal((await p1.event(id, { fence: 1, event: { type: "stage.started", attempt: 1 } })).code, "fence_stale");
  assert.equal((await p1.renew(id, { fence: 1 })).code, "fence_stale");
  assert.equal((await p2.event(id, { fence: 2, event: { type: "stage.started", attempt: 1 } })).ok, true);
  // The first process LOST it: its re-open is refused locally rather than
  // fencing the second out in turn (issue-spor-execution-sticky-loss-gaps-
  // open-and-outbox). A third, fresh instance re-opening still advances it.
  assert.equal((await p1.open(args)).handed_off, true, "the loser never re-opens its way back to a fence");
  const p3 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p3", pinRead });
  const back = await p3.open(args);
  assert.equal(back.fence, 3, "a third process re-opening fences the second out in turn");
  const claimed = await p2.claim(id, {});
  assert.equal(claimed.fence, 4, "a claim by a different instance advances it too");
  assert.equal((await p2.claim(id, {})).fence, 4, "a same-instance re-claim keeps it");
});

test("remote adapter: every open and claim carries this process's instance (never a holder's), renew does not, and a second instance of the same owner pair fences the first out", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const p1 = store.openExecutionStore(remoteCfg(tmp("inst-a"), fake.base), { machine: "box", instance: "p1" });
    const p2 = store.openExecutionStore(remoteCfg(tmp("inst-b"), fake.base), { machine: "box", instance: "p2" });
    const args = { node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" };
    const first = await p1.open(args);
    assert.equal(first.fence, 1, JSON.stringify(first));
    const id = first.execution.execution_id;
    const second = await p2.open(args);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.fence, 2);
    assert.equal((await p1.renew(id, { fence: 1 })).code, "fence_stale", "the first process's lease cannot be renewed under its old fence");
    assert.equal((await p2.claim(id, { instance: "p1" })).fence, 2, "a same-instance re-claim keeps the fence; a caller-supplied instance is ignored");
    const posts = fake.state.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/executions"));
    for (const r of posts) {
      const owning = r.path === "/v1/executions" || r.path.endsWith("/claim");
      assert.equal("instance" in r.body, owning, `${r.path} ${owning ? "carries" : "omits"} the instance`);
    }
    assert.deepEqual(posts.filter((r) => r.path.endsWith("/claim")).map((r) => r.body.instance), ["p2"]);
    // An instance-less store keeps the shipped wire body byte-for-byte.
    const legacy = store.openExecutionStore(remoteCfg(tmp("inst-legacy"), fake.base), { machine: "box" });
    await legacy.claim(id, {});
    assert.equal("instance" in fake.state.requests[fake.state.requests.length - 1].body, false);
  } finally {
    await fake.close();
  }
});

test("bin/spor.js: one execution instance per process, opaque and within the server's 200-character bound", () => {
  const a = spor.executionInstance();
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0 && a.length <= 200);
  assert.equal(spor.executionInstance(), a, "stable for the life of the process");
});

// A process that LOSES the fence never re-claims that execution (the merge
// gate's livelock finding on issue-spor-execution-fence-shared-by-same-agent-
// processes). Two live processes of one owner would otherwise fence each other
// out every pass: each pass's reporter.resume() claims, and a different
// instance is admitted against the live lease and advances the fence. Each
// simulated PROCESS is a store instance (its own home and run-record copy);
// each PASS is a fresh reporter over a freshly opened store, as bin/spor.js
// opens one per pass.
function twoProcessFixture(fake, tag) {
  const proc = (instance) => {
    const home = tmp(`${tag}-${instance}`);
    const cfg = remoteCfg(home, fake.base);
    return { home, cfg, instance, open: () => store.openExecutionStore(cfg, { home, machine: "box", instance }) };
  };
  const seed = (p, record) => {
    const rp = dispatchRuns.runPaths(p.home, record.run_id);
    fs.mkdirSync(path.dirname(rp.record), { recursive: true });
    fs.writeFileSync(rp.record, JSON.stringify(record));
  };
  const pass = (p, record) => spor.executionReporter(p.cfg, record, { home: p.home, store: p.open() });
  return { proc, seed, pass };
}

async function openedRecord(p, runId) {
  const st = p.open();
  const opened = await st.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return {
    run_id: runId,
    node_id: "task-x",
    impl_claim: { execution_id: opened.execution.execution_id, store: "remote", fence: opened.fence, gates: ["acceptance"], completion: { by: "controller", after: "gates" } },
  };
}

test("two processes of one owner: B's claim advances the fence, A is refused fence_stale and then NEVER re-claims across later passes, and B completes", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const { proc, seed, pass } = twoProcessFixture(fake, "fenced-out");
    const A = proc("pA-fenced");
    const B = proc("pB-fenced");
    const record = await openedRecord(A, "run-fo");
    seed(A, record);
    seed(B, record);
    const id = record.impl_claim.execution_id;
    // A's pass 1 holds fence 1.
    const a1 = pass(A, record);
    assert.deepEqual(await a1.resume(), { ok: true, fence: 1 });
    // B (a second live process of the same worker on the same box) claims:
    // admitted against the live lease, the fence advances.
    const b1 = pass(B, record);
    assert.deepEqual(await b1.resume(), { ok: true, fence: 2 });
    // A's next write is refused; it loses ownership.
    const lost = await a1.candidateSubmitted(CAND);
    assert.equal(lost.code, "fence_stale");
    assert.equal(a1.owned, false);
    assert.equal(store.fencedOut("pA-fenced", id), 1, "the loss is recorded for A's process, at the fence it lost");
    assert.equal(store.fencedOut("pB-fenced", id), null);
    a1.leave();
    // A's later passes: the claim is refused LOCALLY — no claim reaches the
    // store, so the fence stays B's — and the item is handed off, not failed.
    const claimsBefore = fake.state.requests.filter((r) => r.path.endsWith("/claim")).length;
    for (let n = 0; n < 3; n++) {
      const again = pass(A, record);
      const r = await again.resume();
      assert.equal(r.ok, false);
      assert.equal(r.handed_off, true, "the execution is handed to the other process");
      assert.equal(again.owned, false);
      assert.equal((await again.confirm()).confirmed, false, "a handed-off process can never confirm a completion");
      assert.notEqual(spor.LIVE_EXECUTIONS.get(id), again, "A's pass is not registered for the heartbeat");
    }
    // Any store this process instance opens refuses, including a direct claim.
    assert.equal((await A.open().claim(id, {})).handed_off, true);
    assert.equal(fake.state.requests.filter((r) => r.path.endsWith("/claim")).length, claimsBefore, "no claim was sent for a lost execution");
    assert.equal(fake.record(id).owner.fence, 2);
    assert.equal(fake.record(id).owner.instance, "pB-fenced");
    assert.equal(fake.record(id).released_at ?? null, null, "nothing was released on the winner's behalf");
    // B works the execution through to completion across its own passes.
    const b2 = pass(B, record);
    assert.deepEqual(await b2.resume(), { ok: true, fence: 2 }, "B's same-instance re-claim keeps its fence");
    assert.equal((await b2.candidateSubmitted(CAND)).ok, true);
    assert.equal((await b2.gateSettled("acceptance", "passed")).ok, true);
    const confirmed = await b2.confirm();
    assert.equal(confirmed.confirmed, true, JSON.stringify(confirmed));
    assert.equal((await b2.completionWritten("art-x")).ok, true);
    assert.equal(fake.record(id).stage, "completed");
    b1.leave();
    b2.leave();
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

test("bin/spor.js callers stop at an execution THIS process lost: the gate pipeline is not run (no claim, no pipeline lease, nothing stamped) and the completion reconciler skips it", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-handoff": itemNode("task-handoff"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("callers-handed-off");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller", after: "gates" } });
    const held = await spor.claimExecutionHold(cfg, { id: "task-handoff" }, factory, { home });
    assert.equal(held.ok, true, held.reason);
    const record = { run_id: "run-ho", node_id: "task-handoff", ...held.recordFields };
    const rp = dispatchRuns.runPaths(home, "run-ho");
    fs.mkdirSync(path.dirname(rp.record), { recursive: true });
    fs.writeFileSync(rp.record, JSON.stringify(record));
    const id = record.impl_claim.execution_id;
    // A node id of its own: execution ids are content-addressed, and the loss
    // is recorded against THIS test runtime's real process instance.
    // This process (the real per-process instance) holds the execution; a
    // second process of the same worker claims it and this one is refused.
    const mine = spor.executionReporter(cfg, record, { home });
    assert.equal((await mine.resume()).ok, true);
    const other = store.openExecutionStore(remoteCfg(tmp("callers-other"), fake.base), { machine: os.hostname(), instance: "p-other-process" });
    assert.equal((await other.claim(id, {})).ok, true);
    assert.equal((await mine.candidateSubmitted(CAND)).code, "fence_stale");
    mine.leave();
    assert.notEqual(store.fencedOut(spor.executionInstance(), id), null);
    const claims = () => fake.state.requests.filter((r) => r.path.endsWith("/claim")).length;
    const before = claims();
    const lines = [];
    const res = await spor.runGateAndIntegration(cfg, { run_id: "run-ho", node_id: "task-handoff", project: "spor" }, record, { home, log: (l) => lines.push(l) });
    assert.equal(res.not_run, true);
    assert.equal(res.superseded, true, "shaped as a lost race: the loop stamps nothing");
    assert.equal(res.handed_off, true);
    const after = dispatchRuns.readJson(rp.record);
    assert.equal(after.gate_state ?? null, null, "nothing is stamped on the record");
    const winner = dispatchRuns.claimPipeline(home, "run-ho", { workerId: "the-winner", ownerLive: () => true });
    assert.equal(winner.refused ?? null, null, "the pipeline lease is left free for the process that holds the execution");
    await spor.reconcileCompletions(cfg, { home, log: (l) => lines.push(l) });
    assert.equal(claims(), before, "neither caller re-claimed the lost execution");
    assert.equal(fake.record(id).owner.instance, "p-other-process");
    assert.equal(fake.record(id).stage === "refused" || !!fake.record(id).released_at, false, "nothing ended on the winner's behalf");
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

// The loss covers the OPEN door too (issue-spor-execution-sticky-loss-gaps-
// open-and-outbox): a re-open of the item names no execution id, yet the
// kernel would re-claim the live execution for this (different) instance and
// advance the fence past the winner's — so a process that lost an item's
// execution is refused the re-open locally until that execution is terminal.
test("a process that lost an execution is refused a RE-OPEN of its item (no open reaches the store, the winner keeps its fence) until the lost execution is terminal", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const { proc, seed, pass } = twoProcessFixture(fake, "reopen");
    const A = proc("pA-reopen");
    const B = proc("pB-reopen");
    const record = await openedRecord(A, "run-ro");
    seed(A, record);
    seed(B, record);
    const id = record.impl_claim.execution_id;
    const args = { node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" };
    const a1 = pass(A, record);
    assert.deepEqual(await a1.resume(), { ok: true, fence: 1 });
    const b1 = pass(B, record);
    assert.deepEqual(await b1.resume(), { ok: true, fence: 2 });
    assert.equal((await a1.candidateSubmitted(CAND)).code, "fence_stale");
    a1.leave();
    const opens = () => fake.state.requests.filter((r) => r.method === "POST" && r.path === "/v1/executions").length;
    const before = opens();
    for (let n = 0; n < 2; n++) {
      const again = await A.open().open(args);
      assert.equal(again.ok, false);
      assert.equal(again.handed_off, true, "the re-open is refused as handed off");
      assert.equal(again.fence ?? null, null, "the loser is never handed a fence");
    }
    assert.equal(opens(), before, "no open was sent for the lost item");
    assert.equal(fake.record(id).owner.fence, 2);
    assert.equal(fake.record(id).owner.instance, "pB-reopen");
    // Once the winner ENDS the execution, an open addresses a new pipeline
    // attempt (a different execution), which the loser may take.
    assert.equal((await B.open().release(id, { fence: 2 })).ok, true);
    const fresh = await A.open().open(args);
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.notEqual(fresh.execution.execution_id, id, "a new pipeline attempt, never the lost execution");
    assert.equal(fresh.fence, 1);
    b1.leave();
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

test("local store: the re-open refusal holds in personal mode too — the lost item's live execution is never re-claimed by the loser", async () => {
  const home = tmp("reopen-local");
  const pinRead = (id) => ({ revision: `rev-${id}`, repo: "spor" });
  const p1 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p1-reopen", pinRead });
  const p2 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p2-reopen", pinRead });
  const args = { node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" };
  const first = await p1.open(args);
  const id = first.execution.execution_id;
  assert.equal((await p2.open(args)).fence, 2);
  assert.equal((await p1.renew(id, { fence: 1 })).code, "fence_stale");
  const again = await p1.open(args);
  assert.equal(again.handed_off, true);
  const rec = await p2.get(id);
  assert.equal(rec.execution.owner.instance, "p2-reopen", "the winner still holds it");
  assert.equal(rec.execution.owner.fence, 2);
});

test("bin/spor.js: claimExecutionHold for an item whose execution THIS process lost is refused as a foreign hold, with no open sent and no fence handed back", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-reopen": itemNode("task-reopen"), "factory-t": itemNode("factory-t") } });
  try {
    const home = tmp("hold-reopen");
    const cfg = remoteCfg(home, fake.base);
    const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller", after: "gates" } });
    const held = await spor.claimExecutionHold(cfg, { id: "task-reopen" }, factory, { home });
    assert.equal(held.ok, true, held.reason);
    const id = held.executionId;
    const record = { run_id: "run-hr", node_id: "task-reopen", ...held.recordFields };
    const rp = dispatchRuns.runPaths(home, "run-hr");
    fs.mkdirSync(path.dirname(rp.record), { recursive: true });
    fs.writeFileSync(rp.record, JSON.stringify(record));
    const mine = spor.executionReporter(cfg, record, { home });
    assert.equal((await mine.resume()).ok, true);
    const other = store.openExecutionStore(remoteCfg(tmp("hold-reopen-other"), fake.base), { machine: os.hostname(), instance: "p-hold-winner" });
    assert.equal((await other.claim(id, {})).ok, true);
    assert.equal((await mine.candidateSubmitted(CAND)).code, "fence_stale");
    mine.leave();
    const opens = () => fake.state.requests.filter((r) => r.method === "POST" && r.path === "/v1/executions").length;
    const before = opens();
    const again = await spor.claimExecutionHold(cfg, { id: "task-reopen" }, factory, { home });
    assert.equal(again.ok, false);
    assert.equal(again.kind, "foreign-hold");
    assert.equal(again.handed_off, true);
    assert.equal(again.fence ?? null, null);
    assert.equal(opens(), before, "the re-open never reached the store");
    assert.equal(fake.record(id).owner.instance, "p-hold-winner");
    assert.equal(fake.record(id).owner.fence, 2);
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

// The OUTBOX is keyed by process instance (issue-spor-execution-sticky-loss-
// gaps-open-and-outbox): two processes of one owner on one box share the
// outbox DIRECTORY, and the winner's reconcile must never send what the loser
// spooled under the winner's fence.
function sharedHomeFixture(fake, tag) {
  const home = tmp(tag);
  const cfg = remoteCfg(home, fake.base);
  return { home, cfg, open: (instance) => store.openExecutionStore(cfg, { home, machine: "box", instance }) };
}

test("outbox: a loser's spooled event is never replayed under the winner's fence — the winner replays only its own, and the loser drops its own when the loss is recorded", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const box = sharedHomeFixture(fake, "outbox-loser");
    const A = box.open("pA-outbox");
    const B = box.open("pB-outbox");
    const o = await A.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal(o.fence, 1);
    assert.equal((await A.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // B (a second live process of the same owner, same box) takes the fence.
    assert.equal((await B.claim(id, {})).fence, 2);
    // A, partitioned, spools a verdict it can no longer own.
    fake.state.down = true;
    const deferred = await A.event(id, { fence: 1, event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "failed" } });
    assert.equal(deferred.deferred, true);
    fake.state.down = false;
    assert.equal(A.outbox(id).length, 1, "the outbox shows what A owes");
    // B reconciles and sends its own verdict: A's line is not B's to send.
    const before = fake.state.requests.length;
    assert.equal((await B.reconcile(id, { fence: 2 })).replayed, 0, "nothing of A's is replayed by B");
    assert.equal((await B.event(id, { fence: 2, event: { type: "gate.settled", gate_id: "acceptance", attempt: 2, state: "passed" } })).ok, true);
    const sent = fake.state.requests.slice(before).filter((q) => q.path.endsWith("/events"));
    assert.deepEqual(sent.map((q) => [q.body.fence, q.body.event.attempt]), [[2, 2]], "only B's own event went out, under B's fence");
    assert.deepEqual(fake.events(id).filter((e) => e.type === "gate.settled").map((e) => e.state), ["passed"], "A's failed verdict never landed");
    // A's next call learns of the loss: its owed line is dropped, not left for B.
    assert.equal((await A.reconcile(id, { fence: 1 })).code, "fence_stale");
    assert.equal(store.fencedOut("pA-outbox", id), 1);
    assert.deepEqual(A.outbox(id), [], "the loser's owed events are dropped with the loss");
    assert.equal((await B.reconcile(id, { fence: 2 })).ok, true);
    assert.deepEqual(fake.events(id).filter((e) => e.type === "gate.settled").map((e) => e.state), ["passed"]);
  } finally {
    await fake.close();
  }
});

test("outbox: a GONE predecessor's backlog from before the takeover is adopted and replayed by the new holder; what it spooled after the takeover is dropped", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const box = sharedHomeFixture(fake, "outbox-dead");
    const A = box.open("pA-dead-outbox");
    const o = await A.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await A.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // A's process died with a partition backlog. Its file names a pid that is
    // gone (a reaped child's), on this machine.
    const { spawnSync } = require("node:child_process");
    const deadPid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    const by = { instance: "pA-dead-outbox", machine: "box", pid: Number(deadPid), ticks: null };
    const tag = sha256("pA-dead-outbox").slice(0, 16);
    const file = store.outboxPath(box.home, "remote", id, tag);
    const ev = (attempt, state) => ({ event: { type: "gate.settled", gate_id: "acceptance", attempt, state, idempotency_key: `${id}:acceptance:${attempt}` }, queued_at: new Date(Date.now() - 60000).toISOString(), by });
    fs.writeFileSync(file, `${JSON.stringify(ev(1, "passed"))}\n`);
    // The restarted process takes over...
    const B = box.open("pB-restarted-outbox");
    assert.equal((await B.claim(id, {})).fence, 2);
    // ...and a line the dead process queued AFTER that takeover is a stale-fence write.
    fs.appendFileSync(file, `${JSON.stringify({ ...ev(2, "failed"), queued_at: new Date(Date.now() + 1000).toISOString() })}\n`);
    const r = await B.reconcile(id, { fence: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.replayed, 1);
    assert.deepEqual(fake.events(id).filter((e) => e.type === "gate.settled").map((e) => [e.attempt, e.state]), [[1, "passed"]]);
    assert.equal(fs.existsSync(file), false, "the adopted file is gone");
    assert.deepEqual(B.outbox(id), []);
  } finally {
    await fake.close();
  }
});

test("outbox: adoption judges the FILE owner's liveness (a live holder carrying a dead predecessor's lines first is never raided), and a loser's forfeit hands adopted lines back for the real holder", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const box = sharedHomeFixture(fake, "outbox-owner");
    const { spawnSync } = require("node:child_process");
    const deadPid = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    const deadBy = { instance: "pA-gone-owner", machine: "box", pid: deadPid, ticks: null };
    const liveBy = { instance: "pB-live-owner", machine: "box", pid: process.pid, ticks: null };
    const line = (by, attempt, state, ago) => ({ event: { type: "gate.settled", gate_id: "acceptance", attempt, state }, queued_at: new Date(Date.now() - ago).toISOString(), by });
    const write = (file, lines) => fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // A (gone) left a backlog from while it held the execution.
    const deadFile = (id) => store.outboxPath(box.home, "remote", id, sha256("pA-gone-owner").slice(0, 16));
    const C = box.open("pC-loser-owner");
    const o = await C.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await C.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // 1. A LIVE holder's file whose first line is an adopted dead author's.
    const liveFile = store.outboxPath(box.home, "remote", id, sha256("pB-live-owner").slice(0, 16));
    write(liveFile, [line(deadBy, 1, "passed", 120000), line(liveBy, 2, "passed", 1000)]);
    assert.equal((await C.reconcile(id, { fence: 1 })).ok, true);
    assert.equal(fs.readFileSync(liveFile, "utf8").trim().split("\n").length, 2, "a live owner's file is left whole");
    fs.rmSync(liveFile);
    // 2. A gone predecessor's pre-takeover line, adopted by the LOSER, goes back on forfeit.
    write(deadFile(id), [line(deadBy, 1, "passed", 120000)]);
    const B = box.open("pB-winner-owner");
    assert.equal((await B.claim(id, {})).fence, 2);
    const lost = await C.reconcile(id, { fence: 1 });
    assert.equal(lost.code, "fence_stale");
    assert.equal(store.fencedOut("pC-loser-owner", id), 1);
    assert.deepEqual(C.outbox(id).map((l) => l.by.instance), ["pA-gone-owner"], "the adopted line is back in its author's file, not dropped");
    assert.equal(fs.existsSync(deadFile(id)), true);
    const r = await B.reconcile(id, { fence: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.replayed, 1, "the real holder replays the gone predecessor's backlog");
    assert.deepEqual(fake.events(id).filter((e) => e.type === "gate.settled").map((e) => [e.attempt, e.fence]), [[1, 2]]);
  } finally {
    await fake.close();
  }
});

test("outbox: a gone holder's file that holds ONLY lines it adopted is still adopted by the next holder — the file names its owner (held_by), not just each line's author", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const box = sharedHomeFixture(fake, "outbox-heldby");
    const { spawnSync } = require("node:child_process");
    const gone = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    const D = box.open("pD-heldby");
    const o = await D.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
    const id = o.execution.execution_id;
    assert.equal((await D.event(id, { fence: 1, event: { type: "candidate.submitted", candidate: CAND } })).ok, true);
    // D adopted a gone A's backlog into its own file, then D died too.
    const aBy = { instance: "pA-heldby", machine: "box", pid: gone(), ticks: null };
    const dBy = { instance: "pD-heldby", machine: "box", pid: gone(), ticks: null };
    const dFile = store.outboxPath(box.home, "remote", id, sha256("pD-heldby").slice(0, 16));
    fs.writeFileSync(dFile, `${JSON.stringify({ event: { type: "gate.settled", gate_id: "acceptance", attempt: 1, state: "passed" }, queued_at: new Date(Date.now() - 60000).toISOString(), by: aBy, held_by: dBy })}\n`);
    const F = box.open("pF-heldby");
    assert.equal((await F.claim(id, {})).fence, 2);
    const r = await F.reconcile(id, { fence: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.replayed, 1);
    assert.equal(fs.existsSync(dFile), false);
    assert.deepEqual(fake.events(id).filter((e) => e.type === "gate.settled").map((e) => [e.attempt, e.fence]), [[1, 2]]);
  } finally {
    await fake.close();
  }
});

test("restart takeover still works: a NEW process instance (no in-memory loss record) takes over the execution its dead predecessor held, at an advanced fence", async () => {
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") } });
  try {
    const { proc, seed, pass } = twoProcessFixture(fake, "restart");
    const old = proc("pA-dead");
    const record = await openedRecord(old, "run-rs");
    seed(old, record);
    const id = record.impl_claim.execution_id;
    const before = pass(old, record);
    assert.equal((await before.resume()).ok, true);
    before.leave();
    // The process dies with its lease still live; the restarted process shares
    // its home (same box, same run record) but is a new instance.
    const restarted = { ...old, instance: "pA-restarted", open: () => store.openExecutionStore(old.cfg, { home: old.home, machine: "box", instance: "pA-restarted" }) };
    const after = pass(restarted, record);
    assert.deepEqual(await after.resume(), { ok: true, fence: 2 }, "admitted against the live lease, the fence advances");
    assert.equal(fake.record(id).owner.instance, "pA-restarted");
    assert.equal((await after.candidateSubmitted(CAND)).ok, true);
    assert.equal((await after.gateSettled("acceptance", "passed")).ok, true);
    assert.equal((await after.confirm()).confirmed, true);
    assert.equal((await after.completionWritten("art-x")).ok, true);
    assert.equal(fake.record(id).stage, "completed");
    after.leave();
  } finally {
    spor.LIVE_EXECUTIONS.clear();
    await fake.close();
  }
});

test("store: a fence_stale on a fence this instance has since superseded with its OWN newer claim is not a loss", async () => {
  const home = tmp("own-stale");
  const pinRead = (id) => ({ revision: `rev-${id}`, repo: "spor" });
  const p1 = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p-own", pinRead });
  const opened = await p1.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
  const id = opened.execution.execution_id;
  const took = await p1.claim(id, { takeover: true });
  assert.equal(took.fence, 2, "an explicit takeover by this same instance advances its own fence");
  assert.equal((await p1.renew(id, { fence: 1 })).code, "fence_stale");
  assert.equal(store.fencedOut("p-own", id), null, "a stale fence of our own is not a loss to someone else");
  assert.equal((await p1.claim(id, {})).fence, 2);
});

// NOT a bug, by design (spor-server b5b0953, EXECUTION-STATE.md §4): an
// instance-LESS (legacy) claim against a record held by an instance-bearing
// process of the same owner pair is a different instance — it advances the
// fence and clears owner.instance.
test("an instance-less claim against an instance-bearing owner of the same pair advances the fence and clears owner.instance", async () => {
  const LATE = later(3600);
  const rec = kernel.claim(kernel.initExecution(SPEC, { sha256 }), { worker: "agent-one", machine: "box", instance: "p1", lease_expires_at: LATE, now: T0 }).record;
  const legacy = kernel.claim(rec, { worker: "agent-one", machine: "box", lease_expires_at: LATE, now: later(1) });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.fence, 2);
  assert.equal("instance" in legacy.record.owner, false, "the owner no longer names the instance-bearing process");
  // ...and the same through the local store.
  const home = tmp("legacy-vs-instance");
  const pinRead = (id) => ({ revision: `rev-${id}`, repo: "spor" });
  const withInstance = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", instance: "p-legacy-test", pinRead });
  const without = store.openExecutionStore(null, { home, mode: "local", worker: "agent-a", machine: "box", pinRead });
  const opened = await withInstance.open({ node_id: "task-x", factory: "factory-t", gates: [{ id: "acceptance" }], boundary: "gates" });
  const claimed = await without.claim(opened.execution.execution_id, {});
  assert.equal(claimed.fence, 2);
  assert.equal("instance" in claimed.execution.owner, false);
});

test("remote ownership belongs to the fixed agent and machine pair on every mutation", async () => {
  let clock = T0;
  const fake = await startFakeExecutionServer({ nodes: { "task-x": itemNode("task-x"), "factory-t": itemNode("factory-t") }, now: () => clock });
  try {
    const a = store.openExecutionStore(remoteCfg(tmp("pair-a"), fake.base), { machine: "box-a" });
    const b = store.openExecutionStore(remoteCfg(tmp("pair-b"), fake.base), { machine: "box-b" });
    const opened = await a.open({ node_id: "task-x", factory: "factory-t", gates: [], boundary: "gates" });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const id = opened.execution.execution_id;
    assert.equal(opened.execution.owner.machine, "box-a");
    assert.equal((await a.claim(id, {})).fence, opened.fence, "same pair retains fence");
    for (const result of [
      await b.claim(id, { machine: "box-a" }),
      await b.renew(id, { fence: opened.fence }),
      await b.release(id, { fence: opened.fence }),
      await b.event(id, { fence: opened.fence, event: { type: "stage.started", attempt: 1 } }),
    ]) assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(fake.record(id).owner.machine, "box-a");
    clock = later(3600);
    const takeover = await b.claim(id, { takeover: true });
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    assert.ok(takeover.fence > opened.fence);
    assert.equal((await a.renew(id, { fence: takeover.fence })).ok, false, "copying a new fence does not confer identity");
    const posts = fake.state.requests.filter(r => r.method === "POST" && r.path.startsWith("/v1/executions"));
    assert.ok(posts.every(r => ["box-a", "box-b"].includes(r.body.machine)));
    assert.equal(posts.find(r => r.path.endsWith("/claim") && r.body.machine === "box-b").body.machine, "box-b", "adapter never copies a caller-supplied holder machine");
  } finally { await fake.close(); }
});

test("reporter emits publication for an unchanged pin and settles only persisted facts against their judged candidate", async () => {
  const observed = [];
  const cfg = { userConfigHome: () => tmp("report-binding") };
  const claim = { execution_id: "exec-binding", store: "local", fence: 1, gates: ["acceptance"], completion: { by: "controller", after: "gates" } };
  const reporter = spor.executionReporter(cfg, { node_id: "task-x", run_id: "run-binding", impl_claim: claim }, {
    home: tmp("binding"), store: { event: async (_id, { event }) => { observed.push(event); return { ok: true }; } },
  });
  let factOk = false;
  const b = { ...CAND, candidate_id: "cand-new", supersedes: CAND.candidate_id };
  const wrapped = spor.reportingGateDeps({
    pinCandidate: async () => ({ ok: true, candidate: b, created: false }),
    recordFact: async () => ({ ok: factOk }),
  }, reporter);
  await wrapped.pinCandidate({});
  assert.deepEqual(observed.map(e => e.type), ["candidate.superseded", "candidate.published"]);
  const fact = { gate: { id: "acceptance", kind: "command" }, verdict: "passed", candidate_id: CAND.candidate_id };
  await wrapped.recordFact(fact);
  assert.equal(observed.length, 2, "a refused fact cannot produce successful gate evidence");
  factOk = true;
  await wrapped.recordFact(fact);
  assert.equal(observed.length, 2, "a bare fact still owes its payment confirmation");
  await wrapped.gateEvidenceRecorded(fact);
  assert.equal(observed[2].type, "gate.settled");
  assert.equal(observed[2].candidate_id, CAND.candidate_id, "late A fact remains bound to A after B pin");
  assert.equal(observed[2].attempt, 1, "refused writes do not spend settlement keys");
});

for (const failure of ['before-release', 'lost-ack', 'before-report', 'released-item-before-report']) test(`withdrawal persists execution release debt across ${failure}`, async t => {
  const fake = await startFakeExecutionServer({ nodes: { 'task-x': itemNode('task-x'), 'factory-t': itemNode('factory-t') } });
  const home = tmp('release-debt');
  t.after(async () => { spor.LIVE_EXECUTIONS.clear(); await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const cfg = remoteCfg(home, fake.base);
  const factory = factoryOf({ factory: 't', trusted_ref: 'main', gates: [{ id: 'acceptance', kind: 'command', command: 'true' }], completion: { by: 'controller' } });
  const held = await spor.claimExecutionHold(cfg, { id: 'task-x', project: 'spor' }, factory, { home });
  assert.equal(held.ok, true, held.reason);
  const record = { run_id: 'run-release-debt', node_id: 'task-x', state: 'done', gate_state: 'failed', ...held.recordFields };
  const p = dispatchRuns.runPaths(home, record.run_id);
  fs.mkdirSync(path.dirname(p.record), { recursive: true }); fs.writeFileSync(p.record, JSON.stringify(record));
  const reporter = spor.executionReporter(cfg, record, { home });
  await reporter.resume();
  // Release carries no process instance (only open/claim do), so it is served
  // by the fake's instance-less engine for this owner pair.
  const engine = [...fake.state.engines].find(([key]) => JSON.parse(key)[2] === null)[1];
  const release = engine.release.bind(engine);
  let calls = 0;
  engine.release = async (...args) => {
    calls++;
    if (calls === 1 && failure === 'before-release') return { ok: false, code: 'unavailable' };
    const result = await release(...args);
    if (calls === 1 && failure === 'lost-ack') return { ok: false, code: 'unavailable' };
    return result;
  };
  const execution = spor.executionCompletionDeps(reporter);
  if (failure.endsWith('before-report')) execution.ended = async () => { throw new Error('crash before report'); };
  const deps = spor.makeCompletionDeps(cfg, { home, runId: record.run_id, execution });
  const releasedItem = failure === 'released-item-before-report';
  if (releasedItem) fake.state.nodes.set('task-x', itemNode('task-x'));
  const withdrawn = releasedItem
    ? await completionShell.writeCompletion({ record, deps, boundary: 'gates' })
    : await completionShell.withdrawCompletion({ record, deps, why: 'person abandoned item' });
  assert.equal(withdrawn.settled, releasedItem ? 'released' : 'withdrawn');
  let saved = dispatchRuns.readJson(p.record);
  assert.ok(saved.completion_withdrawn_at);
  assert.ok(saved.completion_execution_end, 'settled completion must retain store debt');
  const originalStamp = saved.completion_withdrawn_at;
  reporter.leave();
  await spor.reconcileCompletions(cfg, { home });
  saved = dispatchRuns.readJson(p.record);
  assert.equal(saved.completion_execution_end, null);
  assert.equal(saved.completion_withdrawn_at, originalStamp);
  assert.ok(fake.record(held.executionId).released_at);
  const count = calls;
  await spor.reconcileCompletions(cfg, { home });
  assert.equal(calls, count, 'acknowledged release does not repeat');
});

test('execution boundary stays closed until flake payment and receipt persist, including restart', async t => {
  const fake = await startFakeExecutionServer({ nodes: { 'task-x': itemNode('task-x'), 'factory-t': itemNode('factory-t') } });
  const home = tmp('payment-boundary');
  t.after(async () => { spor.LIVE_EXECUTIONS.clear(); await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const cfg = remoteCfg(home, fake.base);
  const factory = factoryOf({ factory: 't', trusted_ref: 'main', gates: [{ id: 'acceptance', kind: 'command', command: 'true' }], completion: { by: 'controller' } });
  const held = await spor.claimExecutionHold(cfg, { id: 'task-x', project: 'spor' }, factory, { home });
  assert.equal(held.ok, true);
  const record = { run_id: 'run-payment-boundary', node_id: 'task-x', state: 'done', ...held.recordFields };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, record.run_id).record, record);
  const firstReporter = spor.executionReporter(cfg, record, { home });
  assert.equal((await firstReporter.resume()).ok, true);
  await firstReporter.candidateSubmitted(CAND);
  const change = { head: CAND.commit, base: 'base', trustedRef: 'main', trustedSha: 'trusted', branch: 'task-x' };
  let progress = { evidence: { gate: factory.gates[0], outcome: { passed: true, verdict: 'passed', flake: { issues: ['issue-flake'], files: ['test/off.js'], linked: [] } }, change, definition: factory.definition || null, candidate_id: CAND.candidate_id } };
  let allowPayment = false;
  const depsFor = reporter => spor.reportingGateDeps({
    changedPaths: async () => ({ ok: true, paths: ['lib/x.js'], ...change }),
    loadGateProgress: async () => JSON.parse(JSON.stringify(progress)),
    saveGateProgress: async ({ progress: p }) => { progress = JSON.parse(JSON.stringify(p)); },
    recordFact: async () => ({ ok: true, linked: [] }),
    linkFact: async () => ({ ok: allowPayment }),
    runSuite: async () => assert.fail('stored classified outcome must survive restart'),
    demote: async () => ({ ok: true }),
  }, reporter);
  const run = reporter => require('../lib/shell/gate-runner.js').runGatePipeline({ item: record, factory, deps: depsFor(reporter) });
  assert.equal((await run(firstReporter)).state, 'interrupted');
  assert.equal(kernel.boundaryReached(fake.record(firstReporter.id)), false);
  assert.equal(progress.evidence.complete, false);
  firstReporter.leave();
  const resumedReporter = spor.executionReporter(cfg, record, { home });
  assert.equal((await resumedReporter.resume()).ok, true);
  allowPayment = true;
  assert.equal((await run(resumedReporter)).state, 'passed');
  const durable = fake.record(resumedReporter.id);
  assert.equal(progress.evidence.complete, true);
  assert.equal(kernel.boundaryReached(durable), true);
  assert.equal(durable.gate_results[0].candidate_id, CAND.candidate_id);
  const settlements = fake.state.requests.filter(q => q.path.endsWith('/events') && q.body?.event?.type === 'gate.settled');
  assert.equal(settlements.length, 1);
});
