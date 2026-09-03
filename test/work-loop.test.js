// `spor work` — the pull-based continuous worker loop over the queue
// (task-spor-work-loop). Two layers:
//
//   1. the LOOP itself (lib/shell/work-loop.js), driven with a fake clock, a
//      fake queue and a fake dispatcher — slot accounting, terminal-state
//      harvesting, refusal cooldowns, backoff, the stop paths, and the status
//      store;
//   2. the CLI wiring, end to end against a real (declared, fake) harness in a
//      scratch graph home — never the live graph (norm-cc-scratch-home-for-tests).
//
// The one thing these must keep proving is that the loop adds NO eligibility
// rule of its own beyond "not human-readiness, accepted by the work.accept
// policy, not already in flight here": every refusal is `spor dispatch`'s,
// reached by calling it.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const workLoop = require("../lib/shell/work-loop.js");
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode } = require("./helpers/portable");

// ---------------------------------------------------------------- the loop --

// A driver that runs the loop with no real clock, no real queue and no real
// dispatch: `queue` is the page each poll returns, `dispatch` decides ok/refused
// per item, and every launched run stays non-terminal until `finish()` says so.
function harness({ queue = [], dispatch = () => ({ ok: true }), pollRuns = null, onTick = () => {}, opts = {}, maxPasses = 20, gate = null } = {}) {
  const state = {
    clock: 1_700_000_000_000,
    sleeps: [],
    dispatched: [],
    polls: 0,
    runs: new Map(), // run_id -> record ({terminal:false} until finish() says otherwise)
    log: [],
    published: [],
  };
  const control = { stopping: false, reason: null, wake: () => {} };
  let seq = 0;
  const deps = {
    now: () => state.clock,
    log: (l) => state.log.push(l),
    publish: (s) => state.published.push(JSON.parse(JSON.stringify(s))),
    candidates: async (hint) => {
      state.polls += 1;
      // The loop hands its live cooldowns to the page fetch (the real wiring
      // is bin/spor.js's `candidates({ cooling })`), so a queue fn can answer
      // differently once an item is cooling — which is how a widening page is
      // modelled here.
      state.cooling = (hint && hint.cooling) || null;
      const page = typeof queue === "function" ? queue(state) : queue;
      if (page === null) throw new Error("queue unreachable");
      // Items are agent-ready unless a test says otherwise: the default accept
      // policy is `ready` (explicit consent), and most of these tests are about
      // slot accounting, not the policy — the policy has its own tests below.
      return page.map((it) => (it && it.id ? { readiness: "agent", ...it } : it));
    },
    dispatch: async (item) => {
      const verdict = dispatch(item, state);
      if (!verdict || !verdict.ok) return { ok: false, reason: (verdict && verdict.reason) || "refused" };
      const runId = `run-${++seq}`;
      state.runs.set(runId, { run_id: runId, node_id: item.id, state: "running", harness: "fake" });
      state.dispatched.push({ id: item.id, run_id: runId });
      return { ok: true, run: { run_id: runId, harness: "fake", launch_mode: "supervised-jsonl" } };
    },
    pollRuns: async (ids) =>
      pollRuns
        ? pollRuns(ids, state)
        : ids.map((id) => {
            const rec = state.runs.get(id);
            return { run_id: id, terminal: !!(rec && rec.terminal), record: rec };
          }),
    // The sleep is where the fake world moves: a test's onTick decides what
    // happened while the worker waited (a run finished, a stop was requested).
    // Driving it from here keeps every case deterministic — a real timer would
    // never fire, since the loop only ever awaits already-resolved promises.
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.clock += ms;
      onTick(state, state.sleeps.length);
      if (state.sleeps.length >= maxPasses) {
        control.stopping = true;
        control.reason = control.reason || "stopped by the test driver";
      }
    },
  };
  state.finish = (runId, patch) => {
    const rec = state.runs.get(runId) || { run_id: runId };
    state.runs.set(runId, { ...rec, terminal: true, state: "done", ...patch });
  };
  state.finishAll = (patch) => {
    for (const id of state.runs.keys()) if (!state.runs.get(id).terminal) state.finish(id, patch);
  };
  state.run = () =>
    workLoop.runWorkLoop({
      opts: { workerId: "worker-test", pid: 4242, intervalMs: 1000, maxIntervalMs: 16000, retryAfterMs: 10000, ...opts },
      control,
      // A gate dep only when a test hands one over — the bare loop's tests must
      // stay exactly the bare loop (the full pipeline has test/gate-pipeline.test.js).
      deps: gate ? { ...deps, gate } : deps,
    });
  state.control = control;
  return state;
}

