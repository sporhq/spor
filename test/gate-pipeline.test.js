// The GATE PIPELINE (task-spor-work-gate-pipeline) — the enforcement layer
// `spor work` runs between a claim and the item counting as done. Four layers,
// each with its own oracle:
//
//   1. the PIPELINE (lib/shell/gate-runner.js) driven with fakes: all three gate
//      kinds, inline and referenced, the fix-cycle loop, the cycle-cap
//      escalation, and the graph fact every outcome leaves behind;
//   2. the COMMAND GATE's git plumbing against a REAL throwaway repo — the one
//      test that has to be real, because the claim being made is "the suite that
//      runs is the trusted ref's copy, never the implementer branch's";
//   3. the LOOP's slot accounting around a gate pipeline, and the standing
//      guarantee that a worker with no factory behaves exactly as it did before;
//   4. the CLI end to end in a scratch graph home — a declared factory refuses
//      to start a worker if it does not validate, and a real dispatch's gate
//      outcome lands in the graph as a node.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const workLoop = require("../lib/shell/work-loop.js");
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode } = require("./helpers/portable");

// ------------------------------------------------------------ the pipeline --

function factoryOf(payload, gateNodes = new Map()) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes });
  assert.deepStrictEqual(errors, [], errors.join("; "));
  return factory;
}

const BASE = {
  factory: "test",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  risk_classes: { "touches:auth": ["lib/auth.js"] },
};

// A fake world: what the diff says, what the suite does, what a review answers,
// what the graph accepts. Every write is captured so the tests can assert on
// the FACTS, which is the deliverable, not just on the verdict.
function fakes({ changed = ["lib/x.js"], suite = () => ({ ok: true }), review = () => ({ ok: true, text: '```json\n{"verdict":"pass"}\n```' }), fix = () => ({ ok: true }), approval = () => ({ state: "approved", by: "person-a" }), writes = null } = {}) {
  const seen = { facts: [], lane: [], human: [], escalations: [], suites: [], reviews: [], fixes: [], approvals: 0, slept: 0 };
  let clock = 1_700_000_000_000;
  const deps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      seen.slept += 1;
    },
    changedPaths: async () => (changed === null ? { ok: false, reason: "unreadable tree" } : { ok: true, paths: changed }),
    runSuite: async (args) => {
      seen.suites.push(args.gate.id);
      return suite(args, seen);
    },
    review: async (args) => {
      seen.reviews.push({ gate: args.gate.id, cycle: args.cycle });
      return review(args, seen);
    },
    fix: async (args) => {
      seen.fixes.push({ gate: args.gate.id, cycle: args.cycle, findings: args.findings });
      return fix(args, seen);
    },
    recordFact: async ({ id, markdown }) => {
      seen.facts.push({ id, markdown });
      return writes === "refuse" ? { ok: false, reason: "the graph refused the write" } : { ok: true, id };
    },
    fileTestLaneItem: async (args) => {
      seen.lane.push(args);
      return { ok: true, id: "task-test-lane-x" };
    },
    fileHumanItem: async (args) => {
      seen.human.push(args);
      return { ok: true, id: "task-approve-x" };
    },
    checkApproval: async () => {
      seen.approvals += 1;
      return approval(seen);
    },
    escalate: async (args) => {
      seen.escalations.push(args);
      return { ok: true, id: `task-gate-${args.gate.id}` };
    },
  };
  return { deps, seen };
}

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };

