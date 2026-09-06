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

// task-spor-gates-sweep-intor-fields-to-guarded-helpers: cycles/reruns/timeout_ms
// are read through the same guarded helper a command gate's are — an
// unreadable value (blank/null/false/array) must take the documented default,
// never clamp to the floor via bare `intOr`'s `Number(null) === 0`.
test("integration.cycles, .reruns and .timeout_ms take the documented default on an unreadable declared value, never the floor", () => {
  for (const junk of ["", null, false, []]) {
    const label = JSON.stringify(junk);
    const r = factoryOf({ ...BASE, integration: { mode: "local", command: "npm test", cycles: junk, reruns: junk, timeout_ms: junk } });
    assert.strictEqual(r.factory.integration.cycles, gates.GATE_DEFAULTS.cycles, `cycles ${label} must take the documented default`);
    assert.strictEqual(r.factory.integration.reruns, gates.GATE_DEFAULTS.reruns, `reruns ${label} must take the documented default, never 0-by-coincidence-with-the-floor`);
    assert.strictEqual(r.factory.integration.timeoutMs, gates.GATE_DEFAULTS.commandTimeoutMs, `timeout_ms ${label} must take the documented default, never the 1000ms floor`);
  }
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
  const seen = { builds: 0, buildArgs: [], suites: 0, lands: 0, proposals: 0, proposeArgs: [], parks: [], fixes: [], escalations: [], demotions: [], facts: [], cleanups: 0, leaseAcquired: 0, leaseReleased: 0 };
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
      seen.buildArgs.push(args);
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
      seen.proposeArgs.push(args);
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
  // task-spor-factory-gate-attestation: the merge fact and the result are
  // commit-bound — the head the stage read, the sha it landed.
  assert.match(seen.facts[0].markdown, /^gate_head: headsha$/m);
  assert.match(seen.facts[0].markdown, /^landed_sha: candidatesha$/m);
  assert.strictEqual(res.head, "headsha");
  assert.strictEqual(res.landed_sha, "candidatesha");
  assert.strictEqual(res.target_sha, "expected1");
  assert.strictEqual(res.mode, "local");
  assert.strictEqual(res.head_matches_gated, null, "no gated head was handed in — nothing to compare");
  assert.ok(res.duration_ms >= 0);
});

// ------------------------------------ head equality (task-spor-factory-gate-attestation) --

test("the stage REFUSES a head that differs from the head the last passing gate judged — no build, no landing, escalated to a person", async () => {
  const { deps, seen } = integrationFakes({ tree: { ok: true, top: "/repo", head: "movedsha", cwd: "/repo/wt" } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "headsha" });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /moved after the gates judged it/);
  assert.match(res.reason, /judged `headsha`/);
  assert.match(res.reason, /now reads `movedsha`/);
  assert.match(res.reason, /spor work --regate run-abcdef12/);
  assert.strictEqual(seen.builds, 0, "nothing is built from an unjudged head");
  assert.strictEqual(seen.lands, 0);
  assert.strictEqual(seen.fixes.length, 0, "not a fix cycle — a fix commits, so it can never restore the equality");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.demotions.length, 1, "the resolution does not stand");
  assert.strictEqual(res.head, "movedsha");
  assert.strictEqual(res.gated_head, "headsha");
  assert.strictEqual(res.head_matches_gated, false);
  assert.match(seen.facts[0].markdown, /the gates judged `headsha`/);
});

test("a matching head proceeds, and the result says the heads matched", async () => {
  const { deps, seen } = integrationFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "headsha" });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.builds, 1);
  assert.strictEqual(res.head_matches_gated, true);
  assert.match(seen.facts[0].markdown, /Integrated commit: `headsha` \(the head the gates judged\)/);
});

test("propose mode hands the PR opener the chain it needs for the attestation — gated head, target sha, and the candidate suite that passed", async () => {
  const propose = { ...FACTORY, integration: { ...FACTORY.integration, mode: "propose" } };
  let seenChain = null;
  const { deps } = integrationFakes({
    propose: (args) => {
      seenChain = args.chain;
      return { ok: true, number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: "task-demo", targetRef: "main", detail: "opened PR #42" };
    },
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: propose, deps, gatedHead: "headsha" });
  assert.strictEqual(res.state, "parked");
  assert.ok(seenChain, "the proposer receives the chain");
  assert.strictEqual(seenChain.head, "headsha");
  assert.strictEqual(seenChain.gatedHead, "headsha");
  assert.strictEqual(seenChain.targetSha, "expected1");
  assert.deepStrictEqual(seenChain.candidate, { base: "expected1", sha: "candidatesha", suite: "passed", command: "npm test", trusted_sha: null });
  assert.deepStrictEqual(res.proposal, { number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: "task-demo" });
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
  // task-spor-escalation-retry-closing-artifact-and-integration-settle: the
  // refusal also leaves the SAME replay payload a gate refusal leaves, so the
  // loop stamps it as `gate_escalation_pending` and the bounded auto-retry
  // (bin/spor.js retryOneEscalation) covers integration refusals too — no
  // second retry machine. `stage` is the route (a gate may be named
  // `integration`); the args are exactly what `deps.escalate` was handed.
  assert.strictEqual(res.escalation_retry.stage, "integration");
  assert.strictEqual(res.escalation_retry.gateId, integrationRunner.INTEGRATION_STAGE_ID);
  assert.strictEqual(res.escalation_retry.attempt, ITEM.attempt, "the exact attempt this call used");
  assert.deepStrictEqual(res.escalation_retry.attempts, seen.escalations[0].attempts);
  assert.strictEqual(res.escalation_retry.detail, seen.escalations[0].detail);
  assert.strictEqual(res.escalation_retry.evidence, seen.escalations[0].evidence);
  assert.match(res.escalation_retry.evidence, /1 failing/);
  assert.strictEqual(res.escalation_retry.factId, seen.facts[0].id, "names the art-merge fact that says no escalation could be filed");
});

test("a propose-mode integration refusal's retry payload names the phase-keyed art-merge fact it will close", async () => {
  const { deps, seen } = integrationFakes({
    suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }),
    escalate: () => ({ ok: false, reason: "offline" }),
  });
  const factory = { ...FACTORY, integration: { ...FACTORY.integration, mode: "propose", cycles: 0 } };
  const res = await integrationRunner.runIntegrationStage({ item: { ...ITEM, attempt: 2 }, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalation_failed, true);
  assert.strictEqual(res.escalation_retry.attempt, 2);
  assert.strictEqual(res.escalation_retry.factId, integrationRunner.integrationFactId("task-demo", ITEM.run_id, "failed", 2));
  assert.strictEqual(res.escalation_retry.factId, seen.facts[0].id);
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
  assert.strictEqual(res.escalation_retry, undefined, "a landed escalation leaves nothing to replay");
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
  git(dir, "config", "core.autocrlf", "false"); // the checked-out BYTES are compared below; the Windows CI runner's global autocrlf would rewrite them
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
function proposeFakeBin({ listJson, createOut = "https://github.com/demo/repo/pull/99\n", createRefused = null, editRefused = null }) {
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
    'if (args[0] === "pr" && args[1] === "view") { process.stdout.write(JSON.stringify({body:"Human context"})); process.exit(0); }',
    `if (args[0] === "pr" && args[1] === "edit") { ${editRefused ? `process.stderr.write(${JSON.stringify(editRefused)}); process.exit(1);` : "process.exit(0);"} }`,
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

// issue-spor-propose-mode-opens-pr-from-head-not-published-commit: the plumbing
// pushes whatever commit the caller names, not the checked-out branch's own
// tip — which is what lets runIntegrationStage hand it a PINNED candidate
// commit that sits BEHIND the branch's current tip (a same-tree relabel, or a
// candidate that predates a later, not-yet-re-pinned commit) and have the PR
// carry exactly that object, not whatever happens to be checked out.
test("proposeIntegrationPR pushes the COMMIT it is given, not the checked-out branch tip — the door runIntegrationStage uses to publish the pinned candidate rather than a relabeled head", () => {
  const sporCli = require("../bin/spor.js");
  const dir = proposeRepo("task-demo-pin");
  const pinned = git(dir, "rev-parse", "HEAD~1").trim(); // the "base" commit, BEHIND the branch's own tip
  const tip = git(dir, "rev-parse", "HEAD").trim();
  assert.notStrictEqual(pinned, tip, "the fixture's pinned commit must differ from the checked-out tip for this test to mean anything");
  const { binDir, callsFile } = proposeFakeBin({ listJson: "[]" });

  const res = withFakeBin(binDir, () => sporCli.proposeIntegrationPR({ top: dir, head: pinned, targetRef: "main" }));

  assert.strictEqual(res.ok, true, res.reason);
  assert.match(res.detail, new RegExp(`for ${pinned.slice(0, 8)} onto main`), "the PR is reported as carrying the pinned commit, not the tip");
  const calls = fs.readFileSync(callsFile, "utf8");
  assert.match(calls, /gh pr create/, "a PR was opened, so the push below actually landed");
  // The bare origin's branch ref is the PINNED commit — never the tip that
  // was checked out when this ran.
  const bareUrl = git(dir, "remote", "get-url", "--push", "origin").trim();
  const landed = execFileSync("git", ["ls-remote", bareUrl, "refs/heads/task-demo-pin"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  assert.strictEqual(landed, pinned, "the pushed branch ref is the pinned commit, not the checked-out tip");
});

test("proposeIntegrationPR: the attestation body reaches `gh pr create`, and a reused PR gets its body refreshed (task-spor-factory-gate-attestation)", () => {
  const sporCli = require("../bin/spor.js");
  const attestation = require("../lib/shell/attestation.js");
  const body = `Opened by spor.\n\n${attestation.PR_BEGIN}\n\`\`\`json\n{"schema":"${attestation.SCHEMA}","subject":{"commit":"abc"}}\n\`\`\`\n${attestation.PR_END}\n`;

  // Fresh PR: the body is what gh is asked to create with.
  const dirA = proposeRepo("task-demo-body-a");
  const headA = git(dirA, "rev-parse", "HEAD").trim();
  const a = proposeFakeBin({ listJson: "[]" });
  const resA = withFakeBin(a.binDir, () => sporCli.proposeIntegrationPR({ top: dirA, head: headA, targetRef: "main", body }));
  assert.strictEqual(resA.ok, true, resA.reason);
  const callsA = fs.readFileSync(a.callsFile, "utf8");
  assert.match(callsA, /gh pr create .*--body Opened by spor\./, "the attestation body is passed to gh pr create");
  assert.match(callsA, /spor-attestation:begin/, "the markers ride along in the body");

  // Reused PR: the body is refreshed (gh pr edit).
  const dirB = proposeRepo("task-demo-body-b");
  const headB = git(dirB, "rev-parse", "HEAD").trim();
  const listJson = JSON.stringify([{ number: 13, url: "https://github.com/demo/repo/pull/13", state: "OPEN", baseRefName: "main" }]);
  const b = proposeFakeBin({ listJson, createRefused: "pr create should not have been called" });
  const resB = withFakeBin(b.binDir, () => sporCli.proposeIntegrationPR({ top: dirB, head: headB, targetRef: "main", body }));
  assert.strictEqual(resB.ok, true, resB.reason);
  assert.strictEqual(resB.number, 13);
  const callsB = fs.readFileSync(b.callsFile, "utf8");
  assert.match(callsB, /gh pr edit 13 --repo demo\/repo --body /, "the reused PR's body is refreshed with the new head's attestation");
  assert.doesNotMatch(callsB, /gh pr create/);

  // No body given: the plain sentence stands, and nothing is edited.
  const dirC = proposeRepo("task-demo-body-c");
  const headC = git(dirC, "rev-parse", "HEAD").trim();
  const c = proposeFakeBin({ listJson });
  withFakeBin(c.binDir, () => sporCli.proposeIntegrationPR({ top: dirC, head: headC, targetRef: "main" }));
  assert.doesNotMatch(fs.readFileSync(c.callsFile, "utf8"), /gh pr edit/, "without a body there is nothing to refresh");
});

// Cross-model review, finding 4: the refresh is the evidence a CI job is told
// to check. A reused PR whose body could NOT be refreshed carries the OLD
// head's attestation under a "success" — so the refusal is the proposal's
// failure, surfaced verbatim, never swallowed.
test("proposeIntegrationPR: a reused PR whose body refresh FAILS is a failed proposal, with gh's reason", () => {
  const sporCli = require("../bin/spor.js");
  const attestation = require("../lib/shell/attestation.js");
  const body = `Opened by spor.\n\n${attestation.PR_BEGIN}\n\`\`\`json\n{"schema":"${attestation.SCHEMA}","subject":{"commit":"abc"}}\n\`\`\`\n${attestation.PR_END}\n`;
  const dir = proposeRepo("task-demo-body-d");
  const head = git(dir, "rev-parse", "HEAD").trim();
  const listJson = JSON.stringify([{ number: 21, url: "https://github.com/demo/repo/pull/21", state: "OPEN", baseRefName: "main" }]);
  const { binDir, callsFile } = proposeFakeBin({ listJson, createRefused: "pr create should not have been called", editRefused: "HTTP 403: Resource not accessible by integration" });
  const res = withFakeBin(binDir, () => sporCli.proposeIntegrationPR({ top: dir, head, targetRef: "main", body }));
  assert.strictEqual(res.ok, false, "an unrefreshed body is not a successful proposal");
  assert.match(res.reason, /PR #21 is already open/);
  assert.match(res.reason, /could not be refreshed with that head's attestation/);
  assert.match(res.reason, /HTTP 403: Resource not accessible by integration/, "gh's own reason surfaces");
  const calls = fs.readFileSync(callsFile, "utf8");
  assert.match(calls, /gh pr edit 21 --repo demo\/repo --body /);
  assert.doesNotMatch(calls, /gh pr create/, "a failed refresh does not fall through to opening a duplicate");
  // The door itself, on its own: {ok:false, reason} shapes.
  const direct = withFakeBin(binDir, () => sporCli.editProposalBody({ top: dir, repo: "demo/repo", number: 21, body }));
  assert.strictEqual(direct.ok, false);
  assert.match(direct.reason, /HTTP 403/);
  assert.deepStrictEqual(sporCli.editProposalBody({ repo: null, number: 21, body }).ok, false);
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

// issue-spor-heal-proposal-tracking-reads-fetch-failure-as-present: healProposalTracking
// used to check bare truthiness of resolveNode()'s result, which — like the F2
// case above — collapses a confirmed absence and a fetch failure into the same
// falsy `null`. Its own comment says it only writes when the node is confirmed
// ABSENT, so a 5xx/timeout pass must neither heal (it hasn't confirmed
// anything) nor be mistaken for "already present" — it must retry next pass,
// and only a genuine 404 may license the write.
test("healProposalTracking: a 5xx on the tracking-node GET defers the heal instead of writing over an unconfirmed absence, and a later 404 heals it (propose mode)", async (t) => {
  const http = require("node:http");
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-tracking-remote-"));

  let mode = 500;
  let postCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/nodes/")) {
      if (mode === 500) { res.writeHead(500, { "content-type": "text/plain" }); res.end("boom"); return; }
      if (mode === 404) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"raw":"---\\nid: x\\ntype: task\\n---\\n"}');
      return;
    }
    if (req.method === "POST" && req.url === "/v1/nodes") {
      postCount++;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ ok: true, status: "created" }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" } });
  assert.strictEqual(cfg.mode(), "remote");

  const record = {
    node_id: "task-proposed-remote",
    run_id: "11111111-2222-3333-4444-000000000099",
    gate_proposal_number: 21,
    gate_proposal_url: "https://github.com/demo/repo/pull/21",
    gate_proposal_target_ref: "main",
    gate_proposal_project: "demo",
  };

  // Pass 1: the GET 5xxs. Not evidence of absence — must not write, and must
  // report failure (not success) so checkProposals retries it next pass.
  const first = await sporCli.healProposalTracking(cfg, record);
  assert.strictEqual(first.healed, false, "a 5xx must not be read as a completed heal");
  assert.strictEqual(first.ok, false, "a 5xx must not be read as 'already present, nothing to do'");
  assert.strictEqual(postCount, 0, "an unconfirmed absence must never trigger a write");

  // Pass 2: the GET now confirms a genuine 404 — the heal may proceed.
  mode = 404;
  const second = await sporCli.healProposalTracking(cfg, record);
  assert.strictEqual(second.healed, true, "a confirmed absence heals the tracking item");
  assert.strictEqual(second.ok, true);
  assert.strictEqual(postCount, 1, "the heal happens on the second (confirmed-absent) pass, not the first");
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

// ----------------------------- propose mode against an ENFORCING remote fake --
//
// issue-spor-restore-proposal-closes-tracking-item-with-bare-done-no-resolver:
// every propose-mode test above drives checkProposals/restoreProposal against a
// LOCAL nodes dir, whose write door (setStatusLocal) only checks status-vocabulary
// membership and the execution hold — it never runs the seed schema's
// transitions() completion gate (task-cc-terminal-status-requires-resolver), so a
// bare `done` with no resolver silently succeeds there. The real gate is remote
// (the server runs transitions() on every status write), so only a fake that
// ENFORCES it — reproducing the seed schema-task rule "a completion status needs a
// live resolves/answers edge from a decision or artifact" — can prove
// restoreProposal never closes the tracking item with a bare status flip.
function startFakeGraphServer() {
  const http = require("node:http");
  const graphLib = require("../lib/graph.js");
  const completionShellHelper = require("../lib/shell/completion.js");
  const store = new Map(); // id -> { raw, revision }

  const parse = (raw, id) => {
    try {
      return graphLib.parseFrontmatter(raw, `${id}.md`);
    } catch {
      return {};
    }
  };
  // Mirrors lib/seed/schema-task.md's declared `status.completion` /
  // `status.resolver_required` — the ONLY types this fake's proposal graphs use.
  const COMPLETION_BY_TYPE = { task: "done" };
  const resolverOf = (id) => {
    for (const [srcId, entry] of store) {
      if (srcId === id) continue;
      const node = parse(entry.raw, srcId);
      if (node.type !== "decision" && node.type !== "artifact") continue;
      const hit = (node.edges || []).find((e) => (e.type === "resolves" || e.type === "answers") && e.to === id);
      if (hit) return { by: srcId, edge: hit.type };
    }
    return null;
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && url.pathname.startsWith("/v1/nodes/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/nodes/".length));
      const entry = store.get(id);
      if (!entry) return send(404, { error: { message: "not found" } });
      const resolution = resolverOf(id);
      return send(200, { raw: entry.raw, revision: String(entry.revision), resolution: resolution ? { by: resolution.by, edge: resolution.edge } : null });
    }

    if (req.method === "POST" && url.pathname === "/v1/nodes") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const results = [];
      for (const item of body.nodes || []) {
        const node = parse(item.node, "unknown");
        const id = node.id;
        if (!id) {
          results.push({ ok: false, code: "invalid", message: "node has no id" });
          continue;
        }
        const existing = store.get(id);
        if (item.if_exists === "skip" && existing) {
          results.push({ ok: true, status: "skipped" });
          continue;
        }
        if (item.if_exists === "update") {
          if (!existing) {
            results.push({ ok: false, code: "not_found", message: `no such node: ${id}` });
            continue;
          }
          if (item.revision != null && String(item.revision) !== String(existing.revision)) {
            results.push({ ok: false, code: "conflict", message: `stale revision for '${id}'` });
            continue;
          }
          store.set(id, { raw: item.node, revision: existing.revision + 1 });
          results.push({ ok: true, revision: String(existing.revision + 1) });
          continue;
        }
        if (existing) {
          results.push({ ok: false, code: "exists", message: `${id} already exists` });
          continue;
        }
        store.set(id, { raw: item.node, revision: 1 });
        results.push({ ok: true, status: "created" });
      }
      return send(200, { results });
    }

    const statusMatch = /^\/v1\/nodes\/([^/]+)\/status$/.exec(url.pathname);
    if (req.method === "POST" && statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const entry = store.get(id);
      if (!entry) return send(404, { error: { message: "not found" } });
      const body = JSON.parse((await readBody(req)) || "{}");
      const node = parse(entry.raw, id);
      // The seed completion gate (task-cc-terminal-status-requires-resolver): a
      // completion status needs a live resolves/answers edge from a decision or
      // artifact node ALREADY on the graph — this is what a bare status flip
      // with no resolver refuses.
      const completionValue = COMPLETION_BY_TYPE[node.type];
      if (completionValue && body.status === completionValue && !resolverOf(id)) {
        return send(409, {
          error: {
            code: "transition_denied",
            message:
              "done requires a decision or artifact node in a RESOLVING state that resolves this task (an inbound resolves edge) (task-cc-terminal-status-requires-resolver)",
          },
        });
      }
      const rewritten = completionShellHelper.setFrontmatterKey(entry.raw, "status", body.status);
      store.set(id, { raw: rewritten != null ? rewritten : entry.raw, revision: entry.revision + 1 });
      return send(200, {});
    }

    const edgeMatch = /^\/v1\/nodes\/([^/]+)\/edges$/.exec(url.pathname);
    if (req.method === "POST" && edgeMatch) {
      const id = decodeURIComponent(edgeMatch[1]);
      const entry = store.get(id);
      if (!entry) return send(404, { error: { message: "not found" } });
      const body = JSON.parse((await readBody(req)) || "{}");
      const rewritten = `${entry.raw.replace(/\n---\n/, `\n  - {type: ${body.type}, to: ${body.to}}\n---\n`)}`;
      store.set(id, { raw: rewritten, revision: entry.revision + 1 });
      return send(200, {});
    }

    send(404, { error: { message: "unknown route" } });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, store }));
  });
}

function fakeNode(id, front) {
  return `---\nid: ${id}\n${front}date: 2026-09-06\n---\n\nBody.\n`;
}

test("issue-spor-restore-proposal-closes-tracking-item-with-bare-done-no-resolver: propose mode under CONTROLLER completion — the landed fact resolves the tracking item BEFORE its status flips, so a remote-mode completion gate never refuses it", async (t) => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const { server, port, store } = await startFakeGraphServer();
  t.after(() => server.close());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-remote-gate-"));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" } });
  assert.strictEqual(cfg.mode(), "remote");

  const nodeId = "task-proposed";
  const runId = "11111111-2222-3333-4444-0000000000aa";
  const trackerId = sporCli.proposalTrackingId(nodeId, runId);
  const executionId = "exec-test-remote-gate";

  // The work item is HELD by a factory controller (execution:) — the same
  // state it would be in when the integration stage parks it for review.
  store.set(nodeId, { raw: fakeNode(nodeId, `type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nexecution: ${executionId}\nexecution_at: 2026-09-06T00:00:00.000Z\n`), revision: 1 });
  // The tracking item park() would have filed — content doesn't need to match
  // buildProposalTrackingNode byte-for-byte; checkProposals only needs it present.
  store.set(trackerId, { raw: fakeNode(trackerId, `type: task\ntitle: Integration proposed\nsummary: The integration stage opened a PR for ${nodeId}; it lands automatically once merged.\nstatus: open\nrequires: [human]\nedges:\n  - {type: blocks, to: ${nodeId}}\n`), revision: 1 });

  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId,
    node_id: nodeId,
    state: "done",
    gate_state: "parked",
    gate_proposal_number: 55,
    gate_proposal_repo: "demo/repo",
    gate_proposal_url: "https://github.com/demo/repo/pull/55",
    gate_proposal_branch: nodeId,
    gate_proposal_target_ref: "main",
    gate_proposal_strategy: "merge",
    gate_proposal_project: "demo",
    gate_proposal_factory: "factory-demo",
    gate_proposal_blocker: trackerId,
    impl_claim: {
      execution_id: executionId,
      completion: { by: "controller", after: "integration" },
      factory: { node_id: "factory-demo" },
    },
    impl_candidate: { candidate_id: "cand-abc123def456", commit: "deadbeef00", tree: "beadfeed00" },
  });

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-remote-gate-"));
  const stateFile = path.join(ghDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ state: "MERGED", mergedAt: "2026-09-06T00:00:00Z", mergeCommit: { oid: "deadbeefcafe" }, mergedBy: { login: "reviewer" }, baseRefName: "main" }));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\ncat "${stateFile}"\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const log = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => log.push(l) });

  const statusOf = (id) => {
    const parsed = require("../lib/graph.js").parseFrontmatter(store.get(id).raw, `${id}.md`);
    return parsed.status;
  };

  assert.ok(!log.some((l) => /could not be closed/.test(l)), `the tracking item's completion gate should never refuse it once the landed fact exists:\n${log.join("\n")}`);
  assert.strictEqual(statusOf(nodeId), "done", "the controller wrote the work item's own completion");
  assert.strictEqual(statusOf(trackerId), "done", "the tracking item closed too, with a resolver already on the graph");

  const landedFactId = require("../lib/shell/integration-runner.js").integrationFactId(nodeId, runId, "landed");
  assert.ok(store.has(landedFactId), "the landed fact was recorded");
  assert.match(store.get(landedFactId).raw, new RegExp(`- \\{type: resolves, to: ${trackerId}\\}`), "the landed fact is the tracking item's resolver");

  const completionResolverId = `art-completion-${nodeId.replace(/^task-/, "")}-abc123def456`;
  assert.ok(store.has(completionResolverId), "the controller's own completion resolver was written for the work item");
  assert.match(store.get(completionResolverId).raw, new RegExp(`- \\{type: resolves, to: ${nodeId}\\}`));
});

