"use strict";
// The work loop's one durable outcome door (lib/shell/work-outcome.js) and the
// shared run-identity token (lib/shell/process-identity.js) —
// task-spor-extract-work-loop-plan-execute-and-outcome-door.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const door = require("../lib/shell/work-outcome.js");
const identity = require("../lib/shell/process-identity.js");

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-outcome-"));
const debtFiles = (home) => {
  try {
    return fs.readdirSync(door.journalDir(home));
  } catch {
    return [];
  }
};

// A fake store + graph whose calls are journaled in order.
function world({ terminate = null, get = null, clear = null } = {}) {
  const calls = [];
  const graph = { hold: "exec-1" };
  const state = { terminal: false };
  const store = {
    terminate: async (id, opts) => {
      calls.push(["terminate", id, opts.fence]);
      if (terminate) return terminate(id, opts, state);
      state.terminal = true;
      return { ok: true };
    },
    get: async (id) => {
      calls.push(["get", id]);
      if (get) return get(id, state);
      return { ok: true, execution: { execution_id: id, terminal: state.terminal } };
    },
  };
  const clearHold = async ({ nodeId, executionId }) => {
    calls.push(["clearHold", nodeId, executionId]);
    if (clear) return clear({ nodeId, executionId }, graph);
    if (graph.hold && graph.hold !== executionId) return { ok: false, foreign: true, holder: graph.hold, reason: `held by ${graph.hold}` };
    const had = !!graph.hold;
    graph.hold = null;
    return { ok: true, cleared: had };
  };
  return { calls, graph, state, store, openStore: () => store, clearHold };
}
const debt = (over = {}) => ({ node_id: "task-x", execution_id: "exec-1", fence: 3, store: "local", reason: "refused", origin: { mode: "local", nodes: "/g" }, ...over });

test("withdrawExecution ends the execution and confirms it BEFORE the graph hold is cleared, and retires its debt", async () => {
  const home = tmpHome();
  const w = world();
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.ok, true);
  assert.equal(r.terminated, true);
  assert.equal(r.cleared, true);
  assert.deepEqual(w.calls.map((c) => c[0]), ["terminate", "get", "clearHold"]);
  assert.equal(w.calls[0][2], 3, "under the claim's fence");
  assert.equal(w.graph.hold, null);
  assert.deepEqual(debtFiles(home), []);
});

test("a failed or ambiguous terminate keeps the graph hold and the debt; the next pass converges", async () => {
  const home = tmpHome();
  let down = true;
  const w = world({
    terminate: async (id, opts, state) => {
      if (down) return { ok: false, transport: true, code: "transport", message: "offline" };
      state.terminal = true;
      return { ok: true };
    },
  });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.equal(w.graph.hold, "exec-1", "the item stays held while the store still holds it");
  assert.ok(!w.calls.some((c) => c[0] === "clearHold"), "the graph was never touched");
  assert.equal(debtFiles(home).length, 1);
  down = false;
  const again = await door.reconcileWithdrawals({ home, origin: debt().origin, openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(again.length, 1);
  assert.equal(again[0].ok, true);
  assert.equal(w.graph.hold, null);
  assert.deepEqual(debtFiles(home), []);
});

test("a cached (non-authoritative) read is not proof the execution ended", async () => {
  const home = tmpHome();
  const w = world({ get: async (id) => ({ ok: true, cached: true, execution: { execution_id: id, terminal: true } }) });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.pending, true);
  assert.equal(w.graph.hold, "exec-1");
});

test("an interruption between ending the execution and clearing the hold is re-driven: replay converges without a second ending", async () => {
  const home = tmpHome();
  let crash = true;
  const w = world({
    clear: async ({ executionId }, graph) => {
      if (crash) throw new Error("killed mid-step");
      graph.hold = graph.hold === executionId ? null : graph.hold;
      return { ok: true, cleared: true };
    },
  });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.pending, true);
  assert.equal(w.state.terminal, true);
  assert.equal(w.graph.hold, "exec-1");
  crash = false;
  // The store now answers an already-ended execution; the replay confirms it
  // by the read, not by the terminate's own answer.
  w.store.terminate = async () => ({ ok: false, code: "execution_terminal", message: "already ended" });
  const [again] = await door.reconcileWithdrawals({ home, origin: debt().origin, openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(again.ok, true);
  assert.equal(w.graph.hold, null);
  assert.deepEqual(debtFiles(home), []);
});

test("recovery never clears a hold that now names a NEWER execution", async () => {
  const home = tmpHome();
  const w = world();
  w.graph.hold = "exec-2";
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.ok, true);
  assert.equal(r.preserved, "exec-2");
  assert.equal(w.graph.hold, "exec-2");
  assert.deepEqual(debtFiles(home), []);
});

test("a fence another holder superseded retires the debt and leaves the hold for its owner", async () => {
  const home = tmpHome();
  const w = world({ terminate: async () => ({ ok: false, code: "fence_stale", message: "superseded" }) });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.ok, false);
  assert.equal(r.pending, false);
  assert.equal(r.retained, true);
  assert.equal(w.graph.hold, "exec-1");
  assert.match(r.reason, /spor release task-x --execution exec-1/);
  assert.deepEqual(debtFiles(home), []);
});

test("a lease that EXPIRED while the withdrawal was owed is re-claimed and ended — not stranded under the hold", async () => {
  const home = tmpHome();
  const w = world({
    terminate: async (id, { fence }, state) => {
      if (fence === 3) return { ok: false, code: "lease_expired", message: "lapsed" };
      state.terminal = true;
      return { ok: true };
    },
  });
  w.store.claim = async (id) => {
    w.calls.push(["claim", id]);
    return { ok: true, fence: 4 };
  };
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.map((c) => c[0]), ["terminate", "claim", "terminate", "get", "clearHold"]);
  assert.equal(w.calls[2][2], 4, "ended under the re-claimed fence");
  assert.equal(w.graph.hold, null);
});