test("a passing pipeline runs its gates IN ORDER and records a graph fact for each", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [
      { id: "acceptance", kind: "command", command: "npm test" },
      { id: "review", kind: "agent-review", profile: "profile-review" },
      { id: "security", kind: "human", risk: ["touches:auth"] },
    ],
  });
  const { deps, seen } = fakes({ changed: ["lib/x.js"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(res.gates.map((g) => [g.gate, g.verdict]), [
    ["acceptance", "passed"],
    ["review", "passed"],
    // Not armed: the change touched no declared risk class.
    ["security", "skipped"],
  ]);
  assert.strictEqual(seen.facts.length, 3, "every gate outcome is a graph fact");
  for (const f of seen.facts) {
    assert.match(f.markdown, /type: artifact/);
    assert.match(f.markdown, /- \{type: relates-to, to: task-demo\}/, "the fact is linked to the work item");
    assert.doesNotMatch(f.markdown, /type: resolves/, "a gate outcome never resolves anything");
  }
  // Readable prefix, whole-tuple identity: the gate id is truncated at 24 chars
  // in the prefix, so the hash is what actually keeps two gates' facts apart.
  for (const [i, gate] of ["acceptance", "review", "security"].entries()) {
    assert.match(seen.facts[i].id, new RegExp(`^art-gate-${gate}-demo-runabcde-[0-9a-f]{8}$`));
  }
  assert.strictEqual(new Set(seen.facts.map((f) => f.id)).size, 3, "one distinct fact per gate");
  assert.strictEqual(seen.human.length, 0, "an unarmed human gate files nothing");
});

test("a REFERENCED shareable gate node runs exactly like the same gate written inline", async () => {
  const shared = { id: "review", kind: "agent-review", profile: "profile-review" };
  const run = async (gatesList, gateNodes) => {
    const factory = factoryOf({ ...BASE, gates: gatesList }, gateNodes);
    const { deps, seen } = fakes();
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    return { res, seen };
  };
  const inline = await run([{ ...shared }]);
  const referenced = await run([{ ref: "gate-review" }], new Map([["gate-review", shared]]));
  assert.strictEqual(inline.res.state, referenced.res.state);
  assert.deepStrictEqual(inline.seen.reviews, referenced.seen.reviews);
  assert.deepStrictEqual(
    inline.res.gates.map((g) => [g.gate, g.verdict]),
    referenced.res.gates.map((g) => [g.gate, g.verdict])
  );
  // The one visible difference is provenance, recorded on the fact.
  assert.match(referenced.seen.facts[0].markdown, /shared gate node/);
  assert.doesNotMatch(inline.seen.facts[0].markdown, /shared gate node/);
});

test("a command gate whose suite fails escalates to a human item, and the fact carries the evidence", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "1 failing\n  the sync worker drops records\n" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, "task-gate-acceptance");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.fixes.length, 0, "cycles default to 0 — one failure escalates");
  assert.match(seen.facts[0].markdown, /the sync worker drops records/);
  assert.match(seen.facts[0].markdown, /Escalated to task-gate-acceptance/);
});

test("an implementer branch that edits a protected test path fails the gate CLOSED — unrun, unretried, routed to the test lane", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 3 }],
  });
  const { deps, seen } = fakes({ changed: ["lib/x.js", "test/x.test.js"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.suites.length, 0, "the suite is never run from a branch that edits it");
  assert.strictEqual(seen.fixes.length, 0, "a protected-path violation is not something a fix cycle may retry");
  assert.strictEqual(seen.lane.length, 1);
  assert.deepStrictEqual(seen.lane[0].paths, ["test/x.test.js"]);
  assert.strictEqual(seen.lane[0].profile, "profile-test-writer", "the test change routes to a DIFFERENT profile");
  assert.strictEqual(res.gates[0].verdict, "fail-closed");
  assert.strictEqual(res.gates[0].escalated_to, "task-test-lane-x");
});

test("an agent-review gate loops fix cycles up to its cap, then escalates by filing a human queue item", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 }] });
  const changesRequested = '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"lib/x.js","summary":"off by one"}]}\n```';
  const { deps, seen } = fakes({ review: () => ({ ok: true, text: changesRequested }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.reviews.length, 3, "the first attempt plus two fix cycles");
  assert.deepStrictEqual(seen.reviews.map((r) => r.cycle), [0, 1, 2]);
  assert.strictEqual(seen.fixes.length, 2, "exactly the declared cap");
  assert.deepStrictEqual(seen.fixes[0].findings.map((f) => f.summary), ["off by one"], "the fix cycle is handed the findings");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.escalations[0].attempts.length, 3);
  assert.strictEqual(seen.facts.length, 1, "one fact per gate, carrying the cycle history");
  assert.match(seen.facts[0].markdown, /Cycles:/);
});

test("a fix cycle that lands makes the gate pass, and nothing is escalated", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 }] });
  let call = 0;
  const { deps, seen } = fakes({
    review: () => {
      call += 1;
      return { ok: true, text: call === 1 ? '```json\n{"verdict":"changes_requested","findings":[{"summary":"x"}]}\n```' : '```json\n{"verdict":"pass"}\n```' };
    },
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.escalations.length, 0);
});

test("a review that cannot be read, dispatched or reported is a FAILURE — never a pass", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review" }] });
  for (const review of [
    () => ({ ok: true, text: "looks great to me" }), // no structured verdict
    () => ({ ok: false, reason: "the profile is unsatisfiable here" }), // never ran
    () => {
      throw new Error("boom");
    },
  ]) {
    const { deps } = fakes({ review });
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    assert.strictEqual(res.state, "failed");
  }
});

