// The GATE PIPELINE (task-spor-work-gate-pipeline) — the enforcement layer
// `spor work` runs between a claim and the item counting as done. Four layers,
// each with its own oracle:
//
//   1. the PIPELINE (lib/shell/gate-runner.js) driven with fakes: all three gate
//      kinds, inline and referenced, the fix-cycle loop, the cycle-cap
//      escalation, the graph fact every outcome leaves behind, and the
//      DEMOTION a refusal writes (§10.7 — a refused claim must stop reading
//      done everywhere, not just in this box's cooldown map);
//   2. the COMMAND GATE's git plumbing against a REAL throwaway repo — the one
//      test that has to be real, because the claim being made is "the suite that
//      runs is the trusted ref's copy, never the implementer branch's";
//   3. the LOOP's slot accounting around a gate pipeline — including that a
//      gating item is out of candidate selection, and that a pipeline a dead
//      worker abandoned is RESUMED rather than lost (§10.8) — plus the standing
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
const { spawn, spawnSync, execFileSync } = require("node:child_process");

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
function fakes({ changed = ["lib/x.js"], suite = () => ({ ok: true }), review = () => ({ ok: true, text: '```json\n{"verdict":"pass"}\n```' }), fix = () => ({ ok: true }), approval = () => ({ state: "approved", by: "person-a" }), demote = () => ({ ok: true, demoted: true, note: "task-demo rolled back done -> open" }), writes = null } = {}) {
  const seen = { facts: [], lane: [], human: [], escalations: [], demotions: [], suites: [], reviews: [], fixes: [], approvals: 0, slept: 0 };
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
    demote: async (args) => {
      seen.demotions.push(args);
      return demote(args, seen);
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

// ------------------------------------------------ a refusal DEMOTES the item --
// The gate necessarily runs AFTER the run wrote its resolver, so a refused
// claim is one the graph is already carrying as finished. A machine-local
// cooldown does not touch that — every other reader would go on calling it done
// — so the refusal has to become graph state.

test("a FAILED gate demotes the work item on the graph, naming the escalation that now blocks it", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "1 failing" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.demotions.length, 1, "a refusal that lives only in this box's cooldown map is not enforcement");
  assert.strictEqual(seen.demotions[0].item.node_id, "task-demo");
  assert.strictEqual(seen.demotions[0].state, "failed");
  assert.strictEqual(
    seen.demotions[0].blockerId,
    "task-gate-acceptance",
    "the demotion names the escalation, so it is filed BEFORE the item is demoted — never a demoted item with nothing to point at"
  );
  assert.strictEqual(res.demoted, true);
  assert.strictEqual(res.demote_reason, null);
  // And the gate's own fact records the demotion, so the graph carries the
  // whole story rather than half of it.
  assert.match(seen.facts[0].markdown, /Demotion: task-demo rolled back done -> open/);
});

test("a BLOCKED human gate demotes too — an unanswered approval is not an approval", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "security", kind: "human", risk: ["touches:auth"], approval_timeout_ms: 0 }] });
  const { deps, seen } = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "pending" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "blocked");
  assert.strictEqual(seen.demotions.length, 1);
  assert.strictEqual(seen.demotions[0].state, "blocked");
  assert.strictEqual(seen.demotions[0].blockerId, "task-approve-x", "the approval item is the blocker");
  assert.strictEqual(res.demoted, true);
});

test("a PASSING pipeline demotes nothing — a gate records what was enforced, it never retires or reopens", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps, seen } = fakes();
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(seen.demotions, []);
  assert.strictEqual(res.demoted, undefined, "and a pass carries no demotion dimension at all");
});

test("a demotion the graph refuses is REPORTED, not swallowed — and never turns a refusal into a pass", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({
    suite: () => ({ ok: false, code: 1 }),
    demote: () => ({ ok: false, reason: "offline — could not reach server" }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed", "the enforcement is the verdict, not the bookkeeping");
  assert.strictEqual(res.demoted, false);
  assert.match(res.demote_reason, /offline/);
  assert.match(seen.facts[0].markdown, /Demotion: the item could not be demoted on the graph \(offline/);
});

test("an escalation that could not be filed still demotes, and the note never implies a blocker that does not exist", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({
    suite: () => ({ ok: false, code: 1 }),
    demote: ({ blockerId }) => ({ ok: true, demoted: true, note: blockerId ? `blocked by ${blockerId}` : "nothing blocks task-demo" }),
  });
  deps.escalate = async () => ({ ok: false, reason: "the graph refused the write" });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, null, "nothing was filed");
  assert.strictEqual(seen.demotions.length, 1, "the status rollback is still worth doing without a blocker");
  assert.strictEqual(seen.demotions[0].blockerId, null);
  assert.match(seen.facts[0].markdown, /Demotion: nothing blocks task-demo/);
});

test("a pipeline with no demote dep at all still settles — the step is optional, like every other write", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps } = fakes({ suite: () => ({ ok: false, code: 1 }) });
  delete deps.demote;
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.demoted, false);
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

// A gating item is UNFINISHED work: its node is not a candidate. Without this
// the second free slot re-dispatches the very item the first gate is judging —
// and for a `resolved` run there is no cooldown standing in the way, because a
// resolved item is supposed to have left the queue by itself.
test("a GATING item is not a candidate: a free slot never re-dispatches what this worker's own gate is still judging", async () => {
  const state = { clock: 1_700_000_000_000, runs: new Map(), dispatched: [], gateCalls: 0, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  let seq = 0;
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a" }],
    dispatch: async (item) => {
      const runId = `run-${++seq}`;
      state.dispatched.push(item.id);
      state.runs.set(runId, { run_id: runId, node_id: item.id, state: "done", terminal_state: "resolved", terminal_enforced: true });
      return { ok: true, run: { run_id: runId, harness: "fake" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: state.runs.get(id) })),
    // A pipeline that never settles — a human gate waiting on a person.
    gate: () => {
      state.gateCalls += 1;
      return new Promise(() => {});
    },
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 4) control.stopping = true;
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 2, intervalMs: 1000 }, deps, control });
  assert.deepStrictEqual(state.dispatched, ["task-a"], "one dispatch, not one per free slot");
  assert.strictEqual(state.gateCalls, 1, "and one gate pipeline, not a second racing the first");
  assert.strictEqual(status.gating.length, 1);
});

