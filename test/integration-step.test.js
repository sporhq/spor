// The INTEGRATION STEP (task-spor-factory-integration-step, derived-from
// dec-spor-factory-integration-step) — the declarative merge-queue landing
// stage `spor work` runs after every declared gate has passed. Four layers,
// mirroring test/gate-pipeline.test.js's own oracle split:
//
//   1. PARSING (lib/kernel/gates.js): an absent `integration:` block is not an
//      error and changes nothing; a present-but-malformed one refuses the
//      factory to load, exactly like a gate.
//   2. THE STAGE (lib/shell/integration-runner.js) driven with fakes: a clean
//      landing, a conflict routed through the fix-cycle machinery, a candidate
//      suite failure routed the same way, and a lost CAS race rebuilding and
//      retrying automatically rather than spending a fix cycle.
//   3. THE GIT PLUMBING against a REAL throwaway repo: the candidate tree
//      really is merge(target_ref, branch), protected paths are really forced
//      back to the trusted ref's copy in that candidate tree, and landing
//      really is a compare-and-swap that detects a moved target ref.
//   4. THE CLI end to end in a scratch graph home: a factory declaring both
//      gates and integration lands a real merge onto local `main` after its
//      gate passes, and an absent integration block is byte-identical to the
//      gate pipeline alone.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const gates = require("../lib/kernel/gates.js");
const integrationRunner = require("../lib/shell/integration-runner.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode, writeFakePathBin, writeFakePathNodeBin, isolatedBinDir } = require("./helpers/portable");

// ---------------------------------------------------------------- parsing --

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  return gates.parseFactory(body, { id: "factory-test" });
}

const BASE = {
  factory: "test",
  trusted_ref: "main",
  gates: [{ id: "acceptance", kind: "command", command: "npm test" }],
};

test("no integration block declared: parseFactory leaves it null and every other field unchanged", () => {
  const { factory, errors } = factoryOf(BASE);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(factory.integration, null);
});

test("a valid integration block resolves with its declared shape and sensible defaults", () => {
  const { factory, errors } = factoryOf({ ...BASE, integration: { mode: "local", command: "npm test" } });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(factory.integration, {
    targetRef: "main", // defaults to trusted_ref
    mode: "local",
    command: "npm test",
    strategy: "merge",
    serialize: "repo",
    cycles: 0,
    timeoutMs: 900000,
    reruns: 0,
  });
});

test("integration.reruns parses like a command gate's: declared as given, capped at 3", () => {
  const one = factoryOf({ ...BASE, integration: { mode: "local", command: "npm test", reruns: 1 } });
  assert.strictEqual(one.factory.integration.reruns, 1);
  const capped = factoryOf({ ...BASE, integration: { mode: "local", command: "npm test", reruns: 50 } });
  assert.strictEqual(capped.factory.integration.reruns, gates.GATE_DEFAULTS.maxReruns);
});

test("integration.target_ref really defaults to the FACTORY's own trusted_ref, not a hardcoded 'main'", () => {
  const { factory, errors } = factoryOf({ ...BASE, trusted_ref: "develop", integration: { mode: "local", command: "npm test" } });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(factory.trustedRef, "develop");
  assert.strictEqual(factory.integration.targetRef, "develop", "gates trust develop, so integration must land onto develop too");

  // An explicit target_ref still wins over the factory's trusted_ref.
  const explicit = factoryOf({ ...BASE, trusted_ref: "develop", integration: { mode: "local", command: "npm test", target_ref: "release" } });
  assert.strictEqual(explicit.factory.integration.targetRef, "release");
});

test("an invalid integration block REFUSES the whole factory to load — the same fail-closed rule a bad gate gets", () => {
  for (const [bad, re] of [
    [{ mode: "local" }, /integration\.command is required/],
    [{ command: "npm test", mode: "bogus" }, /integration\.mode 'bogus' must be one of/],
    [{ command: "npm test", strategy: "cherry-pick" }, /integration\.strategy 'cherry-pick' must be one of/],
    [{ command: "npm test", serialize: "org" }, /integration\.serialize 'org' must be 'repo'/],
    ["not an object", /integration: must be a JSON object/],
  ]) {
    const { factory, errors } = factoryOf({ ...BASE, integration: bad });
    assert.strictEqual(factory, null, JSON.stringify(bad));
    assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);
  }
});

test("mode: propose loads — PR-landing for orgs whose policy requires review (task-spor-integration-propose-mode)", () => {
  const { factory, errors } = factoryOf({ ...BASE, integration: { mode: "propose", command: "npm test" } });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(factory.integration, {
    targetRef: "main",
    mode: "propose",
    command: "npm test",
    strategy: "merge",
    serialize: "repo",
    cycles: 0,
    timeoutMs: 900000,
    reruns: 0,
  });
});

// ------------------------------------------------------------- the stage, faked --

// Mirrors gate-pipeline.test.js's `fakes()` — every write captured so tests
// assert on the FACTS and the FIX-CYCLE calls, not just the verdict.
function integrationFakes({
  tree = { ok: true, top: "/repo", head: "headsha", cwd: "/repo/wt" },
  build = null, // array of results, consumed in order, or a function
  forceProtected = () => ({ ok: true }),
  suite = () => ({ ok: true }),
  land = () => ({ ok: true, sha: "candidatesha", detail: "landed" }),
  propose = () => ({ ok: true, number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: "task-demo", targetRef: "main", detail: "opened PR #42" }),
  parkForReview = () => ({ ok: true, id: "task-integration-proposed-x" }),
  fix = () => ({ ok: true }),
  escalate = () => ({ ok: true, id: "task-integration-escalate-x" }),
  demote = () => ({ ok: true, demoted: true, note: "task-demo rolled back done -> open" }),
} = {}) {
  const seen = { builds: 0, suites: 0, lands: 0, proposals: 0, parks: [], fixes: [], escalations: [], demotions: [], facts: [], cleanups: 0, leaseAcquired: 0, leaseReleased: 0 };
  let buildCalls = 0;
  const deps = {
    now: () => 1_700_000_000_000,
    changedTree: async () => tree,
    acquireLease: async () => {
      seen.leaseAcquired += 1;
      return { kind: "fake" };
    },
    releaseLease: async () => {
      seen.leaseReleased += 1;
    },
    buildCandidate: async (args) => {
      seen.builds += 1;
      const cleanup = () => {
        seen.cleanups += 1;
      };
      if (Array.isArray(build)) {
        const r = build[Math.min(buildCalls, build.length - 1)];
        buildCalls += 1;
        return { cleanup, ...r };
      }
      const r = build ? build(args, seen) : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected1" };
      return { cleanup, ...r };
    },
    forceProtected: async (args) => forceProtected(args, seen),
    runSuite: async (args) => {
      seen.suites += 1;
      return suite(args, seen);
    },
    land: async (args) => {
      seen.lands += 1;
      return land(args, seen);
    },
    propose: async (args) => {
      seen.proposals += 1;
      return propose(args, seen);
    },
    parkForReview: async (args) => {
      seen.parks.push(args);
      return parkForReview(args, seen);
    },
    fix: async (args) => {
      seen.fixes.push(args);
      return fix(args, seen);
    },
    escalate: async (args) => {
      seen.escalations.push(args);
      return escalate(args, seen);
    },
    demote: async (args) => {
      seen.demotions.push(args);
      return demote(args, seen);
    },
    recordFact: async ({ id, markdown }) => {
      seen.facts.push({ id, markdown });
      return { ok: true, id };
    },
    cleanupImplementer: async () => {
      seen.cleanedImplementer = true;
    },
  };
  return { deps, seen };
}

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };
const FACTORY = { id: "factory-demo", integration: { targetRef: "main", mode: "local", command: "npm test", strategy: "merge", serialize: "repo", cycles: 2, timeoutMs: 900000 } };

test("a clean build+suite+land is a PASS, records a landed art-merge fact, and cleans up the implementer's worktree", async () => {
  const { deps, seen } = integrationFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.builds, 1);
  assert.strictEqual(seen.suites, 1);
  assert.strictEqual(seen.lands, 1);
  assert.strictEqual(seen.cleanups, 1, "the candidate worktree is cleaned up");
  assert.ok(seen.cleanedImplementer, "the implementer's worktree is cleaned up on a landing");
  assert.strictEqual(seen.leaseAcquired, 1);
  assert.strictEqual(seen.leaseReleased, 1, "the lease is released even on success");
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].id, /^art-merge-demo-runabcde-[0-9a-f]{8}$/);
  assert.match(seen.facts[0].markdown, /type: artifact/);
  assert.match(seen.facts[0].markdown, /- \{type: relates-to, to: task-demo\}/);
  assert.match(seen.facts[0].markdown, /landed/);
  assert.strictEqual(seen.escalations.length, 0);
  assert.strictEqual(seen.demotions.length, 0, "a landing demotes nothing");
});

test("a merge CONFLICT routes through the fix-cycle machinery, and lands once the fix resolves it", async () => {
  const { deps, seen } = integrationFakes({
    build: [{ ok: false, conflict: true, reason: "merging onto main conflicts" }, { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" }],
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.builds, 2, "the candidate is rebuilt after the fix");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.fixes[0].kind, "conflict");
  assert.strictEqual(seen.escalations.length, 0, "a fix that lands escalates nothing");
});

test("a candidate SUITE FAILURE routes through the SAME fix-cycle machinery, cycle cap included", async () => {
  const { deps, seen } = integrationFakes({ suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }) });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "failed");
  // FACTORY declares cycles: 2 -> attempts 0,1,2 (cap reached on the 3rd).
  assert.strictEqual(seen.fixes.length, 2, "fix cycles are bounded by the declared cap");
  assert.strictEqual(seen.fixes.every((f) => f.kind === "suite"), true);
  assert.strictEqual(seen.escalations.length, 1, "the cap escalates to a human item exactly once");
  assert.strictEqual(seen.demotions.length, 1, "a failure demotes the item, same as a failed gate");
  assert.match(seen.facts[seen.facts.length - 1].markdown, /failed/);
});

test("a candidate suite FLAKE under `integration.reruns: 1` is re-run on the same candidate and LANDS on the rerun — no fix cycle, the first failure kept as evidence", async () => {
  const outcomes = [{ ok: false, reason: "npm test exited 1", output: "1 failing\n  waitForFile read '' under load\n" }, { ok: true }];
  const attempts = [];
  const { deps, seen } = integrationFakes({
    suite: (args) => {
      attempts.push(args.attempt);
      return outcomes.shift();
    },
  });
  const factory = { ...FACTORY, integration: { ...FACTORY.integration, reruns: 1 } };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(attempts, [1, 2], "the candidate suite ran twice on ONE candidate");
  assert.strictEqual(seen.builds, 1, "a rerun never rebuilds the candidate");
  assert.strictEqual(seen.lands, 1);
  assert.strictEqual(seen.fixes.length, 0, "a rerun is not a fix cycle");
  assert.strictEqual(seen.escalations.length, 0);
  const fact = seen.facts[seen.facts.length - 1].markdown;
  assert.match(fact, /passed on rerun 1 of the same tree after failing/);
  assert.match(fact, /waitForFile read '' under load/, "the flake stays on the merge fact");
});

test("a candidate suite that fails on every rerun is charged ONE fix cycle, not one per run", async () => {
  const { deps, seen } = integrationFakes({ suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }) });
  const factory = { ...FACTORY, integration: { ...FACTORY.integration, reruns: 1, cycles: 1 } };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.suites, 4, "two runs per cycle: the declared run plus one rerun, before and after the fix");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.escalations.length, 1);
  // The exhausted budget is on the record everywhere the failure travels: the
  // fix cycle's brief, the escalation and the merge fact all say how many runs
  // of the one candidate failed, so the fact never reads like a single run.
  assert.match(seen.fixes[0].detail, /npm test exited 1 — on every one of 2 runs of the same tree \(1 rerun declared\)/);
  assert.match(seen.escalations[0].detail, /on every one of 2 runs of the same tree \(1 rerun declared\)/);
  const fact = seen.facts[seen.facts.length - 1].markdown;
  assert.match(fact, /on every one of 2 runs of the same tree \(1 rerun declared\)/);
  assert.match(fact, /1 failing/, "the last run's output is the evidence");
});

test("a candidate suite that fails with NO rerun declared is charged with its bare reason — the exhausted-runs wording is only for a spent budget", async () => {
  const { deps, seen } = integrationFakes({ suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }) });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "failed");
  assert.doesNotMatch(seen.escalations[0].detail, /on every one of/);
  assert.match(seen.escalations[0].detail, /^npm test exited 1/);
});

test("in `propose` mode a rerun-rescued candidate suite opens its PR with the first failure kept as evidence beside the PR url", async () => {
  const outcomes = [{ ok: false, reason: "npm test exited 1", output: "1 failing\n  waitForFile read '' under load\n" }, { ok: true }];
  const { deps, seen } = integrationFakes({ suite: () => outcomes.shift() });
  const factory = { ...FACTORY, integration: { ...FACTORY.integration, mode: "propose", reruns: 1 } };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "parked");
  assert.strictEqual(seen.builds, 1, "a rerun never rebuilds the candidate");
  assert.strictEqual(seen.proposals, 1);
  assert.strictEqual(seen.fixes.length, 0, "a rerun is not a fix cycle");
  const fact = seen.facts[seen.facts.length - 1].markdown;
  assert.match(fact, /Integration proposed/);
  assert.match(fact, /passed on rerun 1 of the same tree after failing/);
  assert.match(fact, /https:\/\/github\.com\/demo\/repo\/pull\/42/, "the PR url is still the proposal's evidence");
  assert.match(fact, /waitForFile read '' under load/, "the flake rides the proposed fact exactly as it would a landed one");
});