test("a human gate files an approval item, blocks on it, and takes the person's answer as the verdict", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "security", kind: "human", risk: ["touches:auth"] }] });

  const approved = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "approved", by: "person-a" }) });
  let res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: approved.deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(approved.seen.human.length, 1);
  assert.deepStrictEqual(approved.seen.human[0].classes.map((c) => c.class), ["touches:auth"]);

  const refused = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "rejected", by: "person-a" }) });
  res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: refused.deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(refused.seen.escalations.length, 0, "a refused approval IS the human item — no second one is filed");

  // Unanswered: the runner waits, bounded, and reports BLOCKED rather than
  // deciding on the person's behalf.
  const pending = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "pending" }) });
  const timed = factoryOf({
    ...BASE,
    gates: [{ id: "security", kind: "human", risk: ["touches:auth"], approval_timeout_ms: 10000, poll_ms: 1000 }],
  });
  res = await gateRunner.runGatePipeline({ item: ITEM, factory: timed, deps: pending.deps });
  assert.strictEqual(res.state, "blocked");
  assert.strictEqual(res.escalated_to, "task-approve-x");
  assert.ok(pending.seen.approvals > 1, "it polls the approval item");
  assert.ok(pending.seen.slept <= 11, "and the wait is bounded");
});

test("a gate ordered after a failed one never runs — the pipeline stops at the first refusal", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [
      { id: "acceptance", kind: "command", command: "npm test" },
      { id: "review", kind: "agent-review", profile: "profile-review" },
    ],
  });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "boom" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.reviews.length, 0);
});

test("an unreadable change set fails every path-dependent gate closed", async () => {
  // Both kinds that read the diff, each on its own: the command gate (which
  // would otherwise run a suite over a tree it cannot describe) and the human
  // gate (whose risk classes are path predicates — "assume unarmed" is the
  // fail-OPEN reading on the one kind that exists for risky changes).
  for (const gate of [
    { id: "acceptance", kind: "command", command: "npm test" },
    { id: "security", kind: "human", risk: ["touches:auth"] },
  ]) {
    const factory = factoryOf({ ...BASE, gates: [gate] });
    const { deps, seen } = fakes({ changed: null });
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    assert.strictEqual(res.state, "failed", `${gate.kind} must fail closed on an unreadable diff`);
    assert.strictEqual(seen.suites.length, 0);
    assert.strictEqual(seen.human.length, 0, "and no approval is filed for a change nobody could describe");
    assert.match(res.reason, /unreadable tree/);
  }
});

test("a graph that refuses the fact write does not change the verdict — the enforcement is not the bookkeeping", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps } = fakes({ writes: "refuse" });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(res.facts, [], "and it does not claim a fact it could not write");
});