// The LEGACY half of the same scenario: no impl_claim, so restoreProposal takes
// the non-controller branch (gatePromoteItem, restoring a resolver the
// IMPLEMENTER already wrote before park() demoted it, rather than one the
// controller writes here) — same enforcing gate, same "the tracking item's own
// resolver must already exist before its status flips" requirement.
test("issue-spor-restore-proposal-closes-tracking-item-with-bare-done-no-resolver: propose mode under LEGACY (agent-resolved) completion — the tracking item still closes against the enforcing remote gate", async (t) => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const { server, port, store } = await startFakeGraphServer();
  t.after(() => server.close());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-remote-gate-legacy-"));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" } });
  assert.strictEqual(cfg.mode(), "remote");

  const nodeId = "task-proposed-legacy";
  const runId = "11111111-2222-3333-4444-0000000000bb";
  const trackerId = sporCli.proposalTrackingId(nodeId, runId);

  // The implementer already resolved the work item itself (a decision node,
  // pre-dating the controller-completion boundary) and park() rolled its
  // status back to `open`, blocked by the tracking item — the pre-existing
  // propose-mode shape (task-spor-integration-propose-mode).
  store.set("dec-resolver-legacy", { raw: fakeNode("dec-resolver-legacy", `type: decision\ntitle: Added bounded retry\nsummary: Added bounded retry with backoff to the sync worker.\nedges:\n  - {type: resolves, to: ${nodeId}}\n`), revision: 1 });
  store.set(nodeId, { raw: fakeNode(nodeId, `type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\n`), revision: 1 });
  store.set(trackerId, { raw: fakeNode(trackerId, `type: task\ntitle: Integration proposed\nsummary: The integration stage opened a PR for ${nodeId}; it lands automatically once merged.\nstatus: open\nrequires: [human]\nedges:\n  - {type: blocks, to: ${nodeId}}\n`), revision: 1 });

  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId,
    node_id: nodeId,
    state: "done",
    gate_state: "parked",
    gate_proposal_number: 56,
    gate_proposal_repo: "demo/repo",
    gate_proposal_url: "https://github.com/demo/repo/pull/56",
    gate_proposal_branch: nodeId,
    gate_proposal_target_ref: "main",
    gate_proposal_strategy: "merge",
    gate_proposal_project: "demo",
    gate_proposal_factory: "factory-demo",
    gate_proposal_blocker: trackerId,
  });

  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-remote-gate-legacy-"));
  const stateFile = path.join(ghDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ state: "MERGED", mergedAt: "2026-09-06T00:00:00Z", mergeCommit: { oid: "deadbeefcafe" }, mergedBy: { login: "reviewer" }, baseRefName: "main" }));
  writeFakePathBin(ghDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\ncat "${stateFile}"\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${ghDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const log = [];
  await sporCli.checkProposals(cfg, { home, log: (l) => log.push(l) });

  const statusOf = (id) => {
    const parsed = require("../lib/graph.js").parseFrontmatter(store.get(id).raw, `${id}.md`);
    return parsed.status;
  };

  assert.ok(!log.some((l) => /could not be closed/.test(l)), `the tracking item's completion gate should never refuse it once the landed fact exists:\n${log.join("\n")}`);
  assert.strictEqual(statusOf(nodeId), "done", "the work item's own completion status was restored");
  assert.strictEqual(statusOf(trackerId), "done", "the tracking item closed too, with a resolver already on the graph");

  const landedFactId = require("../lib/shell/integration-runner.js").integrationFactId(nodeId, runId, "landed");
  assert.ok(store.has(landedFactId), "the landed fact was recorded");
  assert.match(store.get(landedFactId).raw, new RegExp(`- \\{type: resolves, to: ${trackerId}\\}`), "the landed fact is the tracking item's resolver");
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
  git(dir, "config", "core.autocrlf", "false"); // the checked-out BYTES are compared below; the Windows CI runner's global autocrlf would rewrite them
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
  git(dir, "config", "core.autocrlf", "false"); // the checked-out BYTES are compared below; the Windows CI runner's global autocrlf would rewrite them
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

// issue-spor-orchestrator-merge-cas-lacks-ancestry-check: `update-ref <ref>
// <new> <old>` only asserts the ref is still at <old> — it never checks that
// <new> descends from it. `integrationRepo()`'s `branch` was cut from main's
// FIRST commit and never rebased onto main's later "main moved" commit, so it
// is exactly the "skipped the rebase" shape that rewound main for real.
test("landCandidate REFUSES to land locally when the candidate does not descend from the observed target tip (ancestry guard)", () => {
  const dir = integrationRepo();
  const expectedSha = git(dir, "rev-parse", "main").trim();
  const staleSha = git(dir, "rev-parse", "branch").trim(); // never rebased onto main

  const landed = integrationRunner.landCandidate({ top: dir, dir, sha: staleSha, expectedSha, targetRef: "main", mode: "local" });
  assert.strictEqual(landed.ok, false);
  assert.strictEqual(landed.race, false, "a non-descendant candidate is a refusal, not a lost race to silently retry");
  assert.match(landed.reason, /does not descend/);
  assert.strictEqual(git(dir, "rev-parse", "main").trim(), expectedSha, "main was NOT rewound — update-ref never ran");
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

// ------------------------------------------- integration merges the PINNED commit --
//
// task-spor-integration-builds-candidate-from-pinned-commit,
// FACTORY-IMPLEMENTATION-STAGE.md §3.2 ("everything downstream consumes the
// PINNED commit, never the branch head") and §4.2 M1 (the mismatch refusal).
// The judged object is the candidate; a branch that moved after the pin must
// never be what lands.

const FACTORY_IMPL = { ...FACTORY, implementation: { profile: "profile-impl" } };
// A pinned candidate whose commit is NOT the branch head: the branch advanced
// after the pin (`tree.head` is "headsha" in the fakes).
const PINNED = {
  candidate_id: "cand-3f9a1c72e5b40d16",
  commit: "pinnedcommit",
  tree: "pinnedtree",
  reference: { kind: "bundle", locator: "file:///home/x/.spor/candidates/cand-3f9a1c72e5b40d16.bundle", verified_at: "2026-09-06T00:00:00Z" },
};
// The standing a pinned commit has on a branch that merely ADVANCED past it.
const ADVANCED = { known: true, contained: true, commitTreeMatches: true, headTreeMatches: false };

function pinnedFakes(opts = {}, { candidate = PINNED, standing = ADVANCED } = {}) {
  const made = integrationFakes(opts);
  made.seen.standings = [];
  made.deps.tipCandidate = async () => candidate;
  made.deps.candidateStanding = async (args) => {
    made.seen.standings.push(args);
    return typeof standing === "function" ? standing(args, made.seen) : standing;
  };
  return made;
}

test("a pinned candidate is what integration merges: the candidate tree is built from impl_candidate.commit, not the branch head", async () => {
  const { deps, seen } = pinnedFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.builds, 1);
  assert.strictEqual(seen.buildArgs[0].head, "pinnedcommit", "the build merges the PINNED commit, never the branch head the gates never judged");
  assert.deepStrictEqual(seen.standings, [{ top: "/repo", head: "headsha", commit: "pinnedcommit", tree: "pinnedtree" }]);
});

test("no candidate pinned — no implementation stage, or a caller with no tipCandidate dep — integrates the branch head exactly as before", async () => {
  const { deps, seen } = pinnedFakes();
  // The stage is not declared, so nothing is a tip: byte-identical.
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.buildArgs[0].head, "headsha");
  assert.deepStrictEqual(seen.standings, [], "nothing is checked when nothing is pinned");

  // Declared, but this caller wires no tip read at all — same door.
  const bare = integrationFakes();
  const res2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps: bare.deps });
  assert.strictEqual(res2.state, "passed", res2.reason);
  assert.strictEqual(bare.seen.buildArgs[0].head, "headsha");
});