// ------------------------------------------- interrupted pipelines, resumed --
// A gate pipeline is the ONE piece of work the worker PROCESS owns, so a worker
// that dies mid-pipeline abandons it — and the run it was judging is already
// terminal and already out of the queue, so no candidate poll would ever come
// back to it. "Re-gates on the next run" has to be something a worker does.

const ORPHAN_RECORD = { run_id: "run-orphan", node_id: "task-orphan", state: "done", terminal_state: "resolved", terminal_enforced: true, finished_at: "2026-08-26T00:00:00.000Z" };

test("orphanedGateRuns joins the dead workers' slots to the run journal, and no live worker's", () => {
  const records = new Map([["run-orphan", ORPHAN_RECORD]]);
  const slot = { run_id: "run-orphan", node_id: "task-orphan", harness: "fake" };
  // `gates` is the gate-armed marker: the worker status file carries that tally
  // if and only if the worker ran with a factory.
  const dead = (extra = {}) => ({ worker_id: "w1", live: false, gates: { passed: 0, failed: 0, blocked: 0 }, gating: [slot], active: [], ...extra });

  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records }).map((o) => [o.run_id, o.node_id]),
    [["run-orphan", "task-orphan"]]
  );

  // A LIVE worker owns its own slots — two workers must not both resume one.
  assert.deepStrictEqual(workLoop.orphanedGateRuns([{ ...dead(), live: true }], { records }), []);
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead(), { worker_id: "w2", live: true, gating: [slot], active: [] }], { records }),
    [],
    "a run a live worker is already gating is not an orphan, whoever else once held it"
  );

  // A GATE-ARMED worker's ACTIVE slot counts too: one killed with runs in
  // flight never reaches the harvest that would have started their gates.
  assert.strictEqual(workLoop.orphanedGateRuns([dead({ gating: [], active: [slot] })], { records }).length, 1);

  // A settled verdict is not an orphan; an unsettled stamp is.
  for (const gate_state of ["passed", "failed", "blocked"]) {
    assert.deepStrictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state }]]) }), []);
  }
  for (const gate_state of ["running", "interrupted"]) {
    assert.strictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state }]]) }).length, 1, gate_state);
  }

  // Nothing to gate, nothing to resume: a pruned record, a run with no claim,
  // and a run past the worker's own ceiling on how long it follows one.
  assert.deepStrictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map() }), []);
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, terminal_state: "reported", terminal_enforced: true }]]) }),
    [],
    "an enforced 'reported' run self-declares not-done — there is no claim to gate"
  );
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records, now: () => Date.parse("2026-09-30T00:00:00.000Z"), maxAgeMs: 86400000 }),
    []
  );

  // A run record already claimed `running` by a worker that is STILL LIVE is
  // that worker's, even though nothing has settled: a worker stamps the record
  // before it publishes its slot, so this is the earlier of the two signals
  // that keep two workers off one orphan.
  const claimed = new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state: "running", gate_worker: "w9" }]]);
  assert.deepStrictEqual(workLoop.orphanedGateRuns([dead(), { worker_id: "w9", live: true, gating: [], active: [] }], { records: claimed }), []);
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead(), { worker_id: "w9", live: false, gating: [], active: [] }], { records: claimed }).length,
    1,
    "…but the same claim from a worker that is GONE is exactly what a resume is for"
  );
});

// `active` is populated by EVERY worker, bare ones included — and a bare worker
// (no factory, the shipped default) was never owed a gate at all. Adopting its
// runs would let a gate-armed worker retroactively judge work nobody meant to
// gate, and on a refusal file a `blocks` edge and roll back the status of an
// item a person may have deliberately closed.
test("a dead BARE worker's runs are never adopted — a gate is only ever imposed on work that was owed one", () => {
  const records = new Map([["run-orphan", ORPHAN_RECORD]]);
  const slot = { run_id: "run-orphan", node_id: "task-orphan", harness: "fake" };
  const armed = { passed: 0, failed: 0, blocked: 0 };

  // Same dead worker, same terminal run, same gateable claim — the ONLY
  // difference is whether that worker itself ran gate-armed.
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "bare", live: false, gating: [], active: [slot] }], { records }),
    [],
    "a bare worker's run was never owed a gate"
  );
  assert.strictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "armed", live: false, gates: armed, gating: [], active: [slot] }], { records }).length,
    1,
    "…and a gate-armed worker's run was"
  );

  // A `gating` slot is self-evidencing — it could not exist without a pipeline
  // — so it is honored even if the tally is missing from a mangled record.
  assert.strictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "odd", live: false, gating: [slot], active: [] }], { records }).length,
    1
  );

  // resumableSlots is the whole rule, in isolation.
  assert.deepStrictEqual(workLoop.resumableSlots({ gates: armed, gating: [slot], active: [slot] }).length, 2);
  assert.deepStrictEqual(workLoop.resumableSlots({ gating: [], active: [slot] }), []);
  assert.deepStrictEqual(workLoop.resumableSlots(null), []);
});