// ------------------------------------------------ the command gate, for real --

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A repo whose `test/acceptance.js` is a real (tiny) acceptance suite, and a
// branch that BREAKS the behavior it checks while rewriting the suite to say so
// anyway — the exact shape a command gate exists to catch.
function repoWithBranch({ weakenTest = true, regress = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".spor"), "project: demo\n");
  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(
    path.join(dir, "test", "acceptance.js"),
    'const add = require("../lib/add.js");\nif (add(2, 3) !== 5) { console.error("add is broken"); process.exit(1); }\n'
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "impl");
  if (regress) fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a * b;\n"); // the regression
  else fs.writeFileSync(path.join(dir, "lib", "sub.js"), "module.exports = (a, b) => a - b;\n"); // benign work
  if (weakenTest) {
    // ...and the implementer "fixes" the suite that would have caught it.
    fs.writeFileSync(path.join(dir, "test", "acceptance.js"), "process.exit(0);\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "implementer work");
  return dir;
}

test("gateChangeSet reads the committed change against the trusted ref, and refuses a dirty tree", () => {
  const dir = repoWithBranch();
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  assert.strictEqual(change.ok, true, change.reason);
  assert.deepStrictEqual(change.paths.sort(), ["lib/add.js", "test/acceptance.js"]);
  assert.strictEqual(change.head, git(dir, "rev-parse", "HEAD").trim());

  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = () => 0;\n");
  const dirty = gateRunner.gateChangeSet({ cwd: dir }, "main");
  assert.strictEqual(dirty.ok, false);
  assert.match(dirty.reason, /uncommitted/);

  assert.strictEqual(gateRunner.gateChangeSet({ cwd: "/nonexistent/xyz" }, "main").ok, false);
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-plain-"));
  assert.strictEqual(gateRunner.gateChangeSet({ cwd: notARepo }, "main").ok, false);
  const missingRef = gateRunner.gateChangeSet({ cwd: repoWithBranch() }, "no-such-ref");
  assert.strictEqual(missingRef.ok, false);
  assert.match(missingRef.reason, /does not resolve/);
});

test("the suite that runs is the TRUSTED ref's copy — an implementer-branch test edit cannot pass its own gate", async () => {
  const dir = repoWithBranch({ weakenTest: true });
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  const gate = { id: "acceptance", command: `"${process.execPath}" test/acceptance.js`, timeoutMs: 60000, dir: "" };

  // 1. The branch's own copy of the suite passes — that is the whole problem.
  const branchRun = await gateRunner.runGateCommand(gate, dir);
  assert.strictEqual(branchRun.ok, true, "the weakened suite passes on the branch, as designed");

  // 2. The gate's tree takes the branch's SOURCE and the trusted ref's TESTS,
  //    and the regression is caught.
  const tree = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: ["test/**"] });
  assert.strictEqual(tree.ok, true, tree.reason);
  try {
    assert.strictEqual(
      fs.readFileSync(path.join(tree.dir, "lib", "add.js"), "utf8").trim(),
      "module.exports = (a, b) => a * b;",
      "the implementer's source is what is under test"
    );
    assert.match(fs.readFileSync(path.join(tree.dir, "test", "acceptance.js"), "utf8"), /add is broken/, "the suite is main's");
    const gated = await gateRunner.runGateCommand(gate, tree.dir);
    assert.strictEqual(gated.ok, false);
    assert.match(gated.output, /add is broken/);
  } finally {
    tree.cleanup();
  }
  assert.ok(!fs.existsSync(tree.dir), "the gate worktree is cleaned up");
});

test("a protected test file the branch ADDED is removed from the gate tree, not carried into it", () => {
  const dir = repoWithBranch({ weakenTest: false });
  fs.writeFileSync(path.join(dir, "test", "extra.js"), "process.exit(0);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "added a test");
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  const tree = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: ["test/**"] });
  try {
    assert.strictEqual(tree.ok, true, tree.reason);
    assert.ok(!fs.existsSync(path.join(tree.dir, "test", "extra.js")));
    assert.ok(fs.existsSync(path.join(tree.dir, "test", "acceptance.js")));
  } finally {
    tree.cleanup();
  }
});

test("runGateCommand reports a non-zero exit and a timeout distinctly, never throws, and never blocks the event loop", async () => {
  const dir = repoWithBranch({ weakenTest: false });
  const ok = await gateRunner.runGateCommand({ id: "g", command: `"${process.execPath}" -e "process.exit(0)"`, timeoutMs: 30000, dir: "" }, dir);
  assert.deepStrictEqual([ok.ok, ok.code], [true, 0]);
  const bad = await gateRunner.runGateCommand({ id: "g", command: `"${process.execPath}" -e "process.exit(3)"`, timeoutMs: 30000, dir: "" }, dir);
  assert.deepStrictEqual([bad.ok, bad.code], [false, 3]);
  // The event loop must keep turning while the suite runs — the worker still
  // has runs to harvest, a status to publish and a SIGTERM handler to serve.
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 50);
  const slow = await gateRunner.runGateCommand(
    { id: "g", command: `"${process.execPath}" -e "setTimeout(()=>{},5000)"`, timeoutMs: 700, dir: "" },
    dir
  );
  clearInterval(ticker);
  assert.strictEqual(slow.ok, false);
  assert.match(slow.reason, /did not finish/);
  assert.ok(ticks > 2, `the loop kept turning during the gate command (ticks: ${ticks})`);
});

// ------------------------------------------------------- the loop's plumbing --