test("a slot is held until the RUN goes terminal, then refilled from the queue", async () => {
  const h = harness({
    // A claimed item leaves the pool, as the real queue's lease filter makes it.
    queue: (state) => {
      const taken = new Set(state.dispatched.map((d) => d.id));
      return [{ id: "task-a", readiness: "agent" }, { id: "task-b", readiness: "agent" }].filter((i) => !taken.has(i.id));
    },
    opts: { concurrency: 1, max: 2 },
    // Nothing finishes on the first wait, so the second item must NOT start.
    onTick: (state, pass) => {
      if (pass >= 2) state.finish("run-1", { terminal_state: "resolved", terminal_enforced: true, resolved_by: "dec-done" });
    },
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-a", "task-b"], "the second item waits for the first slot to free");
  assert.strictEqual(status.dispatched, 2);
  assert.strictEqual(status.outcomes.resolved, 1);
});

test("a run that ends WITHOUT resolving cools its node off — the pool gets it back, this worker does not spin on it", async () => {
  const h = harness({
    // The item returns to the pool the moment its lease is released, exactly
    // as the terminal-state contract intends (it now carries a report).
    queue: [{ id: "task-a" }],
    opts: { concurrency: 1, retryAfterMs: 60000 },
    maxPasses: 4,
    onTick: (state) =>
      state.finishAll({ terminal_state: "reported", terminal_enforced: true, report_node_id: "art-dispatch-report-a-9f8e7d6c" }),
  });
  const status = await h.run();
  assert.strictEqual(status.dispatched, 1, "one attempt, not one per poll");
  assert.strictEqual(status.skipped.length, 1);
  assert.strictEqual(status.skipped[0].id, "task-a");
  assert.match(status.skipped[0].reason, /ended reported \(report art-dispatch-report-a-9f8e7d6c\)/);
});

test("a run whose record has vanished frees its slot, with no verdict invented for it", async () => {
  const h = harness({
    queue: [{ id: "task-a" }, { id: "task-b" }],
    opts: { concurrency: 1, max: 2 },
    maxPasses: 5,
    // The store no longer holds the run: terminal, but with nothing to judge.
    onTick: (state) => state.finishAll({ state: "missing", terminal_state: undefined }),
  });
  const status = await h.run();
  assert.strictEqual(status.dispatched, 2, "the slot is freed, so the queue keeps moving");
  assert.deepStrictEqual(status.outcomes, { resolved: 0, reported: 0, failed: 0, declined: 0, unenforced: 0 }, "a missing record is not evidence of any outcome");
  assert.strictEqual(status.recent[0].terminal_state, null);
  assert.ok(status.skipped.some((s) => s.id === "task-a"), "and the node cools off like any other unresolved run");
});

test("a watchdog give-up refills the slot but cools the node for as long as the run was followed", async () => {
  // Giving up on FOLLOWING a run is not evidence the run stopped, so the node
  // must not return as a candidate on the ordinary refusal window — a
  // local-mode worker has no lease to stop it putting a second agent on work
  // the first may still be doing. pollWorkRuns reports this as terminal with
  // no verdict plus an explicit longer `cool_ms`.
  const h = harness({
    queue: (state) => {
      const taken = new Set(state.dispatched.map((d) => d.id));
      return [{ id: "task-a" }, { id: "task-b" }].filter((i) => !taken.has(i.id));
    },
    opts: { concurrency: 1, retryAfterMs: 1000 },
    maxPasses: 3,
    pollRuns: (ids, state) =>
      ids.map((id) => ({ run_id: id, terminal: true, cool_ms: 3600000, record: { ...state.runs.get(id), state: "running" } })),
  });
  const status = await h.run();
  assert.strictEqual(status.dispatched, 2, "the slot IS refilled — a run we can no longer follow must not hold it forever");
  const cooled = status.skipped.find((x) => x.id === "task-a");
  assert.ok(cooled, "the node we gave up following is cooled off");
  assert.ok(
    Date.parse(cooled.until) - Date.parse(cooled.at) >= 3600000,
    "for the window the harvester asked for, not the short refusal window"
  );
});

test("concurrency N fills N slots in one pass and never exceeds them", async () => {
  const h = harness({
    queue: [
      { id: "task-a", readiness: "agent" },
      { id: "task-b", readiness: "agent" },
      { id: "task-c", readiness: "agent" },
    ],
    opts: { concurrency: 2 },
    maxPasses: 3,
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-a", "task-b"]);
  assert.strictEqual(status.active.length, 2, "both runs are still in flight when the worker stops");
  assert.strictEqual(status.dispatched, 2);
});

test("the outcome is READ off the run record — an unenforced verdict is counted apart", async () => {
  const h = harness({
    queue: [{ id: "task-a" }],
    opts: { concurrency: 1, max: 1 },
    maxPasses: 4,
    onTick: (state) =>
      state.finishAll({
        terminal_state: "reported",
        terminal_enforced: false,
        report_node_id: "art-dispatch-report-a-1234abcd",
        terminal_note: "no team graph configured",
      }),
  });
  const status = await h.run();
  assert.strictEqual(status.outcomes.reported, 1);
  assert.strictEqual(status.outcomes.unenforced, 1, "an unenforced verdict must not read as a verified one");
  assert.strictEqual(status.outcomes.resolved, 0);
  assert.strictEqual(status.recent[0].report_node_id, "art-dispatch-report-a-1234abcd");
  assert.strictEqual(status.recent[0].node_id, "task-a");
});

test("a refused item is skipped with its own reason, the loop advances, and it cools off", async () => {
  const h = harness({
    queue: [{ id: "task-refused" }, { id: "task-ok" }],
    dispatch: (item) =>
      item.id === "task-refused"
        ? { ok: false, reason: "cannot dispatch task-refused here: this machine can't satisfy profile profile-gpu" }
        : { ok: true },
    opts: { concurrency: 1, max: 1 },
    maxPasses: 3,
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-ok"], "a refusal advances down the page, it does not stop the pass");
  assert.strictEqual(status.skipped.length, 1);
  assert.match(status.skipped[0].reason, /can't satisfy profile profile-gpu/);
  assert.strictEqual(status.skipped[0].id, "task-refused");
});

test("a cooled-off item is not re-attempted until its retry window passes", async () => {
  let attempts = 0;
  const h = harness({
    queue: [{ id: "task-refused" }],
    dispatch: () => {
      attempts += 1;
      return { ok: false, reason: "refused" };
    },
    opts: { concurrency: 1, retryAfterMs: 5000 },
    maxPasses: 4, // sleeps of 1s, 2s, 4s, 8s => the clock passes 5s on the third
  });
  await h.run();
  assert.strictEqual(attempts, 2, "one attempt, then one more only after the cooldown expired");
});

test("the cooldown table is bounded, and evicts the LEAST-recently-refused, not the most-refused", async () => {
  // A plain Map.set on an existing key keeps its original insertion position,
  // so the item refused most often would be first out — the opposite of what
  // the cap is for. Re-cooling must move an item to the back of the queue.
  const wanted = workLoop.SKIP_CAP + 5;
  let pass = 0;
  const h = harness({
    // Pass 1 cools off item 0. Later passes present fresh items, and item 0
    // again — its cooldown is refreshed each time it is retried and refused.
    queue: () => {
      pass += 1;
      return pass === 1 ? [{ id: "task-sticky" }] : [{ id: "task-sticky" }, { id: `task-${pass}` }];
    },
    dispatch: () => ({ ok: false, reason: "refused" }),
    opts: { concurrency: 1, retryAfterMs: 0 }, // 0 = always retryable, so every pass re-refuses it
    maxPasses: wanted,
  });
  const status = await h.run();
  assert.ok(status.skipped.length <= workLoop.SKIP_CAP, `bounded at ${workLoop.SKIP_CAP}, got ${status.skipped.length}`);
  assert.ok(
    status.skipped.some((x) => x.id === "task-sticky"),
    "the item refused on every pass is the most recently refused, so it must be the LAST thing evicted"
  );
});

test("a page full of policy skips never evicts a REFUSAL cooldown — the cheap entries go first", async () => {
  // The cap is 50 while a widened page can carry 200 policy skips, so an
  // oldest-first eviction would drop the refusal cooldown that made the page
  // widen in the first place — and the refuser would be re-dispatched every
  // other poll, invisibly (it no longer reads as cooling in --status).
  // A policy skip costs nothing to recompute; a refusal cooldown is the only
  // thing keeping a failed dispatch from being run again.
  let pass = 0;
  const h = harness({
    queue: () => {
      pass += 1;
      const page = [{ id: "task-refuses", readiness: "agent" }];
      // Pass 2 onward: a wide page of untriaged items, more than the cap.
      if (pass > 1) for (let i = 0; i < workLoop.SKIP_CAP * 3; i++) page.push({ id: `task-untriaged-${pass}-${i}`, readiness: "untriaged" });
      return page;
    },
    dispatch: () => ({ ok: false, reason: "cannot dispatch task-refuses here: this machine can't satisfy profile profile-gpu" }),
    opts: { concurrency: 1, retryAfterMs: 600000 },
    maxPasses: 4,
  });
  const status = await h.run();
  const refusals = h.log.filter((l) => l.includes("skipping task-refuses"));
  assert.strictEqual(refusals.length, 1, `the refusal is attempted ONCE, not once every other poll: ${refusals.length}`);
  assert.ok(status.skipped.length <= workLoop.SKIP_CAP, `still bounded at ${workLoop.SKIP_CAP}`);
  const kept = status.skipped.find((x) => x.id === "task-refuses");
  assert.ok(kept, "the refusal cooldown survived a page of policy skips");
  assert.strictEqual(kept.kind, "refusal");
  assert.ok(status.skipped.some((x) => x.kind === "policy"), "policy skips are still recorded — they are just the first to go");
});

test("a human-readiness item is never a candidate — a worker does not claim what needs a person", async () => {
  const h = harness({
    queue: [{ id: "task-human", readiness: "human", readiness_reasons: ["requires human"] }, { id: "task-agent", readiness: "agent" }],
    opts: { concurrency: 2 },
    maxPasses: 2,
  });
  await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-agent"]);
});

test("backoff doubles over idle passes and resets the moment work is dispatched", async () => {
  let pass = 0;
  const h = harness({
    queue: () => (++pass === 4 ? [{ id: "task-late" }] : []),
    opts: { concurrency: 1 },
    maxPasses: 6,
  });
  await h.run();
  // idle, idle, idle -> 1s, 2s, 4s; the pass that dispatches goes back to 1s.
  assert.deepStrictEqual(h.sleeps.slice(0, 4), [1000, 2000, 4000, 1000]);
});

test("backoff is capped, and an unreachable queue backs off instead of crashing the worker", async () => {
  const h = harness({ queue: () => null, opts: { concurrency: 1 }, maxPasses: 7 });
  const status = await h.run();
  assert.deepStrictEqual(h.sleeps, [1000, 2000, 4000, 8000, 16000, 16000, 16000], "capped at maxIntervalMs");
  assert.strictEqual(status.dispatched, 0);
  assert.strictEqual(status.stopped_at != null, true, "a dead server ends in a clean stop, never a throw");
});

test("--max stops the worker once it has dispatched that many, after they finish", async () => {
  const h = harness({
    queue: [{ id: "a" }, { id: "b" }, { id: "c" }],
    opts: { concurrency: 3, max: 2 },
    maxPasses: 6,
    onTick: (state) => state.finishAll({ terminal_state: "failed", terminal_enforced: true }),
  });
  const status = await h.run();
  assert.strictEqual(status.dispatched, 2);
  assert.match(status.stop_reason, /--max/);
  assert.strictEqual(status.outcomes.failed, 2);
});

test("--once dispatches one pass, drains it, and stops without picking up more", async () => {
  let pass = 0;
  const h = harness({
    queue: () => {
      pass += 1;
      return [{ id: `task-${pass}` }];
    },
    opts: { concurrency: 1, once: true },
    maxPasses: 6,
    onTick: (state) => state.finishAll({ terminal_state: "resolved", terminal_enforced: true }),
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-1"], "--once never starts a second round");
  assert.match(status.stop_reason, /--once/);
  assert.strictEqual(status.outcomes.resolved, 1);
});

test("--once with an empty queue exits immediately rather than waiting a poll interval", async () => {
  const h = harness({ queue: [], opts: { concurrency: 1, once: true }, maxPasses: 5 });
  const status = await h.run();
  assert.deepStrictEqual(h.sleeps, [], "nothing to do and nothing in flight: no sleep at all");
  assert.strictEqual(status.dispatched, 0);
});

test("a stop request ends the loop and leaves in-flight runs recorded, not abandoned silently", async () => {
  const h = harness({
    queue: [{ id: "task-a" }],
    opts: { concurrency: 1 },
    maxPasses: 8,
    onTick: (state) => {
      state.control.stopping = true;
      state.control.reason = "stopped on SIGTERM";
      state.control.wake();
    },
  });
  const status = await h.run();
  assert.strictEqual(status.stop_reason, "stopped on SIGTERM");
  assert.strictEqual(status.active.length, 1, "the detached run is still named on the status so it can be followed");
  assert.strictEqual(status.state, "stopped");
  assert.strictEqual(h.sleeps.length, 1, "the stop lands at the next boundary, not after another full pass");
});

test("nextBackoffMs: never below the interval, never above the ceiling, immune to nonsense", () => {
  assert.strictEqual(workLoop.nextBackoffMs(1000, 8000, 0), 1000);
  assert.strictEqual(workLoop.nextBackoffMs(1000, 8000, 3), 8000);
  assert.strictEqual(workLoop.nextBackoffMs(1000, 8000, 999), 8000, "a huge miss count saturates, it does not overflow");
  assert.strictEqual(workLoop.nextBackoffMs(0, 0, 0), 30000, "a nonsense interval falls back to the default rather than spinning");
  assert.strictEqual(workLoop.nextBackoffMs(5000, 1000, 0), 5000, "a ceiling below the interval is raised to it");
});

test("selectWorkCandidates: excludes in-flight, human-readiness and cooling-off items, keeping queue order", () => {
  const items = [
    { id: "a", readiness: "agent" },
    { id: "b", readiness: "human" },
    { id: "c", readiness: "agent" },
    { id: "d", readiness: "agent" },
  ];
  const got = workLoop.selectWorkCandidates(items, {
    active: new Set(["c"]),
    skipped: new Map([["d", { until: 500 }]]),
    now: 100,
  });
  assert.deepStrictEqual(got.map((i) => i.id), ["a"]);
  // …and an EXPIRED cooldown is a candidate again.
  const later = workLoop.selectWorkCandidates(items, { skipped: new Map([["d", { until: 500 }]]), now: 900 });
  assert.deepStrictEqual(later.map((i) => i.id), ["a", "c", "d"]);
});

test("selectWorkCandidates: a factory's declared repo scope bounds what it gates, visibly", () => {
  // issue-spor-work-scope-union-factory-mismatch: a bare --project slug unions
  // its whole home-project grouping, so a worker scoped to spor-server is
  // handed spor's items too — and the factory's suite and integration command,
  // authored for one repo, would judge them anyway. The declared scope is the
  // bound; a mismatch is a VISIBLE skip, like a policy skip, never a silent drop.
  const items = [
    { id: "a", readiness: "agent", project: "spor-server" },
    { id: "b", readiness: "agent", project: "spor" },
    { id: "c", readiness: "agent" },
  ];
  const skips = [];
  const got = workLoop.selectWorkCandidates(items, { repos: ["spor-server"], onSkip: (it, reason) => skips.push([it.id, reason]) });
  assert.deepStrictEqual(got.map((i) => i.id), ["a"]);
  assert.deepStrictEqual(skips.map(([id]) => id), ["b", "c"]);
  assert.match(skips[0][1], /outside the factory's repo scope \(repo spor; this factory judges spor-server\)/);
  assert.match(skips[1][1], /no project stamp/, "an item whose repo cannot be told is skipped, not gated");

  // The stamp KEY is `repo:` (dec-cc-repo-project-two-layer-identity); a queue
  // payload that spells it that way must not fail the guard closed on every
  // item, which would idle a whole mode's workers.
  assert.deepStrictEqual(
    workLoop.selectWorkCandidates([{ id: "r", readiness: "agent", repo: "spor-server" }], { repos: ["spor-server"] }).map((i) => i.id),
    ["r"]
  );

  // No scope (a bare loop, or a factory that declares none) is byte-identical
  // to before this filter existed.
  for (const repos of [null, []]) {
    const all = workLoop.selectWorkCandidates(items, { repos, onSkip: () => assert.fail("an unscoped worker skips nothing on repo") });
    assert.deepStrictEqual(all.map((i) => i.id), ["a", "b", "c"], `repos ${JSON.stringify(repos)} is unscoped`);
  }

  // The scope check runs AFTER the cooldown, so an out-of-scope item that is
  // already cooling is not re-reported every poll.
  const cooling = [];
  workLoop.selectWorkCandidates(items, {
    repos: ["spor-server"],
    skipped: new Map([["b", { until: 500 }], ["c", { until: 500 }]]),
    now: 100,
    onSkip: (it) => cooling.push(it.id),
  });
  assert.deepStrictEqual(cooling, []);
});

test("selectWorkCandidates: the DEFAULT policy is explicit consent — untriaged is skipped, visibly", () => {
  // dec-spor-work-accept-policy-configurable: with nothing configured, only an
  // item a person stamped agent-ready is a candidate. An untriaged item — a
  // missing readiness field included — is skipped through onSkip so the loop
  // can say so, never silently dropped.
  const items = [{ id: "a", readiness: "agent" }, { id: "b", readiness: "untriaged" }, { id: "c" }];
  const skips = [];
  const got = workLoop.selectWorkCandidates(items, { onSkip: (it, reason) => skips.push([it.id, reason]) });
  assert.deepStrictEqual(got.map((i) => i.id), ["a"]);
  assert.deepStrictEqual(skips, [
    ["b", "not agent-ready; work.accept ready"],
    ["c", "not agent-ready; work.accept ready"],
  ]);
  // `open` restores the original pickup: everything except readiness:human.
  const open = workLoop.selectWorkCandidates(items, { accept: "open", onSkip: () => assert.fail("open skips nothing on policy") });
  assert.deepStrictEqual(open.map((i) => i.id), ["a", "b", "c"]);
  // The human floor is NOT part of the knob: refused under EVERY policy, and
  // never reported as a policy skip (it is not one — WORKERS.md §3).
  for (const accept of workLoop.WORK_ACCEPT_POLICIES) {
    const withHuman = workLoop.selectWorkCandidates([{ id: "h", readiness: "human" }, { id: "a", readiness: "agent" }], {
      accept,
      onSkip: (it) => assert.notStrictEqual(it.id, "h", "a human item is the floor, not a policy skip"),
    });
    assert.deepStrictEqual(withHuman.map((i) => i.id), ["a"], `human refused under '${accept}'`);
  }
  // An item already cooling off is not re-reported every pass: the cooldown
  // check runs before the policy check.
  const cooling = [];
  workLoop.selectWorkCandidates([{ id: "b" }], {
    skipped: new Map([["b", { until: 500 }]]),
    now: 100,
    onSkip: (it) => cooling.push(it.id),
  });
  assert.deepStrictEqual(cooling, [], "a cooling policy skip stays quiet until its cooldown expires");
});

test("the loop under the default policy: an untriaged item is cooled off with the reason on stdout and in the status", async () => {
  const h = harness({
    queue: [{ id: "task-untriaged", readiness: "untriaged" }, { id: "task-ready", readiness: "agent" }],
    opts: { concurrency: 1, max: 1 },
    onTick: (state) => state.finishAll({ terminal_state: "resolved", terminal_enforced: true }),
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-ready"], "only the stamped item is dispatched");
  assert.strictEqual(status.accept, "ready", "the status surface names the effective policy");
  assert.strictEqual(status.skipped.length, 1);
  assert.strictEqual(status.skipped[0].id, "task-untriaged");
  assert.strictEqual(status.skipped[0].reason, "not agent-ready; work.accept ready");
  assert.ok(h.log.some((l) => l.includes("skipping task-untriaged — not agent-ready; work.accept ready")), h.log.join("\n"));
});

test("the loop under --accept open takes the untriaged item; human is still refused", async () => {
  const h = harness({
    queue: [{ id: "task-untriaged", readiness: "untriaged" }, { id: "task-human", readiness: "human" }],
    opts: { concurrency: 1, max: 1, accept: "open" },
    onTick: (state) => state.finishAll({ terminal_state: "resolved", terminal_enforced: true }),
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-untriaged"]);
  assert.strictEqual(status.accept, "open");
  assert.strictEqual(status.skipped.length, 0, "an accepted item is not a skip, and human is the floor, not a skip");
});

test("refusalReason takes the REFUSAL, not the warning that preceded it or the remediation after it", () => {
  // Every dispatch refusal can be preceded by non-fatal asides (an unmintable
  // agent token, an ignored --as) and is followed by indented remediation.
  assert.strictEqual(
    workLoop.refusalReason([
      "warning: this server can't mint agent-scoped session tokens yet — dispatching person-scoped.",
      "note: --as agent-x ignored in local mode",
      "task-a is already claimed — held by someone else",
      "  not dispatching a duplicate. Re-run with --force to dispatch anyway,",
    ]),
    "task-a is already claimed — held by someone else"
  );
  // With nothing but asides, say the aside rather than nothing at all.
  assert.match(workLoop.refusalReason(["warning: only a warning"]), /only a warning/);
  assert.strictEqual(workLoop.refusalReason([], "fallback"), "fallback");
  assert.strictEqual(workLoop.refusalReason(["x".repeat(500)]).length, 300);
});

// ------------------------------------------------------------ runHarvest --

const TERMINAL = new Set(["done", "failed", "failed_launch", "vanished"]);

test("runHarvest: a record that is gone is terminal with no verdict — a slot is never held for a record nothing will write", () => {
  assert.deepStrictEqual(workLoop.runHarvest(null, { terminalStates: TERMINAL }), { terminal: true, why: "missing" });
});

test("runHarvest: a supervised record whose OUTCOME is still provisional is not harvested yet — but the hold is BOUNDED", () => {
  // agent-dispatch-runner writes the terminal `state` synchronously with an
  // unenforced placeholder, then merges the verified verdict up to three HTTP
  // round-trips later. Harvesting in that window records a run that RESOLVED
  // its target as an unenforced `reported` and cools the node off.
  const closedAt = Date.parse("2026-08-26T10:00:00.000Z");
  const pending = { run_id: "r", state: "done", contract_pending: true, runner_pid: 99, runner_started_ticks: 7, finished_at: new Date(closedAt).toISOString() };
  const aliveSupervisor = (pid, ticks) => pid === 99 && ticks === 7;
  const at = (ms) => ({ terminalStates: TERMINAL, alive: aliveSupervisor, now: () => closedAt + ms, contractGraceMs: 60000 });
  assert.strictEqual(workLoop.runHarvest(pending, at(2000)).why, "contract-pending");
  // A supervisor killed inside that window leaves contract_pending set FOREVER
  // and its pid can be recycled, so the hold expires with the contract's own
  // worst case — this is the one hold --run-max could never free.
  assert.strictEqual(workLoop.runHarvest(pending, at(90000)).why, "state", "the hold expires; the provisional reading is then the honest one");
  // A supervisor that is simply gone frees it immediately.
  assert.strictEqual(workLoop.runHarvest(pending, { ...at(2000), alive: () => false }).why, "state");
  // A record with no readable close time is never held (our writer always
  // stamps one; anything else must not be able to hold a slot).
  assert.strictEqual(workLoop.runHarvest({ ...pending, finished_at: null }, at(0)).why, "state");
  // …and once the contract has landed, the flag is cleared and it harvests.
  const settled = { ...pending, contract_pending: false, terminal_state: "resolved", terminal_enforced: true };
  assert.strictEqual(workLoop.runHarvest(settled, at(2000)).why, "state");
});

test("runHarvest: a run that has gone silent past the idle ceiling is IDLE — a verdict about the run, not about following it", () => {
  // The failure this exists for is a wedged agent, not a long one: a live
  // supervisor whose child is waiting forever on a prompt nobody will answer
  // reads alive by every other test in this file, and pins its slot, lease and
  // worktree for the whole 24h watchdog while doing nothing.
  const started = Date.parse("2026-08-26T10:00:00.000Z");
  const running = { run_id: "r", state: "running", launch_mode: "supervised-jsonl", created_at: new Date(started).toISOString() };
  const opts = (nowMs, idleMs, quiet = started) => ({
    terminalStates: TERMINAL, now: () => nowMs, maxAgeMs: 86400000, idleMs, activityAt: () => quiet,
  });
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 600000, 2700000)).terminal, false, "ten minutes of quiet is a working agent");
  const idle = workLoop.runHarvest(running, opts(started + 3000000, 2700000));
  assert.strictEqual(idle.terminal, true);
  assert.strictEqual(idle.why, "idle");
  assert.strictEqual(idle.quietMs, 3000000, "the verdict carries how long it has been silent, for the reason the caller records");
  // Activity resets it: this is FRESHNESS, not age.
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 3000000, 2700000, started + 2900000)).terminal, false);
  // Idle beats the watchdog when both would fire — a wedged run should be
  // reported as wedged, not as one we merely followed too long.
  assert.strictEqual(workLoop.runHarvest(running, { ...opts(started + 90000000, 2700000), maxAgeMs: 86400000 }).why, "idle");
  // Off by default-if-zero, and never invented from a record with no readable
  // sign of life at all (which would stop live runs).
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 90000000, 0)).why, "watchdog");
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 90000000, 2700000, 0)).why, "watchdog");
  // A record that is already terminal is done, never idle.
  assert.strictEqual(workLoop.runHarvest({ ...running, state: "done" }, opts(started + 90000000, 2700000)).why, "state");
});

test("runHarvest: a non-terminal run is followed until the watchdog age, then let go with no claim about it", () => {
  const started = Date.parse("2026-08-26T10:00:00.000Z");
  const running = { run_id: "r", state: "running", launch_mode: "native-background", created_at: new Date(started).toISOString() };
  const opts = (nowMs, maxAgeMs) => ({ terminalStates: TERMINAL, now: () => nowMs, maxAgeMs });
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 3600000, 86400000)).terminal, false, "an hour in, it is simply still running");
  const gaveUp = workLoop.runHarvest(running, opts(started + 90000000, 86400000));
  assert.deepStrictEqual(gaveUp, { terminal: true, why: "watchdog" });
  // With no ceiling configured the slot is held indefinitely — the watchdog is
  // the only thing that can free a native run whose harness stopped answering.
  assert.strictEqual(workLoop.runHarvest(running, opts(started + 90000000, 0)).terminal, false);
});