test("a LOST CAS race rebuilds and retries automatically — it is nobody's fix cycle", async () => {
  let lands = 0;
  const { deps, seen } = integrationFakes({
    land: () => {
      lands += 1;
      return lands < 3 ? { ok: false, race: true, reason: "main moved" } : { ok: true, sha: "final", detail: "landed on the 3rd try" };
    },
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.builds, 3, "each race rebuilds the candidate against the ref's new tip");
  assert.strictEqual(seen.fixes.length, 0, "a lost race never dispatches a fix — it is not the implementer's mistake");
});

test("a race that never stops losing is bounded, and escalates instead of spinning forever", async () => {
  const { deps, seen } = integrationFakes({ land: () => ({ ok: false, race: true, reason: "main keeps moving" }) });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.builds, integrationRunner.RACE_RETRY_CAP);
  assert.strictEqual(seen.escalations.length, 1);
});

test("an unreadable change to integrate fails closed, with no build attempted", async () => {
  const { deps, seen } = integrationFakes({ tree: { ok: false, reason: "uncommitted changes" } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.builds, 0);
  assert.match(res.reason, /uncommitted changes/);
});

test("a graph that refuses the fact write does not change the verdict — the enforcement is not the bookkeeping", async () => {
  const { deps } = integrationFakes();
  deps.recordFact = async () => ({ ok: false, reason: "the graph refused the write" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed", "a landing that could not be recorded is still a landing");
});

// issue-spor-integration-landed-sha-pre-restoration: forceProtected may hand
// back a DIFFERENT sha than the one buildCandidate produced (a re-commit of
// the restored tree) — the stage must land THAT sha, not the pre-restoration
// one, and must pass it through even when nothing needed restoring.
test("the sha forceProtected returns is the sha that gets landed, not the pre-restoration build sha", async () => {
  const { deps, seen } = integrationFakes({
    forceProtected: () => ({ ok: true, sha: "restoredsha" }),
    land: (args, s) => {
      s.landArgs = args;
      return { ok: true, sha: args.sha, detail: "landed" };
    },
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.landArgs.sha, "restoredsha", "the restored/re-committed sha is what gets landed");
});

test("a forceProtected that reports no restoration falls back to the build's own sha", async () => {
  const { deps, seen } = integrationFakes({
    forceProtected: () => ({ ok: true }), // no `sha` field — nothing was restored
    land: (args, s) => {
      s.landArgs = args;
      return { ok: true, sha: args.sha, detail: "landed" };
    },
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.landArgs.sha, "candidatesha", "no restoration -> land the build's own sha unchanged");
});

// --------------------------------------------- propose mode (task-spor-integration-propose-mode) --

const FACTORY_PROPOSE = { id: "factory-demo", integration: { targetRef: "main", mode: "propose", command: "npm test", strategy: "merge", serialize: "repo", cycles: 2, timeoutMs: 900000 } };

test("propose mode opens a PR instead of landing: deps.land is NEVER called, target_ref is never touched", async () => {
  const { deps, seen } = integrationFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked");
  assert.strictEqual(seen.proposals, 1);
  assert.strictEqual(seen.lands, 0, "propose mode must never call the CAS-landing dep");
});

test("propose mode parks the item: it demotes on the graph, files a tracking item, and records a 'proposed' fact carrying the PR url — but does not escalate", async () => {
  const { deps, seen } = integrationFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked");
  assert.strictEqual(res.escalated_to, "task-integration-proposed-x");
  assert.strictEqual(seen.parks.length, 1, "a tracking item is filed exactly once");
  assert.strictEqual(seen.escalations.length, 0, "parking is not an escalation — nothing failed yet");
  assert.strictEqual(seen.demotions.length, 1, "the item is demoted, same graph-state fact a blocked gate leaves");
  assert.strictEqual(seen.cleanedImplementer, true, "the branch is already pushed for the PR — the dispatch worktree is still cleaned up");
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].id, /^art-merge-demo-runabcde-proposed-[0-9a-f]{8}$/, "propose-mode facts are phase-qualified, unlike local/push's bare id");
  assert.match(seen.facts[0].markdown, /pending review/);
  assert.match(seen.facts[0].markdown, /https:\/\/github\.com\/demo\/repo\/pull\/42/, "the PR url is recorded on the fact");
  assert.match(seen.facts[0].markdown, /- \{type: relates-to, to: task-integration-proposed-x\}/, "proposing only RELATES to the tracking item — nothing resolves yet");
});

test("a candidate suite failure in propose mode routes through the SAME fix-cycle machinery, and proposing after the fix parks it", async () => {
  const { deps, seen } = integrationFakes({ suite: (() => {
    let calls = 0;
    return () => (calls++ === 0 ? { ok: false, reason: "npm test exited 1", output: "1 failing" } : { ok: true });
  })() });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.fixes[0].kind, "suite");
  assert.strictEqual(seen.proposals, 1, "the PR is only opened once the candidate suite is actually green");
});

test("propose failing to open a PR routes through the fix-cycle cap, then FAILS and escalates — never silently parks a proposal that never happened", async () => {
  const { deps, seen } = integrationFakes({ propose: () => ({ ok: false, reason: "gh: authentication required" }) });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.fixes.every((f) => f.kind === "propose"), true);
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.parks.length, 0, "a proposal that never opened is not parked");
});

// issue-spor-integration-settle-escalate-demote-race: the same atomic pair the
// gate pipeline closed in task-spor-gate-escalation-demote-atomic. A settle()
// whose escalation write fails must NOT roll the item back — that leaves it
// open, agent-ready, unblocked, its resolving edge standing, and the refusal
// held only in this box's cooldown map.
test("an integration escalation that could not be filed STOPS the demotion, records the withheld rollback on the fact, and marks the refusal", async () => {
  const { deps, seen } = integrationFakes({
    suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }),
    escalate: () => ({ ok: false, reason: "the graph refused the write" }),
    demote: ({ blockerId }) => ({ ok: true, demoted: true, note: blockerId ? `blocked by ${blockerId}` : "nothing blocks task-demo" }),
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } }, deps });
  assert.strictEqual(res.state, "failed", "the enforcement is still the verdict");
  assert.strictEqual(res.escalated_to, null, "nothing was filed");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.demotions.length, 0, "the item's status is left exactly as the run left it");
  assert.strictEqual(res.demoted, false);
  assert.strictEqual(res.demote_reason, null, "nothing was attempted, so there is no failure to report");
  assert.strictEqual(res.escalation_failed, true, "the caller stamps gate_escalation_failed on the run record — the refusal is readable only on this box");
  assert.match(res.reason, /the escalation could not be filed, so the item's status was left alone/);
  assert.strictEqual(seen.facts.length, 1, "the verdict still settles as a fact");
  assert.match(seen.facts[0].markdown, /Demotion: not attempted — no escalation could be filed to block task-demo, so its status is left as the run left it/);
  assert.doesNotMatch(seen.facts[0].markdown, /rolled back/);
  assert.doesNotMatch(seen.facts[0].markdown, /Escalated to/);
});

test("the same integration refusal WITH an escalation is unchanged — it escalates, then demotes naming the blocker, and is not marked", async () => {
  const { deps, seen } = integrationFakes({
    suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }),
    demote: ({ blockerId }) => ({ ok: true, demoted: true, note: `task-demo rolled back done -> open; ${blockerId} now blocks task-demo` }),
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } }, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, "task-integration-escalate-x");
  assert.strictEqual(res.escalation_failed, undefined, "a landed escalation settles the verdict as before");
  assert.strictEqual(seen.demotions.length, 1);
  assert.strictEqual(seen.demotions[0].blockerId, "task-integration-escalate-x", "the demotion names the blocker it waits on");
  assert.match(seen.facts[0].markdown, /Demotion: task-demo rolled back done -> open; task-integration-escalate-x now blocks task-demo/);
  assert.match(seen.facts[0].markdown, /Escalated to task-integration-escalate-x/);
});

test("an escalation that throws is the same as one refused — no demotion, marked", async () => {
  const { deps, seen } = integrationFakes({ suite: () => ({ ok: false, reason: "npm test exited 1" }) });
  deps.escalate = async () => { throw new Error("ECONNREFUSED"); };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } }, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalation_failed, true);
  assert.strictEqual(seen.demotions.length, 0);
});

// A blocked-by-escalation demotion that itself fails is still the fail-soft
// case it always was: attempted (the blocker exists), reported, never a pass.
test("a demotion the graph refuses AFTER the escalation landed is reported, not withheld and not marked", async () => {
  const { deps, seen } = integrationFakes({
    suite: () => ({ ok: false, reason: "npm test exited 1" }),
    demote: () => ({ ok: false, reason: "offline — ECONNREFUSED" }),
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY, integration: { ...FACTORY.integration, cycles: 0 } }, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, "task-integration-escalate-x");
  assert.strictEqual(res.escalation_failed, undefined);
  assert.strictEqual(seen.demotions.length, 1, "the demotion was attempted — the blocker exists");
  assert.strictEqual(res.demoted, false);
  assert.match(res.demote_reason, /offline/);
  assert.match(seen.facts[0].markdown, /Demotion: the item could not be demoted on the graph \(offline/);
});

// park() is the propose-mode twin: the tracking item is the blocker, and the
// demotion waits for it exactly the same way — the heal pass (checkProposals)
// completes the pair one pass later, so nothing is marked for a person here.
test("a park whose tracking item could not be filed withholds the demotion, records why on the fact, and is not an escalation failure", async () => {
  const { deps, seen } = integrationFakes({ parkForReview: () => ({ ok: false, reason: "the graph refused the write", id: "task-integration-proposed-x" }) });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked", "the PR is open — the park still settles");
  assert.strictEqual(res.escalated_to, null);
  assert.strictEqual(seen.parks.length, 1);
  assert.strictEqual(seen.demotions.length, 0, "no tracker on the graph, no rollback");
  assert.strictEqual(res.demoted, false);
  assert.strictEqual(res.demote_reason, null);
  assert.strictEqual(res.escalation_failed, undefined, "a park is healed by the next checkProposals pass, not re-gated by a person");
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].markdown, /Demotion: not attempted — no tracking item could be filed to block task-demo, so its status is left as the run left it/);
  assert.doesNotMatch(seen.facts[0].markdown, /rolled back/);
});

test("a park WITH a tracking item demotes naming it, as before", async () => {
  const { deps, seen } = integrationFakes({
    demote: ({ blockerId }) => ({ ok: true, demoted: true, note: `task-demo rolled back done -> open; ${blockerId} now blocks task-demo` }),
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked");
  assert.strictEqual(seen.demotions.length, 1);
  assert.strictEqual(seen.demotions[0].blockerId, "task-integration-proposed-x");
  assert.match(seen.facts[0].markdown, /Demotion: task-demo rolled back done -> open; task-integration-proposed-x now blocks task-demo/);
});

// ------------------------- proposeIntegrationPR: reuse keys on (head, base) --
//
// task-spor-integration-propose-mode base-check gap (cross-model review):
// proposeIntegrationPR used to look up an existing PR by BRANCH NAME alone
// (`gh pr view <branch>`), so a stale or coincidentally same-named open PR to
// a DIFFERENT base could be adopted — and checkProposal would later trust
// GitHub's own merged/closed report by PR number alone, with no base
// cross-check, potentially resolving the work item as "landed on targetRef"
// when the change never reached it. These drive the REAL bin/spor.js
// `proposeIntegrationPR` against a real throwaway git repo, with `gh` faked
// via the same writeFakePathBin fixture pattern the park-orphan test above
// uses, and `git push` short-circuited (there is no real GitHub to push to)
// while every other git command still runs for real.
function proposeRepo(branchName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "remote", "add", "origin", "https://github.com/demo/repo.git");
  // `origin` READS as github.com (what ghRepoSlug resolves the owner/repo
  // from) but PUSHES to a local bare repo, so the branch push that precedes
  // `gh pr create` never reaches GitHub — on any platform, without shadowing
  // `git` on PATH (a PATH shim cannot intercept a bare `git` spawn on
  // Windows, where only .exe/.com resolve).
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "ignore" });
  git(dir, "remote", "set-url", "--push", "origin", bare);
  git(dir, "checkout", "-q", "-b", branchName);
  fs.writeFileSync(path.join(dir, "f.txt"), "base\nbranch work\n");
  git(dir, "commit", "-qam", "branch work");
  return dir;
}