test("a pinned candidate with no commit on it yet falls back to the branch head rather than building from nothing", async () => {
  const { deps, seen } = pinnedFakes({}, { candidate: { candidate_id: "cand-x" } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.buildArgs[0].head, "headsha");
  assert.deepStrictEqual(seen.standings, []);
});

test("the branch head no longer CONTAINS the pinned commit: a MISMATCH — refused before a lease, a worktree or a fix cycle, and escalated to a person", async () => {
  const { deps, seen } = pinnedFakes({}, { standing: { known: true, contained: false, commitTreeMatches: true, headTreeMatches: false } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "mismatch");
  assert.strictEqual(seen.builds, 0, "nothing is built from a branch that dropped the candidate");
  assert.strictEqual(seen.leaseAcquired, 0, "the refusal costs no serialization either");
  assert.strictEqual(seen.fixes.length, 0, "a mismatch is never a fix cycle — the evidence is wrong, not the code");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.escalations[0].kind, "mismatch", "the escalation is framed as a mismatch, not as spent fix cycles");
  assert.strictEqual(seen.escalations[0].fixCycles, 0, "nothing was charged before the refusal");
  assert.match(seen.escalations[0].detail, /cand-3f9a1c72e5b40d16/);
  assert.match(seen.escalations[0].detail, /no longer contains it/);
  assert.match(seen.escalations[0].detail, /cand-3f9a1c72e5b40d16\.bundle/, "the locator a reader would fetch is named");
  assert.strictEqual(seen.facts.length, 1);
  assert.match(seen.facts[0].markdown, /Integration mismatch/);
  assert.match(seen.facts[0].markdown, /the branch no longer carries the candidate the gates judged/);
  assert.strictEqual(seen.demotions.length, 1, "the refusal's graph-state half runs exactly as any other refusal's does");
});

test("a same-tree RELABEL of the pinned commit is NOT a mismatch — §3.2's first-published-wins lands the published commit", async () => {
  // The head is an amend of the pinned commit: not contained, same tree.
  const { deps, seen } = pinnedFakes({}, { standing: { known: true, contained: false, commitTreeMatches: true, headTreeMatches: true } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.buildArgs[0].head, "pinnedcommit", "the commit that was PUBLISHED is what lands, not the relabel");
});

test("a pinned commit that no longer resolves to its pinned TREE is a mismatch — M1's own definition", async () => {
  const { deps, seen } = pinnedFakes({}, { standing: { known: true, contained: true, commitTreeMatches: false, headTreeMatches: false } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "mismatch");
  assert.strictEqual(seen.builds, 0);
  assert.match(seen.escalations[0].detail, /no longer resolves to its pinned tree/);
});

test("a standing git could not read FAILS CLOSED: a tree this stage cannot verify is exactly the tree it must not land", async () => {
  const { deps, seen } = pinnedFakes({}, { standing: { known: false, contained: null, commitTreeMatches: null, headTreeMatches: null, reason: "the pinned commit is not in /repo" } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "mismatch");
  assert.strictEqual(seen.builds, 0);
  assert.match(seen.escalations[0].detail, /could not be verified against the branch head/);
  assert.match(seen.escalations[0].detail, /the pinned commit is not in \/repo/);

  // A dep that THROWS reads the same way — never as "verified".
  const thrown = pinnedFakes();
  thrown.deps.candidateStanding = async () => {
    throw new Error("git exploded");
  };
  const res2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps: thrown.deps });
  assert.strictEqual(res2.state, "mismatch");
  assert.strictEqual(thrown.seen.builds, 0);
  assert.match(thrown.seen.escalations[0].detail, /git exploded/);
});

test("in `propose` mode a head that merely CONTAINS the candidate is a mismatch — the PR lands the branch, so the branch must BE the candidate", async () => {
  // Exactly the standing that PASSES in local mode (the branch advanced past
  // the pin): local mode lands the pinned commit and leaves the drift behind,
  // but a merged PR would carry it.
  const { deps, seen } = pinnedFakes({}, { standing: ADVANCED });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY_PROPOSE, implementation: { profile: "profile-impl" } }, deps });
  assert.strictEqual(res.state, "mismatch");
  assert.strictEqual(seen.proposals, 0, "no pull request is opened for a branch carrying commits the gates never judged");
  assert.match(seen.escalations[0].detail, /`propose` mode lands the branch itself/);

  // The same branch, once the head IS the candidate's tree, proposes as usual.
  const ok = pinnedFakes({}, { standing: { known: true, contained: true, commitTreeMatches: true, headTreeMatches: true } });
  const res2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY_PROPOSE, implementation: { profile: "profile-impl" } }, deps: ok.deps });
  assert.strictEqual(res2.state, "parked", res2.reason);
  assert.strictEqual(ok.seen.proposals, 1);
});

// issue-spor-propose-mode-opens-pr-from-head-not-published-commit: the PR
// propose() opens must carry the PUBLISHED candidate commit, not a same-tree
// relabel of it sitting at the branch head — §3.2 "everything downstream
// consumes the PINNED commit, never the branch head … and the art-merge-*
// fact names it" applies to propose mode exactly as it does to local/push.
test("propose mode opens the PR from the PINNED candidate's own commit, not the branch head — even when the head is only a same-tree relabel of it", async () => {
  const { deps, seen } = pinnedFakes({}, { standing: { known: true, contained: false, commitTreeMatches: true, headTreeMatches: true } });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY_PROPOSE, implementation: { profile: "profile-impl" } }, deps });
  assert.strictEqual(res.state, "parked", res.reason);
  assert.strictEqual(seen.proposals, 1);
  assert.strictEqual(seen.proposeArgs[0].head, "pinnedcommit", "the PR is opened from the commit every art-gate-* fact judged, not the relabeled branch head");
});

test("propose mode with no candidate pinned still opens the PR from the branch head — byte-identical to before the implementation stage existed", async () => {
  const { deps, seen } = integrationFakes();
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_PROPOSE, deps });
  assert.strictEqual(res.state, "parked", res.reason);
  assert.strictEqual(seen.proposeArgs[0].head, "headsha");
});