// --------------------------------------------------------- the status store --

test("status store: round-trips, marks a dead worker stale, and ages records out", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-status-"));
  const live = { worker_id: "aaaa", pid: 111, state: "polling", started_at: "2026-08-26T10:00:00.000Z", updated_at: "2026-08-26T10:00:00.000Z" };
  const dead = { worker_id: "bbbb", pid: 222, state: "waiting", started_at: "2026-08-26T09:00:00.000Z", updated_at: "2026-08-26T09:00:00.000Z" };
  const stopped = { worker_id: "cccc", pid: 333, state: "stopped", started_at: "2026-08-26T08:00:00.000Z", stopped_at: "2026-08-26T08:30:00.000Z" };
  for (const s of [live, dead, stopped]) assert.strictEqual(workLoop.writeWorkerStatus(home, s), true);

  const now = () => Date.parse("2026-08-26T11:00:00.000Z");
  const read = workLoop.readWorkerStatuses(home, { alive: (pid) => pid === 111, now });
  const byId = new Map(read.map((r) => [r.worker_id, r]));
  assert.strictEqual(byId.get("aaaa").live, true);
  assert.strictEqual(byId.get("aaaa").stale, false);
  assert.strictEqual(byId.get("bbbb").stale, true, "a worker whose process is gone must not read as running");
  assert.strictEqual(byId.get("cccc").stale, false, "a cleanly stopped worker is stopped, not stale");
  assert.deepStrictEqual(read.map((r) => r.worker_id), ["aaaa", "bbbb", "cccc"], "newest first");

  // Well past the retention window: the finished records are removed, the live one stays.
  const later = () => Date.parse("2026-09-26T11:00:00.000Z");
  const pruned = workLoop.readWorkerStatuses(home, { alive: (pid) => pid === 111, now: later });
  assert.deepStrictEqual(pruned.map((r) => r.worker_id), ["aaaa"]);
  assert.strictEqual(fs.readdirSync(workLoop.workDir(home)).length, 1);
});