// A resumed pipeline RE-RUNS its gates from the first one, and a fix cycle
// dispatches an implementer with --force --no-worktree into the run's own
// checkout. The abandoned pipeline's fix agent is DETACHED and outlived the
// worker that started it, so adopting while it works would put two agents in
// one checkout — the hazard worktree isolation exists to remove.
test("an orphan whose node still has a live run is DEFERRED, not adopted — never two agents in one checkout", () => {
  const TERMINAL = new Set(["done", "failed", "failed_launch", "vanished"]);
  const dead = { worker_id: "w1", live: false, gating: [{ run_id: "run-orphan", node_id: "task-orphan", harness: "fake" }], active: [] };
  const withFix = (state) =>
    new Map([
      ["run-orphan", ORPHAN_RECORD],
      // The fix cycle the abandoned pipeline dispatched at the same node.
      ["run-fix", { run_id: "run-fix", node_id: "task-orphan", state, created_at: new Date().toISOString() }],
    ]);

  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead], { records: withFix("running"), terminalStates: TERMINAL }),
    [],
    "a live agent at that node defers the resume"
  );
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead], { records: withFix("done"), terminalStates: TERMINAL }).length,
    1,
    "deferred, not dropped: once that agent's run is terminal the orphan is adopted"
  );
  // A record aged past the worker's own watchdog ceiling is not evidence of a
  // live agent — that is precisely the record runHarvest gives up on — so it
  // must not defer the orphan forever.
  const stale = new Map([
    ["run-orphan", ORPHAN_RECORD],
    ["run-fix", { run_id: "run-fix", node_id: "task-orphan", state: "running", created_at: "2020-01-01T00:00:00.000Z" }],
  ]);
  // Pin `now` to ORPHAN_RECORD's own finished_at rather than the real wall
  // clock: this assertion means to test the run-fix record aging out of
  // busyNodes (its `created_at` is 2020, always stale), not ORPHAN_RECORD's
  // own age against maxAgeMs's watchdog on line ~458 — using real Date.now()
  // made this fail once real-world time drifted more than a day past
  // ORPHAN_RECORD.finished_at (2026-08-26), which is exactly what happened.
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead], {
      records: stale,
      terminalStates: TERMINAL,
      maxAgeMs: 86400000,
      now: () => Date.parse(ORPHAN_RECORD.finished_at),
    }).length,
    1
  );
});

test("gatingNodeIds names what LIVE workers are gating — the cross-worker half of the candidate exclusion", () => {
  const ids = workLoop.gatingNodeIds([
    { worker_id: "a", live: true, gating: [{ run_id: "r1", node_id: "task-a" }], active: [{ run_id: "r9", node_id: "task-active" }] },
    { worker_id: "b", live: false, gating: [{ run_id: "r2", node_id: "task-b" }] },
    { worker_id: "c", live: true, gating: [] },
    null,
  ]);
  // A live worker's gating node only. A DEAD worker's is not excluded — that
  // one is an orphan to be resumed, not work in progress — and `active` is
  // already covered by the in-flight agent guard.
  assert.deepStrictEqual([...ids], ["task-a"]);
  assert.deepStrictEqual([...workLoop.gatingNodeIds(null)], []);
});

test("a worker RESUMES an unfinished gate pipeline before taking new work, and stamps the verdict on the run record", async () => {
  const marks = [];
  const h = loopHarness({ queue: [], gate: () => ({ state: "failed", reason: "the acceptance suite still fails" }), maxPasses: 6 });
  h.deps.markGate = (runId, patch) => marks.push({ run_id: runId, ...patch });
  // The real scan stops offering a run once a LIVE worker stamps it `running`.
  h.deps.pendingGates = async () =>
    marks.some((m) => m.gate_state === "running") ? [] : [{ run_id: "run-orphan", node_id: "task-orphan", harness: "fake", record: ORPHAN_RECORD }];

  const status = await workLoop.runWorkLoop({ opts: { workerId: "w2", concurrency: 1, intervalMs: 1000 }, deps: h.deps, control: h.control });
  assert.strictEqual(h.state.gateCalls.length, 1, "the abandoned pipeline is picked up, not left standing forever");
  assert.strictEqual(h.state.gateCalls[0].entry.node_id, "task-orphan");
  assert.strictEqual(status.gates.failed, 1);
  assert.deepStrictEqual(status.gating, []);
  assert.strictEqual(status.recent[0].node_id, "task-orphan");
  assert.strictEqual(status.recent[0].gate, "failed", "and the resumed run gets its verdict on the status surface");
  assert.strictEqual(status.skipped[0].id, "task-orphan", "a refused resume cools the node like any other");
  assert.deepStrictEqual(marks.map((m) => m.gate_state), ["running", "failed"]);
  assert.strictEqual(marks[0].gate_worker, "w2");
  assert.ok(marks.every((m) => m.gate_at), "every stamp is dated");
});

test("resumption is bounded by the free slots, comes AHEAD of new work, and stops when the worker winds down", async () => {
  const state = { clock: 1_700_000_000_000, ticks: 0, dispatched: 0, gated: [] };
  const control = { stopping: false, reason: null, wake: () => {} };
  const orphan = (n) => ({ run_id: `run-orphan-${n}`, node_id: `task-orphan-${n}`, harness: "fake", record: { ...ORPHAN_RECORD, run_id: `run-orphan-${n}`, node_id: `task-orphan-${n}` } });
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a" }],
    dispatch: async () => {
      state.dispatched += 1;
      return { ok: true, run: { run_id: "run-new", harness: "fake" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: "task-a", state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    // Three orphans on offer, on every pass, forever.
    pendingGates: async () => [orphan(1), orphan(2), orphan(3)],
    gate: (entry) => {
      state.gated.push(entry.node_id);
      return { state: "passed" };
    },
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 6) control.stopping = true; // a backstop; --once should end this first
    },
  };
  await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 2, intervalMs: 1000, once: true }, deps, control });
  // Pass 1 has two free slots: both go to orphans, ahead of the queue —
  // finishing what this box already promised to judge outranks starting
  // something else. The third waits for a slot; a DRAINING pass (--once, past
  // its first) takes on nothing new, so it waits for the next worker instead.
  assert.deepStrictEqual(state.gated, ["task-orphan-1", "task-orphan-2"]);
  assert.strictEqual(state.dispatched, 0, "the free slots went to the unfinished gates, not to new work");
});