test("an integration fix cycle RE-PINS, and the rebuild merges the commit that re-pin named — not the stale tip and not the moved head", async () => {
  const buildSequence = (args, s) => (s.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" });
  const { deps, seen } = pinnedFakes({ build: buildSequence, tree: { ok: true, top: "/repo", head: "headsha", cwd: "/repo/wt" }, fix: () => ({ ok: true, runId: "run-fix-1" }) });
  deps.pinCandidate = async () => ({ ok: true, candidate: { candidate_id: "cand-after-fix", commit: "fixedcommit", tree: "fixedtree" }, change: "superseded" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.deepStrictEqual(
    seen.buildArgs.map((b) => b.head),
    ["pinnedcommit", "fixedcommit"],
    "the first build merges the tip as it stood; the rebuild merges what the fix cycle's own re-pin named"
  );
  // And the re-pinned tip is re-checked against the branch before it is built.
  assert.deepStrictEqual(seen.standings[1], { top: "/repo", head: "headsha", commit: "fixedcommit", tree: "fixedtree" });
});

test("a fix cycle whose re-pin FAILS integrates the refreshed head, never the pre-fix candidate that would silently drop the fix", async () => {
  const buildSequence = (args, s) => (s.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" });
  const { deps, seen } = pinnedFakes({ build: buildSequence, fix: () => ({ ok: true, runId: "run-fix-1" }) });
  deps.pinCandidate = async () => ({ ok: false, reason: "the run record could not be stamped" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.deepStrictEqual(seen.buildArgs.map((b) => b.head), ["pinnedcommit", "headsha"]);
  assert.strictEqual(seen.standings.length, 1, "with no tip there is nothing left to check the branch against");
});

test("a lost landing race rebuilds with the SAME pinned candidate — a race is not a re-pin", async () => {
  const { deps, seen } = pinnedFakes({
    land: (args, s) => (s.lands === 1 ? { ok: false, race: true, reason: "main moved under us" } : { ok: true, detail: "landed" }),
  });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.deepStrictEqual(seen.buildArgs.map((b) => b.head), ["pinnedcommit", "pinnedcommit"]);
});

test("the drift is RE-CHECKED after every fix cycle's re-pin: a branch rewritten mid-pipeline is a mismatch, and the escalation says what was already spent", async () => {
  const buildSequence = (args, s) => (s.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" });
  // Clean up front; the fix cycle's own re-pin lands on a branch that dropped it.
  let checks = 0;
  const { deps, seen } = pinnedFakes(
    { build: buildSequence, fix: () => ({ ok: true, runId: "run-fix-1" }) },
    {
      standing: () => {
        checks += 1;
        return checks === 1 ? { known: true, contained: true, commitTreeMatches: true, headTreeMatches: true } : { known: true, contained: false, commitTreeMatches: true, headTreeMatches: false };
      },
    }
  );
  deps.pinCandidate = async () => ({ ok: true, candidate: { candidate_id: "cand-after-fix", commit: "fixedcommit", tree: "fixedtree" }, change: "superseded" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "mismatch");
  assert.strictEqual(seen.builds, 1, "the first build ran; the rebuild never did");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.escalations[0].kind, "mismatch");
  // The escalation must not claim nothing was spent when a fix cycle already
  // ran: the runner reports its OWN charged-cycle count.
  assert.strictEqual(seen.escalations[0].fixCycles, 1);
  assert.strictEqual(
    seen.escalations[0].attempts.filter((a) => a.verdict === "mismatch").length,
    1,
    "the mismatch rides the attempt list beside the conflict that preceded it"
  );
});

// The escalation PROSE is the thing a person reads, so it is asserted against
// the REAL escalate closure, not a fake: a mismatch found after a fix cycle
// must not say "no fix cycle, retry or budget was spent on it".
test("makeIntegrationDeps' escalate: a mismatch reads as a refusal, and names the cycles already spent when it was found mid-pipeline", async () => {
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-esc-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const factory = { id: "factory-esc", integration: { targetRef: "main", mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 2, timeoutMs: 900000 }, trustedRef: "main", protectedPaths: [] };
  // The escalation id is deterministic per (item, run), so each of the three
  // readings below needs its own run — otherwise the second write collides
  // with the first under writeGateNode's same-id-same-content rule.
  const depsFor = (runId) =>
    sporCli.makeIntegrationDeps(cfg, {
      record: { cwd: home },
      entry: { run_id: runId, node_id: "task-demo", project: "demo", attempt: 1 },
      factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
    });

  const readNode = (id) => fs.readFileSync(path.join(home, "nodes", `${id}.md`), "utf8");

  const up = await depsFor("11111111-2222-3333-4444-0000000000d1").escalate({ attempts: [{ verdict: "mismatch", detail: "the pinned candidate cand-x is not what this checkout would land" }], detail: "drifted", evidence: "", kind: "mismatch" });
  assert.strictEqual(up.ok, true, up.reason);
  const upFront = readNode(up.id);
  assert.match(upFront, /the branch no longer carries the candidate its gates judged/);
  assert.doesNotMatch(upFront, /fix cycles are spent/, "a mismatch never borrows the spent-cycles wording");
  assert.match(upFront, /Nothing was built and nothing was landed/);
  assert.doesNotMatch(upFront, /found after \d+ fix cycle/, "nothing ran before this one, so nothing is claimed to have");

  // The same refusal, found after a fix cycle: the prose must change.
  // A rerun-rescued suite pass pushes an attempt entry of its own, so the
  // count must come from the runner's own charged-cycle counter — inferring it
  // from `attempts.length` reports two cycles where one ran, and past a couple
  // of reruns a number above the declared cap.
  const inflated = await depsFor("11111111-2222-3333-4444-0000000000d4").escalate({
    attempts: [
      { verdict: "passed", detail: "the candidate suite passed on rerun 2 of 2" },
      { verdict: "failed", detail: "could not land" },
      { verdict: "mismatch", detail: "the pinned candidate cand-x is not what this checkout would land" },
    ],
    detail: "drifted after the fix",
    evidence: "",
    kind: "mismatch",
    fixCycles: 1,
  });
  assert.strictEqual(inflated.ok, true, inflated.reason);
  const inflatedBody = readNode(inflated.id);
  assert.match(inflatedBody, /found after 1 fix cycle, cap 2/);
  assert.doesNotMatch(inflatedBody, /found after 2 fix cycles/, "the rerun-rescued pass is not a fix cycle");

  const mid = await depsFor("11111111-2222-3333-4444-0000000000d2").escalate({
    attempts: [
      { verdict: "conflict", detail: "merging onto main conflicts" },
      { verdict: "mismatch", detail: "the pinned candidate cand-x is not what this checkout would land" },
    ],
    detail: "drifted after the fix",
    evidence: "",
    kind: "mismatch",
    fixCycles: 1,
  });
  assert.strictEqual(mid.ok, true, mid.reason);
  const midBody = readNode(mid.id);
  assert.match(midBody, /found after 1 fix cycle, cap 2/);
  assert.match(midBody, /1 fix cycle ran and the drift was found on the re-check/);
  assert.doesNotMatch(midBody, /Nothing was built/, "a fix cycle DID build and run — the escalation must not claim otherwise");

  // And an ordinary refusal is untouched by any of it.
  const plain = await depsFor("11111111-2222-3333-4444-0000000000d3").escalate({ attempts: [{ verdict: "failed", detail: "the candidate suite failed" }], detail: "suite failed", evidence: "" });
  assert.strictEqual(plain.ok, true, plain.reason);
  const plainBody = readNode(plain.id);
  assert.match(plainBody, /its fix cycles are spent \(1 attempt, cap 2\)/);
  assert.doesNotMatch(plainBody, /no longer carries the candidate/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a mismatch is a SETTLED gate state — a mismatched pipeline is never re-adopted as an orphan, and `--regate` is still the door back", () => {
  const gatesKernel = require("../lib/kernel/gates.js");
  assert.ok(gatesKernel.SETTLED_GATE_STATES.has("mismatch"), "an unsettled verdict would be re-run on every resume pass, re-refusing the same evidence forever");
  // The `--regate` guard names the verdicts there is nothing left to judge;
  // a mismatch is deliberately NOT one of them (the branch or the pin can be
  // put right and the run re-judged).
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "spor.js"), "utf8");
  const guard = /record\.gate_state === "passed" \|\| record\.gate_state === "parked" \|\| record\.gate_state === "superseded" \|\| record\.gate_state === "scoped"/;
  assert.match(src, guard);
  assert.doesNotMatch(src.match(guard)[0], /mismatch/);
});

test("a candidate carrying a commit but NO tree is judged the same way in every mode — never a propose-only refusal", () => {
  const dir = integrationRepo();
  const tip = git(dir, "rev-parse", "branch").trim();
  const st = integrationRunner.candidateStanding({ top: dir, head: tip, commit: tip, tree: null });
  assert.strictEqual(st.known, true);
  assert.strictEqual(st.contained, true);
  assert.strictEqual(st.commitTreeMatches, null, "nothing was recorded to disagree with");
  assert.strictEqual(st.headTreeMatches, true, "the head IS the pinned commit, so it is trivially the same tree — in propose mode too");
  const behind = integrationRunner.candidateStanding({ top: dir, head: tip, commit: git(dir, "rev-parse", "branch~1").trim(), tree: null });
  assert.strictEqual(behind.headTreeMatches, false, "a branch that moved on is still a different tree");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("candidateStanding refuses a commit that is not a full object name rather than handing it to git as an option", () => {
  const dir = integrationRepo();
  const tip = git(dir, "rev-parse", "branch").trim();
  for (const bad of ["--all", "HEAD", tip.slice(0, 8), ""]) {
    const st = integrationRunner.candidateStanding({ top: dir, head: tip, commit: bad, tree: null });
    assert.strictEqual(st.known, false, `'${bad}' must not be probed`);
    assert.strictEqual(st.contained, null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a caller that wires tipCandidate WITHOUT candidateStanding integrates the head — a tip is never consumed unchecked, a fix cycle's own re-pin included", async () => {
  const { deps, seen } = integrationFakes();
  deps.tipCandidate = async () => PINNED;
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(seen.buildArgs[0].head, "headsha", "with no way to check the tip against the branch, the branch is what is integrated");

  // The fix cycle's re-pin is the back door: it assigns a fresh tip AFTER the
  // opening read's guard has run, so it needs the same one.
  const buildSequence = (args, st) => (st.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" });
  const after = integrationFakes({ build: buildSequence, fix: () => ({ ok: true, runId: "run-fix-1" }) });
  const pins = [];
  after.deps.tipCandidate = async () => PINNED;
  after.deps.pinCandidate = async (args) => {
    pins.push(args);
    return { ok: true, candidate: { candidate_id: "cand-after-fix", commit: "fixedcommit", tree: "fixedtree" }, change: "superseded" };
  };
  const res2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY_IMPL, deps: after.deps });
  assert.strictEqual(res2.state, "passed", res2.reason);
  assert.strictEqual(pins.length, 1, "the re-pin is still OWED — it is the run record's bookkeeping, not this stage's judgement");
  assert.deepStrictEqual(after.seen.buildArgs.map((b) => b.head), ["headsha", "headsha"], "and the tip it produced is still not consumed unchecked");
});

// The real-git half: the three facts the runner's judgement is made of.
test("candidateStanding, real git: containment, the commit's own tree, and a same-tree relabel — with an unresolvable commit reading `known: false`", () => {
  const dir = integrationRepo();
  const branchTip = git(dir, "rev-parse", "branch").trim();
  const branchBase = git(dir, "rev-parse", "branch~1").trim();
  const branchTree = git(dir, "rev-parse", "branch^{tree}").trim();
  const baseTree = git(dir, "rev-parse", "branch~1^{tree}").trim();

  // An unmoved branch: the tip is its own ancestor, and its tree is its own.
  const same = integrationRunner.candidateStanding({ top: dir, head: branchTip, commit: branchTip, tree: branchTree });
  assert.deepStrictEqual({ known: same.known, contained: same.contained, commitTreeMatches: same.commitTreeMatches, headTreeMatches: same.headTreeMatches }, { known: true, contained: true, commitTreeMatches: true, headTreeMatches: true });

  // A branch that ADVANCED past the pin: contained, but the head is a
  // different tree.
  const advanced = integrationRunner.candidateStanding({ top: dir, head: branchTip, commit: branchBase, tree: baseTree });
  assert.deepStrictEqual({ contained: advanced.contained, commitTreeMatches: advanced.commitTreeMatches, headTreeMatches: advanced.headTreeMatches }, { contained: true, commitTreeMatches: true, headTreeMatches: false });

  // A commit whose recorded tree is not the tree it resolves to — M1.
  const wrongTree = integrationRunner.candidateStanding({ top: dir, head: branchTip, commit: branchTip, tree: baseTree });
  assert.strictEqual(wrongTree.commitTreeMatches, false);

  // A same-tree RELABEL: amend the branch tip's message, leaving its tree.
  git(dir, "checkout", "-q", "branch");
  git(dir, "commit", "-q", "--amend", "-m", "branch work, said differently");
  const relabelled = git(dir, "rev-parse", "HEAD").trim();
  assert.notStrictEqual(relabelled, branchTip);
  const relabel = integrationRunner.candidateStanding({ top: dir, head: relabelled, commit: branchTip, tree: branchTree });
  assert.deepStrictEqual({ contained: relabel.contained, commitTreeMatches: relabel.commitTreeMatches, headTreeMatches: relabel.headTreeMatches }, { contained: false, commitTreeMatches: true, headTreeMatches: true });

  // A commit this checkout does not have at all is not evidence of anything.
  const gone = integrationRunner.candidateStanding({ top: dir, head: relabelled, commit: "0".repeat(40), tree: branchTree });
  assert.strictEqual(gone.known, false);
  assert.strictEqual(gone.contained, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// issue-spor-integration-fix-cycle-does-not-repin-candidate: refreshTree
// re-reads the tree above (the stale-head regression this test sits beside),
// but used to never re-pin the candidate — so it kept naming the commit the
// gate pipeline last judged, not the one the integration fix cycle produced.
// Pins that a fix cycle's re-read calls deps.pinCandidate at stage
// "integration-fix", naming the cycle and the fix's own run id, and that a
// factory with no declared implementation stage pins nothing at all —
// byte-identical to before this stage's candidate wiring existed.
test("a fix cycle re-pins the candidate at stage 'integration-fix', naming the cycle and the fix's run id — and pins nothing without a declared implementation stage", async () => {
  const buildSequence = (args, s) =>
    s.builds === 1 ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" };

  const pins = [];
  const { deps } = integrationFakes({ build: buildSequence, fix: () => ({ ok: true, runId: "run-fix-1" }) });
  deps.pinCandidate = async ({ submittedBy, runId }) => {
    pins.push({ submittedBy, runId });
    return { ok: true, candidate: { candidate_id: "cand-x" }, change: "superseded" };
  };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: { ...FACTORY, implementation: { profile: "profile-impl" } }, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.deepStrictEqual(pins, [{ submittedBy: { stage: "integration-fix", cycle: 1, rescue: 0 }, runId: "run-fix-1" }]);

  const pinsNoImpl = [];
  const { deps: deps2 } = integrationFakes({ build: buildSequence, fix: () => ({ ok: true, runId: "run-fix-1" }) });
  deps2.pinCandidate = async ({ submittedBy, runId }) => {
    pinsNoImpl.push({ submittedBy, runId });
    return { ok: true, candidate: { candidate_id: "cand-x" }, change: "superseded" };
  };
  const res2 = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps: deps2 });
  assert.strictEqual(res2.state, "passed", res2.reason);
  assert.deepStrictEqual(pinsNoImpl, [], "no implementation: block declared, no pin — byte-identical to before this stage's candidate wiring existed");
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

// The pinned-commit rule wired against the REAL production deps
// (bin/spor.js's makeIntegrationDeps — `tipCandidate` reading the run record
// off disk, `candidateStanding` reading real git), with only the pieces that
// would dispatch an agent or run a real suite faked out. Two halves of the
// same fact: a branch that ADVANCED past the pin lands the PINNED tree, and a
// branch REWRITTEN off the pin lands nothing at all.
test("REAL deps: a branch that advanced after the pin lands the PINNED commit's tree, not the drift the gates never judged", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const dir = integrationRepo();
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-pinned-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  const factory = {
    id: "factory-pinned",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
    implementation: { profile: "profile-impl" },
  };
  const entry = { run_id: "11111111-2222-3333-4444-0000000000bb", node_id: "task-demo", project: "demo", attempt: 1 };
  const record = { cwd: dir };

  const pinnedHead = git(dir, "rev-parse", "HEAD").trim();
  const change = gateRunner.gateChangeSet(record, targetRef);
  const seeded = gateRunner.pinCandidate(record, targetRef, {
    change, repo: "demo", nodeId: entry.node_id,
    submittedBy: { stage: "implementation", cycle: 0, rescue: 0 },
    provenance: { run_id: entry.run_id, attempt: 1 },
    resolver: { node: null, written: false, resolves_edge: false },
  });
  assert.strictEqual(seeded.ok, true, seeded.reason);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "running",
    impl_state: "candidate", impl_candidate: seeded.candidate, impl_candidates: [seeded.candidate],
  });

  // The branch MOVES after the pin — a stray commit nothing judged.
  fs.writeFileSync(path.join(dir, "lib", "drift.js"), "module.exports = 'never judged';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "drift: committed after the candidate was pinned");
  assert.notStrictEqual(git(dir, "rev-parse", "HEAD").trim(), pinnedHead, "sanity: the branch really moved");

  const realDeps = sporCli.makeIntegrationDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });
  const deps = {
    ...realDeps,
    acquireLease: async () => null,
    releaseLease: async () => {},
    runSuite: async () => ({ ok: true }),
    fix: async () => ({ ok: true }),
    escalate: async () => ({ ok: true, id: "task-integration-escalate-x" }),
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };
  const item = { node_id: entry.node_id, run_id: entry.run_id, project: entry.project, attempt: entry.attempt };
  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  const landed = git(dir, "rev-parse", targetRef).trim();
  assert.doesNotThrow(() => git(dir, "show", `${landed}:lib/sub.js`), "the pinned candidate's own work landed");
  assert.throws(() => git(dir, "show", `${landed}:lib/drift.js`), "the commit made after the pin is NOT what landed — the gates never judged it");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("REAL deps: a branch REWRITTEN off its pinned candidate refuses with a mismatch — nothing is built and the target ref never moves", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const dir = integrationRepo();
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-mismatch-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  const factory = {
    id: "factory-mismatch",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
    implementation: { profile: "profile-impl" },
  };
  const entry = { run_id: "11111111-2222-3333-4444-0000000000cc", node_id: "task-demo", project: "demo", attempt: 1 };
  const record = { cwd: dir };

  const change = gateRunner.gateChangeSet(record, targetRef);
  const seeded = gateRunner.pinCandidate(record, targetRef, {
    change, repo: "demo", nodeId: entry.node_id,
    submittedBy: { stage: "implementation", cycle: 0, rescue: 0 },
    provenance: { run_id: entry.run_id, attempt: 1 },
    resolver: { node: null, written: false, resolves_edge: false },
  });
  assert.strictEqual(seeded.ok, true, seeded.reason);
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "running",
    impl_state: "candidate", impl_candidate: seeded.candidate, impl_candidates: [seeded.candidate],
  });

  // The branch is REWRITTEN onto different content — the pinned commit is no
  // longer reachable from it, and the head is not a relabel of it either.
  const targetBefore = git(dir, "rev-parse", targetRef).trim();
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  fs.writeFileSync(path.join(dir, "lib", "other.js"), "module.exports = 'something else entirely';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "rewrite: different work on the same branch");

  const realDeps = sporCli.makeIntegrationDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });
  let builds = 0;
  const escalations = [];
  const deps = {
    ...realDeps,
    acquireLease: async () => null,
    releaseLease: async () => {},
    buildCandidate: async (args) => {
      builds += 1;
      return realDeps.buildCandidate(args);
    },
    runSuite: async () => ({ ok: true }),
    fix: async () => ({ ok: true }),
    escalate: async (args) => {
      escalations.push(args);
      return { ok: true, id: "task-integration-escalate-x" };
    },
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };
  const item = { node_id: entry.node_id, run_id: entry.run_id, project: entry.project, attempt: entry.attempt };
  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "mismatch", res.reason);
  assert.strictEqual(builds, 0);
  assert.strictEqual(escalations.length, 1);
  assert.strictEqual(escalations[0].kind, "mismatch");
  assert.match(escalations[0].detail, new RegExp(seeded.candidate.candidate_id));
  assert.strictEqual(git(dir, "rev-parse", targetRef).trim(), targetBefore, "nothing landed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// issue-spor-integration-fix-cycle-does-not-repin-candidate: the per-cycle
// `changedTree` refresh above moves `tree`/HEAD after every fix cycle, but
// used to never call `pinCandidate` — so `impl_candidate` kept naming the
// pre-integration commit while the branch (and, once landed, the target ref)
// had already moved past it. Wired against the REAL production dep
// (bin/spor.js's makeIntegrationDeps), with only the pieces that would
// otherwise dispatch a real agent or run a real suite faked out — exactly the
// composition `spor work` runs.
test("REGRESSION issue-spor-integration-fix-cycle-does-not-repin-candidate: a fix cycle re-pins impl_candidate to the fix's OWN commit, not the pre-integration tree", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const dir = integrationRepo();
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-repin-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  const factory = {
    id: "factory-repin",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
    // pinCandidate is a no-op without a declared implementation stage —
    // gate-runner.js's own `pin` guards on it and integration-runner.js's
    // mirrors that guard.
    implementation: { profile: "profile-impl" },
  };
  const entry = { run_id: "11111111-2222-3333-4444-000000000099", node_id: "task-demo", project: "demo", attempt: 1 };
  const record = { cwd: dir };

  // Seed the run record with the candidate the IMPLEMENTATION stage would
  // already have pinned before integration ever ran (gate-runner.js's own
  // pin, at stage "implementation") — the state this bug actually reproduces
  // against, not an empty record.
  const preFixHead = git(dir, "rev-parse", "HEAD").trim();
  const preFixChange = gateRunner.gateChangeSet(record, targetRef);
  assert.strictEqual(preFixChange.ok, true, preFixChange.reason);
  const seedPinned = gateRunner.pinCandidate(record, targetRef, {
    change: preFixChange,
    repo: "demo",
    nodeId: entry.node_id,
    submittedBy: { stage: "implementation", cycle: 0, rescue: 0 },
    provenance: { run_id: entry.run_id, attempt: 1 },
    resolver: { node: null, written: false, resolves_edge: false },
  });
  assert.strictEqual(seedPinned.ok, true, seedPinned.reason);
  assert.strictEqual(seedPinned.candidate.commit, preFixHead, "sanity: the seeded candidate names the pre-fix commit");
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "running",
    impl_state: "candidate", impl_run_id: entry.run_id, impl_attempt: 1, impl_pool: "implementation",
    impl_candidate: seedPinned.candidate, impl_candidates: [seedPinned.candidate],
  });

  // The REAL dep bin/spor.js builds for `spor work`; only the pieces that
  // would otherwise dispatch a subprocess or run a real suite are replaced,
  // exactly as the "REGRESSION, real git" test above does for the gate-only
  // regression this one is the integration-candidate sibling of.
  const realDeps = sporCli.makeIntegrationDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });

  let suiteRuns = 0;
  const deps = {
    ...realDeps,
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
    // A REAL commit in the implementer's own checkout, exactly what a
    // dispatched fix cycle produces.
    fix: async () => {
      fs.writeFileSync(path.join(dir, "lib", "fix-marker.js"), "module.exports = true;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fix: add the marker the suite requires");
      return { ok: true, runId: "run-fixxxxxx" };
    },
    escalate: async () => ({ ok: true, id: "task-integration-escalate-x" }),
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };

  const item = { node_id: entry.node_id, run_id: entry.run_id, project: entry.project, attempt: entry.attempt };
  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(suiteRuns, 2, "the suite ran once before the fix and once on the retried candidate");

  const fixedHead = git(dir, "rev-parse", "branch").trim();
  assert.notStrictEqual(fixedHead, preFixHead, "sanity: the fix cycle actually moved the branch tip");

  const rec = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record);
  assert.ok(rec.impl_candidate, "the candidate is still recorded after the fix cycle");
  assert.strictEqual(rec.impl_candidate.commit, fixedHead, "the re-pinned candidate names the fix cycle's commit — the branch tip — not the pre-integration tree");
  assert.strictEqual(rec.impl_candidate.submitted_by.stage, "integration-fix", "the re-pin is attributed to the integration fix cycle, not the original implementation submission");
  assert.strictEqual(rec.impl_candidate.supersedes, seedPinned.candidate.candidate_id, "the fix produced a different tree, so it supersedes the pre-fix candidate rather than relabeling it");
  assert.strictEqual(rec.impl_candidates.length, 2, "the chain carries both the pre-fix and the re-pinned candidate");
});

// A narrower sibling of the regression above: the gate pipeline's OWN opening
// pin (makeGateDeps' pinCandidate, at the unconditional first readChanged) is
// itself fail-soft — a dirty/unreadable tree just logs and the gate pipeline
// proceeds regardless — so a factory can reach integration having never
// successfully pinned anything at all. In that case an integration fix
// cycle's own re-pin is the FIRST successful pin (`folded.change ===
// "created"`), and makeIntegrationDeps' pinCandidate must stamp
// impl_run_id/impl_attempt/impl_pool/impl_state exactly like makeGateDeps'
// own `created` branch does — a correctness gap a medium-effort review of
// this fix caught: the first cut only ever wrote impl_candidate/
// impl_candidates, leaving those four fields permanently unset even once a
// candidate existed.
test("when no candidate was ever pinned before integration ran, an integration fix cycle's re-pin is the FIRST pin and stamps impl_run_id/impl_attempt/impl_pool/impl_state, not just the candidate", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const dir = integrationRepo();
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-repin-first-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  const factory = {
    id: "factory-repin-first",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
    implementation: { profile: "profile-impl" },
  };
  const entry = { run_id: "11111111-2222-3333-4444-0000000000aa", node_id: "task-demo", project: "demo", attempt: 1 };
  const record = { cwd: dir };

  // The run record EXISTS (a real dispatch always writes one) but carries no
  // impl_ fields at all — the gate pipeline's own opening pin never
  // succeeded, byte-identical to what a dirty/unreadable-tree read leaves
  // behind.
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, { run_id: entry.run_id, node_id: entry.node_id, state: "running" });

  const realDeps = sporCli.makeIntegrationDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });
  let suiteRuns = 0;
  const deps = {
    ...realDeps,
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
    fix: async () => {
      fs.writeFileSync(path.join(dir, "lib", "fix-marker.js"), "module.exports = true;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fix: add the marker the suite requires");
      return { ok: true, runId: "run-fixxxxxx" };
    },
    escalate: async () => ({ ok: true, id: "task-integration-escalate-x" }),
    demote: async () => ({ ok: true, demoted: false }),
    recordFact: async () => ({ ok: true }),
    cleanupImplementer: async () => {},
  };

  const item = { node_id: entry.node_id, run_id: entry.run_id, project: entry.project, attempt: entry.attempt };
  const res = await integrationRunner.runIntegrationStage({ item, factory, deps });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.strictEqual(suiteRuns, 2);

  const fixedHead = git(dir, "rev-parse", "branch").trim();
  const rec = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record);
  assert.ok(rec.impl_candidate, "the first-ever pin still lands, even though it happened at integration-fix rather than implementation");
  assert.strictEqual(rec.impl_candidate.commit, fixedHead);
  assert.strictEqual(rec.impl_run_id, entry.run_id, "impl_run_id is stamped on the FIRST pin, wherever it happens");
  assert.strictEqual(rec.impl_attempt, 1);
  assert.strictEqual(rec.impl_pool, "implementation", "the record-level pool names the implementation run this record represents, not which stage produced the first readable tree");
  assert.ok(rec.impl_state === "candidate" || rec.impl_state === "running", `impl_state must be set, not left undefined: got ${rec.impl_state}`);
});