test("status store: a recycled pid does not resurrect a killed worker", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-pid-"));
  // SIGKILLed: no stopped_at. Its pid is later reused by something unrelated,
  // so a bare pid probe would report it running — with occupied slots — forever.
  workLoop.writeWorkerStatus(home, { worker_id: "killed", pid: 4242, started_ticks: 111, started_at: "2026-08-26T10:00:00.000Z", updated_at: "2026-08-26T10:00:00.000Z" });
  const alive = (pid, ticks) => pid === 4242 && (ticks == null || ticks === 999); // pid alive, but a DIFFERENT process
  const read = workLoop.readWorkerStatuses(home, { alive, now: () => Date.parse("2026-08-26T10:05:00.000Z") });
  assert.strictEqual(read[0].live, false);
  assert.strictEqual(read[0].stale, true);
});

test("status store: a mangled record is skipped, not fatal, and a missing dir reads empty", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-status-bad-"));
  assert.deepStrictEqual(workLoop.readWorkerStatuses(home), []);
  fs.mkdirSync(workLoop.workDir(home), { recursive: true });
  fs.writeFileSync(path.join(workLoop.workDir(home), "half.work.json"), "{not json");
  workLoop.writeWorkerStatus(home, { worker_id: "good", pid: process.pid, started_at: "2026-08-26T10:00:00.000Z" });
  assert.deepStrictEqual(workLoop.readWorkerStatuses(home).map((r) => r.worker_id), ["good"]);
});

// ------------------------------------------------------------------- the CLI --

const HARNESS = "workfake";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: "utf8", timeout: 60000 });
}