// A fake bin dir carrying a `gh` fully faked per-test via `listJson`/`create`
// (the push itself goes to proposeRepo's local bare pushurl, so nothing here
// reaches GitHub). Every gh invocation is appended to a shared calls log so a
// test can assert what was (or was NOT) asked for, not just the final return
// value.
function proposeFakeBin({ listJson, createOut = "https://github.com/demo/repo/pull/99\n", createRefused = null }) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-bin-"));
  const callsFile = path.join(binDir, "calls.log");
  const onCreate = createRefused
    ? `process.stderr.write(${JSON.stringify(createRefused + "\n")}); process.exit(1);`
    : `process.stdout.write(${JSON.stringify(createOut)}); process.exit(0);`;
  writeFakePathNodeBin(binDir, "gh", [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(callsFile)}, "gh " + args.join(" ") + "\\n");`,
    'if (args[0] === "--version") { process.stdout.write("gh version 2.0.0\\n"); process.exit(0); }',
    `if (args[0] === "pr" && args[1] === "list") { process.stdout.write(${JSON.stringify(listJson)}); process.exit(0); }`,
    `if (args[0] === "pr" && args[1] === "create") { ${onCreate} }`,
    'process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");',
    "process.exit(1);",
  ].join("\n"));
  return { binDir, callsFile };
}

function withFakeBin(binDir, fn) {
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

test("proposeIntegrationPR: reuse keys on the (head, base) PAIR — an open same-head PR to a DIFFERENT base is ignored, and a fresh PR is opened against targetRef", () => {
  const sporCli = require("../bin/spor.js");
  const dir = proposeRepo("task-demo-a");
  const head = git(dir, "rev-parse", "HEAD").trim();
  // A same-head PR is open, but onto `release` — someone else's proposal
  // (or a stale one from a prior targetRef), never the target of THIS run.
  const listJson = JSON.stringify([{ number: 11, url: "https://github.com/demo/repo/pull/11", state: "OPEN", baseRefName: "release" }]);
  const { binDir, callsFile } = proposeFakeBin({ listJson });

  const res = withFakeBin(binDir, () => sporCli.proposeIntegrationPR({ top: dir, head, targetRef: "main" }));

  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.number, 99, "the different-base PR (#11) is NEVER adopted — a fresh PR is opened instead");
  assert.match(res.url, /\/pull\/99$/);
  assert.strictEqual(res.branch, "task-demo-a");
  const calls = fs.readFileSync(callsFile, "utf8");
  assert.match(calls, /gh pr list .*--head task-demo-a --base main /, "the lookup is keyed on the (head, base) pair, not head alone");
  assert.match(calls, /gh pr create .*--base main --head task-demo-a/, "the fresh PR targets the real targetRef");
});

test("proposeIntegrationPR: an open PR whose base already matches targetRef is adopted — no new PR is created", () => {
  const sporCli = require("../bin/spor.js");
  const dir = proposeRepo("task-demo-b");
  const head = git(dir, "rev-parse", "HEAD").trim();
  const listJson = JSON.stringify([{ number: 11, url: "https://github.com/demo/repo/pull/11", state: "OPEN", baseRefName: "main" }]);
  const { binDir, callsFile } = proposeFakeBin({ listJson, createRefused: "pr create should not have been called — a matching-base PR was already open" });

  const res = withFakeBin(binDir, () => sporCli.proposeIntegrationPR({ top: dir, head, targetRef: "main" }));

  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(res.number, 11, "the matching-base PR is adopted");
  assert.match(res.detail, /already open/);
  const calls = fs.readFileSync(callsFile, "utf8");
  assert.doesNotMatch(calls, /gh pr create/, "no new PR is opened when an existing one already targets targetRef");
});

test("proposeIntegrationPR: gh's own exact-duplicate refusal on create surfaces verbatim as the stage failure", () => {
  const sporCli = require("../bin/spor.js");
  const dir = proposeRepo("task-demo-c");
  const head = git(dir, "rev-parse", "HEAD").trim();
  // No open PR at this (head, base) pair is found (e.g. it is not OPEN
  // anymore from gh's point of view), but gh still refuses to create —
  // exactly gh's real behavior for an exact head+base duplicate.
  const { binDir } = proposeFakeBin({ listJson: "[]", createRefused: "GraphQL: A pull request already exists for demo:task-demo-c." });

  const res = withFakeBin(binDir, () => sporCli.proposeIntegrationPR({ top: dir, head, targetRef: "main" }));

  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /A pull request already exists for demo:task-demo-c\./);
});

// --------------------------------------- checkProposal — the LATER half, once a PR settles --

function checkProposalFakes({ prStatus = () => ({ ok: true, state: "open" }), recordFact = () => ({ ok: true }), restore = () => ({ ok: true, restored: true, note: "task-demo restored open -> done" }) } = {}) {
  const seen = { facts: [], restores: [] };
  const deps = {
    now: () => 1_700_000_000_000,
    prStatus: async (p) => prStatus(p),
    recordFact: async ({ id, markdown }) => {
      seen.facts.push({ id, markdown });
      return recordFact({ id, markdown });
    },
    restore: async (args) => {
      seen.restores.push(args);
      return restore(args);
    },
  };
  return { deps, seen };
}

const PROPOSAL = { nodeId: "task-demo", runId: "run-abcdef12", project: "demo", number: 42, repo: "demo/repo", url: "https://github.com/demo/repo/pull/42", branch: "task-demo", targetRef: "main", strategy: "merge", blockerId: "task-integration-proposed-x", factory: "factory-demo" };

test("checkProposal: the PR is still open — no-op, nothing is written, nothing is restored", async () => {
  const { deps, seen } = checkProposalFakes();
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.deepStrictEqual(res, { checked: true, settled: false });
  assert.strictEqual(seen.facts.length, 0);
  assert.strictEqual(seen.restores.length, 0);
});

test("checkProposal: the PR MERGED — writes a landed fact that RESOLVES the tracking item, and restores the work item's own resolution", async () => {
  const { deps, seen } = checkProposalFakes({ prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer", baseRefName: "main" }) });
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.strictEqual(res.settled, true);
  assert.strictEqual(res.state, "landed");
  assert.strictEqual(res.restored, true);
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].id, /^art-merge-demo-runabcde-landed-[0-9a-f]{8}$/, "a DIFFERENT id than the 'proposed' fact — same run, second phase");
  assert.match(seen.facts[0].markdown, /- \{type: resolves, to: task-integration-proposed-x\}/, "landing is what actually resolves the tracking item");
  assert.match(seen.facts[0].markdown, /merged by reviewer as deadbeef/);
  assert.strictEqual(seen.restores.length, 1);
  assert.strictEqual(seen.restores[0].blockerId, "task-integration-proposed-x");
  assert.strictEqual(seen.restores[0].nodeId, "task-demo");
});

test("checkProposal: the PR was CLOSED without merging — records it, but does not restore anything (a person decides)", async () => {
  const { deps, seen } = checkProposalFakes({ prStatus: () => ({ ok: true, state: "closed", merged: false }) });
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.strictEqual(res.settled, true);
  assert.strictEqual(res.state, "closed");
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].id, /^art-merge-demo-runabcde-closed-[0-9a-f]{8}$/);
  assert.match(seen.facts[0].markdown, /closed without merging/);
  assert.strictEqual(seen.restores.length, 0, "closed-without-merging never restores the item's resolution");
});

test("checkProposal: an unreadable PR status is reported, not treated as settled", async () => {
  const { deps } = checkProposalFakes({ prStatus: () => ({ ok: false, reason: "gh: rate limited" }) });
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.strictEqual(res.checked, false);
  assert.match(res.reason, /rate limited/);
});

// task-spor-integration-propose-mode base-check gap (cross-model review): a
// merged PR is keyed by NUMBER alone in GitHub's own report — it says nothing
// about which base it merged onto. A retargeted (or coincidentally reused)
// PR number reporting "merged" onto a base OTHER than this proposal's
// targetRef must never resolve/restore the work item: the change never
// reached targetRef, so falsely closing the tracking item would report work
// as landed when it was not. Same fail-safe direction as GAP 2 below — stay
// parked, never falsely resolve.
test("checkProposal: a MERGED PR whose base does not match targetRef does NOT restore/resolve — stays parked with a base-mismatch note", async () => {
  const { deps, seen } = checkProposalFakes({
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer", baseRefName: "release" }),
  });
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.strictEqual(res.checked, true);
  assert.strictEqual(res.settled, false, "a base mismatch is never a settled outcome — it needs a person");
  assert.strictEqual(res.state, "base-mismatch");
  assert.strictEqual(res.baseRefName, "release");
  assert.strictEqual(res.expectedBase, "main");
  assert.strictEqual(seen.restores.length, 0, "restore must NEVER be called on a base mismatch");
  assert.strictEqual(seen.facts.length, 1, "a loud note is still recorded so a person or later pass can intervene");
  assert.ok(res.fact, "the mismatch fact id is reported");
  assert.match(seen.facts[0].markdown, /- \{type: relates-to, to: task-integration-proposed-x\}/, "a base mismatch only RELATES to the tracking item — it never resolves it");
  assert.doesNotMatch(seen.facts[0].markdown, /type: resolves/);
  assert.match(seen.facts[0].markdown, /PR #42/);
  assert.match(seen.facts[0].markdown, /`release`/, "the actual (wrong) base is named");
  assert.match(seen.facts[0].markdown, /`main`/, "the expected targetRef is named");
});

// GAP 2 (cross-model review at the merge gate): the landed fact IS the
// resolver — it carries the `resolves` edge onto the tracking item — so
// task-cc-terminal-status-requires-resolver means `restore` must never run
// when recordFact failed to land it. The OLD code called `deps.restore`
// unconditionally regardless of whether the fact write above succeeded,
// which could promote the work item and close the tracking item with NO
// resolver ever recorded on the graph. This pins the gate, and the retry
// convergence once recordFact stops failing.
test("checkProposal: a MERGED PR whose landed fact fails to record does NOT call restore this pass — it leaves the proposal parked for a retry", async () => {
  const { deps, seen } = checkProposalFakes({
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer", baseRefName: "main" }),
    recordFact: () => ({ ok: false, reason: "graph offline" }),
  });
  const res = await integrationRunner.checkProposal(PROPOSAL, { deps });
  assert.strictEqual(res.checked, true);
  assert.strictEqual(res.settled, false, "not settled — no resolver ever landed on the graph");
  assert.strictEqual(res.state, "landed");
  assert.strictEqual(res.fact, null);
  assert.strictEqual(res.restored, false);
  assert.match(res.restore_reason, /landed fact could not be recorded/);
  assert.strictEqual(seen.facts.length, 1, "recordFact was attempted");
  assert.strictEqual(seen.restores.length, 0, "restore must NEVER be called when the landed fact could not be recorded");
});

test("checkProposal: a MERGED PR whose recordFact fails ONCE converges on the next pass once recordFact succeeds — record-then-restore completes", async () => {
  // Pass 1: recordFact fails, exactly like the test above.
  const { deps: deps1, seen: seen1 } = checkProposalFakes({
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer", baseRefName: "main" }),
    recordFact: () => ({ ok: false, reason: "graph offline" }),
  });
  const first = await integrationRunner.checkProposal(PROPOSAL, { deps: deps1 });
  assert.strictEqual(first.settled, false);
  assert.strictEqual(seen1.restores.length, 0);

  // Pass 2 (a fresh checkProposals scan, same proposal — real callers key the
  // retry on the tracking item's own status staying open, which pass 1 never
  // touched): recordFact now succeeds, so this pass both records the fact
  // AND restores — nothing was left half-done by the failed first attempt.
  const { deps: deps2, seen: seen2 } = checkProposalFakes({
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer", baseRefName: "main" }),
  });
  const second = await integrationRunner.checkProposal(PROPOSAL, { deps: deps2 });
  assert.strictEqual(second.checked, true);
  assert.strictEqual(second.settled, true);
  assert.strictEqual(second.state, "landed");
  assert.ok(second.fact, "the landed fact is recorded this pass");
  assert.strictEqual(second.restored, true);
  assert.strictEqual(seen2.facts.length, 1);
  assert.strictEqual(seen2.restores.length, 1, "restore runs exactly once, only once the resolver actually landed");
  assert.strictEqual(seen2.restores[0].blockerId, PROPOSAL.blockerId);
  assert.strictEqual(seen2.restores[0].nodeId, PROPOSAL.nodeId);
});

// ------------------------------------ GAP 1 — the park() orphan, end to end --
//
// issue-spor-integration-park-orphan: parkForReview (bin/spor.js's real
// makeIntegrationDeps) used to stamp gate_proposal_number/gate_proposal_blocker
// on the run record ONLY when the tracking-node write itself succeeded. A PR
// is already open by the time parkForReview runs (deps.propose opened it
// first) — so a transient failure writing the tracking node permanently
// orphaned an already-opened PR: checkProposals required BOTH stamped fields
// to ever look at it again. This drives the REAL bin/spor.js functions
// (parkForReview via makeIntegrationDeps, and checkProposals) against a
// scratch graph home and a real run journal — a chmod'd nodes dir stands in
// for "the graph write transiently failed", exactly as other suites in this
// repo already simulate a write failure (see agent-dispatch-runner.test.js).
test("issue-spor-integration-park-orphan: a failed tracking-node write still stamps gate_proposal_number, and a later checkProposals pass heals the tracking item and completes the FULL lifecycle once the PR is merged", async (t) => {
  if (process.platform === "win32") return; // chmod-based read-only has no meaning there
  if (process.getuid && process.getuid() === 0) return; // root writes through any permission bits

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-orphan-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\n");

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000001" };
  const factory = { id: "factory-demo", integration: { targetRef: "main", mode: "propose", strategy: "merge" } };
  const proposal = { number: 7, url: "https://github.com/demo/repo/pull/7", repo: "demo/repo", branch: "task-proposed" };

  // The dispatch run record parkForReview stamps onto — created the same way
  // a real dispatched run's record exists by the time integration runs.
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
  });

  const deps = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
  });
  const expectedId = sporCli.proposalTrackingId(entry.node_id, entry.run_id);

  // Force the tracking-node write to genuinely fail — leaving NO file behind
  // (unlike a same-id content collision, which would leave a real, if wrong,
  // node standing) — while the run's OWN journal write path is untouched.
  fs.chmodSync(nodes, 0o500);
  t.after(() => { try { fs.chmodSync(nodes, 0o700); } catch { /* best-effort */ } });
  const filed = await deps.parkForReview({ proposal });
  fs.chmodSync(nodes, 0o700);

  assert.strictEqual(filed.ok, false, "the tracking-node write really failed");
  assert.strictEqual(filed.id, expectedId, "the deterministic id is reported even on failure");
  assert.strictEqual(fs.existsSync(path.join(nodes, `${expectedId}.md`)), false, "nothing was actually written — the orphan this bug produces");

  // THE FIX: gate_proposal_number (and the rest) are stamped on the run
  // record regardless of the write's own outcome.
  const record = dispatchRuns.readRunRecords(home).find((r) => r.run_id === entry.run_id);
  assert.strictEqual(record.gate_proposal_number, 7);
  assert.strictEqual(record.gate_proposal_blocker, expectedId);

  // What the pipeline's caller stamps right after park() settles.
  dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "parked", gate_at: new Date().toISOString() });

  // A fake `gh` standing in for the real CLI — reports the PR as already
  // MERGED, so this single checkProposals pass both heals the orphaned
  // tracking item AND completes its lifecycle, proving the healed item is a
  // real, usable graph node and not just a discoverability fix.
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  const stateFile = path.join(ghDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ state: "MERGED", mergedAt: "2026-08-27T00:00:00Z", mergeCommit: { oid: "deadbeefcafe" }, mergedBy: { login: "reviewer" }, baseRefName: "main" }));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\ncat "${stateFile}"\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  await sporCli.checkProposals(cfg, { home, log: () => {} });

  assert.strictEqual(fs.existsSync(path.join(nodes, `${expectedId}.md`)), true, "checkProposals healed the missing tracking item");
  assert.strictEqual(statusOf("task-proposed"), "done", "and the FULL lifecycle converges in the SAME pass: the PR had already merged");
  assert.strictEqual(statusOf(expectedId), "done", "the healed tracking item is closed too");
  const facts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-merge-"));
  assert.strictEqual(facts.length, 1, `expected one integration fact, saw ${fs.readdirSync(nodes)}`);
  assert.match(fs.readFileSync(path.join(nodes, facts[0]), "utf8"), new RegExp(`- \\{type: resolves, to: ${expectedId}\\}`));

  // A second checkProposals pass is a safe no-op — the tracking item is now
  // terminal, so it is skipped without spending another `gh` call or trying
  // to heal an item that already exists with different (now `done`) content.
  await sporCli.checkProposals(cfg, { home, log: () => {} });
  assert.strictEqual(statusOf(expectedId), "done");
  assert.strictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-merge-")).length, 1, "no duplicate fact from the second pass");
});

// The other half of park()'s withheld demotion: the heal pass that re-creates
// the missing tracking item is the first moment a blocker exists, so it is
// where the rollback finally runs — against the REAL gateDemoteItem and a real
// nodes dir, with the PR still open so nothing else in the lifecycle moves.
test("issue-spor-integration-settle-escalate-demote-race: checkProposals completes park()'s withheld demotion the moment it heals the tracking item", async (t) => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-heal-demote-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  // The run resolved the item (its resolver stands), so the graph reads DONE.
  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");
  write("dec-resolver", "type: decision\ntitle: Added bounded retry\nsummary: Added bounded retry with backoff to the sync worker, so a transient failure retries instead of dropping.\nedges:\n  - {type: resolves, to: task-proposed}\n");

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000002" };
  const factory = { id: "factory-demo", integration: { targetRef: "main", mode: "propose", strategy: "merge" } };
  const proposal = { number: 8, url: "https://github.com/demo/repo/pull/8", repo: "demo/repo", branch: "task-proposed" };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
  });
  const deps = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
  });
  const expectedId = sporCli.proposalTrackingId(entry.node_id, entry.run_id);

  // The tracking-node write fails; park() therefore withholds the demotion.
  fs.chmodSync(nodes, 0o500);
  t.after(() => { try { fs.chmodSync(nodes, 0o700); } catch { /* best-effort */ } });
  const filed = await deps.parkForReview({ proposal });
  assert.strictEqual(filed.ok, false);
  const withheld = filed.ok ? await deps.demote({ blockerId: filed.id }) : null; // what park() does: nothing
  fs.chmodSync(nodes, 0o700);
  assert.strictEqual(withheld, null);
  assert.strictEqual(statusOf("task-proposed"), "done", "no tracker, no rollback — the status is left as the run left it");
  dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "parked", gate_at: new Date().toISOString() });

  // The PR is still OPEN: the heal pass has nothing to land, only the tracker
  // to re-create — and the demotion that was waiting on it.
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const lines = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => lines.push(l) });
  assert.strictEqual(fs.existsSync(path.join(nodes, `${expectedId}.md`)), true, "the tracking item was healed");
  assert.strictEqual(statusOf("task-proposed"), "open", "and the withheld demotion ran the moment its blocker existed");
  assert.ok(lines.some((l) => l.includes(`healed the tracking item for task-proposed; task-proposed rolled back done -> open; ${expectedId} now blocks task-proposed`)), lines.join("\n"));
  assert.ok(fs.existsSync(path.join(nodes, "dec-resolver.md")), "the resolver is left standing — it is the evidence");

  // A second pass finds the tracker present, heals nothing, and demotes nothing again.
  const again = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => again.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open");
  assert.ok(!again.some((l) => l.includes("healed the tracking item")), again.join("\n"));
});

// F2 of the review of issue-spor-integration-settle-escalate-demote-race: a
// demotion that fails TRANSIENTLY beside a tracker that did file — at park
// time, or in the heal pass itself — must be retried by later proposal passes,
// not left at its completion status for the life of the PR. The run record's
// `gate_demote_pending` flag is what carries the debt across passes.
test("checkProposals retries a withheld demotion on gate_demote_pending until it lands, then clears the flag", async (t) => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-demote-retry-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];
  const recordOf = (runId) => dispatchRuns.readRunRecords(home).find((r) => r.run_id === runId);
  const itemFile = path.join(nodes, "task-proposed.md");
  t.after(() => { try { fs.chmodSync(itemFile, 0o600); } catch { /* best-effort */ } });

  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const factory = { id: "factory-demo", integration: { targetRef: "main", mode: "propose", strategy: "merge" } };

  // --- Case 1: the tracker filed at park time, but the demotion's own write failed.
  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000003" };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
  });
  const deps = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
  });
  const proposal = { number: 9, url: "https://github.com/demo/repo/pull/9", repo: "demo/repo", branch: "task-proposed" };
  const filed = await deps.parkForReview({ proposal });
  assert.strictEqual(filed.ok, true, "the tracker filed");
  // The item cannot be re-read (a transient failure standing in for any write
  // error) — exactly the demotion outcome park() reports as `demote_reason`.
  fs.chmodSync(itemFile, 0o000);
  const failed = await deps.demote({ blockerId: filed.id });
  fs.chmodSync(itemFile, 0o600);
  assert.strictEqual(failed.ok, false, "the demotion really failed");
  assert.strictEqual(statusOf("task-proposed"), "done");
  // What the loop stamps for a parked verdict whose demotion failed.
  dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "parked", gate_at: new Date().toISOString(), gate_demote_pending: true });

  const lines = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => lines.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open", "the next proposal pass retried the demotion and it landed");
  assert.ok(lines.some((l) => l.includes(`retried the withheld demotion of task-proposed; task-proposed rolled back done -> open; ${filed.id} now blocks task-proposed`)), lines.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "the debt is cleared on the record");

  // A further pass owes nothing: no demotion attempt, no log line.
  const again = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => again.push(l) });
  assert.ok(!again.some((l) => l.includes("withheld demotion") || l.includes("healed the tracking item")), again.join("\n"));

  // --- Case 2: the heal pass re-created the tracker, but ITS demotion failed.
  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");
  const entry2 = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000004" };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry2.run_id).record, {
    run_id: entry2.run_id, node_id: entry2.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_proposal_number: 10, gate_proposal_url: "https://github.com/demo/repo/pull/10", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
  });
  // Retire case 1's record so only this proposal is on the pass.
  dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "superseded" }, { force: true });
  const tracker2 = sporCli.proposalTrackingId(entry2.node_id, entry2.run_id);
  assert.strictEqual(fs.existsSync(path.join(nodes, `${tracker2}.md`)), false, "the tracker is missing — the heal case");

  // Read-only: the heal's own write (a NEW file) and the graph load both
  // succeed, while setStatusLocal's in-place rewrite of the item fails.
  fs.chmodSync(itemFile, 0o444);
  const healLines = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => healLines.push(l) });
  fs.chmodSync(itemFile, 0o600);
  assert.strictEqual(fs.existsSync(path.join(nodes, `${tracker2}.md`)), true, "the tracker was healed");
  assert.strictEqual(statusOf("task-proposed"), "done", "but the demotion failed this pass");
  assert.ok(healLines.some((l) => l.includes("healed the tracking item for task-proposed, but it could not be demoted") && l.includes("will retry next pass")), healLines.join("\n"));
  assert.strictEqual(recordOf(entry2.run_id).gate_demote_pending, true, "the failed heal-pass demotion is recorded as still owed");

  const retryLines = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => retryLines.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open", "the pass after that retried it, tracker already present");
  assert.ok(retryLines.some((l) => l.includes(`retried the withheld demotion of task-proposed; task-proposed rolled back done -> open; ${tracker2} now blocks task-proposed`)), retryLines.join("\n"));
  assert.strictEqual(recordOf(entry2.run_id).gate_demote_pending, false);
});

// F1 of the third review: the debt must survive the loss of BOTH its
// carriers in one pass — the heal-pass demotion fails AND the
// `gate_demote_pending` stamp that would record it fails (the run record's
// directory unwritable at that moment). Before this, the next pass found the
// tracker present (healed nothing) and no flag, and skipped the demotion for
// the life of the open PR. The pass now re-derives the debt from the graph:
// an open tracker with no landed fact beside an item still claiming completion
// is a withheld rollback, whatever the record says.
test("checkProposals recovers a heal-pass demotion debt whose gate_demote_pending stamp never landed — the graph is the ledger of last resort (F1)", async (t) => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-demote-lost-stamp-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];
  const recordOf = (runId) => dispatchRuns.readRunRecords(home).find((r) => r.run_id === runId);
  const itemFile = path.join(nodes, "task-proposed.md");

  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000005" };
  const recordFile = dispatchRuns.runPaths(home, entry.run_id).record;
  const runDir = path.dirname(recordFile);
  dispatchRuns.atomicJson(recordFile, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_proposal_number: 13, gate_proposal_url: "https://github.com/demo/repo/pull/13", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
  });
  t.after(() => { try { fs.chmodSync(runDir, 0o700); fs.chmodSync(itemFile, 0o600); } catch { /* best-effort */ } });
  const tracker = sporCli.proposalTrackingId(entry.node_id, entry.run_id);
  assert.strictEqual(fs.existsSync(path.join(nodes, `${tracker}.md`)), false, "the tracker is missing — the heal case");

  // Pass 1: the heal's write (a NEW node file) succeeds; the item's in-place
  // rewrite fails (read-only file); and the run record's directory is
  // read-only too, so the stamp that would owe the debt cannot land either.
  fs.chmodSync(itemFile, 0o444);
  fs.chmodSync(runDir, 0o500);
  const healLines = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => healLines.push(l) });
  fs.chmodSync(runDir, 0o700);
  fs.chmodSync(itemFile, 0o600);
  assert.strictEqual(fs.existsSync(path.join(nodes, `${tracker}.md`)), true, "the tracker was healed");
  assert.strictEqual(statusOf("task-proposed"), "done", "the demotion failed this pass");
  assert.ok(healLines.some((l) => l.includes("healed the tracking item for task-proposed, but it could not be demoted")), healLines.join("\n"));
  assert.ok(healLines.some((l) => l.includes("could not be stamped (the rollback is owed)")), healLines.join("\n"));
  assert.notStrictEqual(recordOf(entry.run_id).gate_demote_pending, true, "the record carries NO debt — both carriers were lost");

  // Pass 2: tracker present (nothing to heal), no flag — the debt is
  // re-derived from the graph and the rollback lands anyway.
  const recovered = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => recovered.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open", "the unrecorded debt was recovered from graph state");
  assert.ok(recovered.some((l) => l.includes(`recovered an unrecorded rollback debt for task-proposed`) && l.includes(`task-proposed rolled back done -> open; ${tracker} now blocks task-proposed`)), recovered.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "the landed rollback is recorded");

  // Pass 3: nothing owed — the probe is silent (no demotion line at all).
  const quiet = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => quiet.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open");
  assert.ok(!quiet.some((l) => l.includes("rollback debt") || l.includes("withheld demotion") || l.includes("healed the tracking item")), quiet.join("\n"));

  // A legitimately completed item beside a tracker whose CLOSE failed (the
  // landed fact present, restore() promoted the item, the tracker still open)
  // is never demoted by the probe — that would churn against the landing.
  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");
  const integrationRunner = require("../lib/shell/integration-runner.js");
  const landedId = integrationRunner.integrationFactId(entry.node_id, entry.run_id, "landed");
  write(landedId, "type: artifact\ntitle: Landed\nsummary: The proposal for task-proposed merged into main and the item's completion stands again.\nstatus: active\n");
  const settled = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => settled.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "a landed proposal's completion is left standing by the probe");
  assert.ok(!settled.some((l) => l.includes("rollback debt")), settled.join("\n"));
});

// F2 of the fourth review: the probe above licenses a rollback on "no landed
// fact", but resolveNode answers null to a FAILED read (a 5xx, a timeout, an
// unreadable file) exactly as it does to a missing node — so a server blip
// beside a legitimately landed item would demote it. The probe now keys on a
// CONFIRMED absence (404 / ENOENT); anything else is unknown, and unknown
// never demotes.
test("checkProposals' rollback probe never demotes on an UNREADABLE landed fact — only a confirmed absence licenses it (F2)", async (t) => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-probe-unreadable-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000006" };
  const tracker = sporCli.proposalTrackingId(entry.node_id, entry.run_id);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_proposal_number: 14, gate_proposal_url: "https://github.com/demo/repo/pull/14", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
    gate_proposal_blocker: tracker,
  });
  // The tracker is present and open (nothing to heal), no flag on the record,
  // and the proposal LANDED — but its landed fact is unreadable this pass.
  write(tracker, "type: task\ntitle: Land PR #14\nsummary: Tracking item for the proposal of task-proposed opened as PR #14 against main.\nstatus: open\n");
  const landedId = integrationRunner.integrationFactId(entry.node_id, entry.run_id, "landed");
  const landedFile = path.join(nodes, `${landedId}.md`);
  write(landedId, "type: artifact\ntitle: Landed\nsummary: The proposal for task-proposed merged into main and the item's completion stands again.\nstatus: active\n");
  fs.chmodSync(landedFile, 0o000);
  t.after(() => { try { fs.chmodSync(landedFile, 0o600); } catch { /* best-effort */ } });

  const blip = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => blip.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "an unreadable landed fact is not evidence of absence — the completed item stands");
  assert.ok(!blip.some((l) => l.includes("rollback debt") || l.includes("rolled back")), blip.join("\n"));

  // The read heals: the fact is present, and the probe still leaves the
  // landing alone (the F1 case, unchanged).
  fs.chmodSync(landedFile, 0o600);
  const readable = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => readable.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done");
  assert.ok(!readable.some((l) => l.includes("rollback debt")), readable.join("\n"));

  // Only a CONFIRMED absence licenses the probe: with the fact gone (ENOENT),
  // the same open tracker beside the same completed item IS the debt.
  fs.unlinkSync(landedFile);
  const absent = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => absent.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open", "a confirmed absence still recovers the unrecorded debt");
  assert.ok(absent.some((l) => l.includes("recovered an unrecorded rollback debt for task-proposed")), absent.join("\n"));
});

// The remote half of the same distinction: the helper the probe keys on
// answers "absent" to a 404 ONLY — a 5xx, a non-JSON 200-less blip and a
// dead server are all "unknown", which the probe treats as not-absent.
test("nodeConfirmedAbsent: remote mode confirms absence on 404 only — a 5xx or a dead server is unknown, never absent (F2)", async (t) => {
  const http = require("node:http");
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-absent-remote-"));
  let mode = 404;
  const server = http.createServer((req, res) => {
    if (mode === 404) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); return; }
    if (mode === 500) { res.writeHead(500, { "content-type": "text/plain" }); res.end("boom"); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"raw":"---\\nid: x\\ntype: artifact\\n---\\n"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" } });
  assert.strictEqual(cfg.mode(), "remote");

  assert.strictEqual(await sporCli.nodeConfirmedAbsent(cfg, "x"), true, "404 is a confirmed absence");
  mode = 500;
  assert.strictEqual(await sporCli.nodeConfirmedAbsent(cfg, "x"), false, "a 5xx is unknown, not absent");
  mode = 200;
  assert.strictEqual(await sporCli.nodeConfirmedAbsent(cfg, "x"), false, "a readable node is present");

  // A dead server (transport failure) is unknown too.
  await new Promise((r) => server.close(r));
  const dead = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" } });
  assert.strictEqual(await sporCli.nodeConfirmedAbsent(dead, "x"), false, "a transport failure is unknown, not absent");
});

// F3 of the same review: the pending-demotion retry must NOT run against a
// tracker that is already closed. Once the PR merged, restore() promoted the
// item and closed the tracker (`done`) — if the flag still stood from an
// earlier failed pass, the retry would roll the completed item back to
// `open` behind a terminal, non-live blocker and the settled check would
// then skip every restoration, stranding it. The settled check runs first
// and the no-longer-owed debt is cleared.
test("checkProposals never retries a pending demotion against an already-closed tracker — it clears the debt and leaves the completed item alone (F3)", async (t) => {
  if (process.platform === "win32") return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-demote-closed-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];
  const recordOf = (runId) => dispatchRuns.readRunRecords(home).find((r) => r.run_id === runId);

  // The PR reads MERGED onto main — so the first pass restores and closes the tracker.
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"MERGED","baseRefName":"main","mergedBy":{"login":"anthony"},"mergeCommit":{"oid":"abcdef0123456789"}}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000005" };
  const tracker = sporCli.proposalTrackingId(entry.node_id, entry.run_id);
  write("task-proposed", `type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n`);
  // The tracker filed at park time; the demotion beside it failed, so the
  // debt is on the record — and the PR has since merged.
  write(tracker, `type: task\ntitle: Review the proposal\nsummary: Review the proposal for task-proposed opened as a pull request and merge or close it.\nstatus: open\nrequires: [human]\nedges:\n  - {type: blocks, to: task-proposed}\n`);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_demote_pending: true, gate_proposal_number: 11, gate_proposal_blocker: tracker,
    gate_proposal_url: "https://github.com/demo/repo/pull/11", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
  });

  // Pass 1: the tracker is still open, so the owed demotion lands first; the
  // merged PR then restores the item and closes the tracker in the same pass.
  const first = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => first.push(l) });
  assert.strictEqual(statusOf(tracker), "done", "the merged PR closed the tracker");
  assert.strictEqual(statusOf("task-proposed"), "done", "and restored the item");
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "the demotion landed before the restore");

  // The hazard itself: the debt is still on the record (a pass that
  // restored but whose clearing stamp never landed, or a person who closed
  // the tracker under a pending flag). The next pass must NOT reopen the
  // completed item behind the terminal tracker.
  dispatchRuns.stampGateState(home, entry.run_id, { gate_demote_pending: true }, { force: true });
  const second = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => second.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "a closed tracker never reopens the completed item");
  assert.strictEqual(statusOf(tracker), "done");
  assert.ok(!second.some((l) => l.includes("retried the withheld demotion")), second.join("\n"));
  assert.ok(second.some((l) => l.includes(`the tracking item ${tracker} for task-proposed is already closed — the withheld demotion is no longer owed`)), second.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "the no-longer-owed debt is cleared");

  // And a further pass is a silent no-op.
  const third = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => third.push(l) });
  assert.deepStrictEqual(third.filter((l) => l.includes("task-proposed")), []);
});

// ---------------------------------------------------- the git plumbing, for real --

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A repo with `main` and a `branch` that add a NEW file (no textual conflict)
// plus a protected `test/**` file the branch also touched — so a landing test
// can assert BOTH that the merge lands cleanly and that the candidate tree
// forces the protected path back to main's copy before anything runs.
function integrationRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".spor"), "project: demo\n");
  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "test", "acceptance.js"), 'const add = require("../lib/add.js");\nif (add(2, 3) !== 5) { console.error("add is broken"); process.exit(1); }\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "branch");
  fs.writeFileSync(path.join(dir, "lib", "sub.js"), "module.exports = (a, b) => a - b;\n");
  // The implementer also "fixes" the protected suite — a command gate already
  // fails this closed at claim time (WORKERS.md §10.3), but the CANDIDATE tree
  // must independently force it back too: two gate cycles apart from now, the
  // fact this branch's edit never reaches the candidate suite is what this
  // test pins.
  fs.writeFileSync(path.join(dir, "test", "acceptance.js"), "process.exit(0);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "branch work");
  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "main moved on\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main moved");
  return dir;
}

test("buildCandidateTree really is merge(target_ref, branch), and forceProtectedPaths forces the candidate tree's protected paths back to the trusted ref's copy", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, true, built.reason);
  try {
    assert.ok(fs.existsSync(path.join(built.dir, "README.md")), "main's own work is in the candidate");
    assert.ok(fs.existsSync(path.join(built.dir, "lib", "sub.js")), "the branch's own work is in the candidate");
    // Before forcing: the candidate carries the branch's weakened suite.
    assert.match(fs.readFileSync(path.join(built.dir, "test", "acceptance.js"), "utf8"), /process\.exit\(0\)/);

    const gateRunner = require("../lib/shell/gate-runner.js");
    const forced = gateRunner.forceProtectedPaths({ top: dir, dir: built.dir, trustedRef: "main", protectedPaths: ["test/**"] });
    assert.strictEqual(forced.ok, true, forced.reason);
    assert.match(fs.readFileSync(path.join(built.dir, "test", "acceptance.js"), "utf8"), /add is broken/, "forced back to main's own suite");
  } finally {
    built.cleanup();
  }
  assert.ok(!fs.existsSync(built.dir), "the candidate worktree is cleaned up");
  assert.strictEqual(git(dir, "worktree", "list").trim().split("\n").length, 1, "and pruned from the repo's worktree list");
});

test("buildCandidateTree reports a real merge conflict, aborts cleanly, and leaves no worktree behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-conflict-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "branch");
  fs.writeFileSync(path.join(dir, "f.txt"), "base\nbranch change\n");
  git(dir, "commit", "-qam", "branch work");
  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), "base\nmain change\n");
  git(dir, "commit", "-qam", "main moved");

  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, false);
  assert.strictEqual(built.conflict, true);
  assert.match(built.reason, /conflicts/);
  assert.strictEqual(git(dir, "worktree", "list").trim().split("\n").length, 1, "no worktree leaked by the aborted merge");
});

test("landCandidate CAS-lands locally with git update-ref, and reports a LOST RACE when the target ref moved", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();

  // A clean landing.
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, true, built.reason);
  const landed = integrationRunner.landCandidate({ top: dir, dir: built.dir, sha: built.sha, expectedSha: built.expectedSha, targetRef: "main", mode: "local" });
  assert.strictEqual(landed.ok, true, landed.reason);
  assert.strictEqual(git(dir, "rev-parse", "main").trim(), built.sha, "main really points at the candidate now");
  built.cleanup();

  // A lost race: main moves between building and landing.
  const built2 = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built2.ok, true, built2.reason);
  git(dir, "commit", "--allow-empty", "-qm", "someone else landed first");
  const raced = integrationRunner.landCandidate({ top: dir, dir: built2.dir, sha: built2.sha, expectedSha: built2.expectedSha, targetRef: "main", mode: "local" });
  assert.strictEqual(raced.ok, false);
  assert.strictEqual(raced.race, true);
  assert.match(raced.reason, /moved to/);
  built2.cleanup();
});

// issue-spor-integration-landed-sha-pre-restoration: forceProtectedPaths only
// rewrites the candidate worktree's WORKING DIRECTORY — buildCandidateTree's
// own `sha` still names the pre-restoration commit. This pins the actual bug:
// without reconcileCandidateSha, `built.sha`'s tree still carries the
// branch's tampered protected-path edit even after forceProtectedPaths "fixed"
// the working directory.
test("REGRESSION: buildCandidateTree's own sha is NOT updated by forceProtectedPaths — the working tree and the sha diverge until reconciled", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, true, built.reason);
  try {
    const forced = gateRunner.forceProtectedPaths({ top: dir, dir: built.dir, trustedRef: "main", protectedPaths: ["test/**"] });
    assert.strictEqual(forced.ok, true, forced.reason);
    // The working directory is fixed...
    assert.match(fs.readFileSync(path.join(built.dir, "test", "acceptance.js"), "utf8"), /add is broken/);
    // ...but the commit buildCandidateTree already produced is untouched: its
    // tree still carries the branch's tampered copy. This is the exact
    // divergence the bug landed.
    assert.match(git(dir, "show", `${built.sha}:test/acceptance.js`), /process\.exit\(0\)/, "the pre-restoration sha still carries the tampered file");
  } finally {
    built.cleanup();
  }
});

test("reconcileCandidateSha re-commits the restored tree and lands THAT sha — never the pre-restoration one", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  for (const strategy of ["merge", "squash", "rebase"]) {
    const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy });
    assert.strictEqual(built.ok, true, `${strategy}: ${built.reason}`);
    try {
      const forced = gateRunner.forceProtectedPaths({ top: dir, dir: built.dir, trustedRef: "main", protectedPaths: ["test/**"] });
      assert.strictEqual(forced.ok, true, `${strategy}: ${forced.reason}`);

      const reconciled = integrationRunner.reconcileCandidateSha({ dir: built.dir, sha: built.sha });
      assert.strictEqual(reconciled.ok, true, `${strategy}: ${reconciled.reason}`);
      assert.strictEqual(reconciled.amended, true, `${strategy}: something was restored, so a re-commit is expected`);
      assert.notStrictEqual(reconciled.sha, built.sha, `${strategy}: the reconciled sha must differ from the pre-restoration one`);

      // The reconciled sha's tree — not the original build sha's — carries the
      // restored protected file, and still carries the branch's own honest work.
      assert.match(git(dir, "show", `${reconciled.sha}:test/acceptance.js`), /add is broken/, `${strategy}: reconciled sha carries the trusted suite`);
      assert.match(git(dir, "show", `${reconciled.sha}:lib/sub.js`), /a - b/, `${strategy}: reconciled sha still carries the branch's own work`);

      // The candidate worktree's own HEAD now points at the reconciled sha —
      // this is what a caller landing straight from `dir`'s HEAD would ship.
      assert.strictEqual(git(built.dir, "rev-parse", "HEAD").trim(), reconciled.sha, `${strategy}: the candidate worktree's HEAD is the reconciled sha`);

      // Landing the reconciled sha (not built.sha) is what a real caller does.
      const landed = integrationRunner.landCandidate({ top: dir, dir: built.dir, sha: reconciled.sha, expectedSha: built.expectedSha, targetRef: "main", mode: "local" });
      assert.strictEqual(landed.ok, true, `${strategy}: ${landed.reason}`);
      assert.match(git(dir, "show", `${git(dir, "rev-parse", "main").trim()}:test/acceptance.js`), /add is broken/, `${strategy}: main now carries the trusted suite, not the tampered one`);

      // Reset main back for the next strategy in this loop.
      git(dir, "update-ref", "refs/heads/main", built.expectedSha);
    } finally {
      built.cleanup();
    }
  }
});

test("reconcileCandidateSha is a no-op when nothing needed restoring — the common case", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  try {
    // No protected paths declared -> forceProtectedPaths is a no-op.
    const forced = gateRunner.forceProtectedPaths({ top: dir, dir: built.dir, trustedRef: "main", protectedPaths: [] });
    assert.strictEqual(forced.ok, true);
    const reconciled = integrationRunner.reconcileCandidateSha({ dir: built.dir, sha: built.sha });
    assert.strictEqual(reconciled.ok, true, reconciled.reason);
    assert.strictEqual(reconciled.amended, false);
    assert.strictEqual(reconciled.sha, built.sha, "nothing changed, so the original build sha is landed unchanged");
  } finally {
    built.cleanup();
  }
});

// Drives runIntegrationStage with REAL git plumbing end to end, composing
// forceProtected exactly the way bin/spor.js's makeIntegrationDeps does
// (forceProtectedPaths, then reconcileCandidateSha) — the one seam the faked
// "stage" tests above and the direct git-plumbing tests above don't exercise
// together: the actual composed dependency the worker runs in production.
test("runIntegrationStage, wired with the real composed forceProtected dep, lands the RESTORED tree — a protected-path tamper never reaches the target ref", async () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const targetRef = "main";
  const factory = {
    id: "factory-regression",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 0, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: ["test/**"],
  };
  const item = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };
  const deps = {
    now: () => 1_700_000_000_000,
    changedTree: async () => ({ ok: true, top: dir, head, cwd: dir }),
    acquireLease: async () => null,
    releaseLease: async () => {},
    buildCandidate: async ({ head: h, targetRef: t, strategy: s }) => integrationRunner.buildCandidateTree({ top: dir, head: h, targetRef: t, strategy: s }),
    // The exact composition bin/spor.js's forceProtected dep uses.
    forceProtected: ({ dir: candidateDir, sha }) => {
      const forced = gateRunner.forceProtectedPaths({ top: dir, dir: candidateDir, trustedRef: factory.trustedRef, protectedPaths: factory.protectedPaths });
      if (!forced.ok) return forced;
      return integrationRunner.reconcileCandidateSha({ dir: candidateDir, sha });
    },
    runSuite: async () => ({ ok: true }),
    land: async (args) => integrationRunner.landCandidate(args),
    fix: async () => ({ ok: false, reason: "no fix cycles declared in this test" }),
    escalate: async () => ({ ok: true, id: "task-integration-escalate-x" }),
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };

  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  const landedSha = git(dir, "rev-parse", targetRef).trim();
  assert.match(git(dir, "show", `${landedSha}:test/acceptance.js`), /add is broken/, "the landed commit carries the trusted suite, not the branch's tampered protected-path edit");
  assert.doesNotMatch(git(dir, "show", `${landedSha}:test/acceptance.js`), /process\.exit\(0\)/);
  assert.match(git(dir, "show", `${landedSha}:lib/sub.js`), /a - b/, "the branch's own, non-protected work still landed");
});

// issue-spor-integration-stale-head-across-fix-cycles: `tree` used to be
// captured once, before the fix-cycle loop, and never refreshed across a
// `continue` — so a conflict-fix or suite-fix that commits new work in the
// implementer's checkout was invisible to the retried rebuild, which kept
// merging the STALE pre-fix head forever. Pins that `changedTree()` is
// re-read after every fix cycle, and that the retried build actually uses
// the refreshed head.
test("issue-spor-integration-stale-head-across-fix-cycles: a fix-cycle retry rebuilds from the REFRESHED head, not the stale pre-fix one", async () => {
  const heads = ["head-v1", "head-v2"];
  let changedTreeCalls = 0;
  const seenHeads = [];
  const { deps, seen } = integrationFakes({
    build: (args) => {
      seenHeads.push(args.head);
      return seenHeads.length === 1
        ? { ok: false, conflict: true, reason: "merging onto main conflicts" }
        : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" };
    },
  });
  deps.changedTree = async () => ({ ok: true, top: "/repo", head: heads[Math.min(changedTreeCalls++, heads.length - 1)], cwd: "/repo/wt" });

  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(changedTreeCalls, 2, "changedTree is re-read after the fix cycle, not just once up front");
  assert.deepStrictEqual(seenHeads, ["head-v1", "head-v2"], "the retried build used the refreshed post-fix head, not the stale pre-fix one");
  assert.strictEqual(seen.fixes.length, 1);
});

// The same regression, pinned against REAL git plumbing end to end: the fix
// cycle's commit must actually land, not merely be visible to a fake.
test("REGRESSION, real git: a fix cycle's commit in the implementer's checkout reaches the LANDED tree on retry", async () => {
  const dir = integrationRepo();
  // integrationRepo() leaves `dir` checked out on `main` (so other tests can
  // read `branch`'s tip without disturbing it) — but changedTree() reads
  // `HEAD` of the IMPLEMENTER's own checkout, which is always the task
  // branch, never the target ref. Move `dir` there so this test's changedTree
  // dep reflects the real shape.
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const factory = {
    id: "factory-stale-head",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
  };
  const item = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };
  let suiteRuns = 0;
  const deps = {
    now: () => 1_700_000_000_000,
    // The REAL production wiring (bin/spor.js's changedTree dep): re-reads
    // HEAD from the implementer's checkout on every call.
    changedTree: async () => gateRunner.gateChangeSet({ cwd: dir }, targetRef),
    acquireLease: async () => null,
    releaseLease: async () => {},
    buildCandidate: async ({ head, targetRef: t, strategy }) => integrationRunner.buildCandidateTree({ top: dir, head, targetRef: t, strategy }),
    runSuite: async ({ dir: candidateDir }) => {
      suiteRuns += 1;
      return fs.existsSync(path.join(candidateDir, "lib", "fix-marker.js"))
        ? { ok: true }
        : { ok: false, reason: "the candidate is missing the implementer's fix", output: "" };
    },
    land: async (args) => integrationRunner.landCandidate(args),
    // Simulates the implementer resolving the "failure" with a REAL commit in
    // their OWN checkout — exactly what a fix-cycle dispatch produces.
    fix: async () => {
      fs.writeFileSync(path.join(dir, "lib", "fix-marker.js"), "module.exports = true;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fix: add the marker the suite requires");
      return { ok: true };
    },
    escalate: async () => ({ ok: true, id: "task-integration-escalate-x" }),
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };

  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(suiteRuns, 2, "the suite ran once before the fix and once on the retried candidate");
  const landedSha = git(dir, "rev-parse", targetRef).trim();
  assert.doesNotThrow(() => git(dir, "show", `${landedSha}:lib/fix-marker.js`), "the landed tree carries the fix cycle's commit, not the stale pre-fix head");
});

test("squash and rebase strategies both produce a candidate that descends cleanly from the target ref", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  for (const strategy of ["squash", "rebase"]) {
    const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy });
    assert.strictEqual(built.ok, true, `${strategy}: ${built.reason}`);
    assert.ok(fs.existsSync(path.join(built.dir, "README.md")), `${strategy}: main's work is present`);
    assert.ok(fs.existsSync(path.join(built.dir, "lib", "sub.js")), `${strategy}: branch's work is present`);
    built.cleanup();
  }
});

// -------------------------------------------------------------- the CLI, end to end --

const HARNESS = "integrationfake";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env: cleanEnv(env), encoding: "utf8", timeout: 120000 });
}

// A scratch graph home holding one ready task, a fake supervised harness, and
// a factory definition. Mirrors gate-pipeline.test.js's cliFixture, scoped
// down to what the integration end-to-end tests need: one command gate, and
// (when `integration` is passed) an integration block riding beside it.
function integrationCliFixture({ integration = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = integrationRepo();
  git(repo, "branch", "-D", "branch"); // the CLI dispatch below cuts its OWN branch off HEAD; the fixture repo only needed `branch` to build/verify the plumbing helpers above
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add subtraction to the math lib\nsummary: Add a subtract helper to the math lib alongside the existing add helper.\nstatus: open\nedges:\n  - {type: assigned, to: agent-box, profile: profile-integration}\n",
    "Add subtraction to the math lib."
  );
  write("agent-box", "type: agent\ntitle: The integration test box\nsummary: An agent identity for the integration-step test fixture.\n", "Test agent.");
  write("profile-integration", `type: profile\ntitle: Integration test profile\nsummary: A profile selecting the fake harness the integration-step test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  const payload = {
    factory: "demo",
    trusted_ref: "main",
    gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" test/acceptance.js` }],
    ...(integration ? { integration } : {}),
  };
  write("factory-demo", "type: factory\ntitle: The demo factory\nsummary: The gate+integration pipeline the demo project enforces between claim and resolve.\nstatus: active\n", ["```json", JSON.stringify(payload, null, 2), "```"].join("\n"));
  const outfile = path.join(home, "invocations.jsonl");
  // The fake worker: commits a NEW file (sub.js) on its own branch and leaves
  // its own report — the real acceptance suite (test/acceptance.js, main's
  // copy) never touches sub.js, so the command gate passes cleanly, and the
  // candidate tree the integration stage builds is exactly merge(main, this
  // commit).
  const stub = writeSpawnableNodeStub(
    home,
    "integration-stub",
    `
const fs = require("node:fs");
const cp = require("node:child_process");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  const cwd = process.cwd();
  const commitCount = (cp.execSync("git rev-list --count HEAD", { cwd }).toString().trim());
  // Only do real implementer work the FIRST time this worker is asked to work
  // this node — a fix-cycle re-dispatch (its prompt says the stage "refused to land")
  // must not re-add a file that's already there.
  if (!prompt.includes("refused to land") && !fs.existsSync(cwd + "/lib/sub.js")) {
    fs.writeFileSync(cwd + "/lib/sub.js", "module.exports = (a, b) => a - b;\\n");
    cp.execSync('git add -A && git -c user.email=t@t -c user.name=Test commit -qm "add subtract"', { cwd });
  }
  fs.appendFileSync(process.env.OUTFILE, JSON.stringify({ cwd, prompt }) + "\\n");
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
          harness: { [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Integration Fake", report: { from: "lastText", text: "message.text" } } },
        },
      },
      null,
      2
    )}\n`
  );
  return { home, repo, nodes, outfile };
}

test("end to end, local mode: after its gate passes, the integration stage lands the candidate on local main, and cleans up", () => {
  const { home, repo, nodes, outfile } = integrationCliFixture({ integration: { mode: "local", command: `"${process.execPath}" test/acceptance.js`, strategy: "merge" } });
  const before = git(repo, "rev-parse", "main").trim();
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--worktree", "--factory", "factory-demo"], {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    OUTFILE: outfile,
    PATH: pathWithOnlyGitAndNode(),
  });
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /gate acceptance passed on task-ready/);
  assert.match(r.stdout, /integration landed on main/);
  assert.match(r.stdout, /work: gates — passed 1/);
  const after = git(repo, "rev-parse", "main").trim();
  assert.notStrictEqual(after, before, "main really moved");
  // main's own CHECKED-OUT working tree may lag a moved ref (update-ref does
  // not refresh it) — the commit content is what matters here.
  assert.match(git(repo, "show", `${after}:lib/sub.js`), /a - b/, "the implementer's work really landed on main");
  const facts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-merge-"));
  assert.strictEqual(facts.length, 1, `expected one integration fact, saw ${fs.readdirSync(nodes)}`);
  assert.match(fs.readFileSync(path.join(nodes, facts[0]), "utf8"), /- \{type: relates-to, to: task-ready\}/);
  assert.strictEqual(git(repo, "worktree", "list").trim().split("\n").length, 1, "the candidate worktree is cleaned up, and the implementer's dispatch worktree too");
});

test("end to end: with NO integration block, behavior is byte-identical to the gate pipeline alone — no art-merge fact, main untouched", () => {
  const { home, repo, nodes, outfile } = integrationCliFixture({ integration: null });
  const before = git(repo, "rev-parse", "main").trim();
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--worktree", "--factory", "factory-demo"], {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    OUTFILE: outfile,
    PATH: pathWithOnlyGitAndNode(),
  });
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /gate acceptance passed on task-ready/);
  assert.doesNotMatch(r.stdout, /integration landed|integration stage/);
  assert.strictEqual(git(repo, "rev-parse", "main").trim(), before, "main is untouched with no integration declared");
  assert.strictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-merge-")).length, 0);
});

test("spor work refuses to start on an invalid integration block — the same load-time refusal a bad gate gets", () => {
  const { home } = integrationCliFixture({ integration: { mode: "local" /* missing command */ } });
  const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /integration\.command is required/);
  assert.match(r.stderr, /does not run ungated/);
});