// The integration twin of the makeGateDeps regression in
// test/candidate.test.js: `pinCandidate` here has the exact same
// `folded.change === "created"` first-pin branch, so it is exposed to the
// exact same late/racing-pin race (issue-spor-pin-candidate-settled-record-
// stamp-race) — a record whose `impl_state` settled through a path that never
// pinned a candidate (two workers adopting one orphaned pipeline; the
// winner's `exhausted` lands via stampImplState directly) reads
// `impl_candidate` as still null, so a late integration-fix re-pin arriving
// afterward would otherwise be read as the first-ever submission and stamp
// impl_run_id/impl_attempt/impl_pool beside the terminal verdict.
test("REGRESSION issue-spor-pin-candidate-settled-record-stamp-race (integration twin): a late first pin arriving after impl_state already settled is refused, not stamped beside the settled verdict", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");

  const dir = integrationRepo();
  git(dir, "checkout", "-q", "branch");
  const targetRef = "main";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-repin-settled-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  const factory = {
    id: "factory-repin-settled",
    integration: { targetRef, mode: "local", command: "true", strategy: "merge", serialize: "repo", cycles: 1, timeoutMs: 900000 },
    trustedRef: targetRef,
    protectedPaths: [],
    implementation: { profile: "profile-impl" },
  };
  const entry = { run_id: "33333333-4444-5555-6666-0000000000bb", node_id: "task-demo", project: "demo", attempt: 1 };
  const record = { cwd: dir };

  // Settled through a path that never pinned a candidate at all.
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "running", impl_state: "exhausted",
  });

  const warnings = [];
  const deps = sporCli.makeIntegrationDeps(cfg, {
    record, entry, factory, slug: "demo", passthrough: {}, warn: (l) => warnings.push(l), sleep: async () => {}, log: () => {}, home,
  });

  const changed = await deps.changedTree();
  assert.strictEqual(changed.ok, true, changed.reason);
  const result = await deps.pinCandidate({ submittedBy: { stage: "integration-fix", cycle: 1, rescue: 0 } });

  assert.strictEqual(result.ok, true, "a refusal here is a no-op, not a pipeline failure");
  assert.strictEqual(result.change, "refused-settled");
  assert.strictEqual(result.candidate, null, "nothing was ever pinned for this record");
  assert.ok(
    warnings.some((w) => /impl_state already settled/.test(w) && /exhausted/.test(w)),
    "the refusal is logged, not silent"
  );

  const rec = dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record);
  assert.strictEqual(rec.impl_state, "exhausted", "the terminal verdict stands untouched");
  assert.strictEqual(rec.impl_run_id, undefined, "no live-run metadata is stamped beside a settled verdict");
  assert.strictEqual(rec.impl_attempt, undefined);
  assert.strictEqual(rec.impl_pool, undefined);
  assert.strictEqual(rec.impl_candidate, undefined, "no candidate is fabricated for a stage that never actually submitted one");
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

  // task-spor-factory-gate-attestation: ONE attestation per run, in the graph
  // and on the run record, binding the gate verdicts to the commit they judged
  // and to the definition that judged them.
  const attests = fs.readdirSync(nodes).filter((f) => f.startsWith("art-attest-"));
  assert.strictEqual(attests.length, 1, `expected one attestation, saw ${fs.readdirSync(nodes)}`);
  const attMd = fs.readFileSync(path.join(nodes, attests[0]), "utf8");
  const att = JSON.parse(attMd.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.strictEqual(att.schema, "spor.attestation/1");
  assert.strictEqual(att.passed, true);
  assert.strictEqual(att.gate.allPassed, true);
  assert.deepStrictEqual(att.gate.steps.map((st) => [st.id, st.verdict]), [["acceptance", "passed"]]);
  assert.match(att.subject.commit, /^[0-9a-f]{40}$/, "the subject is a real commit");
  assert.strictEqual(att.integration.head_matches_gated, true, "the stage landed the head the gate judged");
  assert.strictEqual(att.integration.landed_sha, after, "the landed sha is main's new tip");
  assert.match(att.configIntegrity.factory.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(att.configIntegrity.factory.revision, /^[0-9a-f]{40}$/, "the factory node's revision is stamped");
  assert.match(attMd, new RegExp(`- \\{type: relates-to, to: ${facts[0].replace(/\.md$/, "")}\\}`), "the attestation links the merge fact");
  const gateFacts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-"));
  assert.strictEqual(gateFacts.length, 1);
  assert.match(fs.readFileSync(path.join(nodes, gateFacts[0]), "utf8"), new RegExp(`^gate_head: ${att.subject.commit}$`, "m"), "the gate fact is bound to the same commit");
  const runRecord = require("../lib/shell/agent-dispatch-runner.js").readRunRecords(home).find((r) => r.gate_attestation);
  assert.ok(runRecord, "the run record names its attestation");
  assert.strictEqual(runRecord.gate_attestation, attests[0].replace(/\.md$/, ""));
  assert.strictEqual(runRecord.gate_head, att.subject.commit);
  assert.strictEqual(runRecord.gate_landed_sha, after);
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
  git(dir, "config", "core.autocrlf", "false"); // the checked-out BYTES are compared below; the Windows CI runner's global autocrlf would rewrite them
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

// ---------------------- acquireLocalIntegrationLease / releaseLocalIntegrationLease --
// issue-spor-integration-lease-reclaim-toctou: this lease's local-mode reclaim
// had the exact pre-fix shape dec-spor-local-dispatch-lock-breaker-serialized-
// reclaim closed for the dispatch lock — a plain rm-then-`wx` judge-then-act
// sequence (two racers can both read the same stale content and one can tear
// down the other's brand-new live lock), and an unconditional release (which
// can delete a lock that was reclaimed out from under it). Both are now the
// SAME breaker-lock-serialized-reclaim / ownership-checked-release primitive
// acquireLocalDispatchLock uses; this section is that primitive's own test
// coverage, applied to this call site.
{
  const sporCli = require("../bin/spor.js");
  const { spawn } = require("node:child_process");

  test("acquireLocalIntegrationLease: a second acquire for the same repo is refused while the first is live-held", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const first = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(first && first.kind === "lockfile" && fs.existsSync(first.file));
    // A short wait bound (this process itself is alive, so the lock is never
    // judged stale) — proves the busy branch actually refuses rather than
    // waiting out the real 20s production default.
    const second = await sporCli.acquireLocalIntegrationLease(home, top, { waitMs: 50, pollMs: 5 });
    assert.strictEqual(second, null, "a live holder is waited out, then refused — not reclaimed");
    sporCli.releaseLocalIntegrationLease(first);
    assert.ok(!fs.existsSync(first.file), "release removes the lockfile");
  });

  test("acquireLocalIntegrationLease: releasing frees the repo for a later acquire", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const first = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(first);
    sporCli.releaseLocalIntegrationLease(first);
    const second = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(second, "a released lease can be re-acquired");
    sporCli.releaseLocalIntegrationLease(second);
  });

  test("releaseLocalIntegrationLease: does not delete a lock that was reclaimed out from under it", async () => {
    // A lease this call once won can be evicted later by the staleness
    // ceiling (a holder judged dead/aged-out, whether or not it actually
    // still is, just slow) — release must not blindly remove whatever now
    // sits at the path, or it deletes the NEW holder's live lease instead of
    // this process's own long-gone one.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const first = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(first);
    // Simulate a reclaim: someone else's fresh lease now occupies the same path.
    fs.rmSync(first.file, { force: true });
    fs.writeFileSync(first.file, JSON.stringify({ pid: 999999, started_ticks: null, at: new Date().toISOString() }));
    sporCli.releaseLocalIntegrationLease(first);
    assert.ok(fs.existsSync(first.file), "release must leave the new holder's lease alone — it is not ours to remove");
  });

  test("acquireLocalIntegrationLease: a stale lease (holder pid gone) self-heals and is reclaimed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const file = path.join(home, "journal", "integration-lease", `${sporCli.integrationLeaseKey(top)}.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A pid that (almost certainly) is not alive, with no started_ticks — the
    // same "no stamp: the pid probe is all there is" fallback workerAlive uses.
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, started_ticks: null, at: new Date().toISOString() }));
    const acquired = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(acquired, "a lease held by a dead pid does not block integration forever");
    sporCli.releaseLocalIntegrationLease(acquired);
  });

  test("acquireLocalIntegrationLease: an unreadable lock file cannot be honored as live — reclaimed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const file = path.join(home, "journal", "integration-lease", `${sporCli.integrationLeaseKey(top)}.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json at all");
    const acquired = await sporCli.acquireLocalIntegrationLease(home, top);
    assert.ok(acquired);
    sporCli.releaseLocalIntegrationLease(acquired);
  });

  test("acquireLocalIntegrationLease: an unwritable journal fails open (nothing to release)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const journalDir = path.join(home, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    // Read+execute only, no write — mkdirSync under it (the integration-lease
    // subdir) fails EACCES.
    fs.chmodSync(journalDir, 0o500);
    try {
      const acquired = await sporCli.acquireLocalIntegrationLease(home, top);
      assert.strictEqual(acquired, null, "an unwritable lease dir must not block integration — fails open with nothing to release");
      sporCli.releaseLocalIntegrationLease(acquired); // a no-op; must not throw
    } finally {
      fs.chmodSync(journalDir, 0o700); // restore so the temp-dir cleanup can remove it
    }
  });

  test("acquireLocalIntegrationLease: a genuine (non-EEXIST) failure reclaiming a stale lease fails open immediately, not after the wait bound", async () => {
    // Judging staleness and reclaiming both run under the breaker lock, so
    // getting HERE means judge-as-stale already succeeded and reclaim's own
    // rm+recreate is the thing that fails. A directory sitting at the lock
    // path (instead of the lockfile itself) reproduces exactly that: reading
    // it throws (unreadable -> judged stale), and rmSync on a directory
    // throws ERR_FS_EISDIR regardless of `force` — a genuine, non-EEXIST
    // failure distinct from "an unrelated fresh acquirer already recreated
    // it" (EEXIST). This must fail open right away, same as the top-level
    // attempt's own unwritable-journal case, rather than busy-polling out
    // the full wait bound over a lease that will never become writable.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-top-"));
    const dir = path.join(home, "journal", "integration-lease");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sporCli.integrationLeaseKey(top)}.lock`);
    fs.mkdirSync(file); // occupies the lock path with a directory, not a lockfile
    const start = Date.now();
    const acquired = await sporCli.acquireLocalIntegrationLease(home, top, { waitMs: 5000, pollMs: 50 });
    const elapsed = Date.now() - start;
    assert.strictEqual(acquired, null, "a genuine reclaim failure must not be treated as integration-worth-waiting-for contention");
    assert.ok(elapsed < 2000, `must fail open immediately, not busy-poll out the wait bound (took ${elapsed}ms)`);
  });

  // The unit tests above prove the FUNCTION's logic; this proves the
  // PRIMITIVE holds under real cross-process contention over a genuinely
  // stale lease — two independent OS processes that both read the same
  // stale content and both attempt to reclaim it. Judging staleness and
  // reclaiming are serialized under the shared breaker lock
  // (acquireBreakerLock) so two racers can never both decide the SAME stale
  // content is theirs to act on; a `rename`/`rm`-only eviction alone would
  // not be enough, since it doesn't check WHAT it evicts. Seed the stale
  // lease BEFORE either racer starts so both are guaranteed to take the
  // reclaim branch, then confirm only one of them ends up owning it.
  function raceLeaseScript(home, top, outFile) {
    return `
const fs = require("node:fs");
const cli = require(${JSON.stringify(CLI)});
// A short wait bound: the LOSING racer falls through to the ordinary busy-
// wait loop (the winner's freshly-written lease is live, not stale), and this
// test only cares that reclaim itself is exclusive — not about proving out
// the full 20s production wait bound.
cli.acquireLocalIntegrationLease(${JSON.stringify(home)}, ${JSON.stringify(top)}, { waitMs: 500, pollMs: 20 }).then((result) => {
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ ok: !!result, pid: process.pid }));
  // A winner stays alive for a while instead of exiting the instant it
  // acquires, so a losing racer's own staleness check (which pays the cost of
  // re-requiring this whole CLI module) can't misread a real race as an
  // abandoned lease and reclaim it too — a test artifact, not the hazard
  // this fix closes.
  if (result) setTimeout(() => process.exit(0), 4000);
  else process.exit(0);
});
`;
  }

  test("acquireLocalIntegrationLease: exactly one of two REAL concurrent processes wins RECLAIMING an already-stale lease", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-reclaim-race-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-reclaim-race-top-"));
    const lockFile = path.join(home, "journal", "integration-lease", `${sporCli.integrationLeaseKey(top)}.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, started_ticks: null, at: new Date(0).toISOString() }));
    const outA = path.join(home, "a.result.json");
    const outB = path.join(home, "b.result.json");
    const scriptA = path.join(home, "a.js");
    const scriptB = path.join(home, "b.js");
    fs.writeFileSync(scriptA, raceLeaseScript(home, top, outA));
    fs.writeFileSync(scriptB, raceLeaseScript(home, top, outB));
    await Promise.all([
      new Promise((resolve) => spawn(process.execPath, [scriptA]).on("close", resolve)),
      new Promise((resolve) => spawn(process.execPath, [scriptB]).on("close", resolve)),
    ]);
    const a = JSON.parse(fs.readFileSync(outA, "utf8"));
    const b = JSON.parse(fs.readFileSync(outB, "utf8"));
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    assert.strictEqual(winners.length, 1, "exactly one real process reclaims the stale lease");
    assert.strictEqual(losers.length, 1, "exactly one real process is refused, not both");
  });
}

