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
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode, writeFakePathBin } = require("./helpers/portable");

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
  });
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
  const { deps, seen } = checkProposalFakes({ prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer" }) });
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
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer" }),
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
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer" }),
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
    prStatus: () => ({ ok: true, state: "closed", merged: true, mergeCommitSha: "deadbeef1234", mergedBy: "reviewer" }),
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
  fs.writeFileSync(stateFile, JSON.stringify({ state: "MERGED", mergedAt: "2026-08-27T00:00:00Z", mergeCommit: { oid: "deadbeefcafe" }, mergedBy: { login: "reviewer" } }));
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
  // this node — a fix-cycle re-dispatch (prompt mentions "integration stage")
  // must not re-add a file that's already there.
  if (!prompt.includes("integration stage") && !fs.existsSync(cwd + "/lib/sub.js")) {
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