// ------ task-spor-propose-gh-capability-satisfiability -----------------------
//
// `gh` used to be a bare startup PATH probe: a factory declaring `propose`
// on a box with no `gh` killed the whole worker before it ever polled the
// queue. It is now wired through machine-profile satisfiability instead
// (dec-spor-machine-profile-satisfiability) — the worker stays alive, warns
// once, and skips every candidate under that factory with a visible reason,
// the same pattern an unsatisfiable profile already gets. The literal
// `hasCmd("gh")` checks inside proposeIntegrationPR/ghPrStatus remain as the
// backstop at the actual point of use (see the two tests further below).
//
// pathWithOnlyGitAndNode() is NOT good enough here: on a box where `git` and
// `gh` happen to live in the SAME directory (e.g. a Homebrew-style shared
// bin), that "git-only" PATH drags gh along with it. These tests need a PATH
// that genuinely has git (and, for the CLI ones, node) but NOT gh —
// isolatedBinDir() builds one from symlinks to the real binaries.
function pathWithGitAndNodeButNoGh() {
  return isolatedBinDir(["git", "node"]);
}

test("spor work under a propose factory on a box with no gh: warns loudly, never crashes, and NEVER CLAIMS the item — skipped with a visible reason in --status, same pattern as an unsatisfiable profile", () => {
  const { home, outfile } = integrationCliFixture({ integration: { mode: "propose", command: `"${process.execPath}" test/acceptance.js`, strategy: "merge" } });
  // pathWithGitAndNodeButNoGh() has no `gh` anywhere on it — the deterministic
  // "this box cannot satisfy propose mode" case.
  const r = cli(["work", "--once", "--interval", "1", "--no-brief", "--factory", "factory-demo"], {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    OUTFILE: outfile,
    PATH: pathWithGitAndNodeButNoGh(),
  });
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  // Loud at startup — but the worker keeps running (exit 0, not 1).
  assert.match(r.stderr, /factory 'factory-demo' declares integration mode 'propose', but the 'gh' CLI is not available/);
  assert.match(r.stdout, /work: skipping task-ready — /);
  assert.match(r.stdout, /dispatched 0;/);
  assert.ok(!fs.existsSync(outfile), "never claimed/launched — the implementer stub never ran, no gate ever started");

  const status = JSON.parse(cli(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
  const skipped = status.workers[0].skipped;
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].id, "task-ready");
  assert.match(skipped[0].reason, /the 'gh' CLI is not available on this machine/);
  assert.ok(Date.parse(skipped[0].until) > Date.now(), "cooling off, not dropped — a capable box can still pick it up");
});