// ---------- issue-spor-serialize-lease-does-not-wait-out-a-long-suite ----
// The serialize:repo lease was sized for the integration stage's short
// landing pass, not a CPU-bound command gate's own suite: gateLeaseBudgetMs
// sizes wait/staleness/TTL to the GATE's own declared timeout_ms x
// (reruns+1), and both the local staleness ceiling and the remote poll now
// honor that budget instead of a fixed 20s/30min.
{
  const sporCli = require("../bin/spor.js");
  const http = require("node:http");

  test("gateLeaseBudgetMs: sizes to timeout_ms x (reruns+1) plus margin, and falls back on an unset/invalid timeout", () => {
    assert.strictEqual(sporCli.gateLeaseBudgetMs({ timeoutMs: 600000, reruns: 2 }), 600000 * 3 + 5 * 60 * 1000);
    assert.strictEqual(sporCli.gateLeaseBudgetMs({ timeoutMs: 600000, reruns: 0 }), 600000 + 5 * 60 * 1000);
    // No gate at all (a defensive caller) still returns a sane, positive budget.
    const fallback = sporCli.gateLeaseBudgetMs(null);
    assert.ok(Number.isFinite(fallback) && fallback > 0);
  });

  test("makeGateDeps: the REAL acquireGateLease closure threads gateLeaseBudgetMs(gate) through as waitMs and the stamped budgetMs — not a mock", async () => {
    const { loadConfig } = require("../lib/config.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-lease-wiring-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-lease-wiring-top-"));
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
    const item = { node_id: "task-demo", run_id: "run-abcdef12" };
    const gate = { id: "acceptance", timeoutMs: 600000, reruns: 2 };
    const expectedBudget = sporCli.gateLeaseBudgetMs(gate);
    const deps = sporCli.makeGateDeps(cfg, { entry: item, factory: {}, slug: "demo", record: { cwd: top }, home, log: () => {}, warn: () => {} });
    const lease = await deps.acquireGateLease({ gate, item });
    assert.ok(lease && lease.kind === "lockfile", "local mode: the real closure falls back to the lockfile lease");
    const payload = JSON.parse(fs.readFileSync(lease.file, "utf8"));
    assert.strictEqual(payload.budgetMs, expectedBudget, "the closure computed gateLeaseBudgetMs(gate) and stamped it on the lock, not a default");
    await deps.releaseGateLease(lease);
    assert.ok(!fs.existsSync(lease.file), "release actually frees the real lockfile");
  });

  test("acquireLocalIntegrationLease: a holder's declared budgetMs replaces the fixed 30min staleness ceiling", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-budget-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-budget-top-"));
    const file = path.join(home, "journal", "integration-lease", `${sporCli.integrationLeaseKey(top)}.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A dead-pid holder stamped with a 45min budget, aged 40 minutes — well
    // past a fixed 30min ceiling but still inside its OWN declared budget, so
    // a contender must not reclaim it yet.
    const at = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_ticks: null, at, budgetMs: 45 * 60 * 1000 }));
    const stillHeld = await sporCli.acquireLocalIntegrationLease(home, top, { waitMs: 50, pollMs: 5 });
    assert.strictEqual(stillHeld, null, "a live holder inside its own declared budget is waited out, not reclaimed as stale");

    // The SAME age against a SHORTER declared budget (10min) IS stale.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_ticks: null, at, budgetMs: 10 * 60 * 1000 }));
    const reclaimed = await sporCli.acquireLocalIntegrationLease(home, top, { waitMs: 50, pollMs: 5 });
    assert.ok(reclaimed, "a holder past ITS OWN declared budget is reclaimed even though it is still 'alive' by pid");
    sporCli.releaseLocalIntegrationLease(reclaimed);
  });

  test("acquireLocalIntegrationLease: an acquired lease stamps the caller's own budgetMs for the NEXT contender to judge", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-budget-stamp-"));
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "spor-int-lease-budget-stamp-top-"));
    const acquired = await sporCli.acquireLocalIntegrationLease(home, top, { budgetMs: 42000 });
    assert.ok(acquired);
    const raw = fs.readFileSync(acquired.file, "utf8");
    assert.strictEqual(JSON.parse(raw).budgetMs, 42000);
    sporCli.releaseLocalIntegrationLease(acquired);
  });

  // A duck-typed remote cfg — acquireIntegrationLease only ever calls
  // cfg.mode()/server()/token() (via lib/remote.js), never anything else.
  function remoteCfg(base) {
    return { mode: () => "remote", server: () => base, token: () => "test-token", tenant: () => null };
  }

  test("acquireIntegrationLease (remote): waits out a held claim (409) and succeeds once it frees, instead of refusing at once", async () => {
    let claimCalls = 0;
    const extendCalls = [];
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.method === "POST" && req.url === "/v1/nodes") return j(200, { results: [{ ok: true }] });
        if (req.method === "POST" && /\/claim$/.test(req.url)) {
          claimCalls += 1;
          if (claimCalls < 3) return j(409, { error: { code: "already_claimed", message: "held by someone else, expires in 5m" } });
          return j(200, { lease: { node_id: "lock-integration-demo" } });
        }
        if (req.method === "POST" && /\/extend$/.test(req.url)) {
          extendCalls.push(JSON.parse(raw || "{}"));
          return j(200, { ok: true });
        }
        return j(404, { error: { code: "not_found" } });
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const sleeps = [];
      const token = await sporCli.acquireIntegrationLease(remoteCfg(base), "/unused-home", "/unused/top", {
        slug: "demo",
        waitMs: 60000,
        budgetMs: 1800000,
        pollMs: 10,
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      });
      assert.ok(token && token.kind === "remote", "eventually succeeds once the held claim frees, rather than refusing on the first 409");
      assert.strictEqual(claimCalls, 3, "polled the claim door until it freed");
      assert.ok(sleeps.length >= 2, "waited between polls instead of busy-looping");
      assert.strictEqual(extendCalls.length, 1, "stretches the claim's TTL to the caller's own budget once acquired");
      assert.strictEqual(extendCalls[0].ms, 1800000);
    } finally {
      srv.close();
    }
  });

  test("acquireIntegrationLease (remote): a transient extend failure is RETRIED, not silently accepted as the final word", async () => {
    // The TTL stretch is this lease's one chance to outlive a long suite —
    // nothing else re-extends it once the suite is running (issue-spor-
    // serialize-lease-does-not-wait-out-a-long-suite). A claim still lands
    // even if the extend never succeeds (fail-open), but a transient blip on
    // the FIRST attempt must not be the end of the story.
    let extendCalls = 0;
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.method === "POST" && req.url === "/v1/nodes") return j(200, { results: [{ ok: true }] });
        if (req.method === "POST" && /\/claim$/.test(req.url)) return j(200, { lease: { node_id: "lock-integration-demo" } });
        if (req.method === "POST" && /\/extend$/.test(req.url)) {
          extendCalls += 1;
          if (extendCalls < 2) return j(500, { error: { code: "internal" } }); // transient — the retry must recover
          return j(200, { ok: true });
        }
        return j(404, { error: { code: "not_found" } });
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const sleeps = [];
      const token = await sporCli.acquireIntegrationLease(remoteCfg(base), "/unused-home", "/unused/top", {
        slug: "demo",
        budgetMs: 1800000,
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      });
      assert.ok(token && token.kind === "remote");
      assert.strictEqual(extendCalls, 2, "a failed extend attempt is retried at least once before giving up");
      assert.ok(sleeps.length >= 1, "backs off between retries rather than hammering the server");
    } finally {
      srv.close();
    }
  });

  test("acquireIntegrationLease (remote): an extend that fails EVERY attempt still fails open — the claim itself is not undone", async () => {
    let extendCalls = 0;
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.method === "POST" && req.url === "/v1/nodes") return j(200, { results: [{ ok: true }] });
        if (req.method === "POST" && /\/claim$/.test(req.url)) return j(200, { lease: { node_id: "lock-integration-demo" } });
        if (req.method === "POST" && /\/extend$/.test(req.url)) {
          extendCalls += 1;
          return j(500, { error: { code: "internal" } });
        }
        return j(404, { error: { code: "not_found" } });
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const token = await sporCli.acquireIntegrationLease(remoteCfg(base), "/unused-home", "/unused/top", {
        slug: "demo",
        budgetMs: 1800000,
        sleep: () => Promise.resolve(),
      });
      assert.ok(token && token.kind === "remote", "the claim itself still lands even though the TTL stretch never did — fail-open, not fail-closed");
      assert.ok(extendCalls >= 2, "retried more than once before giving up");
    } finally {
      srv.close();
    }
  });

  test("acquireIntegrationLease (remote): gives up at the wait bound if the claim never frees — fails open, never blocks integration forever", async () => {
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.method === "POST" && req.url === "/v1/nodes") return j(200, { results: [{ ok: true }] });
        if (req.method === "POST" && /\/claim$/.test(req.url)) return j(409, { error: { code: "already_claimed", message: "held" } });
        return j(404, { error: { code: "not_found" } });
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      let sleepCount = 0;
      const start = Date.now();
      const token = await sporCli.acquireIntegrationLease(remoteCfg(base), "/unused-home", "/unused/top", {
        slug: "demo",
        waitMs: 500,
        pollMs: 5,
        sleep: (ms) => { sleepCount += 1; return Promise.resolve(); },
      });
      const elapsed = Date.now() - start;
      assert.strictEqual(token, null, "a claim that never frees within the wait bound fails open — never blocks integration forever");
      assert.ok(sleepCount >= 1, "polled at least once before giving up");
      assert.ok(elapsed < 5000, `must give up at the wait bound, not run indefinitely (took ${elapsed}ms)`);
    } finally {
      srv.close();
    }
  });

  test("acquireIntegrationLease (remote): a non-conflict failure (transport/5xx) is never worth waiting out", async () => {
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.method === "POST" && req.url === "/v1/nodes") return j(200, { results: [{ ok: true }] });
        if (req.method === "POST" && /\/claim$/.test(req.url)) return j(500, { error: { code: "internal" } });
        return j(404, { error: { code: "not_found" } });
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      let sleepCount = 0;
      const start = Date.now();
      const token = await sporCli.acquireIntegrationLease(remoteCfg(base), "/unused-home", "/unused/top", {
        slug: "demo",
        waitMs: 60000,
        pollMs: 10,
        sleep: (ms) => { sleepCount += 1; return Promise.resolve(); },
      });
      assert.strictEqual(token, null);
      assert.strictEqual(sleepCount, 0, "a non-conflict failure returns immediately rather than polling out the wait bound");
      assert.ok(Date.now() - start < 2000);
    } finally {
      srv.close();
    }
  });
}

// ---------------------------------------------- re-gating a moved head (task-spor-factory-gate-attestation, review finding 2) --
// The entry check refuses a head the gates never judged; the SAME rule must
// hold after the stage's OWN fix cycle commits new work. The moved head is
// handed back to the gate pipeline through `deps.regate`, and only a pass at
// exactly that head lets the stage go on to land it.
test("a fix cycle that moves the head is RE-GATED before the retried candidate can land — a pass at the moved head advances gated_head", async () => {
  const heads = ["head-v1", "head-v2"];
  let reads = 0;
  const regates = [];
  const { deps, seen } = integrationFakes({
    build: (args) => (args.head === "head-v1" ? { ok: false, conflict: true, reason: "merging onto main conflicts" } : { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" }),
  });
  deps.changedTree = async () => ({ ok: true, top: "/repo", head: heads[Math.min(reads++, heads.length - 1)], cwd: "/repo/wt" });
  deps.regate = async (args) => {
    regates.push(args);
    return { state: "passed", head: args.head, gates: [], facts: ["art-gate-review-regated"] };
  };
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.strictEqual(res.state, "passed", res.reason);
  assert.deepStrictEqual(regates.map((r) => [r.head, r.gatedHead]), [["head-v2", "head-v1"]], "the moved head was re-gated once, against the head the gates had judged");
  assert.strictEqual(res.gated_head, "head-v2", "the pass at the moved head is what the landing is now bound to");
  assert.strictEqual(res.head_matches_gated, true);
  assert.strictEqual(seen.lands, 1);
  assert.strictEqual(seen.fixes.length, 1);
  const fact = seen.facts[seen.facts.length - 1].markdown;
  assert.match(fact, /Integrated commit: `head-v2` \(the head the gates judged\)/, "the merge fact names the RE-GATED head as the judged one");
});

test("a re-gate that FAILS at the moved head settles the stage failed — nothing lands, and the re-gate's own escalation stands in for the stage's", async () => {
  const heads = ["head-v1", "head-v2"];
  let reads = 0;
  const { deps, seen } = integrationFakes({ build: [{ ok: false, conflict: true, reason: "merging onto main conflicts" }, { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" }] });
  deps.changedTree = async () => ({ ok: true, top: "/repo", head: heads[Math.min(reads++, heads.length - 1)], cwd: "/repo/wt" });
  deps.regate = async () => ({ state: "failed", reason: "gate 'review' failed: still broken", head: "head-v2", escalated_to: "task-gate-review" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /re-gating that head failed — gate 'review' failed: still broken/);
  assert.strictEqual(seen.lands, 0, "an un-gated head never lands");
  assert.strictEqual(seen.builds, 1, "no second candidate is built for a head nothing passed");
  assert.strictEqual(seen.escalations.length, 0, "the re-gate already filed the person's item — no second escalation");
  assert.strictEqual(res.escalated_to, "task-gate-review");
  assert.strictEqual(res.gated_head, "head-v1", "gated_head never advanced to a head that did not pass");
  assert.strictEqual(res.head_matches_gated, false);
});

test("a re-gate that passes at a DIFFERENT head than the moved one is not a pass for the moved head", async () => {
  const heads = ["head-v1", "head-v2"];
  let reads = 0;
  const { deps, seen } = integrationFakes({ build: [{ ok: false, conflict: true, reason: "conflicts" }, { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" }] });
  deps.changedTree = async () => ({ ok: true, top: "/repo", head: heads[Math.min(reads++, heads.length - 1)], cwd: "/repo/wt" });
  deps.regate = async () => ({ state: "passed", head: "head-v3", gates: [], facts: [] });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /the re-gate judged `head-v3`, not the moved one/);
  assert.strictEqual(seen.lands, 0);
});

test("with no re-gate door wired, a moved head fails the stage closed rather than landing un-gated", async () => {
  const heads = ["head-v1", "head-v2"];
  let reads = 0;
  const { deps, seen } = integrationFakes({ build: [{ ok: false, conflict: true, reason: "conflicts" }, { ok: true, dir: "/tmp/candidate", sha: "candidatesha", expectedSha: "expected2" }] });
  deps.changedTree = async () => ({ ok: true, top: "/repo", head: heads[Math.min(reads++, heads.length - 1)], cwd: "/repo/wt" });
  const res = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps, gatedHead: "head-v1" });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /no way to re-gate the moved head/);
  assert.strictEqual(seen.lands, 0);
  assert.strictEqual(seen.escalations.length, 1, "the stage files the person's item itself here");
});

// The bin/spor.js wiring: runGateAndIntegration hands the stage a `regate`
// that re-runs the REAL pipeline, and the attestation/result carry the
// pipeline's verdict AS IT STANDS after the re-gate — plus the run record is
// SETTLED before the attestation node exists (review finding 5).
test("runGateAndIntegration settles the run record BEFORE writing the attestation, and the attestation names the settled verdict", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-settle-first-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-settle.md"), "---\nid: task-settle\ntype: task\ntitle: Settle first\nsummary: A work item whose gate pipeline must settle its run record before any attestation is written.\nstatus: done\ndate: 2026-08-26\n---\n\nBody.\n");
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const repo = integrationRepo();
  git(repo, "checkout", "-q", "branch");
  const entry = { node_id: "task-settle", run_id: "11111111-2222-3333-4444-000000000077", attempt: 0 };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, { run_id: entry.run_id, node_id: entry.node_id, state: "done", cwd: repo, created_at: new Date().toISOString() });
  const factory = {
    id: "factory-settle", trustedRef: "main", protectedPaths: [], riskClasses: {}, testLaneProfile: null, integration: null,
    gates: [{ id: "acceptance", kind: "command", command: "true", timeoutMs: 60000, cycles: 0, source: "inline", risk: [] }],
    definition: { factory: { id: "factory-settle", revision: null, digest: "sha256:0000" }, gates: [{ id: "acceptance", source: "inline", revision: null, digest: "sha256:1111" }] },
  };
  // Observe the ORDER: the moment the attestation file appears, what does the
  // run record say? A watcher on the nodes dir reads the record on creation.
  const seenAtWrite = [];
  const origWrite = fs.writeFileSync;
  const recordPath = dispatchRuns.runPaths(home, entry.run_id).record;
  fs.writeFileSync = function (file, ...rest) {
    if (typeof file === "string" && path.basename(file).startsWith("art-attest-")) {
      seenAtWrite.push(JSON.parse(origWrite === fs.writeFileSync ? "{}" : fs.readFileSync(recordPath, "utf8")).gate_state || null);
    }
    return origWrite.call(fs, file, ...rest);
  };
  let res;
  try {
    res = await sporCli.runGateAndIntegration(cfg, entry, { cwd: repo, run_id: entry.run_id }, {
      factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home, stopping: () => false,
    });
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.strictEqual(res.state, "passed", res.reason);
  assert.ok(res.attestation, "an attestation was written");
  assert.ok(seenAtWrite.length >= 1, "the attestation node was written through the observed door");
  assert.ok(seenAtWrite.every((st) => st === "passed"), `the run record already read the settled verdict when the attestation node was written (saw ${JSON.stringify(seenAtWrite)})`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.strictEqual(record.gate_state, "passed");
  assert.strictEqual(record.gate_attestation, res.attestation);
  assert.strictEqual(record.gate_head, res.head);
  const md = fs.readFileSync(path.join(nodes, `${res.attestation}.md`), "utf8");
  const att = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(md)[1]);
  assert.strictEqual(att.passed, true);
  assert.strictEqual(att.subject.commit, git(repo, "rev-parse", "HEAD").trim());
});

// Cross-model review, blocking findings 1 and 2: a duplicate pipeline for the
// SAME run (a resumed orphan, a second adopter) must not reach the graph at
// all — not an attestation, not a fact, not an escalation or a demotion — nor
// overwrite the winner's evidence fields on the record. The ownership claim is
// taken BEFORE the first gate runs, so a record another worker already
// settled refuses the pipeline outright: nothing of this worker's reaches the
// record or the graph, and the caller is handed the record's verdict.
test("runGateAndIntegration: a record another pipeline settled refuses the pipeline before it runs — no fact, no attestation, no evidence field", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-settle-race-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-race.md"), "---\nid: task-race\ntype: task\ntitle: Settle race\nsummary: A work item whose run record another pipeline settled first, so this pipeline must not attest over it.\nstatus: done\ndate: 2026-08-26\n---\n\nBody.\n");
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const repo = integrationRepo();
  git(repo, "checkout", "-q", "branch");
  const entry = { node_id: "task-race", run_id: "11111111-2222-3333-4444-000000000088", attempt: 0 };
  const recordPath = dispatchRuns.runPaths(home, entry.run_id).record;
  const winner = {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", cwd: repo, created_at: new Date().toISOString(),
    gate_state: "failed", gate_at: "2026-09-02T10:00:00.000Z", gate_worker: "other-worker", gate_reason: "gate 'acceptance' failed",
    gate_head: "winnerhead00000000000000000000000000000001", gate_attestation: "art-attest-race-11111111-deadbeef",
  };
  dispatchRuns.atomicJson(recordPath, winner);
  const factory = {
    id: "factory-race", trustedRef: "main", protectedPaths: [], riskClasses: {}, testLaneProfile: null, integration: null,
    gates: [{ id: "acceptance", kind: "command", command: "true", timeoutMs: 60000, cycles: 0, source: "inline", risk: [] }],
    definition: { factory: { id: "factory-race", revision: null, digest: "sha256:0000" }, gates: [{ id: "acceptance", source: "inline", revision: null, digest: "sha256:1111" }] },
  };
  const logs = [];
  const res = await sporCli.runGateAndIntegration(cfg, entry, { cwd: repo, run_id: entry.run_id }, {
    factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: (m) => logs.push(m), home, stopping: () => false,
  });
  assert.strictEqual(res.state, "failed", "the caller is handed the RECORD's verdict, not one this pipeline never produced");
  assert.strictEqual(res.not_run, true);
  assert.strictEqual(res.attestation, null);
  assert.strictEqual(res.superseded, true);
  assert.strictEqual(res.settled.worker, "other-worker");
  assert.strictEqual(res.settled.head, winner.gate_head);
  assert.ok(logs.some((m) => /already settled as 'failed' by other-worker/.test(m) && /does not run the gate pipeline/.test(m)), `the refusal is logged: ${logs.join(" | ")}`);
  const after = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  for (const k of Object.keys(winner)) assert.strictEqual(after[k], winner[k], `${k} is the winner's, untouched`);
  assert.ok(!Object.keys(after).some((k) => /^gate_(base|trusted_sha|factory_digest|settle_id)$/.test(k)), "none of this pipeline's fields landed");
  // NOTHING reached the graph: no attestation, and no gate fact either — a
  // pipeline that never ran judged nothing.
  assert.deepStrictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-")), [], "no artifact of any kind on the graph");
});