// The same fake-world driver work-loop.test.js uses, plus a gate.
function loopHarness({ queue = [], gate = null, terminalState = "resolved", enforced = true, maxPasses = 12 } = {}) {
  const state = { clock: 1_700_000_000_000, runs: new Map(), log: [], gateCalls: [], published: [] };
  const control = { stopping: false, reason: null, wake: () => {} };
  let seq = 0;
  let resolveGate = null;
  const deps = {
    now: () => state.clock,
    log: (l) => state.log.push(l),
    publish: (s) => state.published.push(JSON.parse(JSON.stringify(s))),
    candidates: async () => queue,
    dispatch: async (item) => {
      const runId = `run-${++seq}`;
      state.runs.set(runId, {
        run_id: runId,
        node_id: item.id,
        state: "done",
        terminal_state: terminalState,
        terminal_enforced: enforced,
      });
      return { ok: true, run: { run_id: runId, harness: "fake", launch_mode: "supervised-jsonl" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: state.runs.get(id) })),
    sleep: async (ms) => {
      state.clock += ms;
      state.published.push({ tick: true });
      if (resolveGate) {
        const r = resolveGate;
        resolveGate = null;
        r();
      }
      if (state.published.filter((p) => p.tick).length >= maxPasses) control.stopping = true;
    },
    ...(gate
      ? {
          gate: (entry, record) => {
            state.gateCalls.push({ entry, record });
            // Settle on the NEXT sleep, so the test sees a pass with the item
            // still gating (the slot held) before the verdict lands.
            return new Promise((resolve, reject) => {
              resolveGate = () => {
                try {
                  resolve(gate(entry, record));
                } catch (e) {
                  reject(e);
                }
              };
            });
          },
        }
      : {}),
  };
  return { deps, control, state };
}

test("with NO factory the loop is unchanged: nothing gates, nothing is held, no gate counters", async () => {
  const { deps, control } = loopHarness({ queue: [{ id: "task-a" }] });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.dispatched, 1);
  assert.strictEqual(status.outcomes.resolved, 1);
  assert.strictEqual(status.gates, undefined, "a bare worker publishes no gate counters");
  assert.deepStrictEqual(status.gating, []);
  assert.deepStrictEqual(status.skipped, []);
});

test("a resolved run holds its slot through the gate pipeline, and a PASS clears it with no cooldown", async () => {
  const { deps, control, state } = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed", reason: "2 gate(s) passed", facts: ["art-gate-x"] }),
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000, max: 1 }, deps, control });
  assert.strictEqual(state.gateCalls.length, 1);
  assert.strictEqual(state.gateCalls[0].entry.node_id, "task-a");
  assert.strictEqual(status.gates.passed, 1);
  assert.deepStrictEqual(status.gating, []);
  assert.deepStrictEqual(status.skipped, [], "a gated-and-passed item is done — no cooldown");
  assert.strictEqual(status.recent[0].gate, "passed");
  // The slot was genuinely held: a pass ran while the item was still gating.
  const held = state.published.some((p) => p.gating && p.gating.length === 1);
  assert.ok(held, "the item occupied a slot while its gates ran");
});

test("a FAILED gate cools the item off — a worker does not re-dispatch what its own gate just refused", async () => {
  const { deps, control } = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "failed", reason: "gate 'acceptance' failed: npm test exited 1", escalated_to: "task-gate-acceptance" }),
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, retryAfterMs: 600000, max: 1 }, deps, control });
  assert.strictEqual(status.gates.failed, 1);
  assert.strictEqual(status.skipped.length, 1);
  assert.strictEqual(status.skipped[0].id, "task-a");
  assert.match(status.skipped[0].reason, /gate pipeline failed/);
  assert.strictEqual(status.recent[0].gate, "failed");
  assert.strictEqual(status.recent[0].escalated_to, "task-gate-acceptance");
});

test("a BLOCKED gate (waiting on a person) also cools the item, and a thrown pipeline is a failure, not a crash", async () => {
  let blocked = await workLoop.runWorkLoop({
    opts: { workerId: "w", intervalMs: 1000, max: 1 },
    ...(() => {
      const h = loopHarness({ queue: [{ id: "task-a" }], gate: () => ({ state: "blocked", reason: "waiting on task-approve-x" }) });
      return { deps: h.deps, control: h.control };
    })(),
  });
  assert.strictEqual(blocked.gates.blocked, 1);
  assert.strictEqual(blocked.skipped.length, 1);

  const thrown = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => {
      throw new Error("git exploded");
    },
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, max: 1 }, deps: thrown.deps, control: thrown.control });
  assert.strictEqual(status.gates.failed, 1);
  assert.match(status.recent[0].gate_reason, /git exploded/);
});