test("spor work --print names a propose factory as unsatisfiable here when gh is missing, alongside the rest of the factory preview", () => {
  const { home } = integrationCliFixture({ integration: { mode: "propose", command: `"${process.execPath}" test/acceptance.js`, strategy: "merge" } });
  const r = cli(["work", "--print", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithGitAndNodeButNoGh() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /integration: mode 'propose' — UNSATISFIABLE here: the 'gh' CLI is not available/);
});

// ------ the backstop: proposeIntegrationPR/ghPrStatus refuse directly, -------
// ------ regardless of any satisfiability check having run --------------------

test("proposeIntegrationPR: refuses directly when gh is not on PATH — the backstop, independent of the satisfiability layer above", () => {
  const sporCli = require("../bin/spor.js");
  const dir = proposeRepo("task-demo-backstop");
  const head = git(dir, "rev-parse", "HEAD").trim();
  const originalPath = process.env.PATH;
  process.env.PATH = pathWithGitAndNodeButNoGh(); // no gh anywhere
  try {
    const res = sporCli.proposeIntegrationPR({ top: dir, head, targetRef: "main" });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /the 'gh' CLI is not on PATH — propose mode needs it to open pull requests/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("ghPrStatus: refuses directly when gh is not on PATH — the backstop checkProposals relies on", () => {
  const sporCli = require("../bin/spor.js");
  const originalPath = process.env.PATH;
  process.env.PATH = pathWithGitAndNodeButNoGh(); // no gh anywhere
  try {
    const res = sporCli.ghPrStatus({ repo: "demo/repo", number: 1 });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /the 'gh' CLI is not on PATH/);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ------------------------------------- reconciling the checked-out target --
// `git update-ref` moves the ref and nothing else: the checkout that has the
// target branch checked out (the shared main checkout on a dev box) is left
// with HEAD at the landed commit but its index and working tree at the OLD one
// — `git status` reads as a staged mega-revert of the landing, and a plain
// `git commit` there backs the feature out again (the beb04c9 incident). The
// stage brings that checkout up to the landed commit, for the landed paths,
// only where nothing local touched them.

function reconcileRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-reconcile-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  for (const f of ["modified.txt", "deleted.txt", "collides.txt", "untouched.txt"]) fs.writeFileSync(path.join(dir, f), `${f} v1\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "branch");
  fs.writeFileSync(path.join(dir, "modified.txt"), "modified.txt v2\n");
  fs.rmSync(path.join(dir, "deleted.txt"));
  fs.writeFileSync(path.join(dir, "added.txt"), "added.txt v2\n");
  fs.writeFileSync(path.join(dir, "collides.txt"), "collides.txt v2\n");
  fs.writeFileSync(path.join(dir, "adds-over-local.txt"), "adds-over-local.txt v2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "branch work");
  git(dir, "checkout", "-q", "main");
  return dir;
}

test("after a local landing, the checkout holding the target branch is brought up to the landed commit — landed paths only, local edits left alone", () => {
  const dir = reconcileRepo();
  // Local state in the main checkout that the landing must respect:
  fs.writeFileSync(path.join(dir, "collides.txt"), "collides.txt LOCAL EDIT\n"); // landed too — must be skipped
  fs.writeFileSync(path.join(dir, "adds-over-local.txt"), "someone's untracked file\n"); // landing adds it — must not be overwritten
  fs.writeFileSync(path.join(dir, "wip.txt"), "unrelated wip\n"); // untracked, unrelated
  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, true, built.reason);
  const landed = integrationRunner.landCandidate({ top: dir, dir: built.dir, sha: built.sha, expectedSha: built.expectedSha, targetRef: "main", mode: "local" });
  built.cleanup();
  assert.strictEqual(landed.ok, true, landed.reason);
  assert.strictEqual(git(dir, "rev-parse", "main").trim(), built.sha);
  assert.strictEqual(fs.realpathSync.native(landed.reconciled.checkout), fs.realpathSync.native(dir));
  assert.deepStrictEqual(landed.reconciled.updated.sort(), ["added.txt", "deleted.txt", "modified.txt"]);
  assert.deepStrictEqual(landed.reconciled.skipped.sort(), ["adds-over-local.txt", "collides.txt"]);
  assert.match(landed.detail, /brought .* up to the landed commit \(3 paths; left 2 locally-modified paths alone/);
  // The working tree now matches the landed commit where it safely can...
  assert.strictEqual(fs.readFileSync(path.join(dir, "modified.txt"), "utf8"), "modified.txt v2\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, "added.txt"), "utf8"), "added.txt v2\n");
  assert.ok(!fs.existsSync(path.join(dir, "deleted.txt")), "a path the landing deleted is gone");
  // ...and nobody's local work was touched.
  assert.strictEqual(fs.readFileSync(path.join(dir, "collides.txt"), "utf8"), "collides.txt LOCAL EDIT\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, "adds-over-local.txt"), "utf8"), "someone's untracked file\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, "wip.txt"), "utf8"), "unrelated wip\n");
  // No phantom revert: the only things git status reports are the local edits.
  const status = git(dir, "status", "--porcelain").trimEnd().split("\n").sort();
  assert.deepStrictEqual(status, [" M adds-over-local.txt", " M collides.txt", "?? wip.txt"].sort(), status.join(" | "));
});

test("reconcile is a no-op when nothing has the target branch checked out, and when the landing is empty", () => {
  const dir = reconcileRepo();
  git(dir, "checkout", "-q", "--detach");
  const head = git(dir, "rev-parse", "branch").trim();
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge" });
  assert.strictEqual(built.ok, true, built.reason);
  const landed = integrationRunner.landCandidate({ top: dir, dir: built.dir, sha: built.sha, expectedSha: built.expectedSha, targetRef: "main", mode: "local" });
  built.cleanup();
  assert.strictEqual(landed.ok, true, landed.reason);
  assert.strictEqual(landed.reconciled.checkout, null);
  assert.ok(!fs.existsSync(path.join(dir, "added.txt")), "a detached checkout is nobody's stale main tree — untouched");
  assert.deepStrictEqual(integrationRunner.reconcileCheckedOutTarget({ top: dir, ref: "refs/heads/main", fromSha: built.sha, toSha: built.sha }).updated, []);
});

test("end to end, local mode: the candidate tree is staged with the repo's own dispatch.worktreeSetup hook before its suite runs", () => {
  const { home, repo, outfile } = integrationCliFixture({ integration: { mode: "local", command: `"${process.execPath}" test/acceptance.js`, strategy: "merge" } });
  const hookLog = path.join(home, "hook.log");
  // Node-scripted hooks (a .cmd wrapper on Windows, where the hook runner's
  // shell is cmd.exe and a #!/bin/sh script cannot run), declared by the
  // relative path the stub actually landed at.
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  const stage = writeSpawnableNodeStub(path.join(repo, "scripts"), "stage", [
    'const fs = require("node:fs");',
    'fs.appendFileSync(process.env.HOOK_LOG, "setup " + process.env.SPOR_TREE_ROLE + " " + process.env.SPOR_MAIN_CHECKOUT + "\\n");',
    'fs.writeFileSync(require("node:path").join(process.env.SPOR_WORKTREE, "staged.txt"), "");',
  ].join("\n"));
  const unstage = writeSpawnableNodeStub(path.join(repo, "scripts"), "unstage",
    'require("node:fs").appendFileSync(process.env.HOOK_LOG, "teardown " + process.env.SPOR_TREE_ROLE + " " + process.env.SPOR_DISPATCH_NODE + "\\n");');
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktreeSetup: path.relative(repo, stage), worktreeTeardown: path.relative(repo, unstage) } }));
  fs.writeFileSync(
    path.join(repo, "test", "acceptance.js"),
    'const fs = require("fs");\nif (!fs.existsSync("staged.txt")) { console.error("not staged: the suite needs the hook"); process.exit(1); }\n'
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "declare the setup hook and a suite that needs it");
  const before = git(repo, "rev-parse", "main").trim();
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--worktree", "--factory", "factory-demo"], {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    OUTFILE: outfile,
    HOOK_LOG: hookLog,
    PATH: pathWithOnlyGitAndNode(),
  });
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /gate acceptance passed on task-ready/);
  assert.match(r.stdout, /integration landed on main/);
  assert.notStrictEqual(git(repo, "rev-parse", "main").trim(), before, "main really moved");
  // Three trees, each staged with its ROLE and torn down again: the
  // implementer's dispatch worktree, the command gate's tree, the integration
  // candidate (task-spor-worktree-hook-role-and-teardown).
  const ran = fs.readFileSync(hookLog, "utf8").trim().split("\n");
  const setups = ran.filter((l) => l.startsWith("setup "));
  const teardowns = ran.filter((l) => l.startsWith("teardown "));
  assert.deepStrictEqual(setups.map((l) => l.split(" ")[1]), ["dispatch", "gate", "integration"], `roles in order, saw ${ran}`);
  for (const l of setups) assert.strictEqual(fs.realpathSync.native(l.split(" ")[2]), fs.realpathSync.native(repo));
  assert.deepStrictEqual(teardowns.sort(), ["teardown dispatch task-ready", "teardown gate task-ready", "teardown integration task-ready"], `every tree is torn down, saw ${teardowns}`);
  // And the main checkout — which has `main` checked out — was reconciled to
  // the landing rather than left as a staged phantom revert.
  assert.strictEqual(fs.readFileSync(path.join(repo, "lib", "sub.js"), "utf8"), "module.exports = (a, b) => a - b;\n");
  assert.strictEqual(git(repo, "status", "--porcelain").trim(), "", "no phantom revert in the main checkout after the landing");
});


test("buildCandidateTree runs the caller's teardown first thing in cleanup, even when it throws", () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const order = [];
  const built = integrationRunner.buildCandidateTree({ top: dir, head, targetRef: "main", strategy: "merge", teardown: (d) => { order.push(fs.existsSync(d)); throw new Error("boom"); } });
  assert.strictEqual(built.ok, true, built.reason);
  built.cleanup();
  assert.deepStrictEqual(order, [true]);
  assert.ok(!fs.existsSync(built.dir));
  assert.strictEqual(git(dir, "worktree", "list").trim().split("\n").length, 1);
});

test("the candidate suite is told what it is judging: SPOR_GATE_BASE/HEAD are the target and candidate shas, the stage is integration", async () => {
  const dir = integrationRepo();
  git(dir, "branch", "-D", "branch");
  git(dir, "checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "lib", "sub.js"), "module.exports = (a, b) => a - b;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "impl work");
  git(dir, "checkout", "-q", "main");
  // Drive the stage with real git plumbing but a recording runSuite.
  const seen = [];
  const factory = gates.parseFactory(["```json", JSON.stringify({ ...BASE, integration: { mode: "local", command: "true" } }), "```"].join("\n"), { id: "factory-test" }).factory;
  const head = git(dir, "rev-parse", "impl").trim();
  const res = await integrationRunner.runIntegrationStage({
    item: { node_id: "task-x", run_id: "run-1", project: "demo" },
    factory,
    deps: {
      now: () => Date.now(),
      changedTree: async () => ({ ok: true, top: dir, head, cwd: dir }),
      buildCandidate: (a) => integrationRunner.buildCandidateTree(a),
      runSuite: async (a) => { seen.push(a); return { ok: true }; },
      land: (a) => integrationRunner.landCandidate(a),
      recordFact: async ({ id }) => ({ ok: true, id }),
      escalate: async () => ({ ok: false }),
    },
  });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].base, /^[0-9a-f]{40}$/);
  assert.match(seen[0].head, /^[0-9a-f]{40}$/);
  assert.strictEqual(seen[0].head, git(dir, "rev-parse", "main").trim(), "head is the sha that landed");
  assert.notStrictEqual(seen[0].base, seen[0].head);
});

// Push mode lands on a REMOTE ref whose local remote-tracking copy moves only
// when this box pushes or fetches. A second pusher (another worker machine, a
// human) advancing the branch between builds must be SEEN by the next
// candidate build, or a lost race rebuilds on the same stale tip until the
// retry cap (issue-spor-integration-push-mode-never-fetches).
function pushModeFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-push-"));
  const bare = path.join(parent, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const seed = path.join(parent, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "ignore" });
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "trusted");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  // The worker's checkout: a clone with origin/main at the seed tip and a branch.
  const worker = path.join(parent, "worker");
  execFileSync("git", ["clone", "-q", bare, worker], { stdio: "ignore" });
  git(worker, "config", "user.email", "t@t");
  git(worker, "config", "user.name", "Test");
  git(worker, "checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(worker, "b.txt"), "b\n");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "impl work");
  git(worker, "checkout", "-q", "main");
  return { parent, bare, seed, worker };
}

test("push mode fetches the target branch before every candidate build, so a rebuild sees another pusher's tip", () => {
  const { seed, worker } = pushModeFixture();
  const head = git(worker, "rev-parse", "impl").trim();
  const staleTip = git(worker, "rev-parse", "origin/main").trim();
  // Someone else lands on origin/main behind this worker's back.
  fs.writeFileSync(path.join(seed, "c.txt"), "c\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "other pusher");
  git(seed, "push", "-q", "origin", "main");
  const liveTip = git(seed, "rev-parse", "main").trim();
  assert.notStrictEqual(liveTip, staleTip);
  assert.strictEqual(git(worker, "rev-parse", "origin/main").trim(), staleTip, "precondition: the worker's remote-tracking ref is stale");

  const built = integrationRunner.buildCandidateTree({ top: worker, head, targetRef: "origin/main", strategy: "merge", mode: "push" });
  assert.strictEqual(built.ok, true, built.reason);
  try {
    assert.strictEqual(built.expectedSha, liveTip, "the candidate is built on the LIVE remote tip, not the stale tracking ref");
    assert.ok(fs.existsSync(path.join(built.dir, "c.txt")), "the other pusher's work is in the candidate tree");
    assert.ok(fs.existsSync(path.join(built.dir, "b.txt")), "and so is the branch's");
    assert.strictEqual(git(worker, "rev-parse", "origin/main").trim(), liveTip, "the fetch updated the remote-tracking ref");
  } finally {
    built.cleanup();
  }
});

test("push mode fails closed when the target branch cannot be fetched", () => {
  const { worker, parent } = pushModeFixture();
  const head = git(worker, "rev-parse", "impl").trim();
  git(worker, "remote", "set-url", "origin", path.join(parent, "does-not-exist.git"));
  const built = integrationRunner.buildCandidateTree({ top: worker, head, targetRef: "origin/main", strategy: "merge", mode: "push" });
  assert.strictEqual(built.ok, false);
  assert.ok(!built.race && !built.conflict, "a fetch failure is neither a race nor a conflict");
  assert.match(built.reason, /could not fetch origin\/main/);
  assert.strictEqual(git(worker, "worktree", "list").trim().split("\n").length, 1, "no candidate worktree is left behind");
});

test("local mode never fetches — an unreachable origin does not stop a local landing", () => {
  const { worker, parent } = pushModeFixture();
  const head = git(worker, "rev-parse", "impl").trim();
  git(worker, "remote", "set-url", "origin", path.join(parent, "does-not-exist.git"));
  const built = integrationRunner.buildCandidateTree({ top: worker, head, targetRef: "main", strategy: "merge", mode: "local" });
  assert.strictEqual(built.ok, true, built.reason);
  built.cleanup();
});

test("runIntegrationStage passes the factory's integration mode through to buildCandidate", async () => {
  const dir = integrationRepo();
  const head = git(dir, "rev-parse", "branch").trim();
  const factory = gates.parseFactory(["```json", JSON.stringify({ ...BASE, integration: { mode: "push", target_ref: "origin/main", command: "true" } }), "```"].join("\n"), { id: "factory-test" }).factory;
  const seen = [];
  const res = await integrationRunner.runIntegrationStage({
    item: { node_id: "task-x", run_id: "run-1", project: "demo" },
    factory,
    deps: {
      now: () => Date.now(),
      changedTree: async () => ({ ok: true, top: dir, head, cwd: dir }),
      buildCandidate: async (a) => { seen.push(a); return { ok: false, reason: "stop here" }; },
      runSuite: async () => ({ ok: true }),
      land: async () => ({ ok: false, reason: "unreached" }),
      recordFact: async ({ id }) => ({ ok: true, id }),
      runFix: async () => ({ ok: false, reason: "no fix" }),
      escalate: async () => ({ ok: true, id: "task-h" }),
      demote: async () => ({ ok: true }),
      cleanupImplementer: async () => {},
      log: () => {},
    },
  });
  assert.ok(seen.length >= 1);
  assert.strictEqual(seen[0].mode, "push");
  assert.strictEqual(seen[0].targetRef, "origin/main");
  assert.ok(res);
});

// F4 of the same review: the tracker read that licenses the pending-demotion
// retry is not atomic with the demotion itself. Another actor — a second
// box's proposal pass, or a person — can settle the proposal in that window:
// restore() writes the landed fact, promotes the item, then closes the
// tracker, so a pass that read the tracker open can still roll a COMPLETED
// item back to `open` behind a tracker that is terminal by the time anyone
// looks again — and with the flag cleared and the settled check skipping the
// closed tracker, nothing would restore it. The pass re-reads the settled
// evidence AFTER a demotion that flipped the item and undoes it on the spot;
// an undo that fails is owed on the record (`gate_restore_pending`) and
// retried by every later pass.
test("checkProposals undoes a demotion that landed against a proposal settled meanwhile, and retries a failed undo on gate_restore_pending (F4)", async (t) => {
  if (process.platform === "win32") return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const integrationRunner = require("../lib/shell/integration-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-demote-race-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];
  const recordOf = (runId) => dispatchRuns.readRunRecords(home).find((r) => r.run_id === runId);

  // The PR still reads OPEN to this box: the settling actor is the OTHER one.
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000006" };
  const tracker = sporCli.proposalTrackingId(entry.node_id, entry.run_id);
  const item = `type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n`;
  write("task-proposed", item);
  // The interleaving the tracker read cannot see: the other actor's restore
  // has written the landed fact and promoted the item, but has not yet
  // closed the tracker — so this pass reads the tracker OPEN and the owed
  // demotion is licensed against a proposal that is already settled.
  write(tracker, `type: task\ntitle: Review the proposal\nsummary: Review the proposal for task-proposed opened as a pull request and merge or close it.\nstatus: open\nrequires: [human]\nedges:\n  - {type: blocks, to: task-proposed}\n`);
  const landedFact = integrationRunner.integrationFactId(entry.node_id, entry.run_id, "landed");
  write(landedFact, `type: artifact\ntitle: Integration landed task-proposed\nsummary: Integration landed task-proposed onto main for dispatched run 11111111 — PR #12 merged onto main.\nstatus: active\nedges:\n  - {type: resolves, to: ${tracker}}\n  - {type: relates-to, to: task-proposed}\n`);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_demote_pending: true, gate_proposal_number: 12, gate_proposal_blocker: tracker,
    gate_proposal_url: "https://github.com/demo/repo/pull/12", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
  });

  const first = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => first.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "the demotion that landed against the settled proposal was undone");
  assert.ok(first.some((l) => l.includes("retried the withheld demotion of task-proposed; task-proposed rolled back done -> open")), first.join("\n"));
  assert.ok(first.some((l) => l.includes("the proposal for task-proposed settled while its demotion was landing — undone; task-proposed restored open -> done")), first.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "the demotion did land, so that debt is cleared");
  assert.strictEqual(recordOf(entry.run_id).gate_restore_pending, false, "and the undo landed too, so nothing is owed");

  // The undo can fail like any write. Stage its debt on the record beside the
  // stranded state F3 describes — item demoted, tracker now closed — and a
  // later pass must restore the item rather than skip the closed tracker.
  write("task-proposed", item.replace("status: done", "status: open"));
  write(tracker, `type: task\ntitle: Review the proposal\nsummary: Review the proposal for task-proposed opened as a pull request and merge or close it.\nstatus: done\nrequires: [human]\nedges:\n  - {type: blocks, to: task-proposed}\n`);
  dispatchRuns.stampGateState(home, entry.run_id, { gate_restore_pending: true }, { force: true });
  const second = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => second.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "the owed undo was retried and landed");
  assert.ok(second.some((l) => l.includes("undid the demotion of task-proposed that landed against an already-settled proposal; task-proposed restored open -> done")), second.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_restore_pending, false, "the debt is cleared");
  assert.ok(!second.some((l) => l.includes("retried the withheld demotion")), second.join("\n"));

  // And a further pass is a silent no-op.
  const third = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => third.push(l) });
  assert.deepStrictEqual(third.filter((l) => l.includes("task-proposed")), []);
});