// A scratch graph home whose queue holds one agent-ready task, one that
// requires a human, and one already resolved — plus a profile selecting a fake
// harness this machine declares. The point is that `spor work` picks exactly
// the first, with dispatch's own guards deciding the rest.
function cliFixture({ declaration = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-repo-"));
  const node = (id, extra, body) =>
    fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\ntype: task\nrepo: demo\n${extra}date: 2026-08-20\n---\n${body}\n`);
  node("task-ready", "title: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-workbox, profile: profile-work}\n", "Add bounded retry to the sync worker.");
  node("task-needs-human", "title: Decide the retention policy for sync worker logs\nsummary: Decide how long the sync worker keeps its logs, a policy call with legal input.\nstatus: open\nrequires: [human]\n", "Needs a person.");
  // Open, unassigned, no readiness stamp: derived UNTRIAGED. The default
  // accept policy must skip it — visibly — and `--accept open` must take it.
  node("task-untriaged", "title: Tidy up the sync worker imports\nsummary: A captured cleanup nobody has triaged or stamped agent-ready yet.\nstatus: open\n", "Untriaged capture.");
  node("task-done", "title: Ship the sync worker skeleton\nsummary: The sync worker skeleton shipped, with its first end-to-end run recorded.\nstatus: done\n", "Already done.");
  fs.writeFileSync(path.join(nodes, "agent-workbox.md"), `---\nid: agent-workbox\ntype: agent\ntitle: The work loop test box\nsummary: An agent identity for the work-loop test fixture, owned by the test person.\ndate: 2026-08-20\n---\nTest agent.\n`);
  fs.writeFileSync(path.join(nodes, "profile-work.md"), `---\nid: profile-work\ntype: profile\ntitle: Work loop test profile\nsummary: A profile selecting the fake harness the work-loop test declares locally.\nharness: ${HARNESS}\ndate: 2026-08-20\n---\nTest profile.\n`);

  const stub = writeSpawnableNodeStub(home, "work-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.WORK_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`);
  const cfg = { dispatch: { repos: { demo: repo } } };
  if (declaration) {
    cfg.dispatch.harness = {
      [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Work Fake", report: { from: "lastText", text: "message.text" } },
    };
  }
  fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  return { home, repo, nodes, outfile: path.join(home, "invocations.jsonl") };
}

test("spor work --print previews scope, pacing and candidates, and launches nothing", () => {
  const { home, outfile } = cliFixture();
  const r = cli(["work", "--print"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^project: \(all projects\)$/m);
  assert.match(r.stdout, /^accept:  ready — only items explicitly stamped agent-ready/m, "the effective policy is printed beside the scope");
  assert.match(r.stdout, /concurrency 1, interval 30s, backoff to 300s/);
  assert.match(r.stdout, /-> task-ready/);
  // The one that matters: `task-needs-human` IS in the live queue (it is open
  // and unresolved — `spor next` shows it), and it is the loop's own readiness
  // filter that keeps a worker off it.
  assert.match(cli(["next", "--limit", "20"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout, /task-needs-human/);
  assert.doesNotMatch(r.stdout, /task-needs-human/, "a human-readiness item is never a candidate");
  // The untriaged item is not a candidate under the default policy — and it is
  // shown as a policy skip, not silently absent.
  assert.doesNotMatch(r.stdout, /-> task-untriaged/, "an untriaged item is not a candidate by default");
  assert.match(r.stdout, /skip task-untriaged\s+untriaged\s+not agent-ready; work\.accept ready/);
  assert.ok(!fs.existsSync(outfile), "nothing was launched");

  // `--accept open` opts back into the original pickup: the untriaged item is
  // a candidate again, and human is still refused (the floor, not the policy).
  const open = cli(["work", "--print", "--accept", "open"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(open.status, 0, open.stderr);
  assert.match(open.stdout, /^accept:  open — any queue item except readiness:human/m);
  assert.match(open.stdout, /task-untriaged/);
  assert.doesNotMatch(open.stdout, /skip task-untriaged/);
  assert.doesNotMatch(open.stdout, /task-needs-human/, "human-readiness stays out under every policy");
});

// Two repos in ONE home-project grouping, each with an agent-ready item, plus a
// factory living in one of them. This is the shape of the reported repro
// (issue-spor-work-scope-union-factory-mismatch): `--project <repo slug>`
// resolves UP to the grouping and unions the members, so the sibling repo's
// item lands in a gated worker's page.
function groupedFixture({ repos = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-scope-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-20\n---\n${body}\n`);
  write("proj-demo", "type: project\ntitle: The demo product\nsummary: The grouping above the demo client and server repos.\n", "A product grouping.");
  for (const slug of ["demo", "demo-server"]) {
    write(`repo-${slug}`, `type: repo\ntitle: The ${slug} repo\nsummary: Repo identity for ${slug}, grouped under the demo product.\nslugs: [${slug}]\nedges:\n  - {type: grouped-under, to: proj-demo}\n`, "A repo identity.");
  }
  write("agent-workbox", "type: agent\ntitle: The work loop test box\nsummary: An agent identity for the work-loop scope fixture, owned by the test person.\n", "Test agent.");
  write("profile-work", `type: profile\ntitle: Work loop test profile\nsummary: A profile selecting the fake harness the work-loop scope test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  const task = (id, slug, title) =>
    write(id, `type: task\nrepo: ${slug}\ntitle: ${title}\nsummary: ${title}, an agent-ready item stamped to repo ${slug}.\nstatus: open\nedges:\n  - {type: assigned, to: agent-workbox, profile: profile-work}\n`, title);
  task("task-server-ready", "demo-server", "Add bounded retry to the demo server sync worker");
  task("task-client-ready", "demo", "Add bounded retry to the demo client sync worker");
  const payload = { factory: "demo-server", ...(repos ? { repos } : {}), gates: [{ id: "acceptance", kind: "command", command: "npm test" }] };
  write(
    "factory-demo-server",
    "type: factory\nrepo: demo-server\nstatus: active\ntitle: What done means in demo-server\nsummary: The gate the demo-server repo's work must clear before it counts as done.\n",
    ["The demo-server factory.", "", "```json", JSON.stringify(payload, null, 2), "```"].join("\n")
  );
  return { home, nodes };
}

test("a gated worker judges only the repos its factory declares — the grouping union does not widen it", () => {
  const { home } = groupedFixture();
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() };

  // The union is REAL: unfactoried, `--project demo-server` surfaces the
  // sibling repo's item too (dec-spor-queue-slug-resolves-to-grouping), which
  // is the documented read semantics and stays untouched.
  const bare = cli(["work", "--print", "--project", "demo-server"], env);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /queue:   2 candidate\(s\)/);
  assert.match(bare.stdout, /task-server-ready/);
  assert.match(bare.stdout, /task-client-ready/, "the bare loop is unchanged: the grouping union still applies");
  assert.match(bare.stdout, /^factory: none/m);

  // With the factory armed, the sibling repo's item is SKIPPED — visibly, with
  // the repo named — rather than gated by a suite written for another repo.
  const gated = cli(["work", "--print", "--project", "demo-server", "--factory", "factory-demo-server"], env);
  assert.strictEqual(gated.status, 0, gated.stderr);
  assert.match(gated.stdout, /judges: repo\(s\) demo-server/);
  assert.match(gated.stdout, /queue:   1 candidate\(s\)/);
  assert.match(gated.stdout, /-> task-server-ready/);
  assert.doesNotMatch(gated.stdout, /-> task-client-ready/);
  assert.match(gated.stdout, /skip task-client-ready.*outside the factory's repo scope \(repo demo; this factory judges demo-server\)/);

  // ...and with no --project at all the scope DEFAULTS to the factory's own
  // repo, instead of reading every project's queue to discard most of it.
  const defaulted = cli(["work", "--print", "--factory", "factory-demo-server"], env);
  assert.strictEqual(defaulted.status, 0, defaulted.stderr);
  assert.match(defaulted.stdout, /^project: demo-server$/m);
  assert.match(defaulted.stdout, /queue:   1 candidate\(s\)/);
  assert.match(defaulted.stdout, /-> task-server-ready/);
});

test("a declared repo that names nothing in this graph is called out at startup, not left to look like an empty queue", () => {
  // The quiet failure mode of the whole feature: one typo in `repos` and every
  // item is out of scope, so the worker reads an empty page and idles with
  // nothing to say. A warning, not a refusal — an unknown-here repo is not
  // necessarily a typo.
  const { home } = groupedFixture({ repos: ["demo-sever"] });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--print", "--factory", "factory-demo-server"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /declares repo 'demo-sever', which names no repo or project in this graph/);
  assert.match(r.stdout, /queue:   nothing dispatchable right now/);
  // A repo that DOES resolve says nothing.
  const good = groupedFixture().home;
  const ok = cli(["work", "--print", "--factory", "factory-demo-server"], { SPOR_HOME: good, XDG_CONFIG_HOME: good, PATH: pathWithOnlyGitAndNode() });
  assert.doesNotMatch(ok.stderr, /names no repo or project/);
});

test("a factory that declares its repos judges those, not the one it happens to live in", () => {
  // The escape hatch (option c of the issue): a factory whose gates genuinely
  // do apply to several repos says so, and an explicit --project cannot widen
  // it past that declaration either.
  const { home } = groupedFixture({ repos: ["demo", "demo-server"] });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--print", "--project", "demo-server", "--factory", "factory-demo-server"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /judges: repo\(s\) demo, demo-server/);
  assert.match(r.stdout, /task-server-ready/);
  assert.match(r.stdout, /task-client-ready/);
  assert.doesNotMatch(r.stdout, /outside the factory's repo scope/);
  // Two declared repos leave the scope token alone — there is no single repo
  // to narrow a missing --project to.
  const defaulted = cli(["work", "--print", "--factory", "factory-demo-server"], env);
  assert.match(defaulted.stdout, /^project: \(all projects\)$/m);
});

test("an unknown accept policy refuses to start the worker — flag or config, never a silent fallback", () => {
  const { home, outfile } = cliFixture();
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const flag = cli(["work", "--once", "--accept", "yolo"], env);
  assert.strictEqual(flag.status, 1);
  assert.match(flag.stderr, /--accept yolo — expected one of: ready, open/);
  // The same posture when the bad value arrives through the cascade
  // (SPOR_WORK_ACCEPT / work.accept), which an unattended unit file would use.
  const viaEnv = cli(["work", "--once"], { ...env, SPOR_WORK_ACCEPT: "anything" });
  assert.strictEqual(viaEnv.status, 1);
  assert.match(viaEnv.stderr, /work\.accept anything — expected one of: ready, open/);
  assert.ok(!fs.existsSync(outfile), "nothing was launched under a refused policy");
});

test("spor work --once --max 1 dispatches through the real guards, waits for the run, and reports the outcome", async () => {
  const { home, repo, outfile } = cliFixture();
  const r = cli(
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: dispatched task-ready/);
  assert.match(r.stdout, /work: task-ready finished/);
  assert.match(r.stdout, /dispatched 1;/);

  const invocations = fs.readFileSync(outfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(invocations.length, 1, "exactly one launch, into the mapped repo");
  assert.strictEqual(invocations[0].cwd, repo);
  assert.match(invocations[0].prompt, /task-ready/);

  // The run record carries the outcome dimension, and the loop read it rather
  // than inventing one: local mode can never be `resolved` (nothing to verify).
  const runsJson = cli(["runs", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  const runs = JSON.parse(runsJson.stdout).runs;
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].node_id, "task-ready");
  assert.strictEqual(runs[0].terminal_enforced, false, "local mode has no graph to verify against");

  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  assert.strictEqual(status.count, 1);
  const w = status.workers[0];
  assert.strictEqual(w.dispatched, 1);
  assert.strictEqual(w.active.length, 0, "the slot was freed when the run went terminal");
  assert.strictEqual(w.recent[0].node_id, "task-ready");
  assert.strictEqual(w.recent[0].run_id, runs[0].run_id);
  assert.match(w.stop_reason, /--max|--once/);
  assert.strictEqual(w.stale, false, "a worker that stopped cleanly is stopped, not stale");
});

test("a dispatch refusal is recorded with its own reason and the worker stops instead of spinning", () => {
  // No declaration for the harness the profile selects: this machine cannot
  // launch it, so `spor dispatch` refuses — and the loop must record WHY
  // rather than retry it in a tight loop.
  const { home, outfile } = cliFixture({ declaration: false });
  const r = cli(
    ["work", "--once", "--interval", "1", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /work: skipping task-ready — /);
  assert.match(r.stdout, /dispatched 0;/);
  assert.ok(!fs.existsSync(outfile), "a refused item is never launched");

  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  const skipped = status.workers[0].skipped;
  // Two skips: the dispatch refusal under test, plus the fixture's untriaged
  // item cooled off by the default accept policy.
  const refused = skipped.find((s) => s.id === "task-ready");
  assert.ok(refused, JSON.stringify(skipped));
  assert.match(refused.reason, /task-ready/, "the refusal's own first line is the reason");
  assert.ok(Date.parse(refused.until) > Date.now(), "and it is cooling off, not dropped");
  assert.strictEqual(skipped.find((s) => s.id === "task-untriaged").reason, "not agent-ready; work.accept ready");
});

// The cooling half of the page's eligible predicate (bin/spor.js's
// `candidates`, the closure handed to dispatchableQueuePage): a queue whose
// FIRST page holds one agent-ready item this box refuses deterministically
// (its profile selects a harness with no declaration here) plus a page's worth
// of untriaged items ranked above a second agent-ready item. Poll 1 tries the
// refusable one and cools it off; the page does not widen (something on it WAS
// eligible). Poll 2 sees it cooling, finds nothing else eligible on the same
// 25, and must widen past it to reach the item below — the exact starvation
// the widening exists to fix (dec-spor-work-page-widens-past-undispatchable),
// one hop deeper than the policy skips, and the one branch the fake-queue loop
// tests and `--print` (which runs with no cooldowns) cannot reach.
function widenFixture() {
  const { home, repo, nodes, outfile } = cliFixture();
  // A second profile whose harness NO declaration binds: `spor dispatch`
  // refuses it, every time, which is what makes the cooldown deterministic.
  fs.writeFileSync(path.join(nodes, "profile-nodecl.md"), `---\nid: profile-nodecl\ntype: profile\ntitle: Work loop undeclared-harness profile\nsummary: A profile selecting a harness this machine declares no binding for, so dispatch refuses it.\nharness: workmissing\ndate: 2026-08-20\n---\nUndeclared here.\n`);
  const node = (id, extra, body) =>
    fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\ntype: task\nrepo: demo\n${extra}date: 2026-08-20\n---\n${body}\n`);
  // Ranked FIRST (p1): agent-ready, refused on this box.
  node("task-refused", "title: Port the sync worker to the other harness\nsummary: An agent-ready item whose profile this machine cannot satisfy, so every dispatch of it refuses.\nstatus: open\npriority: p1\nedges:\n  - {type: assigned, to: agent-workbox, profile: profile-nodecl}\n", "Refused here.");
  // Ranked ABOVE the fixture's `task-ready` (p3 outranks its unset priority;
  // same date, so nothing else separates them): enough to fill the rest of the
  // first 25-item page, and two more so the widened page still holds all of
  // them ahead of the item under test.
  for (let i = 1; i <= 26; i++) {
    const n = String(i).padStart(2, "0");
    node(`task-untriaged-${n}`, `title: Captured sync worker cleanup ${n}\nsummary: A captured cleanup nobody has triaged or stamped agent-ready yet, number ${n}.\nstatus: open\npriority: p3\n`, "Untriaged capture.");
  }
  return { home, repo, nodes, outfile };
}

test("a cooled-off refusal lets the next poll widen the page past it and dispatch the eligible item below", () => {
  const { home, repo, outfile } = widenFixture();
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };

  // The control: with no cooldowns in play (`--print` runs the same closure
  // before the loop starts) the page stops at 25 — the refusable item is
  // eligible, so nothing widens — and `task-ready` is BELOW it. So if the loop
  // dispatches `task-ready`, a widened page is the only way it got there.
  const print = cli(["work", "--print"], env);
  assert.strictEqual(print.status, 0, print.stderr);
  assert.match(print.stdout, /-> task-refused/);
  assert.doesNotMatch(print.stdout, /task-ready/, "the item under test is beyond the first page");
  assert.ok(!fs.existsSync(outfile), "--print launches nothing");

  // Two real polls: --max 1 without --once, so the loop keeps polling after
  // the refusal until it has dispatched one item. Poll 1 refuses and cools
  // task-refused; poll 2 widens past it.
  const r = cli(["work", "--max", "1", "--interval", "1", "--no-brief"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const refused = r.stdout.indexOf("work: skipping task-refused — ");
  const dispatched = r.stdout.indexOf("work: dispatched task-ready");
  assert.ok(refused >= 0, r.stdout);
  assert.ok(dispatched >= 0, r.stdout);
  assert.ok(refused < dispatched, "the refusal is cooled BEFORE the poll that reaches the item below it");
  assert.match(r.stdout, /work: task-ready finished/);
  assert.match(r.stdout, /dispatched 1;/);
  assert.strictEqual((r.stdout.match(/work: skipping task-refused/g) || []).length, 1, "a cooling item is not re-refused on the next poll");

  const invocations = fs.readFileSync(outfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(invocations.length, 1, "exactly one launch");
  assert.strictEqual(invocations[0].cwd, repo);
  assert.match(invocations[0].prompt, /task-ready/);
  assert.doesNotMatch(invocations[0].prompt, /task-refused/);

  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  const w = status.workers[0];
  assert.strictEqual(w.dispatched, 1);
  assert.strictEqual(w.recent[0].node_id, "task-ready");
  assert.match(w.stop_reason, /--max/);
  const cooled = w.skipped.find((s) => s.id === "task-refused");
  assert.ok(cooled, JSON.stringify(w.skipped));
  assert.ok(Date.parse(cooled.until) > Date.now(), "the refusal is still cooling when the worker stops");
  // The untriaged page-fillers were policy skips, never candidates.
  assert.ok(w.skipped.filter((s) => s.id.startsWith("task-untriaged-")).every((s) => s.reason === "not agent-ready; work.accept ready"));
  // The dispatched item cools only AFTER its run ended unresolved (local mode
  // can never verify a resolution) — a post-run cooldown, never a refusal.
  const ready = w.skipped.find((s) => s.id === "task-ready");
  assert.ok(ready, JSON.stringify(w.skipped));
  assert.match(ready.reason, /^last run here ended /);
});

// A scratch graph home whose queue holds exactly one item that names its
// worker profile via `profile:` frontmatter alone — no `assigned -> agent`
// edge at all, the exact shape `buildGateWorkNode`'s test-change lane item
// takes (task-spor-test-change-lane-auto-routing, WORKERS.md §10.3). The
// point is that a PLAIN `spor work` (no `--profile`) still routes it.
function laneFixture({ declaration = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-lane-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-lane-repo-"));
  fs.writeFileSync(
    path.join(nodes, "task-lane.md"),
    `---\nid: task-lane\ntype: task\nrepo: demo\ntitle: Move the retention-policy test into its own file\nsummary: A protected test path changed on the implementer's branch; the change belongs in its own lane.\nstatus: open\nreadiness: agent\nprofile: profile-work\ndate: 2026-08-20\n---\nTest-change lane item.\n`
  );
  fs.writeFileSync(
    path.join(nodes, "profile-work.md"),
    `---\nid: profile-work\ntype: profile\ntitle: Work loop test profile\nsummary: A profile selecting the fake harness the work-loop test declares locally.\nharness: ${HARNESS}\ndate: 2026-08-20\n---\nTest profile.\n`
  );

  const stub = writeSpawnableNodeStub(home, "work-lane-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.WORK_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`);
  const cfg = { dispatch: { repos: { demo: repo } } };
  if (declaration) {
    cfg.dispatch.harness = {
      [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Work Lane Fake", report: { from: "lastText", text: "message.text" } },
    };
  }
  fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  return { home, repo, nodes, outfile: path.join(home, "invocations.jsonl") };
}

test("spor work auto-routes a queue item's `profile:` frontmatter — no manual --profile targeting needed (task-spor-test-change-lane-auto-routing)", () => {
  const { home, repo, outfile } = laneFixture();
  const r = cli(
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: dispatched task-lane/);

  const invocations = fs.readFileSync(outfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(invocations.length, 1, "the item with no assigned edge at all still launched, routed by its frontmatter alone");
  assert.strictEqual(invocations[0].cwd, repo);
});

test("spor work refuses a lane item it cannot satisfy — same as an explicit --profile would, never silently dropped or run bare", () => {
  const { home, outfile } = laneFixture({ declaration: false });
  const r = cli(
    ["work", "--once", "--interval", "1", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /work: skipping task-lane — /);
  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  assert.match(status.workers[0].skipped[0].reason, /profile-work/, "the refusal names the routed profile, not a generic skip");
  assert.ok(!fs.existsSync(outfile), "never launched under an unsatisfiable profile");
});

// An explicit --profile on the worker itself still wins over the item's own
// frontmatter (mirrors resolveDispatchProfile's --profile-beats-inferred
// precedence for a node's assigned->agent edge, bin/spor.js).
test("an explicit --profile on the worker overrides an item's own `profile:` frontmatter", () => {
  const { home, outfile } = laneFixture({ declaration: false });
  // profile-other resolves to nothing on disk, so passing it makes dispatch
  // refuse loudly on THAT id — proof the item's own profile-work was never
  // consulted once --profile was given explicitly.
  const r = cli(
    ["work", "--once", "--interval", "1", "--no-brief", "--profile", "profile-other"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, WORK_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  assert.match(status.workers[0].skipped[0].reason, /profile-other/);
  assert.ok(!fs.existsSync(outfile));
});

test("a numeric option that is not a number is refused, never silently replaced", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-opts-"));
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() };
  // The dangerous one: `--max $N` with an unset variable must not quietly
  // become an unbounded worker.
  const bad = cli(["work", "--max", "abc", "--print"], env);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /--max abc — expected a number between 0 and \d+/);
  assert.strictEqual(cli(["work", "--concurrency", "0", "--print"], env).status, 1, "a zero concurrency is a mistake, not a default");
  assert.strictEqual(cli(["work", "--interval", "-5", "--print"], env).status, 1, "a negative interval is a mistake, not a 1s spin");
  // setTimeout clamps anything over 2**31-1 ms to 1ms, so an unbounded value
  // is a SPIN, not a long wait — and work.intervalMs sitting beside a flag in
  // seconds makes it an easy slip.
  assert.strictEqual(cli(["work", "--interval", "3000000", "--print"], env).status, 1, "an out-of-range interval is refused, not clamped into a spin");
  assert.strictEqual(cli(["work", "--max", "", "--print"], env).status, 1, "an empty --max is a mistake, not 'run forever'");
  // Every problem is reported in one run, not one per re-run.
  const both = cli(["work", "--max", "x", "--interval", "y", "--print"], env);
  assert.match(both.stderr, /--max x/);
  assert.match(both.stderr, /--interval y/);
  // An explicit 0 where 0 is meaningful is HONORED, not treated as absent.
  const zero = cli(["work", "--retry-after", "0", "--print"], env);
  assert.strictEqual(zero.status, 0, zero.stderr);
  assert.match(zero.stdout, /retry refused after 0s/);
});

// A queue whose whole first page is items the default policy may not take:
// 30 p1-priority untriaged captures ranked ABOVE one agent-ready task. This is
// the starvation shape the review found — the accept filter ran after a
// fixed-size fetch, so the ready item (rank 31) was never on the page.
function starvedFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-starve-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-20\n---\n${body}\n`);
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, "0");
    write(
      `task-untriaged-${n}`,
      `type: task\nrepo: demo\ntitle: Untriaged capture number ${n}\nsummary: A captured cleanup number ${n} nobody has triaged or stamped agent-ready yet.\nstatus: open\npriority: p1\n`,
      "Untriaged capture."
    );
  }
  write("agent-workbox", "type: agent\ntitle: The work loop test box\nsummary: An agent identity for the starvation fixture, owned by the test person.\n", "Test agent.");
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-workbox}\n",
    "Ready."
  );
  return { home, nodes };
}

test("an agent-ready item ranked BELOW a full page of untriaged ones is still reached — the page widens instead of starving", () => {
  const { home } = starvedFixture();
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() };

  // The starvation is real: the one agent-ready item is ranked past the
  // 25-item page a poll reads. Asserted on the RANK the queue prints, not on a
  // line offset — `spor next` prints two lines per item, so a line index would
  // pass at rank 13 and stop exercising the widening without anyone noticing.
  const rank = Number((cli(["next", "--limit", "40"], env).stdout.match(/^(\d+)\. .*task-ready/m) || [])[1]);
  assert.ok(rank > 25, `task-ready must rank past the first page, got rank ${rank}`);

  const r = cli(["work", "--print"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /-> task-ready/, "the fetch widens past a page of un-dispatchable items");
  assert.match(r.stdout, /queue:   1 candidate\(s\)/);

  // ...and the widening is CONDITIONAL: under --accept open the first page
  // already holds candidates, so the page is taken as-is (the top-ranked
  // untriaged item, not the one 31 rows down).
  const open = cli(["work", "--print", "--accept", "open"], env);
  assert.strictEqual(open.status, 0, open.stderr);
  assert.match(open.stdout, /-> task-untriaged-\d\d/);
});

test("a deterministically-refusing item does not pin the page width — the cooldown is part of what the fetch widens past", async () => {
  // The starvation one hop deeper: the page stops widening at the first
  // ELIGIBLE item, so an item that refuses every time (a profile this box
  // cannot satisfy) would hold the page at its own rank forever while it
  // cools, and everything below it would never be fetched.
  const page = [];
  for (let i = 0; i < 3; i++) page.push({ id: `task-untriaged-${i}`, readiness: "untriaged" });
  page.push({ id: "task-refuses", readiness: "agent" });
  const deeper = { id: "task-ready", readiness: "agent" };
  const widths = [];
  const h = harness({
    // A stand-in for the real page fetch: `task-ready` is only returned when
    // the caller looks past the items it cannot use.
    queue: (state) => {
      const cooling = state.cooling || (() => false);
      const usable = page.filter((it) => it.readiness === "agent" && !cooling(it.id));
      widths.push(usable.length ? "narrow" : "wide");
      return usable.length ? page : [...page, deeper];
    },
    dispatch: (item) => (item.id === "task-refuses" ? { ok: false, reason: "cannot dispatch task-refuses here: this machine can't satisfy profile profile-x" } : { ok: true }),
    opts: { concurrency: 1, max: 1 },
    onTick: (state) => state.finishAll({ terminal_state: "resolved", terminal_enforced: true }),
  });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-ready"], "the refusal cools off and the deeper item is then reached");
  assert.deepStrictEqual(widths, ["narrow", "wide"], "the first pass stopped at the refusing item; the second looked past it");
  assert.strictEqual(status.skipped.find((sk) => sk.id === "task-refuses").reason, "cannot dispatch task-refuses here: this machine can't satisfy profile profile-x");
});

test("summarizeSkips aggregates by REASON CLASS, so one item's specifics never fragment the count", () => {
  const reasons = [
    ...Array(18).fill("not agent-ready; work.accept ready"),
    "outside the factory's repo scope (repo demo; this factory judges demo-server)",
    "outside the factory's repo scope (repo other; this factory judges demo-server)",
  ];
  assert.strictEqual(workLoop.summarizeSkips(reasons), "18 not agent-ready, 2 outside the factory's repo scope");
  // The per-item detail a refusal carries is what the class strips: the repo
  // named in a scope skip, the node named in a dispatch refusal.
  assert.strictEqual(workLoop.skipClass("outside the factory's repo scope (repo demo; this factory judges demo-server)"), "outside the factory's repo scope");
  assert.strictEqual(workLoop.skipClass("not agent-ready; work.accept ready"), "not agent-ready");
  // A dispatch refusal leads with the node id, so classifying by the raw first
  // segment would give every refused item a class of its own — the exact
  // fragmentation an aggregate exists to avoid.
  assert.strictEqual(
    workLoop.summarizeSkips([
      "cannot dispatch task-a here: this machine can't satisfy profile profile-x (via assigned)",
      "cannot dispatch task-b here: this machine can't satisfy profile profile-x (via assigned)",
    ]),
    "2 this machine can't satisfy profile profile-x"
  );
  assert.strictEqual(workLoop.skipClass("cannot dispatch task-a: this item requires a human — no owner"), "this item requires a human — no owner");
  // Distinct classes are bounded, with the tail counted rather than dropped.
  assert.strictEqual(workLoop.summarizeSkips(["a", "a", "b", "c", "d", "e"]), "2 a, 1 b, 1 c, 2 other");
  assert.strictEqual(workLoop.summarizeSkips([]), "");
});

test("the loop names the first few skips and AGGREGATES the rest, rather than one log line per untriaged item per poll", async () => {
  // The widened page (above) can hand a pass far more skips than the cooldown
  // map remembers, so an uncoalesced log re-prints every evicted one every 30s.
  const queue = [];
  for (let i = 0; i < 12; i++) queue.push({ id: `task-untriaged-${i}`, readiness: "untriaged" });
  queue.push({ id: "task-ready", readiness: "agent" });
  const h = harness({ queue, opts: { concurrency: 1, max: 1 }, onTick: (state) => state.finishAll({ terminal_state: "resolved", terminal_enforced: true }) });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-ready"]);
  const named = h.log.filter((l) => /^work: skipping task-untriaged-/.test(l));
  assert.strictEqual(named.length, workLoop.SKIP_LOG_CAP, "the individually-named skips are capped");
  assert.ok(
    h.log.some((l) => l === `work: ...and 7 more skipped this pass — 7 not agent-ready ('spor work --status' lists them, newest first)`),
    h.log.join("\n")
  );
  // The COUNT is capped, never the record: every skip still cooled off, and
  // the status surface carries them all.
  assert.strictEqual(status.skipped.length, 12);
});

test("spor work --status says out loud when a refusal filed NOTHING on the graph, and names the re-judge command", () => {
  // task-spor-gate-escalation-demote-atomic: with no escalation there is
  // deliberately no demotion either, so `demote_reason` is null and the
  // fail-soft demotion line above says nothing. Without its own line the only
  // trace is a `gate_reason` a 300-char slice can cut the suffix off.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-unescalated-"));
  workLoop.writeWorkerStatus(home, {
    worker_id: "11111111-2222-3333-4444-666666666666",
    pid: 999999,
    state: "polling",
    project: "demo",
    concurrency: 1,
    dispatched: 1,
    outcomes: { resolved: 1, reported: 0, failed: 0 },
    active: [],
    gating: [],
    recent: [
      {
        run_id: "run-abcdef12",
        node_id: "task-demo",
        terminal_state: "resolved",
        terminal_enforced: true,
        gate: "failed",
        gate_reason: "gate 'acceptance' failed: the suite failed",
        demoted: false,
        escalation_failed: true,
      },
    ],
    skipped: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stopped_at: new Date().toISOString(),
    stop_reason: "one pass (--once)",
  });
  const text = cli(["work", "--status"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /no escalation could be filed, so nothing was demoted — re-judge with 'spor work --regate run-abcdef12'/);
});

test("spor work --status counts the skips it does not list, instead of stopping silently at five", () => {
  // The human renderer is the DEFAULT surface: showing five of 25 told an
  // operator that five items were skipped (the review's second finding).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-skips-"));
  const skipped = [];
  for (let i = 0; i < 25; i++) {
    skipped.push({
      id: `task-untriaged-${String(i).padStart(2, "0")}`,
      reason: i < 20 ? "not agent-ready; work.accept ready" : `outside the factory's repo scope (repo demo-${i}; this factory judges demo-server)`,
      at: `2026-08-31T10:${String(59 - i).padStart(2, "0")}:00.000Z`,
      until: "2026-08-31T11:30:00.000Z",
    });
  }
  workLoop.writeWorkerStatus(home, {
    worker_id: "11111111-2222-3333-4444-555555555555",
    pid: 999999,
    state: "polling",
    project: "demo",
    accept: "ready",
    concurrency: 1,
    dispatched: 0,
    outcomes: { resolved: 0, reported: 0, failed: 0 },
    active: [],
    gating: [],
    recent: [],
    skipped,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stopped_at: new Date().toISOString(),
    stop_reason: "one pass (--once)",
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home };
  const text = cli(["work", "--status"], env);
  assert.strictEqual(text.status, 0, text.stderr);
  assert.strictEqual((text.stdout.match(/^  skipped:  task-untriaged-/gm) || []).length, 5, "the list itself stays a glance");
  assert.match(text.stdout, /^  skipped:  \+20 more — 15 not agent-ready, 5 outside the factory's repo scope \('spor work --status --json' lists them all\)$/m);
  // --json is unchanged: it carries every entry, in full detail.
  const json = cli(["work", "--status", "--json"], env);
  assert.strictEqual(JSON.parse(json.stdout).workers[0].skipped.length, 25);
});

test("spor work --status with nothing recorded says so, in both renderings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-empty-"));
  const text = cli(["work", "--status"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(text.status, 0);
  assert.match(text.stdout, /no spor work loops recorded/);
  const json = cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.deepStrictEqual(JSON.parse(json.stdout), { count: 0, workers: [] });
});

// --- declined (task-spor-worker-declined-outcome) -------------------------

test("shouldGate: a DECLINED run is never gated, enforced or not — its route is triage", () => {
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "declined", terminal_enforced: true }), false);
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "declined", terminal_enforced: false }), false);
  // ...while the two gateable cases are unchanged.
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "resolved", terminal_enforced: true }), true);
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: false }), true);
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: true }), false);
  assert.strictEqual(workLoop.shouldGate({ terminal_state: "failed", terminal_enforced: true }), false);
});