// The other half of finding 2: a record a LIVE worker is gating right now is
// refused too (two adopters of one orphan, work-loop.js's read/publish race),
// while a DEAD owner's record is taken over — that is orphan resumption — and
// the taker's token replaces the corpse's, so the settle lands under its own.
test("runGateAndIntegration: a record a live worker holds is refused before anything runs; a dead owner's is taken over", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-claim-race-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-claim.md"), "---\nid: task-claim\ntype: task\ntitle: Claim race\nsummary: A work item whose run record another worker is gating, so a second pipeline must refuse before it runs anything.\nstatus: done\ndate: 2026-08-26\n---\n\nBody.\n");
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const repo = integrationRepo();
  git(repo, "checkout", "-q", "branch");
  const entry = { node_id: "task-claim", run_id: "11111111-2222-3333-4444-000000000089", attempt: 0 };
  const recordPath = dispatchRuns.runPaths(home, entry.run_id).record;
  const held = { run_id: entry.run_id, node_id: entry.node_id, state: "done", cwd: repo, created_at: new Date().toISOString(), gate_state: "running", gate_at: "2026-09-02T10:00:00.000Z", gate_worker: "other-worker", gate_settle_id: "othertoken00000000000000" };
  dispatchRuns.atomicJson(recordPath, held);
  const factory = {
    id: "factory-claim", trustedRef: "main", protectedPaths: [], riskClasses: {}, testLaneProfile: null, integration: null,
    gates: [{ id: "acceptance", kind: "command", command: "true", timeoutMs: 60000, cycles: 0, source: "inline", risk: [] }],
    definition: { factory: { id: "factory-claim", revision: null, digest: "sha256:0000" }, gates: [{ id: "acceptance", source: "inline", revision: null, digest: "sha256:1111" }] },
  };
  const base = { factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, home, stopping: () => false, workerId: "this-worker" };
  // Alive: refused, untouched, nothing on the graph.
  const logs = [];
  const refused = await sporCli.runGateAndIntegration(cfg, entry, { cwd: repo, run_id: entry.run_id }, { ...base, log: (m) => logs.push(m), ownerLive: (w) => w === "other-worker" });
  assert.strictEqual(refused.not_run, true);
  assert.strictEqual(refused.superseded, true);
  assert.strictEqual(refused.state, "running", "the record's own state is what the caller is handed");
  assert.ok(logs.some((m) => /being gated right now by worker other-worker/.test(m)), logs.join(" | "));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")), held, "the live owner's record is byte-for-byte untouched");
  assert.deepStrictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-")), []);
  // Dead: taken over — the pipeline runs, settles under ITS token, and the corpse's is gone.
  const taken = await sporCli.runGateAndIntegration(cfg, entry, { cwd: repo, run_id: entry.run_id }, { ...base, log: () => {}, ownerLive: () => false });
  assert.strictEqual(taken.state, "passed", taken.reason);
  assert.ok(!taken.superseded);
  assert.ok(taken.attestation, "the taker attests");
  const after = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.strictEqual(after.gate_state, "passed");
  assert.strictEqual(after.gate_worker, "this-worker");
  assert.notStrictEqual(after.gate_settle_id, held.gate_settle_id, "the ownership nonce is the taker's");
  assert.strictEqual(after.gate_attestation, taken.attestation);
  assert.ok(fs.readdirSync(nodes).some((f) => f.startsWith("art-gate-")));
  // A settle whose ownership was re-opened underneath it (a --regate between
  // the claim and the settle) does NOT land: the record is not the settler's.
  const rerun = { run_id: entry.run_id, node_id: entry.node_id, state: "done", cwd: repo, created_at: new Date().toISOString(), gate_state: "running", gate_settle_id: null, gate_worker: null };
  dispatchRuns.atomicJson(recordPath, rerun);
  const claim = dispatchRuns.claimGateRecord(home, entry.run_id, { workerId: "this-worker" });
  assert.strictEqual(claim.ok, true);
  dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "running", gate_settle_id: null, gate_worker: null }, { force: true }); // the re-gate re-opens it
  const stamped = dispatchRuns.stampGateState(home, entry.run_id, { gate_state: "passed", gate_settle_id: claim.token, gate_worker: "this-worker" }, { own: claim.token });
  assert.notStrictEqual(stamped.gate_settle_id, claim.token, "the stale owner's settle is refused");
  assert.strictEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")).gate_state, "running");
});

// The mirror: the SETTLER's own evidence stamp goes through stampGateState's
// `own` door — it lands only while the record's gate_at is the settler's, and
// is refused (record returned unchanged) once another writer's verdict is on
// the file. `force` remains --regate's door alone.
test("stampGateState `own`: lands only on the record whose gate_at is the caller's, never over another settler's", () => {
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-own-stamp-"));
  const runId = "11111111-2222-3333-4444-000000000099";
  const file = dispatchRuns.runPaths(home, runId).record;
  dispatchRuns.atomicJson(file, { run_id: runId, node_id: "task-x", state: "done", gate_state: "passed", gate_at: "2026-09-02T10:00:00.000Z" });
  const mine = dispatchRuns.stampGateState(home, runId, { gate_attestation: "art-attest-mine" }, { own: "2026-09-02T10:00:00.000Z" });
  assert.strictEqual(mine.gate_attestation, "art-attest-mine");
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).gate_attestation, "art-attest-mine");
  const theirs = dispatchRuns.stampGateState(home, runId, { gate_attestation: "art-attest-theirs", gate_head: "h2" }, { own: "2026-09-02T11:11:11.000Z" });
  assert.strictEqual(theirs.gate_attestation, "art-attest-mine", "the record comes back unchanged");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(after.gate_attestation, "art-attest-mine");
  assert.strictEqual(after.gate_head, undefined);
});