test("a stop folds in the verdicts that DID land before abandoning the rest", async () => {
  // The loop has SEVERAL exits, and the one a signal actually takes is not the
  // stop-condition step: `control.stopping` is set by a handler at any instant,
  // and a stop that lands during slot-filling breaks out at the end of the pass
  // — after that pass's settle has already run. A pipeline that reported in
  // that window has a verdict, and abandoning it so the next worker re-runs the
  // whole thing (a suite, a review dispatch, a fix cycle) is pure waste. So the
  // final fold lives on the way OUT of the loop, where every exit reaches it.
  const marks = [];
  const state = { clock: 1_700_000_000_000, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  const settle = new Map(); // run_id -> resolve
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => {
      // A pass with a free slot reaches the queue poll — and this is where the
      // SIGTERM lands, mid-pass, with one pipeline's verdict arriving with it.
      if (settle.has("run-task-a") && !control.stopping) {
        settle.get("run-task-a")({ state: "failed", reason: "the suite fails" });
        await new Promise((r) => setImmediate(r)); // let the verdict reach its job handle
        control.stopping = true;
      }
      return [{ id: "task-a" }, { id: "task-b" }];
    },
    dispatch: async (item) => ({ ok: true, run: { run_id: `run-${item.id}`, harness: "fake" } }),
    pollRuns: async (ids) =>
      ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: id.replace("run-", ""), state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    gate: (entry) => new Promise((resolve) => settle.set(entry.run_id, resolve)),
    markGate: (runId, patch) => marks.push({ run_id: runId, ...patch }),
    sleep: async (ms) => {
      state.clock += ms;
      state.ticks += 1;
      await new Promise((r) => setImmediate(r)); // the pipelines start in a microtask
      if (state.ticks > 5) control.stopping = true; // a backstop, never reached
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 3, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.gates.failed, 1, "a verdict that exists is recorded, not thrown away for the next worker to re-run");
  assert.deepStrictEqual(status.gating.map((g) => g.node_id), ["task-b"], "and only the pipeline that never reported is abandoned");
  assert.deepStrictEqual(
    marks.filter((m) => m.run_id === "run-task-a").map((m) => m.gate_state),
    ["running", "failed"],
    "the settled run is stamped with its verdict, never 'interrupted'"
  );
  assert.deepStrictEqual(
    marks.filter((m) => m.run_id === "run-task-b").map((m) => m.gate_state),
    ["running", "interrupted"],
    "and the one that never reported is left in the state the next worker resumes from"
  );
});

test("a stop marks its abandoned pipelines INTERRUPTED — the state the next worker resumes from", async () => {
  const marks = [];
  const state = { clock: 1_700_000_000_000, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a" }],
    dispatch: async () => ({ ok: true, run: { run_id: "run-1", harness: "fake" } }),
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: "task-a", state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    gate: () => new Promise(() => {}),
    markGate: (runId, patch) => marks.push({ run_id: runId, ...patch }),
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 2) control.stopping = true;
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.gating.length, 1, "the slot stays in the published record — it is what the next worker joins on");
  assert.deepStrictEqual(marks.map((m) => m.gate_state), ["running", "interrupted"]);
});

test("the resume scan reads back what the run journal and the worker status files actually store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-resume-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "11111111-2222-3333-4444-555555555555";
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId, node_id: "task-orphan", state: "done", terminal_state: "resolved", terminal_enforced: true, created_at: new Date().toISOString(),
  });
  // A worker record with a pid that is gone: STALE, never running (the same
  // reading `spor work --status` gives an operator).
  workLoop.writeWorkerStatus(home, {
    worker_id: "dead", pid: 999999, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    active: [], gating: [{ run_id: runId, node_id: "task-orphan", harness: "fake", started_at: new Date().toISOString() }],
  });
  const scan = () =>
    workLoop.orphanedGateRuns(workLoop.readWorkerStatuses(home, { alive: () => false }), {
      records: new Map(dispatchRuns.readRunRecords(home).map((r) => [r.run_id, r])),
    });
  assert.deepStrictEqual(scan().map((o) => o.node_id), ["task-orphan"]);

  // …and once a pipeline settles, the stamp takes it out of the scan for good.
  assert.ok(dispatchRuns.stampGateState(home, runId, { gate_state: "passed", gate_at: new Date().toISOString() }));
  assert.deepStrictEqual(scan(), []);
  assert.strictEqual(dispatchRuns.stampGateState(home, "no-such-run", { gate_state: "passed" }), null);

  // A SETTLED verdict is final for this run. Two workers can, in a narrow
  // window, both adopt one orphan; without this the loser's later `passed`
  // would overwrite the winner's refusal — a refusal laundered into an
  // approval, the one direction this feature must never fail in.
  const refused = dispatchRuns.stampGateState(home, runId, { gate_state: "failed", gate_reason: "the suite fails" });
  assert.strictEqual(refused.gate_state, "passed", "the settled verdict stands");
  assert.strictEqual(refused.gate_reason, undefined);
  assert.strictEqual(
    dispatchRuns.stampGateState(home, runId, { gate_state: "interrupted" }).gate_state,
    "passed",
    "and a stop cannot reopen one either"
  );
  assert.strictEqual(dispatchRuns.stampGateState(home, runId, { terminal_state: "failed" }), null, "a patch with nothing of its own writes nothing at all");
});