test("a declined run frees its slot without a gate, is tallied apart, and cools the node off naming the finding", async () => {
  const gated = [];
  const h = harness({
    queue: [{ id: "task-a", readiness: "agent" }],
    opts: { concurrency: 1, max: 1 },
    maxPasses: 4,
    onTick: (state) =>
      state.finishAll({
        terminal_state: "declined",
        terminal_enforced: true,
        declined_reason: "the server half already shipped in 50c53d0",
        finding_node_id: "find-declined-a-1234abcd",
        terminal_note: "routed to triage",
      }),
    gate: async (args) => {
      gated.push(args);
      return { state: "passed", gates: [], facts: [] };
    },
  });
  const status = await h.run();
  assert.strictEqual(status.outcomes.declined, 1);
  assert.strictEqual(status.outcomes.reported, 0);
  assert.strictEqual(status.outcomes.unenforced, 0);
  assert.deepStrictEqual(gated, [], "a decline carries no claim of completion — nothing to gate");
  assert.deepStrictEqual(status.gating, []);
  assert.strictEqual(status.recent[0].declined_reason, "the server half already shipped in 50c53d0");
  assert.strictEqual(status.recent[0].finding_node_id, "find-declined-a-1234abcd");
  const cooled = status.skipped.find((x) => x.id === "task-a");
  assert.ok(cooled, "the declined item does not come straight back to this worker");
  assert.match(cooled.reason, /declined — the server half already shipped .* \(finding find-declined-a-1234abcd\)/);
});