test("only a claimed completion is gated: an enforced 'reported' run is not, an UNENFORCED one is", async () => {
  const enforcedReported = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed" }),
    terminalState: "reported",
    enforced: true,
  });
  await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps: enforcedReported.deps, control: enforcedReported.control });
  assert.strictEqual(enforcedReported.state.gateCalls.length, 0, "a run that self-declares not-done has no claim to test");

  const unenforced = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed" }),
    terminalState: "reported",
    enforced: false,
  });
  await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, max: 1 }, deps: unenforced.deps, control: unenforced.control });
  assert.strictEqual(unenforced.state.gateCalls.length, 1, "an unverifiable claim is exactly where the gates are the only check");

  assert.strictEqual(workLoop.shouldGate({ terminal_state: "failed", terminal_enforced: true }), false);
  assert.strictEqual(workLoop.shouldGate({}), false);
});

// ------------------------------------------- the approval oracle + gate ids --

const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");

// The approval item is read for ONE thing: a live resolving edge. Every other
// terminal status is a refusal — the dispatch guard's "is this resolved?"
// reading counts `closed`/`superseded`/`abandoned` as resolved, which is right
// for "would dispatching this redo finished work" and exactly backwards here.
test("an approval item approves ONLY on a resolving edge — every other terminal status is a refusal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-approve-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, front, body = "Body.") =>
    fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  write("task-approve-open", "type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: open\nrequires: [human]\n");
  assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-open"), { state: "pending" });
  assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-missing"), { state: "pending" });

  // Dismissed, not approved — the status the old hand-written reject set missed.
  for (const status of ["abandoned", "closed", "superseded"]) {
    write("task-approve-x", `type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: ${status}\n`);
    assert.strictEqual((await sporCli.gateApprovalState(cfg, "task-approve-x")).state, "rejected", `status ${status} is not an approval`);
  }

  // A resolver pointing at it IS the approval.
  write("task-approve-y", "type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: open\n");
  write(
    "dec-approved-it",
    "type: decision\ntitle: Approved the security gate\nsummary: Approved the security gate on the auth change after reading the diff and the threat model.\nstatus: accepted\nedges:\n  - {type: resolves, to: task-approve-y}\n"
  );
  const approved = await sporCli.gateApprovalState(cfg, "task-approve-y");
  assert.strictEqual(approved.state, "approved");
  assert.strictEqual(approved.by, "dec-approved-it");
});

test("a gate-filed WORK NODE is fence-safe and fits the server's body cap", () => {
  const body = [
    "Findings:",
    "",
    "```",
    // A suite tail or a review report can contain its own fence; ours must not
    // close early and spill the rest into the body as prose.
    "```json\n{\"verdict\":\"changes_requested\"}\n```",
    "```",
    "",
    "x".repeat(40000), // unbounded by construction: 20 findings + evidence + cycles
  ].join("\n");
  const md = sporCli.buildGateWorkNode({
    id: "task-gate-demo",
    title: "Gate escalation — demo",
    summary: "A gate refused the demo item and it needs a person.",
    body,
    project: "demo",
    date: "2026-08-26",
    requiresHuman: true,
    edges: [{ type: "relates-to", to: "task-demo" }],
  });
  assert.ok(Buffer.byteLength(md, "utf8") <= 8192, `a node the server would reject wholesale is an escalation nobody is told about (${Buffer.byteLength(md, "utf8")} bytes)`);
  assert.match(md, /^id: task-gate-demo$/m, "the frontmatter survives the trim");
  assert.match(md, /^requires: \[human\]$/m);
  // A newline in a title or summary would truncate the node at the parser.
  const flattened = sporCli.buildGateWorkNode({
    id: "task-gate-demo",
    title: "Gate\nescalation",
    summary: "line one\nline two",
    body: "Body.",
    date: "2026-08-26",
  });
  assert.match(flattened, /^title: Gate escalation$/m);
  assert.match(flattened, /^summary: line one line two$/m);
});

test("a gate-filed id is keyed on the WHOLE triple, so two gates sharing a 24-char prefix cannot collide", () => {
  const a = sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-1");
  const b = sporCli.gateIdSuffix("approve", "security-approval-database-schema", "task-x", "run-1");
  assert.notStrictEqual(a, b, "the readable prefix truncates at 24 chars; the identity must not");
  assert.strictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-1"), "and it is deterministic");
  assert.notStrictEqual(a, sporCli.gateIdSuffix("escalate", "security-approval-database-migration", "task-x", "run-1"));
  assert.notStrictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-y", "run-1"));
  assert.notStrictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-2"));
  // The FACT id — written on every gate outcome, not just the filed items —
  // carries the same identity: two gates sharing a prefix must not record over
  // each other, which for a pass/fail pair would file the wrong verdict.
  assert.notStrictEqual(
    gateRunner.gateFactId("security-review-database-migration", "task-x", "run-1"),
    gateRunner.gateFactId("security-review-database-schema", "task-x", "run-1")
  );
});