// F5 of the same review: the flags that carry a debt across passes are
// themselves best-effort writes (stampGateState returns null when the record
// cannot be written). Clearing `gate_demote_pending` in one stamp and owing
// `gate_restore_pending` in a second meant a second stamp that failed — or a
// crash between the two — left a demoted item behind a closed tracker with
// NO debt on the record, and every later pass skipping the closed tracker.
// Now the settle check and the undo run before any flag is written, the
// record moves in ONE stamp, a stamp that fails is logged and leaves the
// previous debt standing, and a stale pending flag against a closed tracker
// whose proposal LANDED is recovered (the item restored) rather than cleared.
test("checkProposals writes a demotion's outcome in ONE stamp, keeps the debt when the stamp fails, and recovers a stranded item behind a closed tracker (F5)", async (t) => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return;

  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const integrationRunner = require("../lib/shell/integration-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-park-demote-stamp-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n\nBody.\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];
  const recordOf = (runId) => dispatchRuns.readRunRecords(home).find((r) => r.run_id === runId);

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho '{"state":"OPEN","baseRefName":"main"}'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const entry = { node_id: "task-proposed", run_id: "11111111-2222-3333-4444-000000000007" };
  const tracker = sporCli.proposalTrackingId(entry.node_id, entry.run_id);
  const item = `type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n`;
  const trackerNode = (status) => `type: task\ntitle: Review the proposal\nsummary: Review the proposal for task-proposed opened as a pull request and merge or close it.\nstatus: ${status}\nrequires: [human]\nedges:\n  - {type: blocks, to: task-proposed}\n`;
  const landedFact = integrationRunner.integrationFactId(entry.node_id, entry.run_id, "landed");
  const runDir = dispatchRuns.runPaths(home, entry.run_id).dir;
  t.after(() => { try { fs.chmodSync(runDir, 0o700); } catch { /* best-effort */ } });

  // --- Part 1: the F4 interleaving (tracker read open, proposal already
  // landed), but the run record cannot be written when the pass goes to
  // record its outcome. The rollback and its undo both land on the graph;
  // the record must NOT lose the debt — the previous flag stands.
  write("task-proposed", item);
  write(tracker, trackerNode("open"));
  write(landedFact, `type: artifact\ntitle: Integration landed task-proposed\nsummary: Integration landed task-proposed onto main for dispatched run 11111111 — PR #13 merged onto main.\nstatus: active\nedges:\n  - {type: resolves, to: ${tracker}}\n  - {type: relates-to, to: task-proposed}\n`);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
    gate_state: "parked", gate_demote_pending: true, gate_proposal_number: 13, gate_proposal_blocker: tracker,
    gate_proposal_url: "https://github.com/demo/repo/pull/13", gate_proposal_repo: "demo/repo",
    gate_proposal_branch: "task-proposed", gate_proposal_target_ref: "main", gate_proposal_strategy: "merge", gate_proposal_project: "demo",
  });
  fs.chmodSync(runDir, 0o500); // atomicJson's temp file cannot be created: every stamp fails
  const first = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => first.push(l) });
  fs.chmodSync(runDir, 0o700);
  assert.strictEqual(statusOf("task-proposed"), "done", "the demotion landed and was undone on the graph");
  assert.ok(first.some((l) => l.includes("the proposal for task-proposed settled while its demotion was landing — undone")), first.join("\n"));
  assert.ok(first.some((l) => l.includes("the run record for task-proposed could not be stamped")), first.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, true, "a stamp that fails leaves the previous debt standing — nothing is cleared without its outcome recorded");
  assert.strictEqual(recordOf(entry.run_id).gate_restore_pending, undefined, "and never owes a debt the same write did not clear");

  // --- Part 2: the stranded state F5 describes — a pass whose rollback
  // landed against the settled proposal, whose undo did not, and whose
  // record never got either fact: the item OPEN behind a tracker now
  // CLOSED, only the stale pending flag left. The next pass recognizes the
  // landed proposal and restores the item before it clears the flag.
  write("task-proposed", item.replace("status: done", "status: open"));
  write(tracker, trackerNode("done"));
  const second = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => second.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "the stranded item is restored — the proposal landed, so its completion stands");
  assert.ok(second.some((l) => l.includes(`the tracking item ${tracker} for task-proposed is already closed — the withheld demotion is no longer owed; task-proposed restored open -> done`)), second.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false, "cleared only once the restore held");
  assert.ok(!second.some((l) => l.includes("retried the withheld demotion")), second.join("\n"));

  // The restore can fail like any write: the flag then STAYS, and the next
  // pass tries again — a debt is never cleared ahead of the write it owes.
  write("task-proposed", item.replace("status: done", "status: open"));
  dispatchRuns.stampGateState(home, entry.run_id, { gate_demote_pending: true }, { force: true });
  const itemFile = path.join(nodes, "task-proposed.md");
  t.after(() => { try { fs.chmodSync(itemFile, 0o600); } catch { /* best-effort */ } });
  fs.chmodSync(itemFile, 0o000);
  const third = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => third.push(l) });
  fs.chmodSync(itemFile, 0o600);
  assert.strictEqual(statusOf("task-proposed"), "open");
  assert.ok(third.some((l) => l.includes("is already closed and its proposal landed, but the item could not be restored")), third.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, true, "the debt stands until the restore lands");
  const fourth = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => fourth.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "done", "retried and landed");
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false);

  // --- Part 3: a tracker a PERSON closed with no landing is not a landing:
  // the stale flag is cleared and the item is left exactly as it stands.
  fs.unlinkSync(path.join(nodes, `${landedFact}.md`));
  write("task-proposed", item.replace("status: done", "status: open"));
  dispatchRuns.stampGateState(home, entry.run_id, { gate_demote_pending: true }, { force: true });
  const fifth = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => fifth.push(l) });
  assert.strictEqual(statusOf("task-proposed"), "open", "no landed fact — nothing says the completion should stand, so nothing is restored");
  assert.ok(fifth.some((l) => l.includes(`the tracking item ${tracker} for task-proposed is already closed — the withheld demotion is no longer owed`)), fifth.join("\n"));
  assert.strictEqual(recordOf(entry.run_id).gate_demote_pending, false);

  // And a further pass is a silent no-op.
  const sixth = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => sixth.push(l) });
  assert.deepStrictEqual(sixth.filter((l) => l.includes("task-proposed")), []);
});

// issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-background-job: the
// integration stage's fix cycle is a dispatched implementer like any other,
// so its prompt ends with the shared one-turn notice — a fix that backgrounds
// the candidate suite and ends its turn waiting on it commits nothing.
test("the integration fix-cycle prompt names the refusal and ends with the one-turn notice", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const { ONE_TURN_NOTICE } = require("../lib/shell/worker-contract.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-fix-prompt-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const entry = { node_id: "task-landing", run_id: "11111111-2222-3333-4444-000000000009" };
  const factory = { id: "factory-demo", integration: { targetRef: "main", mode: "local", strategy: "squash", command: "npm test" } };
  const launches = [];
  const deps = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
    dispatch: async (_cfg, values, positionals) => {
      const id = "integration-fix-run-1";
      dispatchRuns.atomicJson(dispatchRuns.runPaths(home, id).record, { run_id: id, node_id: entry.node_id, name: values.name, state: "done", created_at: new Date().toISOString() });
      launches.push({ values, prompt: positionals[0] });
      return { ok: true, run: { run_id: id, harness: "fake" } };
    },
  });
  const r = await deps.fix({ cycle: 0, kind: "suite", detail: "2 failing", evidence: "not ok 1" });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(launches.length, 1);
  const p = launches[0].prompt;
  assert.match(p, /^The integration stage refused to land task-landing onto `main` \(`local` mode, `squash` strategy\)\.\nthe integration stage's candidate suite \(`npm test`\) failed on the merged tree\.\n2 failing\nEvidence:\nnot ok 1\n/);
  assert.match(p, /Fix the cause in this checkout and commit\./);
  assert.ok(p.endsWith(ONE_TURN_NOTICE), "the integration fix prompt ends with the one-turn notice");
});
