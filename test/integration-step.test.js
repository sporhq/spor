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
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode, writeFakePathBin, pathWithOnlyGit, isolatedBinDir } = require("./helpers/portable");

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
  assert.deepStrictEqual(seenChain.candidate, { base: "expected1", sha: "candidatesha", suite: "passed", command: "npm test" });
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
  git(dir, "checkout", "-q", "-b", branchName);
  fs.writeFileSync(path.join(dir, "f.txt"), "base\nbranch work\n");
  git(dir, "commit", "-qam", "branch work");
  return dir;
}

// A fake bin dir shadowing both `git` (real, except `push` is short-circuited
// to a no-op success — nothing here actually reaches GitHub) and `gh` (fully
// faked per-test via `listJson`/`create`). Every invocation of either is
// appended to a shared calls log so a test can assert what was (or was NOT)
// asked for, not just the final return value.
function proposeFakeBin({ listJson, createOut = "https://github.com/demo/repo/pull/99\n", createRefused = null, editRefused = null }) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-propose-bin-"));
  const callsFile = path.join(binDir, "calls.log");
  const realGit = path.join(pathWithOnlyGit(), "git");
  writeFakePathBin(binDir, "git", `echo "git $*" >> "${callsFile}"\nif [ "$1" = "push" ]; then exit 0; fi\nexec "${realGit}" "$@"\n`);
  writeFakePathBin(
    binDir,
    "gh",
    [
      `echo "gh $*" >> "${callsFile}"`,
      `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi`,
      `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' '${listJson}'; exit 0; fi`,
      editRefused
        ? `if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then echo "${editRefused}" >&2; exit 1; fi`
        : `if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then exit 0; fi`,
      createRefused
        ? `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "${createRefused}" >&2; exit 1; fi`
        : `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf '%s' '${createOut}'; exit 0; fi`,
      `echo "unexpected gh invocation: $*" >&2`,
      `exit 1`,
    ].join("\n")
  );
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
  assert.strictEqual(fs.realpathSync(landed.reconciled.checkout), fs.realpathSync(dir));
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
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "stage.sh"), '#!/bin/sh\nprintf "setup %s %s\\n" "$SPOR_TREE_ROLE" "$SPOR_MAIN_CHECKOUT" >> "$HOOK_LOG"\n: > "$SPOR_WORKTREE/staged.txt"\n');
  fs.writeFileSync(path.join(repo, "scripts", "unstage.sh"), '#!/bin/sh\nprintf "teardown %s %s\\n" "$SPOR_TREE_ROLE" "$SPOR_DISPATCH_NODE" >> "$HOOK_LOG"\n');
  fs.chmodSync(path.join(repo, "scripts", "stage.sh"), 0o755);
  fs.chmodSync(path.join(repo, "scripts", "unstage.sh"), 0o755);
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktreeSetup: "scripts/stage.sh", worktreeTeardown: "scripts/unstage.sh" } }));
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
  for (const l of setups) assert.strictEqual(fs.realpathSync(l.split(" ")[2]), fs.realpathSync(repo));
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

// Cross-model review, blocking finding 1: a duplicate pipeline for the SAME
// run (a resumed orphan, a second adopter) that loses the settle race must not
// write an attestation for its own verdict, nor overwrite the winner's
// evidence fields (gate_head/gate_attestation/...) on the record. Here the
// record is already settled by "another worker" as FAILED at a different head
// before this pipeline finishes PASSING: nothing of this pipeline's reaches
// the record or the graph.
test("runGateAndIntegration: a pipeline that loses the settle race writes NO attestation and touches NO evidence field on the record", async () => {
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
  assert.strictEqual(res.state, "passed", "this pipeline's own verdict is still reported to its caller");
  assert.strictEqual(res.attestation, null, "no attestation for a verdict the record does not hold");
  assert.strictEqual(res.superseded, true);
  assert.ok(logs.some((m) => /already settled as 'failed' by other-worker/.test(m) && /no attestation is written/.test(m)), `the race is logged: ${logs.join(" | ")}`);
  const after = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  for (const k of Object.keys(winner)) assert.strictEqual(after[k], winner[k], `${k} is the winner's, untouched`);
  assert.ok(!Object.keys(after).some((k) => /^gate_(base|trusted_sha|factory_digest)$/.test(k)), "none of this pipeline's evidence fields landed");
  assert.deepStrictEqual(fs.readdirSync(nodes).filter((f) => f.startsWith("art-attest-")), [], "no attestation node on the graph");
  // The gate fact itself IS written (a record of what was judged — it never
  // claims the run's verdict), so the graph holds the gate fact and nothing else.
  assert.ok(fs.readdirSync(nodes).some((f) => f.startsWith("art-gate-")));
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
  const ok = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, log: (m) => logs.push(m), settledAt, cwd: null, editBody: (a) => { edits.push(a); return { ok: true }; } });
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

  const bad = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, log: (m) => logs.push(m), settledAt, editBody: () => ({ ok: false, reason: "gh: HTTP 502" }) });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "gh: HTTP 502");
  rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.gate_proposal_attestation_stale, true, "a failed refresh is on the record");
  assert.strictEqual(rec.gate_proposal_attestation_error, "gh: HTTP 502");
  assert.ok(logs.some((m) => /could NOT be refreshed/.test(m) && /validator will refuse/.test(m)));
  // A throwing editor is the same failure, not a crash.
  const thrown = await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, settledAt, editBody: () => { throw new Error("boom"); } });
  assert.deepStrictEqual(thrown, { ok: false, reason: "boom" });
  // And the stamp is own-guarded: another settler's record is never touched.
  dispatchRuns.atomicJson(file, { run_id: runId, node_id: item.node_id, state: "done", gate_state: "failed", gate_at: "2026-09-02T13:00:00.000Z" });
  await sporCli.refreshProposalAttestation(cfg, { item, factory, intResult, attestationObject: att, home, settledAt, editBody: () => ({ ok: true }) });
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