test("writing a gate node twice is one node — but the same id with DIFFERENT content is refused, never adopted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gatewrite-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const node = (summary) =>
    `---\nid: art-gate-demo-x-abcdef12\ntype: artifact\ntitle: Gate demo\nsummary: ${summary}\ndate: 2026-08-26\n---\n\nBody.\n`;
  const first = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("The demo gate passed on the change under judgement, and this records it."));
  assert.strictEqual(first.ok, true);
  const again = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("The demo gate passed on the change under judgement, and this records it."));
  assert.deepStrictEqual([again.ok, again.existing], [true, true]);
  const collision = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("Something else entirely happened here, and it is not the same fact at all."));
  assert.strictEqual(collision.ok, false, "adopting another gate's node silently is how an approved item passes a gate nobody read");
  assert.match(collision.reason, /already exists with different content/);

  // And a malformed node never reaches the local graph unvalidated.
  const bad = await sporCli.writeGateNode(cfg, "art-gate-bad", "not a node at all");
  assert.strictEqual(bad.ok, false);
});

// ------------------------------------------------------------------- the CLI --

const HARNESS = "gatefake";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: "utf8", timeout: 120000 });
}

// A scratch graph home holding one ready task, a fake harness profile, and a
// factory definition (plus one shareable gate node it references).
function cliFixture({ factoryPayload, gatePayload = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = repoWithBranch({ weakenTest: false, regress: false });
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-gatebox, profile: profile-gate}\n",
    "Add bounded retry to the sync worker."
  );
  write("agent-gatebox", "type: agent\ntitle: The gate test box\nsummary: An agent identity for the gate-pipeline test fixture.\n", "Test agent.");
  write("profile-gate", `type: profile\ntitle: Gate test profile\nsummary: A profile selecting the fake harness the gate-pipeline test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  if (factoryPayload) {
    write(
      "factory-demo",
      "type: factory\ntitle: The demo factory\nsummary: The gate pipeline the demo project enforces between claim and resolve.\nstatus: active\n",
      ["```json", JSON.stringify(factoryPayload, null, 2), "```"].join("\n")
    );
  }
  if (gatePayload) {
    write(
      "gate-shared",
      "type: gate\ntitle: A shared gate\nsummary: A shareable gate node the demo factory references by id.\nstatus: active\n",
      ["```json", JSON.stringify(gatePayload, null, 2), "```"].join("\n")
    );
  }
  const stub = writeSpawnableNodeStub(home, "gate-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GATE_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`);
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        dispatch: {
          repos: { demo: repo },
          harness: { [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Gate Fake", report: { from: "lastText", text: "message.text" } } },
        },
      },
      null,
      2
    )}\n`
  );
  return { home, repo, nodes, outfile: path.join(home, "invocations.jsonl") };
}

const OK_FACTORY = {
  factory: "demo",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" test/acceptance.js` }],
};

test("spor work --print names the factory and its gates, inline and referenced alike", () => {
  const { home, outfile } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { ref: "gate-shared" }] },
    gatePayload: { id: "adversarial", kind: "agent-review", profile: "profile-review", cycles: 2 },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--print", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /factory: factory-demo — trusted ref main, protected test\/\*\* -> profile-test-writer/);
  assert.match(r.stdout, /gate acceptance {2}command/);
  assert.match(r.stdout, /gate adversarial {2}agent-review {2}review under profile-review {2}\(up to 2 fix cycles\) {2}\[gate-shared\]/);

  // And with no factory the preview says so rather than implying gates.
  const bare = cli(["work", "--print"], env);
  assert.match(bare.stdout, /factory: none — the loop runs bare/);
});