test("a gate stamp only ever writes its own namespace, and survives the writers that own the record", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-stamp-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "22222222-3333-4444-5555-666666666666";
  const paths = dispatchRuns.runPaths(home, runId);
  const base = { run_id: runId, node_id: "task-x", state: "done", terminal_state: "resolved", terminal_enforced: true, contract_pending: true };
  dispatchRuns.atomicJson(paths.record, base);

  // The process and outcome dimensions (§8) are not reachable from a gate
  // stamp, whatever a caller passes.
  const stamped = dispatchRuns.stampGateState(home, runId, { gate_state: "running", gate_worker: "w1", terminal_state: "failed", state: "vanished" });
  assert.deepStrictEqual(
    [stamped.terminal_state, stamped.state, stamped.gate_state, stamped.gate_worker],
    ["resolved", "done", "running", "w1"]
  );

  // …and the reverse: a supervised record goes terminal carrying a PROVISIONAL
  // `contract_pending` outcome, and the loop harvests (and starts gating) it
  // once the contract grace elapses. The supervisor's own later write comes
  // from an IN-MEMORY copy that predates the stamp, so without carrying the
  // namespace across it would silently erase the gate verdict this feature
  // promises is durable.
  const handle = { paths, record: { ...base } };
  dispatchRuns.updateRun(handle, { terminal_note: "verified on the graph", contract_pending: false });
  const after = dispatchRuns.readJson(paths.record);
  assert.strictEqual(after.contract_pending, false, "the supervisor's own patch still lands");
  assert.strictEqual(after.gate_state, "running", "and the out-of-band gate stamp survives it");
  assert.strictEqual(after.gate_worker, "w1");
});

// `carryGateFields` closes the ordinary ordering, but neither writer holds a
// lock: a supervisor that READ before a settle and RENAMED after it reverts the
// verdict to whatever its stale copy held. The consequence is bounded (the gate
// FACTS and the graph demotion have already landed, so a revert costs a re-run,
// not correctness) — and a verify-and-reapply pass closes it in practice.
test("a settle that gets clobbered by a concurrent whole-record write is re-applied, and yields to a real verdict", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-race-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "33333333-4444-5555-6666-777777777777";
  const paths = dispatchRuns.runPaths(home, runId);
  const base = { run_id: runId, node_id: "task-x", state: "done", terminal_state: "resolved", terminal_enforced: true, gate_state: "running" };
  // A supervisor whose rename straddles the settle: it puts its own stale copy
  // back on disk, reverting the verdict to `running`.
  const clobber = (extra = {}) => dispatchRuns.atomicJson(paths.record, { ...base, gate_state: "running", ...extra });

  dispatchRuns.atomicJson(paths.record, base);
  let reads = 0;
  const flaky = (file) => {
    reads += 1;
    if (reads === 1) {
      clobber({ terminal_note: "the supervisor's stale copy" });
      return dispatchRuns.readJson(file);
    }
    return dispatchRuns.readJson(file);
  };
  const settled = dispatchRuns.stampGateState(home, runId, { gate_state: "failed", gate_reason: "the suite fails" }, { readBack: flaky });
  assert.strictEqual(settled.gate_state, "failed");
  assert.strictEqual(reads, 2, "the clobbered write is noticed and re-applied, then verified");
  const onDisk = dispatchRuns.readJson(paths.record);
  assert.strictEqual(onDisk.gate_state, "failed", "the verdict is what is on disk");
  assert.strictEqual(onDisk.terminal_note, "the supervisor's stale copy", "and the supervisor's own write is not undone");

  // Retries are BOUNDED — a permanently contended file must not spin.
  dispatchRuns.atomicJson(paths.record, base);
  let spins = 0;
  const never = (file) => {
    spins += 1;
    clobber();
    return dispatchRuns.readJson(file);
  };
  dispatchRuns.stampGateState(home, runId, { gate_state: "failed" }, { verifyAttempts: 2, readBack: never });
  assert.strictEqual(spins, 2, "it gives up rather than spinning; the resume scan re-offers the run");

  // And if the clobber was ANOTHER worker legitimately settling first, the
  // retry yields to that verdict instead of fighting for the last word.
  dispatchRuns.atomicJson(paths.record, base);
  const raced = (file) => {
    dispatchRuns.atomicJson(paths.record, { ...base, gate_state: "blocked" }); // the other worker lands
    return dispatchRuns.readJson(file);
  };
  const yielded = dispatchRuns.stampGateState(home, runId, { gate_state: "failed" }, { readBack: raced });
  assert.strictEqual(yielded.gate_state, "blocked", "a settled verdict is final, whoever wrote it");
  assert.strictEqual(dispatchRuns.readJson(paths.record).gate_state, "blocked");
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

// The demotion's own write door. Only a claim of COMPLETION is rolled back: a
// gate refuses "this is finished", it never reopens a person's decision to drop
// the work — and it never touches the resolving EDGE, which is the agent's own
// record of what it did and the evidence the escalation asks a person to judge.
test("a refused item's COMPLETION status is rolled back — and nothing else is", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-demote-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, status, extra = "") =>
    fs.writeFileSync(
      path.join(nodes, `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: ${status}\n${extra}date: 2026-08-26\n---\n\nBody.\n`
    );
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  // The whole point: the run wrote a resolver, so the graph reads DONE. The
  // gate refused it, and the graph must stop saying so.
  write("task-done", "done");
  fs.writeFileSync(
    path.join(nodes, "dec-resolver.md"),
    "---\nid: dec-resolver\ntype: decision\ntitle: Added bounded retry\nsummary: Added bounded retry with backoff to the sync worker, so a transient failure retries instead of dropping.\ndate: 2026-08-26\nedges:\n  - {type: resolves, to: task-done}\n---\n\nBody.\n"
  );
  const demoted = await sporCli.gateDemoteItem(cfg, "task-done", { blockerId: "task-gate-acceptance" });
  assert.strictEqual(demoted.ok, true);
  assert.strictEqual(demoted.demoted, true);
  assert.match(demoted.note, /task-done rolled back done -> open; task-gate-acceptance now blocks task-done/);
  assert.strictEqual(statusOf("task-done"), "open");
  assert.ok(fs.existsSync(path.join(nodes, "dec-resolver.md")), "the resolver node is left standing — it is the evidence, not the verdict");
  assert.match(fs.readFileSync(path.join(nodes, "dec-resolver.md"), "utf8"), /type: resolves/, "and its edge is never retracted (this client has no edge-removal door)");

  // Nothing to roll back: the ordinary local-mode case, where the run only ever
  // `reported` and the item never left the queue at all.
  write("task-open", "open");
  const open = await sporCli.gateDemoteItem(cfg, "task-open", { blockerId: "task-gate-acceptance" });
  assert.deepStrictEqual([open.ok, open.demoted], [true, false]);
  assert.match(open.note, /not a claim of completion/, "a do-nothing demotion still SAYS so — a silent one reads exactly like a working one");
  assert.strictEqual(statusOf("task-open"), "open");

  // A person's decision to DROP the work is not a claim of completion.
  write("task-abandoned", "abandoned");
  const abandoned = await sporCli.gateDemoteItem(cfg, "task-abandoned");
  assert.deepStrictEqual([abandoned.ok, abandoned.demoted], [true, false], "a gate never reopens what a person deliberately dropped");
  assert.strictEqual(statusOf("task-abandoned"), "abandoned");

  // And a node it cannot read is a reported failure, not a silent no-op.
  const missing = await sporCli.gateDemoteItem(cfg, "task-nope");
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /could not be re-read/);

  // The escalation write can fail (an offline graph, an id collision), and the
  // demotion still runs — but it must not imply a blocker that does not exist.
  write("task-done-2", "done");
  fs.writeFileSync(
    path.join(nodes, "dec-resolver-2.md"),
    "---\nid: dec-resolver-2\ntype: decision\ntitle: Added bounded retry again\nsummary: Added bounded retry with backoff to the second sync worker, so a transient failure retries instead of dropping.\ndate: 2026-08-26\nedges:\n  - {type: resolves, to: task-done-2}\n---\n\nBody.\n"
  );
  const unblocked = await sporCli.gateDemoteItem(cfg, "task-done-2");
  assert.deepStrictEqual([unblocked.ok, unblocked.demoted], [true, true]);
  assert.match(unblocked.note, /nothing blocks task-done-2/, "the note says the blocker is missing rather than implying one");
  assert.strictEqual(statusOf("task-done-2"), "open");
});