// ------------------------------------------------ pollWorkRuns: idle + grace --
//
// The two halves of task-spor-work-idle-run-detection, driven through the real
// wiring (bin/spor.js pollWorkRuns) against a scratch graph home:
//
//   - a run that has stopped writing anything is STOPPED and classified, rather
//     than pinning its slot until the 24h watchdog. `runHarvest` above decides
//     it; this is what acting on that decision does;
//   - a `contract_pending` record whose supervisor never landed the verified
//     verdict is not filed under the provisional one without RE-READING the
//     graph first — a run that genuinely resolved its target reads `resolved`.

const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { spawn } = require("node:child_process");

// A scratch SPOR_HOME with one task and, optionally, the decision that resolves
// it — the exact evidence WORKERS.md §6 calls `resolved`.
function pollFixture({ resolver = false } = {}) {
  // The live-agent listing is irrelevant to both halves under test (neither
  // record is native-background) and probing for real would spawn every
  // installed harness CLI; the canned empty listing is the same seam
  // `enumerateHarnessAgents` offers everywhere else.
  process.env.SPOR_FAKE_AGENTS_JSON = "[]";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-poll-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-wedged.md"),
    "---\nid: task-wedged\ntype: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\ndate: 2026-09-03\n---\n\nBody.\n"
  );
  if (resolver) {
    fs.writeFileSync(
      path.join(nodes, "dec-retry-added.md"),
      "---\nid: dec-retry-added\ntype: decision\ntitle: Added bounded retry to the sync worker\nsummary: Added bounded retry with backoff to the sync worker, so a transient failure retries instead of dropping the record.\ndate: 2026-09-03\nedges:\n  - {type: resolves, to: task-wedged}\n---\n\nBody.\n"
    );
  }
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  return { home, nodes, cfg };
}