test("a factory that does not validate REFUSES to start the worker — it never runs ungated", () => {
  for (const [payload, re] of [
    [{ ...OK_FACTORY, gates: [{ id: "x", kind: "command" }] }, /needs a 'command'/],
    [{ ...OK_FACTORY, gates: [{ ref: "gate-missing" }] }, /gate-missing/],
    [{ ...OK_FACTORY, test_lane_profile: "" }, /no separate lane to route to/],
  ]) {
    const { home, outfile } = cliFixture({ factoryPayload: payload });
    const r = cli(["work", "--once", "--factory", "factory-demo"], {
      SPOR_HOME: home,
      XDG_CONFIG_HOME: home,
      GATE_OUTFILE: outfile,
      PATH: pathWithOnlyGitAndNode(),
    });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, re);
    assert.match(r.stderr, /does not run ungated/);
    assert.ok(!fs.existsSync(outfile), "and nothing was dispatched");
  }
});

test("a factory id that is not a factory node says so, and points at the candidate schema", () => {
  const { home } = cliFixture({ factoryPayload: OK_FACTORY });
  const r = cli(["work", "--once", "--factory", "task-ready"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is a 'task' node, not a 'type: factory' definition/);
  assert.match(r.stderr, /spor schema adopt schema-factory/);

  const missing = cli(["work", "--once", "--factory", "factory-nope"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /could not be read from the graph/);
});

test("end to end: a dispatched run is gated, and the gate outcome lands in the graph as a fact on the item", () => {
  const { home, repo, nodes, outfile } = cliFixture({ factoryPayload: OK_FACTORY });
  const r = cli(
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: dispatched task-ready/);
  assert.match(r.stdout, /task-ready — running the gate pipeline/);
  assert.match(r.stdout, /gate acceptance passed on task-ready/);
  assert.match(r.stdout, /work: gates — passed 1/);
  // The deliverable: a graph fact, linked to the work item, in the scratch home.
  const facts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-acceptance-ready-"));
  assert.strictEqual(facts.length, 1, `expected one gate fact, saw ${fs.readdirSync(nodes)}`);
  const body = fs.readFileSync(path.join(nodes, facts[0]), "utf8");
  assert.match(body, /- \{type: relates-to, to: task-ready\}/);
  assert.match(body, /passed/);
  assert.ok(fs.existsSync(path.join(repo, "test", "acceptance.js")), "the gate left the repo alone");
  assert.strictEqual(
    execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length,
    1,
    "and cleaned up its gate worktree"
  );
});

test("end to end: an armed human gate files a requires:[human] approval item and BLOCKS the resolve", () => {
  const { home, nodes, outfile } = cliFixture({
    factoryPayload: {
      ...OK_FACTORY,
      risk_classes: { "touches:lib": ["lib/**"] },
      // approval_timeout_ms 0: the runner files the item, finds it unanswered,
      // and reports BLOCKED rather than deciding on the person's behalf.
      gates: [{ id: "security", kind: "human", risk: ["touches:lib"], approval_timeout_ms: 0 }],
    },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: gates — passed 0, failed 0, blocked 1/);
  const approval = fs.readdirSync(nodes).find((f) => f.startsWith("task-approve-security-ready-"));
  assert.ok(approval, `expected an approval item, saw ${fs.readdirSync(nodes)}`);
  const body = fs.readFileSync(path.join(nodes, approval), "utf8");
  assert.match(body, /requires: \[human\]/);
  assert.match(body, /- \{type: relates-to, to: task-ready\}/);
  assert.match(body, /touches:lib/, "the item names the risk class that armed the gate");
  assert.match(body, /spor set-status .* abandoned/, "and how to refuse it");
  // Blocked is not approved: the item is cooled, not treated as done.
  assert.match(cli(["work", "--status"], env).stdout, /skipped:\s+task-ready — gate pipeline blocked/);
});

test("end to end: a failing gate cools the item, files an escalation, and says so in --status", () => {
  const { home, nodes, outfile } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" -e "process.exit(1)"` }] },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: gates — passed 0, failed 1/);
  const filed = fs.readdirSync(nodes);
  const escalation = filed.find((f) => f.startsWith("task-gate-acceptance-ready-"));
  assert.ok(escalation, `expected a human escalation item, saw ${filed}`);
  const body = fs.readFileSync(path.join(nodes, escalation), "utf8");
  assert.match(body, /requires: \[human\]/, "the escalation is a person's item — no worker can claim it");
  assert.match(body, /- \{type: relates-to, to: task-ready\}/);

  const status = cli(["work", "--status"], env);
  assert.match(status.stdout, /gates:\s+factory-demo — passed 0, failed 1/);
  assert.match(status.stdout, /skipped:\s+task-ready — gate pipeline failed/);
});