// Propose mode's post-settle refresh: the PR body written at propose time
// predates the graph artifact it must be bound to, so once the run settles the
// PR is refreshed with the FINAL, digest-bound copy — and a refresh that fails
// is logged loudly and stamped stale on the record (never "success").
test("refreshProposalAttestation: the PR body is replaced with the bound attestation; a failed refresh is stamped stale, not swallowed", async () => {
  const sporCli = require("../bin/spor.js");
  const attestation = require("../lib/shell/attestation.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-refresh-"));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const runId = "11111111-2222-3333-4444-000000000066";
  const item = { node_id: "task-refresh", run_id: runId, attempt: 0, project: "demo" };
  const factory = { id: "factory-p", trustedRef: "main", integration: { targetRef: "origin/main", mode: "propose", strategy: "merge", command: "npm test" }, definition: { factory: { id: "factory-p", revision: null, digest: "sha256:0000" }, gates: [] } };
  const settledAt = "2026-09-02T12:00:00.000Z";
  const file = dispatchRuns.runPaths(home, runId).record;
  dispatchRuns.atomicJson(file, { run_id: runId, node_id: item.node_id, state: "done", gate_state: "parked", gate_at: settledAt, gate_proposal_number: 7 });
  const intResult = { state: "parked", mode: "propose", head: "h1", gated_head: "h1", proposal: { number: 7, url: "https://github.com/demo/repo/pull/7", repo: "demo/repo", branch: "task-refresh" } };
  const att = attestation.buildAttestationObject({ item, factory, gate: { state: "passed", gates: [], facts: [], head: "h1" }, integration: intResult, signing: { key: "k", keyId: "ci" } });
  const edits = [];
  const logs = [];
  const ok = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, log: (m) => logs.push(m), settleToken: settledAt, cwd: null, editBody: (a) => { edits.push(a); return { ok: true }; } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual([edits[0].repo, edits[0].number], ["demo/repo", 7]);
  const back = attestation.extractPrAttestation(edits[0].body);
  assert.strictEqual(back.id, att.id);
  assert.strictEqual(back.digest, att.digest, "the PR now carries the graph artifact's own bound copy");
  assert.deepStrictEqual(back.signature, att.signature);
  assert.match(edits[0].body, /onto `main`/, "the base is the branch half of the remote ref");
  let rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.gate_proposal_attestation, att.id);
  assert.strictEqual(rec.gate_proposal_attestation_stale, false);
  assert.ok(logs.some((m) => /PR #7 now carries the bound attestation/.test(m)));

  const bad = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, log: (m) => logs.push(m), settleToken: settledAt, editBody: () => ({ ok: false, reason: "gh: HTTP 502" }) });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "gh: HTTP 502");
  rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.gate_proposal_attestation_stale, true, "a failed refresh is on the record");
  assert.strictEqual(rec.gate_proposal_attestation_error, "gh: HTTP 502");
  assert.ok(logs.some((m) => /could NOT be refreshed/.test(m) && /validator will refuse/.test(m)));
  // A throwing editor is the same failure, not a crash.
  const thrown = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, settleToken: settledAt, editBody: () => { throw new Error("boom"); } });
  assert.deepStrictEqual(thrown, { ok: false, reason: "boom" });
  // And the stamp is own-guarded: another settler's record is never touched.
  dispatchRuns.atomicJson(file, { run_id: runId, node_id: item.node_id, state: "done", gate_state: "failed", gate_at: "2026-09-02T13:00:00.000Z" });
  await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, settleToken: settledAt, editBody: () => ({ ok: true }) });
  rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.gate_proposal_attestation, undefined);
});

// The validator's CLI: `spor attestation verify` against a scratch graph
// holding the runner-written artifact — the copy on the PR must match it.
test("spor attestation verify: binds a PR body to the graph artifact, verifies the key, and refuses a tampered or foreign copy", () => {
  const attestation = require("../lib/shell/attestation.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-verify-cli-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const item = { node_id: "task-verify", run_id: "11111111-2222-3333-4444-000000000055", attempt: 0, project: "demo" };
  const factory = { id: "factory-v", trustedRef: "main", integration: null, protectedPaths: [], gates: [{ id: "acceptance", kind: "command", command: "npm test" }], definition: { factory: { id: "factory-v", revision: "r1", digest: "sha256:abcd" }, gates: [{ id: "acceptance", source: "inline", revision: "r1", digest: "sha256:ef01" }] } };
  const gate = { state: "passed", head: "c0ffee00", base: "b", trusted_ref: "main", trusted_sha: "t", branch: "task-verify", definition: factory.definition, facts: [], gates: [{ gate: "acceptance", kind: "command", verdict: "passed", head: "c0ffee00", base: "b", digest: "sha256:ef01", revision: "r1", fact: null }] };
  const node = attestation.buildAttestationNode({ item, factory, gate, signing: { key: "team-key", keyId: "ci" } });
  fs.writeFileSync(path.join(nodes, `${node.id}.md`), node.markdown);
  const prBody = attestation.renderPrBody({ attestation: node.attestation, branch: "task-verify", base: "main" });
  const prFile = path.join(home, "pr.md");
  fs.writeFileSync(prFile, `Reviewer prose.\n\n${prBody}`);
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ATTESTATION_KEY: "team-key" };

  const good = cli(["attestation", "verify", "--pr-body", prFile, "--commit", "c0ffee00", "--max-age", "24h", "--factory-digest", "sha256:abcd", "--require-signature"], env);
  assert.strictEqual(good.status, 0, good.stderr + good.stdout);
  assert.match(good.stdout, /ok {4}trusted {3}bound to graph artifact art-attest-/);
  assert.match(good.stdout, /ok {4}signature hmac-sha256 by key 'ci'/);
  assert.match(good.stdout, /verified$/m);
  const asJson = JSON.parse(cli(["attestation", "verify", "--pr-body", prFile, "--json"], env).stdout);
  assert.strictEqual(asJson.ok, true);
  assert.strictEqual(asJson.id, node.id);

  // Tampered PR body: the author flips the commit. Digest, signature and the
  // graph binding all refuse; exit 1.
  const forged = JSON.parse(JSON.stringify(node.attestation));
  forged.subject.commit = "attacker1";
  fs.writeFileSync(path.join(home, "forged.md"), attestation.renderPrBody({ attestation: forged, branch: "task-verify", base: "main" }));
  const bad = cli(["attestation", "verify", "--pr-body", path.join(home, "forged.md"), "--commit", "attacker1"], env);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /FAIL {2}digest/);
  assert.match(bad.stdout, /FAIL {2}signature/);
  assert.match(bad.stdout, /REFUSED/);
  // Re-bound by the attacker (digest recomputed): the graph copy still disagrees, and it is unsigned.
  fs.writeFileSync(path.join(home, "rebound.md"), attestation.renderPrBody({ attestation: attestation.bindAttestation(JSON.parse(JSON.stringify(forged))), branch: "b", base: "main" }));
  const rebound = cli(["attestation", "verify", "--pr-body", path.join(home, "rebound.md"), "--commit", "attacker1"], env);
  assert.strictEqual(rebound.status, 1);
  assert.match(rebound.stdout, /ok {4}digest/);
  assert.match(rebound.stdout, /FAIL {2}signature .*unsigned/);
  assert.match(rebound.stdout, /FAIL {2}trusted .*carries digest/);
  // Without the key on this box the signature is not checked — but the graph binding still refuses the forgery.
  const noKey = cli(["attestation", "verify", "--pr-body", path.join(home, "rebound.md")], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(noKey.status, 1);
  assert.match(noKey.stdout, /FAIL {2}trusted/);
  assert.doesNotMatch(noKey.stdout, /signature/);
  // A copy naming an artifact the graph does not hold fails closed; --no-graph is the only way past, and it says so.
  const orphan = JSON.parse(JSON.stringify(node.attestation));
  orphan.id = "art-attest-nowhere-runabcde-00000000";
  attestation.bindAttestation(orphan, { key: "team-key", keyId: "ci" });
  fs.writeFileSync(path.join(home, "orphan.json"), JSON.stringify(orphan));
  const missing = cli(["attestation", "verify", "--file", path.join(home, "orphan.json")], env);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stdout, /FAIL {2}trusted .*could not be read/);
  const skipped = cli(["attestation", "verify", "--file", path.join(home, "orphan.json"), "--no-graph"], env);
  assert.strictEqual(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /ok {4}signature hmac-sha256 by key 'ci'/, "--no-graph passes only on a VERIFIED signature");
  // ...and with no key on this box, --no-graph has no anchor left: refused,
  // never passed on the self-authored digest (cross-model review, blocking finding 1).
  const anchorless = cli(["attestation", "verify", "--file", path.join(home, "orphan.json"), "--no-graph"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(anchorless.status, 1, anchorless.stdout);
  assert.match(anchorless.stdout, /FAIL {2}signature .*verification key is required/);
  assert.match(anchorless.stdout, /REFUSED/);
  // An unsigned copy under --no-graph is refused even where the key IS configured.
  const unsignedCopy = JSON.parse(JSON.stringify(orphan));
  attestation.bindAttestation(unsignedCopy);
  fs.writeFileSync(path.join(home, "unsigned.json"), JSON.stringify(unsignedCopy));
  const unsignedNoGraph = cli(["attestation", "verify", "--file", path.join(home, "unsigned.json"), "--no-graph"], env);
  assert.strictEqual(unsignedNoGraph.status, 1);
  assert.match(unsignedNoGraph.stdout, /FAIL {2}signature .*unsigned/);
  // Stale, wrong commit, wrong factory digest, unreadable input, bad duration.
  assert.strictEqual(cli(["attestation", "verify", "--pr-body", prFile, "--max-age", "1ms"], env).status, 1);
  assert.match(cli(["attestation", "verify", "--pr-body", prFile, "--commit", "other"], env).stdout, /FAIL {2}commit/);
  assert.match(cli(["attestation", "verify", "--pr-body", prFile, "--factory-digest", "sha256:9999"], env).stdout, /FAIL {2}config/);
  fs.writeFileSync(path.join(home, "prose.md"), "no attestation here");
  assert.match(cli(["attestation", "verify", "--pr-body", path.join(home, "prose.md")], env).stdout, /FAIL {2}schema/);
  assert.match(cli(["attestation", "verify", "--pr-body", prFile, "--max-age", "soon"], env).stderr, /not a duration/);
  assert.match(cli(["attestation", "verify"], env).stderr, /usage: spor attestation verify/);
  assert.match(cli(["attestation", "frobnicate"], env).stderr, /usage: spor attestation verify/);
});

// The REMOTE door: `if_exists: skip` reports the id existed, not that this
// fact landed. The node is read back and compared; a different fact under the
// same id is a collision to refuse, never evidence to adopt.
test("writeGateNode (remote): a skipped write is compared against the existing node — same fact adopts, different fact refuses", async () => {
  const http = require("node:http");
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const stored = new Map();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.method === "POST" && req.url === "/v1/nodes") {
        const node = JSON.parse(body).nodes[0].node;
        const id = /^id: (.+)$/m.exec(node)[1];
        if (stored.has(id)) return j(200, { results: [{ status: "skipped", id }] });
        // The server stamps what it stamps on write.
        stored.set(id, node.replace(/^date: (.+)$/m, "date: 2026-09-01\nauthor: Someone Else <else@example.com>\nauthored_via: rest"));
        return j(200, { results: [{ status: "created", id }] });
      }
      const m = /^\/v1\/nodes\/([^/?]+)$/.exec(req.url);
      if (req.method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        return stored.has(id) ? j(200, { id, raw: stored.get(id) }) : j(404, { error: { code: "not_found" } });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-remote-skip-"));
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${srv.address().port}`, SPOR_TOKEN: "t" } });
    const node = (summary, date = "2026-08-26") => `---\nid: art-gate-demo-z-abcdef12\ntype: artifact\ntitle: Gate demo\nsummary: ${summary}\ndate: ${date}\ngate_head: abc123\nedges:\n  - {type: relates-to, to: task-demo}\n---\n\nThe demo gate passed.\n`;
    const first = await sporCli.writeGateNode(cfg, "art-gate-demo-z-abcdef12", node("The demo gate passed on the change under judgement."));
    assert.deepStrictEqual(first, { ok: true, id: "art-gate-demo-z-abcdef12" });
    const again = await sporCli.writeGateNode(cfg, "art-gate-demo-z-abcdef12", node("The demo gate passed on the change under judgement.", "2026-08-27"));
    assert.strictEqual(again.ok, true, `the same fact (modulo the server's own stamps and the day) is this write landing: ${again.reason}`);
    assert.strictEqual(again.existing, true);
    const other = await sporCli.writeGateNode(cfg, "art-gate-demo-z-abcdef12", node("The demo gate FAILED on the change under judgement."));
    assert.strictEqual(other.ok, false);
    assert.match(other.reason, /already exists with different content/);
  } finally {
    srv.close();
  }
});

// -- major finding 3 (cross-model review): the candidate-suite evidence rides
// on the SETTLED integration result in every mode — the run's final,
// graph-bound attestation is built from that result, not from the chain handed
// to the PR opener at propose time.
test("the settled integration result carries the candidate evidence in propose AND landing modes — the final attestation never loses it", async () => {
  const propose = { ...FACTORY, integration: { ...FACTORY.integration, mode: "propose" } };
  const { deps } = integrationFakes({
    propose: () => ({ ok: true, number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: "task-demo", targetRef: "main", detail: "opened PR #42" }),
  });
  const parked = await integrationRunner.runIntegrationStage({ item: ITEM, factory: propose, deps, gatedHead: "headsha" });
  assert.strictEqual(parked.state, "parked");
  assert.deepStrictEqual(parked.candidate, { base: "expected1", sha: "candidatesha", suite: "passed", command: "npm test", trusted_sha: null });
  assert.strictEqual(parked.target_sha, "expected1");
  const attestation = require("../lib/shell/attestation.js");
  const gate = { state: "passed", gates: [{ gate: "acceptance", kind: "command", verdict: "passed", head: "headsha" }], facts: [], head: "headsha", definition: propose.definition };
  const att = attestation.buildAttestationObject({ item: ITEM, factory: propose, gate, integration: parked });
  assert.deepStrictEqual(att.integration.candidate, parked.candidate);
  assert.deepStrictEqual(attestation.attestationCore(att).integration.candidate, parked.candidate, "and it is inside the bound core");

  const { deps: landDeps } = integrationFakes({});
  const landed = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps: landDeps, gatedHead: "headsha" });
  assert.strictEqual(landed.state, "passed");
  assert.deepStrictEqual(landed.candidate, { base: "expected1", sha: "candidatesha", suite: "passed", command: "npm test", trusted_sha: null });

  // A candidate suite that FAILED is recorded as such on the settled result.
  const { deps: badDeps } = integrationFakes({ suite: () => ({ ok: false, reason: "npm test exited 1", output: "1 failing" }) });
  const failed = await integrationRunner.runIntegrationStage({ item: ITEM, factory: FACTORY, deps: badDeps, gatedHead: "headsha" });
  assert.strictEqual(failed.state, "failed");
  assert.strictEqual(failed.candidate && failed.candidate.suite, "failed");
});

// -- major finding 5 (cross-model review): a PR that cannot carry its
// attestation is not opened — the attestation-bearing body IS the contract a
// PR-policy repo's CI validates, so building it failing is a failed proposal.
test("propose mode refuses to open a PR without its attestation body: a body that cannot be built is a failed proposal, never a generic PR", async () => {
  const sporCli = require("../bin/spor.js");
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-body-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const entry = { node_id: "task-no-body", run_id: "11111111-2222-3333-4444-000000000009" };
  const factory = { id: "factory-demo", integration: { targetRef: "main", mode: "propose", strategy: "merge" } };
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, entry.run_id).record, {
    run_id: entry.run_id, node_id: entry.node_id, state: "done", terminal_state: "resolved", terminal_enforced: true,
  });
  const opened = [];
  const logs = [];
  const deps = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: (l) => logs.push(l), home,
    buildProposalBody: () => { throw new Error("no definition digest"); },
    proposeIntegrationPR: (args) => { opened.push(args); return { ok: true, number: 1 }; },
  });
  const refused = await deps.propose({ head: "abc123", targetRef: "main", chain: null });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /attestation for the pull request body could not be built \(no definition digest\)/);
  assert.match(refused.reason, /no PR was opened/);
  assert.deepStrictEqual(opened, [], "gh was never asked to open a PR");
  assert.ok(logs.some((l) => /no PR was opened/.test(l)), "the refusal is logged");

  // An empty body is refused the same way.
  const deps2 = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
    buildProposalBody: () => null,
    proposeIntegrationPR: (args) => { opened.push(args); return { ok: true, number: 1 }; },
  });
  const empty = await deps2.propose({ head: "abc123", targetRef: "main", chain: null });
  assert.strictEqual(empty.ok, false);
  assert.deepStrictEqual(opened, []);

  // And a body that builds goes to gh with the body attached.
  const deps3 = sporCli.makeIntegrationDeps(cfg, {
    record: { cwd: home }, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home,
    buildProposalBody: () => "<!-- spor-attestation:begin -->{}<!-- spor-attestation:end -->",
    proposeIntegrationPR: (args) => { opened.push(args); return { ok: true, number: 1 }; },
  });
  assert.strictEqual((await deps3.propose({ head: "abc123", targetRef: "main", chain: null })).ok, true);
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0].body, /spor-attestation:begin/);
});