function writeRecord(home, runId, extra) {
  const rec = { run_id: runId, node_id: "task-wedged", name: "task-wedged", harness: "workfake", cwd: home, ...extra };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, rec);
  return rec;
}

// A supervised run's log, opened at launch and untouched since — the OBSERVED
// output channel the idle ceiling reads a run's freshness off. Without one the
// run has no observable channel at all and is deliberately not judged idle.
function silentLog(home, runId, agoMs) {
  const file = dispatchRuns.runPaths(home, runId).log;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const at = (Date.now() - agoMs) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}

// A real process to stand in for a supervisor that is alive and identity-checks
// clean — the ONLY case reconciliation leaves a run open indefinitely, and
// therefore the only one an idle ceiling has to catch.
function liveProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  return { pid: child.pid, ticks: dispatchRuns.processStartTicks(child.pid), kill: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
}

async function goneWithin(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!dispatchRuns.pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return dispatchRuns.pidAlive(pid) === false;
}

test("pollWorkRuns: a run silent past the idle ceiling is STOPPED and classified, not followed to the watchdog", async () => {
  const { home, cfg } = pollFixture();
  const proc = liveProcess();
  try {
    const runId = "run-idle-1";
    writeRecord(home, runId, {
      state: "running",
      launch_mode: "supervised-jsonl",
      created_at: new Date(Date.now() - 3600000).toISOString(),
      log_path: silentLog(home, runId, 3600000),
      runner_pid: proc.pid,
      runner_started_ticks: proc.ticks,
    });
    const warned = [];
    const [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 60000, warn: (l) => warned.push(l) });

    assert.strictEqual(verdict.terminal, true, "the slot is freed on the same pass the ceiling is crossed");
    assert.strictEqual(verdict.record.state, "failed");
    assert.strictEqual(verdict.record.termination_class, "idle");
    assert.strictEqual(verdict.record.termination_signal, "idle-timeout");
    assert.match(verdict.record.termination_reason, /wrote nothing to its log or transcript/);
    assert.strictEqual(verdict.record.terminal_state, "failed");
    assert.strictEqual(verdict.record.terminal_enforced, false, "nothing verified it — the graph does not show the target resolved");
    assert.ok(!verdict.cool_ms, "we ENDED the run rather than giving up on it, so the ordinary refusal window applies");
    assert.match(warned.join("\n"), /stopping run run-idle/);
    assert.match(warned.join("\n"), /nothing written to its log or transcript for 60m \(idle ceiling 1m\)/);

    // Durable, not just reported: `spor runs` and the resume scan read the file.
    const onDisk = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
    assert.strictEqual(onDisk.state, "failed");
    assert.strictEqual(onDisk.termination_signal, "idle-timeout");
    // And the wedged process is actually gone — the whole point of stopping it.
    assert.strictEqual(await goneWithin(proc.pid), true, "the idle run's supervisor was signalled, not just recorded");
  } finally {
    proc.kill();
  }
});

test("pollWorkRuns: an idle run whose target reads resolved is classified RESOLVED — a stop is not evidence the work was not done", async () => {
  const { home, cfg } = pollFixture({ resolver: true });
  const proc = liveProcess();
  try {
    const runId = "run-idle-2";
    writeRecord(home, runId, {
      state: "running",
      launch_mode: "supervised-jsonl",
      created_at: new Date(Date.now() - 3600000).toISOString(),
      log_path: silentLog(home, runId, 3600000),
      runner_pid: proc.pid,
      runner_started_ticks: proc.ticks,
    });
    const [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 60000 });
    assert.strictEqual(verdict.record.state, "failed", "the PROCESS was stopped mid-flight, and the record says so");
    assert.strictEqual(verdict.record.terminal_state, "resolved", "the OUTCOME is a graph read: the agent wrote its resolver, then wedged");
    assert.strictEqual(verdict.record.terminal_enforced, true);
    assert.strictEqual(verdict.record.resolved_by, "dec-retry-added");
    assert.strictEqual(await goneWithin(proc.pid), true);
  } finally {
    proc.kill();
  }
});

test("pollWorkRuns: an idle run with no process of ours to signal takes the WATCHDOG's cooldown, not the ordinary one", async () => {
  // A native-background agent lives in the harness's own daemon, which this
  // client has no stop verb for. Freeing the slot is still right — 45 minutes
  // of silence is not a working agent — but we only stopped FOLLOWING it, so
  // the node must not come straight back round to a worker and put a second
  // agent into a checkout the first may still hold.
  const { home, cfg } = pollFixture();
  const runId = "run-idle-native";
  const cwd = path.join(home, "checkout");
  // A native run's observable channel is the harness's own session transcript,
  // reachable only through a bound session id.
  const configDir = path.join(home, "cc");
  const projectDir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "sid-live.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const anHourAgo = (Date.now() - 3600000) / 1000;
  fs.utimesSync(transcript, anHourAgo, anHourAgo);
  writeRecord(home, runId, {
    state: "running",
    launch_mode: "native-background",
    session_id: "sid-live",
    cwd,
    created_at: new Date(Date.now() - 3600000).toISOString(),
  });
  // The harness still lists the agent, so reconciliation leaves the record
  // open — the exact case the idle ceiling is the only thing that can free.
  process.env.SPOR_FAKE_AGENTS_JSON = JSON.stringify([{ id: "a1", sessionId: "sid-live", kind: "background", state: "running", cwd }]);
  const warned = [];
  let verdict;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 60000, warn: (l) => warned.push(l) });
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.SPOR_FAKE_AGENTS_JSON = "[]";
  }
  assert.strictEqual(verdict.terminal, true);
  assert.strictEqual(verdict.cool_ms, 60000, "cooled for at least as long as the silence we waited out");
  assert.match(verdict.record.termination_reason, /no process of ours left to signal/);
  assert.match(warned.join("\n"), /giving up following run run-idle/);
  assert.match(warned.join("\n"), /something may still be running in its checkout/);
});

test("pollWorkRuns: a run with NO observable output channel is never judged idle — it falls through to the watchdog", async () => {
  // A `claude --bg` launch binds its session best-effort and deliberately
  // leaves the record session-less rather than guessing, so such a record has
  // no transcript and no log of ours. Reading its LAUNCH as its last activity
  // would stop a perfectly healthy agent the moment the ceiling passed.
  const { home, cfg } = pollFixture();
  const runId = "run-unbound";
  writeRecord(home, runId, {
    state: "running",
    launch_mode: "native-background",
    created_at: new Date(Date.now() - 3600000).toISOString(),
  });
  process.env.SPOR_FAKE_AGENTS_JSON = JSON.stringify([{ id: "a2", name: "task-wedged", kind: "background", state: "running", cwd: home, startedAt: Date.now() - 3600000 }]);
  const [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 60000 });
  assert.strictEqual(verdict.terminal, false, "the slot is held; the 24h watchdog is the honest instrument here");
  assert.strictEqual(verdict.record.state, "running", "and the record is left open, not closed as failed");
  process.env.SPOR_FAKE_AGENTS_JSON = "[]";
});

test("pollWorkRuns: a contract-pending record is verified against the graph before it is filed under the provisional verdict", async () => {
  // The record a supervised run writes SYNCHRONOUSLY on close: terminal, with
  // an unenforced placeholder, waiting on the contract's verify leg. A
  // supervisor killed inside that window never lands the real one, and
  // harvesting it as-is files a run that RESOLVED its target as an unenforced
  // `reported` — then gates it and cools it off despite being done.
  const { home, cfg } = pollFixture({ resolver: true });
  const runId = "run-grace-1";
  writeRecord(home, runId, {
    state: "done",
    launch_mode: "supervised-jsonl",
    created_at: new Date(Date.now() - 600000).toISOString(),
    finished_at: new Date(Date.now() - 300000).toISOString(),
    contract_pending: true,
    terminal_state: "reported",
    terminal_enforced: false,
    terminal_note: "provisional",
    gate_state: "running",
  });
  const [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 0 });
  assert.strictEqual(verdict.terminal, true);
  assert.strictEqual(verdict.record.terminal_state, "resolved");
  assert.strictEqual(verdict.record.terminal_enforced, true);
  assert.strictEqual(verdict.record.resolved_by, "dec-retry-added");
  assert.strictEqual(verdict.record.contract_pending, false, "the contract is settled — by this worker, since nothing else was going to");
  assert.match(verdict.record.terminal_note, /verified by this worker/);
  assert.strictEqual(verdict.record.gate_state, "running", "the out-of-band gate namespace survives this write, as it does the supervisor's");

  const onDisk = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
  assert.strictEqual(onDisk.terminal_state, "resolved");
  assert.strictEqual(onDisk.contract_pending, false);
});

test("pollWorkRuns: a contract-pending record the graph does NOT show resolved is left exactly as it was", async () => {
  // Only a POSITIVE reading may overwrite what a record says. "We could not
  // tell" leaves the provisional verdict — and the pending flag — for a slow
  // supervisor to settle, rather than inventing a verdict of our own.
  const { home, cfg } = pollFixture();
  const runId = "run-grace-2";
  writeRecord(home, runId, {
    state: "done",
    launch_mode: "supervised-jsonl",
    created_at: new Date(Date.now() - 600000).toISOString(),
    finished_at: new Date(Date.now() - 300000).toISOString(),
    contract_pending: true,
    terminal_state: "reported",
    terminal_enforced: false,
    terminal_note: "provisional",
  });
  const [verdict] = await sporCli.pollWorkRuns(cfg, [runId], { maxAgeMs: 86400000, idleMs: 0 });
  assert.strictEqual(verdict.terminal, true);
  assert.strictEqual(verdict.record.terminal_state, "reported");
  assert.strictEqual(verdict.record.terminal_enforced, false);
  assert.strictEqual(verdict.record.contract_pending, true);
  assert.strictEqual(dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record).contract_pending, true);
});