test("a transient failure after the re-claim is re-driven under the NEW fence", async () => {
  const home = tmpHome();
  let down = true;
  const w = world({
    terminate: async (id, { fence }, state) => {
      if (fence === 3) return { ok: false, code: "lease_expired", message: "lapsed" };
      if (fence !== 4) return { ok: false, code: "fence_stale", message: "superseded" };
      if (down) return { ok: false, transport: true };
      state.terminal = true;
      return { ok: true };
    },
  });
  w.store.claim = async () => ({ ok: true, fence: 4 });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.pending, true);
  const [name] = debtFiles(home);
  assert.equal(JSON.parse(fs.readFileSync(path.join(door.journalDir(home), name), "utf8")).fence, 4);
  down = false;
  const [again] = await door.reconcileWithdrawals({ home, origin: debt().origin, openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(again.ok, true);
  assert.equal(w.graph.hold, null);
});

test("an expired lease someone else took over meanwhile is theirs: the hold is left", async () => {
  const home = tmpHome();
  const w = world({ terminate: async () => ({ ok: false, code: "lease_expired", message: "lapsed" }) });
  w.store.claim = async () => ({ ok: false, code: "lease_live", message: "held by another worker" });
  const r = await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(r.retained, true);
  assert.equal(w.graph.hold, "exec-1");
  assert.deepEqual(debtFiles(home), []);
});

test("a pre-adapter claim (no store) only clears the exact hold", async () => {
  const home = tmpHome();
  const w = world();
  const r = await door.withdrawExecution({ home, debt: debt({ store: null }), openStore: () => assert.fail("no store to open"), clearHold: w.clearHold });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.map((c) => c[0]), ["clearHold"]);
});

test("reconcileWithdrawals re-drives only the debts owned by the current origin", async () => {
  const home = tmpHome();
  const w = world({ terminate: async () => ({ ok: false, transport: true }) });
  await door.withdrawExecution({ home, debt: debt(), openStore: w.openStore, clearHold: w.clearHold });
  assert.equal(debtFiles(home).length, 1);
  const other = await door.reconcileWithdrawals({ home, origin: { mode: "remote", server: "https://elsewhere" }, openStore: w.openStore, clearHold: w.clearHold });
  assert.deepEqual(other, []);
});

test("settleIdleStop closes the record BEFORE releasing the lease, and releases only a run that ENDED", async () => {
  const order = [];
  const run = async (stopped) =>
    door.settleIdleStop({
      record: { run_id: "r1" },
      idleMs: 1000,
      quietAt: 0,
      outcome: null,
      stopIdleRun: async (r) => {
        order.push("close");
        return { record: { ...r, state: "failed" }, stopped };
      },
      releaseLease: async (closed, { ended }) => {
        order.push(`release:${ended}`);
        assert.equal(closed.state, "failed", "the lease leg sees the CLOSED record");
        return { ...closed, lease_released: ended };
      },
    });
  const a = await run({ child: true, alive: false });
  assert.equal(a.ended, true);
  assert.equal(a.record.lease_released, true);
  const b = await run({ child: true, alive: true });
  assert.equal(b.ended, false);
  const c = await run({ alive: false });
  assert.equal(c.ended, false, "nothing of ours was signalled: we only stopped following it");
  assert.deepEqual(order, ["close", "release:true", "close", "release:false", "close", "release:false"]);
});

test("isOurProcess: a live pid with matching ticks is ours; a mismatch (a recycled pid) is not; no ticks is unverified but alive", () => {
  const readTicks = () => 42;
  assert.deepEqual(identity.isOurProcess(process.pid, 42, { readTicks }), { reallyAlive: true, identityKnown: true });
  assert.deepEqual(identity.isOurProcess(process.pid, 41, { readTicks }), { reallyAlive: false, identityKnown: true });
  assert.deepEqual(identity.isOurProcess(process.pid, null, { readTicks }), { reallyAlive: true, identityKnown: false });
  // The raw /proc spelling an older lock file stored is the same instant.
  assert.deepEqual(identity.isOurProcess(process.pid, "42", { readTicks }), { reallyAlive: true, identityKnown: true });
  assert.deepEqual(identity.isOurProcess(0, 42, { readTicks }), { reallyAlive: false, identityKnown: false });
  assert.deepEqual(identity.isOurProcess(-5), { reallyAlive: false, identityKnown: false });
});

test("mintIdentity records this process's pid and start ticks, and verifies against itself", () => {
  const me = identity.mintIdentity();
  assert.equal(me.pid, process.pid);
  assert.equal(identity.isOurProcess(me.pid, me.ticks).reallyAlive, true);
  if (process.platform === "linux") assert.equal(typeof me.ticks, "number");
});

test("the run store, the local execution lock and the spool all read the ONE identity check", () => {
  const runner = require("../lib/shell/agent-dispatch-runner.js");
  assert.equal(runner.processStartTicks, identity.processStartTicks);
  assert.equal(runner.supervisorAliveProbe, identity.aliveProbe);
  assert.deepEqual(runner.isSameSupervisor(process.pid, 7, { readTicks: () => 8 }), identity.isOurProcess(process.pid, 7, { readTicks: () => 8 }));
  for (const f of ["lib/shell/local-execution-lock.js", "lib/shell/spool.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.match(src, /require\("\.\/process-identity\.js"\)/, `${f} uses the shared identity`);
    assert.doesNotMatch(src, /\/proc\/\$\{/, `${f} carries no copy of the /proc ticks read`);
  }
});