// The gate's demotion writes through the SAME local door `spor set-status`
// uses. That door reads a type's status enum from two different declaration
// sites — the declarative `status.vocabulary` (task/issue/question) and the
// older `fields.status.enum` (workflow/workflow-run, which declare only that) —
// and reading either one alone silently disarms the check for every type using
// the other.
test("the shared local status door reads BOTH status-enum declaration sites, so neither type family goes unchecked", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-setstatus-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  // `task` declares status.vocabulary.
  fs.writeFileSync(
    path.join(nodes, "task-vocab.md"),
    "---\nid: task-vocab\ntype: task\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\ndate: 2026-08-26\n---\n\nBody.\n"
  );
  // `workflow-run` declares fields.status.enum and NO status.vocabulary.
  fs.writeFileSync(
    path.join(nodes, "run-enum.md"),
    "---\nid: run-enum\ntype: workflow-run\ntitle: A workflow run\nsummary: One run of the demo workflow, recorded so the status door has a fields.status.enum type to gate.\nstatus: running\ndate: 2026-08-26\n---\n\nBody.\n"
  );

  for (const [id, bogus, good] of [["task-vocab", "totally-bogus", "done"], ["run-enum", "totally-bogus", "succeeded"]]) {
    const refused = sporCli.setStatusLocal(cfg, id, bogus);
    assert.strictEqual(refused.ok, false, `${id}: an off-vocabulary status must be refused, not written`);
    assert.match(refused.reason, /not allowed for type/);
    assert.strictEqual(sporCli.setStatusLocal(cfg, id, good).ok, true, `${id}: and a declared one still lands`);
    assert.match(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"), new RegExp(`^status: ${good}$`, "m"));
  }

  // Membership is a VERBATIM compare: every declared value is lowercase, so a
  // shouted one is refused rather than passing the check and being written
  // through unchanged.
  assert.strictEqual(sporCli.setStatusLocal(cfg, "task-vocab", "DONE").ok, false);

  // A type that declares neither is unconstrained, exactly as before.
  fs.writeFileSync(
    path.join(nodes, "norm-free.md"),
    "---\nid: norm-free\ntype: norm\ntitle: A norm with no status enum\nsummary: A norm node, whose type declares no status vocabulary at all, so any status value is accepted.\nstatus: active\ndate: 2026-08-26\n---\n\nBody.\n"
  );
  assert.strictEqual(sporCli.setStatusLocal(cfg, "norm-free", "whatever").ok, true);
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

// --------------------------------------------------- stop-during-fix-cycle --
// issue-spor-work-stop-abandons-inflight-gates: a fix cycle's own run is
// DETACHED and can be dispatched for up to a day (runMaxMs) before its
// makeGateDeps `fix` closure's awaitGateRun ever gives up on it — so a worker
// stopped while that await is in flight abandons the whole pipeline with no
// record of which child run it left running. The fix stamps `gate_fix_run_id`
// onto the PIPELINE's own run record the moment the fix cycle is dispatched —
// before the long wait, not after — so an interrupted record already names
// the orphan by the time any stop could land.
test("a fix cycle's run id is stamped onto the pipeline's own run BEFORE the long await, not after", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fix-orphan-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });

  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId, node_id: "task-fix-me", state: "done", terminal_state: "resolved", terminal_enforced: true,
    created_at: new Date().toISOString(), gate_state: "running", gate_worker: "w1", gate_at: new Date().toISOString(),
  });

  const dispatchCalls = [];
  const deps = sporCli.makeGateDeps(cfg, {
    record: { node_id: "task-fix-me", cwd: home },
    entry: { run_id: runId, node_id: "task-fix-me", project: null },
    factory: { id: "factory-test" },
    slug: null,
    passthrough: {},
    warn: () => {},
    log: () => {},
    runMaxMs: 200, // the fix's own awaitGateRun gives up quickly — nothing here waits on the run terminating
    stopping: () => false,
    home,
    dispatch: async (_cfg, values) => {
      dispatchCalls.push(values);
      // A run record that reads NON-terminal, exactly like a real fix-cycle
      // dispatch's supervised run while its harness is still working — this is
      // what keeps awaitGateRun actually polling (not resolving on its very
      // first check) so there is a real mid-flight window to observe.
      dispatchRuns.atomicJson(dispatchRuns.runPaths(home, "fix-run-orphan").record, {
        run_id: "fix-run-orphan", node_id: "task-fix-me", state: "running", created_at: new Date().toISOString(),
      });
      return { ok: true, run: { run_id: "fix-run-orphan", harness: "fake" } };
    },
    // A plain timer so awaitGateRun's own poll loop can actually reach its
    // (short) deadline instead of hanging the test.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const fixOutcome = deps.fix({ gate: { id: "acceptance" }, cycle: 0, findings: [], detail: "the suite fails", evidence: "" });
  // Give the dispatch + stamp their microtasks — this is the moment a stop
  // would land in real life, well before the fix cycle's own run ever
  // terminates: fixOutcome is still pending, its awaitGateRun still polling a
  // run record that reads "running" until the short runMaxMs gives up on it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(dispatchCalls.length, "the fix cycle was actually dispatched by this point");

  const midFlight = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
  assert.strictEqual(midFlight.gate_fix_run_id, "fix-run-orphan", "the fix cycle's run id lands on the PIPELINE's own run before its await settles");
  assert.ok(midFlight.gate_fix_at, "and it is dated");
  assert.strictEqual(dispatchCalls[0].node, "task-fix-me");
  assert.strictEqual(dispatchCalls[0].force, true);

  // Simulate the stop: work-loop.js's runWorkLoop marks the pipeline's own run
  // interrupted on the way out (lib/shell/work-loop.js, the final `if
  // (status.gating.length)` block) — via the exact same stampGateState door.
  const interrupted = dispatchRuns.stampGateState(home, runId, { gate_state: "interrupted" });
  assert.strictEqual(interrupted.gate_state, "interrupted");
  assert.strictEqual(
    interrupted.gate_fix_run_id,
    "fix-run-orphan",
    "the interrupted record still names the orphaned fix-cycle run — what a restarted 'spor work' or a human ('spor runs') finds it by"
  );

  // Let the fix's own promise settle (a missing run record reads as terminal
  // with no verdict — awaitGateRun does not hang on it) so the test leaves no
  // dangling handle. Its outcome is irrelevant to what this test checks: the
  // stamp above already landed before this point, which is the whole claim.
  await fixOutcome;
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
function cliFixture({ factoryPayload, gatePayload = null, factoryStatus = "active", gateStatus = "active" } = {}) {
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
      `type: factory\ntitle: The demo factory\nsummary: The gate pipeline the demo project enforces between claim and resolve.\nstatus: ${factoryStatus}\n`,
      ["```json", JSON.stringify(factoryPayload, null, 2), "```"].join("\n")
    );
  }
  if (gatePayload) {
    write(
      "gate-shared",
      `type: gate\ntitle: A shared gate\nsummary: A shareable gate node the demo factory references by id.\nstatus: ${gateStatus}\n`,
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

test("a retired factory refuses to start the worker instead of silently continuing to enforce", () => {
  const { home } = cliFixture({ factoryPayload: OK_FACTORY, factoryStatus: "retired" });
  const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /'factory-demo' is 'retired', not 'status: active'/);
});

test("a retired gate referenced by an active factory is a load-time validation failure", () => {
  const { home } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { ref: "gate-shared" }] },
    gatePayload: { id: "adversarial", kind: "agent-review", profile: "profile-review", cycles: 2 },
    gateStatus: "retired",
  });
  const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /referenced gate 'gate-shared' is 'retired', not 'status: active'/);
  // The status error is the whole story — no misleading "could not be read"
  // duplicate from the gate resolver, which would send an operator debugging
  // the wrong thing (issue-spor-factory-definition-status-ignored review).
  assert.doesNotMatch(r.stderr, /could not be read from the graph/);
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
  assert.match(body, /- \{type: blocks, to: task-ready\}/, "an unanswered approval BLOCKS the gated item on the graph, not just in this box's cooldown map");
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
  // The demotion is really wired through the CLI, not just through the fakes:
  // the escalation the gate filed now blocks the gated item on the graph. (The
  // fixture's item never went to a completion status, so there is no status to
  // roll back — the `blocks` half is the whole demotion here.)
  assert.match(r.stdout, /gate acceptance failed on task-ready.*now blocks task-ready/);
  const filed = fs.readdirSync(nodes);
  const escalation = filed.find((f) => f.startsWith("task-gate-acceptance-ready-"));
  assert.ok(escalation, `expected a human escalation item, saw ${filed}`);
  const body = fs.readFileSync(path.join(nodes, escalation), "utf8");
  assert.match(body, /requires: \[human\]/, "the escalation is a person's item — no worker can claim it");
  assert.match(body, /- \{type: blocks, to: task-ready\}/, "the refusal is durable graph state: the escalation blocks the gated item");

  const status = cli(["work", "--status"], env);
  assert.match(status.stdout, /gates:\s+factory-demo — passed 0, failed 1/);
  assert.match(status.stdout, /skipped:\s+task-ready — gate pipeline failed/);
});

// end to end: SIGTERM mid fix-cycle (issue-spor-work-stop-abandons-inflight-
// gates). A real `spor work` process, no --once — it must keep running until
// stopped. The declared harness answers a plain dispatch immediately but HANGS
// on a fix-cycle dispatch (recognized by its prompt), so the worker gets stuck
// mid-`awaitGateRun` exactly like an implementer that is still working when a
// service manager sends SIGTERM. Two things this must be true of: the worker
// actually EXITS on the first signal instead of sitting on the abandoned
// pipeline's own live timer, and the run record it leaves behind names the
// fix-cycle run it walked away from.
test("a single SIGTERM mid fix-cycle stops the worker promptly and leaves a durable record naming the orphaned run", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-stop-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = repoWithBranch({ weakenTest: false, regress: false }); // benign diff — the command below fails regardless of it
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-gatebox, profile: profile-gate}\n",
    "Add bounded retry to the sync worker."
  );
  write("agent-gatebox", "type: agent\ntitle: The gate test box\nsummary: An agent identity for the gate-pipeline test fixture.\n", "Test agent.");
  write("profile-gate", `type: profile\ntitle: Gate test profile\nsummary: A profile selecting the fake harness the gate-pipeline test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  write(
    "factory-demo",
    "type: factory\ntitle: The demo factory\nsummary: The gate pipeline the demo project enforces between claim and resolve.\nstatus: active\n",
    [
      "```json",
      JSON.stringify({
        factory: "demo", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer",
        // Always fails, regardless of the diff — this only exists to force
        // exactly one fix-cycle dispatch, never to be satisfied.
        gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" -e "process.exit(1)"`, cycles: 1 }],
      }),
      "```",
    ].join("\n")
  );

  const outfile = path.join(home, "invocations.jsonl");
  // A plain dispatch (the initial claim) answers immediately, as every other
  // fixture's stub does. A FIX-CYCLE dispatch — its prompt names the gate that
  // refused the resolution (makeGateDeps' `fix`, bin/spor.js) — never answers:
  // it self-exits after a few seconds purely so this test does not leak a
  // process, but that is well past when this test has already killed the
  // worker and made its assertions.
  const stub = writeSpawnableNodeStub(
    home,
    "gate-stub",
    `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GATE_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  if (prompt.includes("gate refused your resolution")) { setTimeout(() => process.exit(0), 5000); return; }
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`
  );
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

  const env = cleanEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() });
  const child = spawn(process.execPath, [CLI, "work", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  try {
    // Wait for the fix cycle to actually be dispatched (two harness
    // invocations recorded: the initial claim, then the fix).
    const deadline = Date.now() + 20000;
    for (;;) {
      const n = fs.existsSync(outfile) ? fs.readFileSync(outfile, "utf8").split("\n").filter(Boolean).length : 0;
      if (n >= 2) break;
      if (Date.now() > deadline) throw new Error(`timed out waiting for the fix cycle to dispatch.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // ...and that the pipeline's own run record already names it — the stamp
    // this feature adds, landing well before this worker is ever asked to stop.
    const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
    let named = null;
    for (;;) {
      const records = dispatchRuns.readRunRecords(home).filter((r) => r.node_id === "task-ready");
      named = records.find((r) => r.gate_fix_run_id);
      if (named) break;
      if (Date.now() > deadline) throw new Error(`timed out waiting for gate_fix_run_id to be stamped.\nrecords: ${JSON.stringify(records)}\nstdout:\n${stdout}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const fixRunId = named.gate_fix_run_id;

    child.kill("SIGTERM");
    // "close", not "exit" — "exit" can fire before the child's stdio pipes have
    // finished delivering their buffered data to this process (Node's own
    // docs), and the assertion right below reads the accumulated `stdout`.
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert.strictEqual(exitCode, 0, `a single SIGTERM must actually end the worker, even mid fix-cycle, not leave it running on the abandoned pipeline's own timer.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, new RegExp(`gate pipeline abandoned by the stop.*fix cycle \\(run ${fixRunId.slice(0, 8)}\\)`), "the abandon log names the orphaned fix-cycle run");

    // The durable record: interrupted, and still naming the run it left going.
    const finalRecord = dispatchRuns.readRunRecords(home).find((r) => r.run_id === named.run_id);
    assert.strictEqual(finalRecord.gate_state, "interrupted");
    assert.strictEqual(finalRecord.gate_fix_run_id, fixRunId, "the interrupted record still names the orphaned fix-cycle run");

    // A restarted `spor runs` surfaces both — the pipeline's own interrupted
    // state and the fix cycle it named — without needing --json.
    const runs = cli(["runs"], env);
    assert.match(runs.stdout, /gate:\s+interrupted/);
    assert.match(runs.stdout, new RegExp(`fix cycle:\\s+run ${fixRunId.slice(0, 8)}`));
  } finally {
    // Best-effort cleanup: the fix-cycle harness self-exits after 5s regardless,
    // but do not leave the worker (if somehow still alive) or its child around
    // for the rest of the suite.
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});
