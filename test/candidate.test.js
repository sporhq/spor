// The FACTORY CANDIDATE (task-spor-factory-candidate-record) — the object the
// implementation stage submits instead of a claim of resolution, and the
// additive `impl_*` run-record fields that carry it.
//
// Three layers, each with its own oracle:
//
//   1. the pure vocabulary (lib/kernel/candidate.js): the content-addressed id
//      and what does and does not go into it, the re-pin fold, the reference
//      refusal table, the settled/resumable reading of `impl_state`;
//   2. the git half (`pinCandidate` in lib/shell/gate-runner.js) against a REAL
//      throwaway repo — the claim is that the pinned tree is what `commit`
//      resolves to, which only a real repo can settle;
//   3. the run-record stamp (`stampImplState` in
//      lib/shell/agent-dispatch-runner.js) and the pipeline's re-pin wiring:
//      a settled verdict is final, a re-pin never reopens it, and a factory
//      that declares no `implementation:` block pins nothing at all.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const candidate = require("../lib/kernel/candidate.js");
const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const TREE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function mint(over = {}) {
  const r = candidate.mintCandidate(
    {
      repo: "spor",
      node_id: "task-x",
      commit: COMMIT,
      tree: TREE,
      base: { ref: "main", commit: BASE_SHA, merge_base: BASE_SHA },
      branch: "task-x",
      clean: true,
      changed_paths: ["lib/a.js"],
      ...over,
    },
    { sha256 }
  );
  assert.deepStrictEqual(r.errors, [], r.errors.join("; "));
  return r.candidate;
}

// ------------------------------------------------------ the identity rule --

test("candidate_id is cand- plus 16 hex of sha256(repo, node_id, tree) and nothing else", () => {
  const c = mint();
  const expect = `cand-${sha256(`spor\ntask-x\n${TREE}\n`).slice(0, 16)}`;
  assert.strictEqual(c.candidate_id, expect);
  assert.match(c.candidate_id, /^cand-[0-9a-f]{16}$/);
  // The commit, the attempt and the run are FIELDS, never identity: an amend
  // that changes only the message re-labels one candidate, it does not mint a
  // second (§3.2).
  assert.strictEqual(mint({ commit: "d".repeat(40) }).candidate_id, expect);
  assert.strictEqual(mint({ provenance: { run_id: "other", attempt: 9 } }).candidate_id, expect);
  assert.strictEqual(mint({ branch: "elsewhere" }).candidate_id, expect);
});

test("the tree, the item and the repo each change the identity", () => {
  const base = mint().candidate_id;
  assert.notStrictEqual(mint({ tree: "e".repeat(40) }).candidate_id, base, "a new tree is a new candidate");
  assert.notStrictEqual(mint({ node_id: "task-y" }).candidate_id, base, "the same tree for another item is another candidate");
  assert.notStrictEqual(mint({ repo: "spor-server" }).candidate_id, base, "the same tree in another repo is another candidate");
});

test("the key is field-terminated, so no two triples can collide by concatenation", () => {
  assert.notStrictEqual(
    candidate.candidateKey({ repo: "a", nodeId: "b", tree: "c" }),
    candidate.candidateKey({ repo: "a\nb", nodeId: "", tree: "c" })
  );
  assert.strictEqual(candidate.candidateKey({ repo: "a", nodeId: "b", tree: "c" }), "a\nb\nc\n");
});

test("candidateIdFor refuses a hasher that is not one", () => {
  assert.throws(() => candidate.candidateIdFor({ repo: "a", nodeId: "b", tree: "c" }), /sha256/);
  assert.throws(() => candidate.candidateIdFor({ repo: "a", nodeId: "b", tree: "c" }, () => "NOT-HEX"), /hex digest/);
});

// ---------------------------------------------------------- minting rules --

test("a candidate that cannot name what it pins is refused, field by field", () => {
  const cases = [
    [{ repo: "" }, /'repo' is required/],
    [{ node_id: "" }, /'node_id' is required/],
    [{ commit: "abc" }, /'commit' must be a full git object name/],
    [{ tree: "" }, /'tree' must be a full git object name/],
    [{ base: { ref: "main" } }, /'base.merge_base' is required/],
    [{ submitted_by: { stage: "whenever" } }, /submitted_by.stage/],
    [{ provenance: { pool: "wallet" } }, /provenance.pool/],
  ];
  for (const [over, re] of cases) {
    const r = candidate.mintCandidate(
      { repo: "spor", node_id: "task-x", commit: COMMIT, tree: TREE, base: { ref: "main", merge_base: BASE_SHA }, clean: true, ...over },
      { sha256 }
    );
    assert.strictEqual(r.ok, false, `${JSON.stringify(over)} should refuse`);
    assert.strictEqual(r.candidate, null, "a refused mint returns no half-filled object");
    assert.ok(r.errors.some((e) => re.test(e)), `${r.errors.join("; ")} should match ${re}`);
  }
});

test("`clean` must be a real boolean — an unreadable git status is false, never absent", () => {
  const r = candidate.mintCandidate(
    { repo: "spor", node_id: "task-x", commit: COMMIT, tree: TREE, base: { merge_base: BASE_SHA } },
    { sha256 }
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /'clean' must be a boolean/.test(e)));
  assert.strictEqual(mint({ clean: false }).clean, false, "a dirty verdict is carried, not dropped");
});

test("a fresh candidate carries no reference and no supersession — the publish is owed", () => {
  const c = mint();
  assert.strictEqual(c.reference, null);
  assert.strictEqual(c.supersedes, null);
  assert.deepStrictEqual(c.commits_seen, []);
  assert.strictEqual(c.spec_version, candidate.SPEC_VERSION);
  assert.strictEqual(candidate.candidateSubmitted(c), false, "unpublished has exactly one meaning: owed");
  assert.strictEqual(candidate.candidateSubmitted({ ...c, reference: { kind: "bundle", verified_at: "2026-09-05T00:00:00Z" } }), true);
});

test("cwd is provenance, never a reference", () => {
  const c = mint({ provenance: { cwd: "/tmp/worktree" } });
  assert.strictEqual(c.provenance.cwd, "/tmp/worktree");
  assert.strictEqual(c.reference, null, "nothing in the pipeline follows a cwd");
});

test("resolver.resolves_edge records a premature resolution rather than hiding it", () => {
  assert.strictEqual(mint({ resolver: { node: "dec-x", written: true } }).resolver.resolves_edge, false);
  assert.strictEqual(mint({ resolver: { node: "dec-x", written: true, resolves_edge: true } }).resolver.resolves_edge, true);
});

test("changed_paths_sha256 keeps git's order and terminates every path", () => {
  const a = mint({ changed_paths: ["lib/a.js", "lib/b.js"] }).changed_paths_sha256;
  const b = mint({ changed_paths: ["lib/b.js", "lib/a.js"] }).changed_paths_sha256;
  assert.notStrictEqual(a, b, "re-sorting would disagree with the list the globs matched");
  assert.notStrictEqual(candidate.changedPathsKey([]), candidate.changedPathsKey([""]));
});

// ------------------------------------------------------------ the re-pin --

test("the same tree is the same candidate: the new commit is a relabel, nothing else moves", () => {
  const first = mint();
  const amended = mint({ commit: "d".repeat(40), branch: "renamed" });
  const { candidate: folded, change } = candidate.repinCandidate(first, amended);
  assert.strictEqual(change, "seen");
  assert.strictEqual(folded.candidate_id, first.candidate_id);
  assert.strictEqual(folded.commit, COMMIT, "the pinned commit is immutable: first published wins");
  assert.strictEqual(folded.branch, first.branch, "nothing else changes");
  assert.deepStrictEqual(folded.commits_seen, ["d".repeat(40)]);
  // ...and the ancestor object itself was not mutated.
  assert.deepStrictEqual(first.commits_seen, []);
  // Re-folding the same commit is a no-op, not a growing list.
  assert.strictEqual(candidate.repinCandidate(folded, amended).change, "unchanged");
  assert.deepStrictEqual(candidate.repinCandidate(folded, amended).candidate.commits_seen, ["d".repeat(40)]);
});

test("a different tree is a NEW candidate carrying supersedes", () => {
  const first = mint();
  const next = mint({ tree: "e".repeat(40), commit: "f".repeat(40) });
  const { candidate: folded, change } = candidate.repinCandidate(first, next);
  assert.strictEqual(change, "superseded");
  assert.strictEqual(folded.supersedes, first.candidate_id);
  assert.strictEqual(folded.tree, "e".repeat(40));
  assert.strictEqual(first.supersedes, null, "the ancestor is untouched");
});

test("the first pin is `created`", () => {
  const r = candidate.repinCandidate(null, mint());
  assert.strictEqual(r.change, "created");
  assert.strictEqual(r.candidate.supersedes, null);
});

test("a tree that comes BACK is appended, never folded onto its own ancestor", () => {
  // A fix cycle that reverts a one-hunk change reproduces the earlier tree
  // exactly, which by §3.2 is the same candidate id. Replacing the ancestor's
  // ENTRY would destroy the record of who first produced that tree, put the tip
  // somewhere other than the end, and leave two entries pointing `supersedes`
  // at each other so a reader walking back to the first submission never stops.
  const A = mint();
  const B = candidate.repinCandidate(A, mint({ tree: "e".repeat(40), commit: "f".repeat(40) })).candidate;
  let chain = candidate.appendCandidateChain(candidate.appendCandidateChain(null, A), B);
  const back = candidate.repinCandidate(B, mint({ commit: "9".repeat(40) }));
  assert.strictEqual(back.change, "superseded");
  chain = candidate.appendCandidateChain(chain, back.candidate);
  assert.deepStrictEqual(chain.map((c) => c.candidate_id), [A.candidate_id, B.candidate_id, A.candidate_id]);
  assert.strictEqual(chain[chain.length - 1], back.candidate, "the tip is always the last entry");
  assert.strictEqual(chain[0].supersedes, null, "the ancestor's own first-submission record survives");
  assert.strictEqual(chain[0].submitted_by.stage, "implementation");
  // ...and the supersedes walk terminates.
  const byIndex = (i) => chain[i];
  assert.strictEqual(byIndex(2).supersedes, B.candidate_id);
  assert.strictEqual(byIndex(1).supersedes, A.candidate_id);
  assert.strictEqual(byIndex(0).supersedes, null);
});

test("the chain replaces only its own tip, and a relabel updates that entry", () => {
  const first = mint();
  let chain = candidate.appendCandidateChain(null, first);
  assert.strictEqual(chain.length, 1);
  const relabelled = candidate.repinCandidate(first, mint({ commit: "d".repeat(40) })).candidate;
  chain = candidate.appendCandidateChain(chain, relabelled);
  assert.strictEqual(chain.length, 1, "the same candidate does not appear twice");
  assert.deepStrictEqual(chain[0].commits_seen, ["d".repeat(40)]);
  const next = candidate.repinCandidate(relabelled, mint({ tree: "e".repeat(40) })).candidate;
  chain = candidate.appendCandidateChain(chain, next);
  assert.deepStrictEqual(chain.map((c) => c.candidate_id), [first.candidate_id, next.candidate_id]);
});

// ------------------------------------------------------- the impl_ states --

test("impl_state reads settled/resumable exactly as gate_state does", () => {
  for (const s of ["candidate", "declined", "exhausted", "escalated", "unroutable", "mismatch"]) {
    assert.strictEqual(candidate.implSettled(s), true, `${s} is settled`);
    assert.strictEqual(candidate.implResumable(s), false);
  }
  for (const s of ["dispatched", "running", "interrupted"]) {
    assert.strictEqual(candidate.implSettled(s), false, `${s} is not a verdict`);
    assert.strictEqual(candidate.implResumable(s), true);
  }
  // An unrecognized value — written by a newer client — RESUMES rather than
  // reading as a verdict.
  assert.strictEqual(candidate.implSettled("harvested"), false);
  assert.strictEqual(candidate.implResumable("harvested"), true);
  // ...but ABSENCE is a legacy run, not an unfinished stage.
  assert.strictEqual(candidate.implResumable(undefined), false);
  assert.strictEqual(candidate.implResumable(""), false);
  assert.strictEqual(candidate.implSettled(undefined), false);
});

test("no-candidate and cancelled are ATTEMPT outcomes, never settled stage states", () => {
  for (const o of ["no-candidate", "cancelled"]) {
    assert.ok(candidate.IMPL_ATTEMPT_OUTCOMES.includes(o));
    assert.strictEqual(candidate.SETTLED_IMPL_STATES.has(o), false);
  }
  assert.ok(candidate.IMPL_ATTEMPT_OUTCOMES.includes("pending"));
});

// -------------------------------------------------- the reference refusals --

test("a reference must be fetchable by locator, or it is refused with the reason named", () => {
  const ok = { kind: "bundle", locator: "file:///home/x/.spor/candidates/cand-1.bundle", key: "cand-1.bundle", commit: COMMIT };
  assert.strictEqual(candidate.referenceRefusal(ok, { bundleStore: "file:///home/x/.spor/candidates" }), null);
  const cases = [
    [null, /must be an object/],
    [{ ...ok, kind: "local" }, /reference.kind/],
    [{ ...ok, locator: "" }, /locator is required/],
    [{ ...ok, locator: COMMIT }, /bare commit sha/],
    [{ ...ok, locator: "/home/x/cand.bundle" }, /filesystem path/],
    [{ ...ok, locator: "origin" }, /not an absolute URI/],
    [{ ...ok, locator: "ssh://git@h/r.git" }, /not a reachable scheme/],
    [{ ...ok, commit: "abc" }, /reference.commit must be the full pinned commit/],
    [{ ...ok, locator: "file:///home/x/repo/.git/cand.bundle" }, /\.git directory/],
    // issue-spor-candidate-reference-percent-encoding-bypass: the `.git` rule
    // ran on the RAW locator while the traversal rule decoded first, so a
    // percent-encoded dot walked straight past it into the one place §3.4 names
    // explicitly as not-a-store. Both rules judge the decoded form now.
    [{ ...ok, locator: "file:///home/x/.spor/candidates/%2egit/objects/c.bundle" }, /\.git directory/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/%2Egit/objects/c.bundle" }, /\.git directory/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/repo%2F%2egit/c.bundle" }, /\.git directory/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/../../../etc/x.bundle" }, /relative path segment/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/%2e%2e/x.bundle" }, /relative path segment/],
    // `\` is a path separator for special schemes on EVERY platform per the
    // WHATWG URL spec — `new URL("file:///store/..\\..\\etc/x").href` is
    // `file:///etc/x` — so a backslash walk escapes a store the raw string
    // still prefixes. Percent-encoded separators fold for the same reason.
    [{ ...ok, locator: "file:///home/x/.spor/candidates/..\\..\\etc\\x.bundle" }, /relative path segment/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/..%2f..%2fetc/x.bundle" }, /relative path segment/],
    [{ ...ok, locator: "file:///home/x/.spor/candidates/..%5cetc/x.bundle" }, /relative path segment/],
    [{ ...ok, key: "" }, /needs the object 'key'/],
    [{ kind: "branch", locator: "https://h/r.git", commit: COMMIT }, /needs the 'ref'/],
  ];
  for (const [ref, re] of cases) {
    const reason = candidate.referenceRefusal(ref, { bundleStore: "file:///home/x/.spor/candidates" });
    assert.ok(reason && re.test(reason), `${JSON.stringify(ref)} -> ${reason} should match ${re}`);
  }
});

test("ssh:// is a reachable scheme for a branch reference — the common git-over-ssh origin — but not for a bundle", () => {
  const branchOk = { kind: "branch", locator: "ssh://git@github.com/sporhq/spor.git", ref: "refs/spor/candidates/cand-1", commit: COMMIT };
  assert.strictEqual(candidate.referenceRefusal(branchOk), null);
  // A bundle's locator is always the declared/default bundle_store, which
  // stays file:// or https:// only (resolveBundleStore) — ssh:// is refused here
  // exactly as it always was.
  const bundleSsh = { kind: "bundle", locator: "ssh://git@h/r.git", key: "cand-1.bundle", commit: COMMIT };
  assert.match(candidate.referenceRefusal(bundleSsh, { bundleStore: "file:///home/x/.spor/candidates" }), /not a reachable scheme/);
});

test("a file:// reference under the producing run's own working tree is refused", () => {
  const ref = { kind: "bundle", key: "c.bundle", commit: COMMIT, locator: "file:///w/run-1/c.bundle" };
  assert.match(candidate.referenceRefusal(ref, { cwd: "/w/run-1" }), /working tree/);
  // ...and one outside the declared store is refused too, so a producer cannot
  // publish somewhere no reader was told to look.
  assert.match(candidate.referenceRefusal(ref, { bundleStore: "file:///store" }), /does not resolve under the declared bundle store/);
  // A sibling directory whose name merely starts the same way is a different
  // place, in both prefix tests.
  assert.strictEqual(candidate.referenceRefusal({ ...ref, locator: "file:///w/run-10/c.bundle" }, { cwd: "/w/run-1" }), null);
  // A store PREFIX must not match a sibling directory by string prefix alone.
  assert.match(
    candidate.referenceRefusal({ ...ref, locator: "file:///store-other/c.bundle" }, { bundleStore: "file:///store" }),
    /does not resolve under the declared bundle store/
  );
});

test("a scheme is case-insensitive, but the path it names is not", () => {
  const store = "file:///home/x/.spor/candidates";
  const ok = { kind: "bundle", key: "k", commit: COMMIT };
  assert.strictEqual(candidate.referenceRefusal({ ...ok, locator: `FILE://${store.slice(7)}/c.bundle` }, { bundleStore: store }), null);
  assert.strictEqual(candidate.referenceRefusal({ ...ok, locator: `${store}/c.bundle` }, { bundleStore: `FILE://${store.slice(7)}` }), null);
  // ...the PATH still is: a store is a directory, and those are case-sensitive
  // where this runs.
  assert.match(
    candidate.referenceRefusal({ ...ok, locator: "file:///home/X/.spor/candidates/c.bundle" }, { bundleStore: store }),
    /does not resolve under the declared bundle store/
  );
});

test("candidateSummary leads with the tree, and says so when nothing is published", () => {
  const s = candidate.candidateSummary(mint());
  assert.match(s, /^cand-[0-9a-f]{16}\s+tree a{12}\s+commit b{12}/);
  assert.match(s, /unpublished/);
  assert.match(candidate.candidateSummary(mint({ clean: false })), /tree not clean/);
  assert.strictEqual(candidate.candidateSummary(null), "");
});

// --------------------------------------------------- the git half, for real --

function realRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cand-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  g("config", "user.email", "t@t");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "trusted");
  g("checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  return { dir, g };
}

test("pinCandidate pins the tree the commit actually resolves to, in a real repo", (t) => {
  const { dir, g } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { cwd: dir, run_id: "run-1", harness: "claude-code" };
  const change = gateRunner.gateChangeSet(record, "main");
  assert.strictEqual(change.ok, true, change.reason);
  const pinned = gateRunner.pinCandidate(record, "main", { change, repo: "demo", nodeId: "task-x", provenance: { run_id: "run-1" } });
  assert.strictEqual(pinned.ok, true, pinned.reason);
  const c = pinned.candidate;
  assert.strictEqual(c.commit, g("rev-parse", "HEAD"));
  assert.strictEqual(c.tree, g("rev-parse", "HEAD^{tree}"), "the tree is read from git, never assumed");
  assert.strictEqual(c.base.merge_base, g("merge-base", "main", "HEAD"));
  assert.strictEqual(c.base.commit, g("rev-parse", "main^{commit}"));
  assert.strictEqual(c.base.ref, "main");
  assert.strictEqual(c.branch, "impl");
  assert.strictEqual(c.clean, true);
  assert.strictEqual(c.provenance.cwd, dir);
  assert.strictEqual(c.submitted_by.stage, "implementation");
  assert.deepStrictEqual(c.commits_seen, []);
});

test("an amend re-pins to the same candidate; a real content change to a new one", (t) => {
  const { dir, g } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { cwd: dir, run_id: "run-1" };
  const pin = () => {
    const change = gateRunner.gateChangeSet(record, "main");
    assert.strictEqual(change.ok, true, change.reason);
    return gateRunner.pinCandidate(record, "main", { change, repo: "demo", nodeId: "task-x" }).candidate;
  };
  const first = pin();
  g("commit", "-q", "--amend", "-m", "work, better message");
  const amended = pin();
  assert.notStrictEqual(amended.commit, first.commit, "the amend really did move HEAD");
  assert.strictEqual(amended.candidate_id, first.candidate_id, "the tree did not move, so the candidate did not");
  const folded = candidate.repinCandidate(first, amended);
  assert.strictEqual(folded.change, "seen");
  assert.strictEqual(folded.candidate.commit, first.commit);

  fs.writeFileSync(path.join(dir, "c.txt"), "three\n");
  g("add", "-A");
  g("commit", "-q", "-m", "a fix cycle");
  const fixed = pin();
  assert.notStrictEqual(fixed.candidate_id, first.candidate_id, "new content is a new candidate");
  assert.strictEqual(candidate.repinCandidate(folded.candidate, fixed).candidate.supersedes, first.candidate_id);
});

test("a dirty tree pins nothing — a candidate whose clean verdict nobody could take is not one", (t) => {
  const { dir } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "uncommitted\n");
  const record = { cwd: dir, run_id: "run-1" };
  const change = gateRunner.gateChangeSet(record, "main");
  assert.strictEqual(change.ok, false, "the command gate's own read refuses a dirty tree");
  const pinned = gateRunner.pinCandidate(record, "main", { change, repo: "demo", nodeId: "task-x" });
  assert.strictEqual(pinned.ok, false);
  assert.match(pinned.reason, /no committed tree to pin/);
  // ...and so does a read that never happened at all.
  assert.strictEqual(gateRunner.pinCandidate(record, "main", { repo: "demo", nodeId: "task-x" }).ok, false);
});

test("pinCandidate refuses rather than guesses when the tree cannot be read", (t) => {
  const { dir } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { cwd: dir, run_id: "run-1" };
  const change = gateRunner.gateChangeSet(record, "main");
  const pinned = gateRunner.pinCandidate(record, "main", { change: { ...change, head: "0".repeat(40) }, repo: "demo", nodeId: "task-x" });
  assert.strictEqual(pinned.ok, false);
  assert.match(pinned.reason, /has no identity/);
});

// ------------------------------------------------------- the record stamp --

function scratchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cand-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeRecord(home, runId, extra = {}) {
  const p = dispatchRuns.runPaths(home, runId);
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: runId, node_id: "task-x", state: "done", ...extra }));
  return p.record;
}

test("a settled impl_state drops only that key from the patch, never the pin with it", (t) => {
  const home = scratchHome(t);
  const file = writeRecord(home, "run-1", { impl_state: "escalated" });
  const tip = mint();
  dispatchRuns.stampImplState(home, "run-1", { impl_state: "candidate", impl_candidate: tip, impl_pool: "implementation" });
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.impl_state, "escalated", "the verdict is final");
  assert.strictEqual(rec.impl_candidate.candidate_id, tip.candidate_id, "…but WHICH TREE was pinned is still recorded");
  assert.strictEqual(rec.impl_pool, "implementation");
});

test("stampImplState re-applies an impl_state a concurrent whole-record write reverted", (t) => {
  const home = scratchHome(t);
  const file = writeRecord(home, "run-1");
  let reads = 0;
  // A supervisor that READ before this settle and RENAMED after it: the first
  // read-back actually clobbers the file back to its pre-stamp content, which
  // is what the reapply pass exists to notice.
  const readBack = (f) => {
    reads += 1;
    if (reads === 1) fs.writeFileSync(f, JSON.stringify({ run_id: "run-1", terminal_state: "reported" }));
    return JSON.parse(fs.readFileSync(f, "utf8"));
  };
  const merged = dispatchRuns.stampImplState(home, "run-1", { impl_state: "candidate" }, { readBack });
  assert.strictEqual(merged.impl_state, "candidate");
  assert.ok(reads >= 1, "the stamp was verified after writing");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.impl_state, "candidate", "the reverted stamp was written again");
  assert.strictEqual(rec.terminal_state, "reported", "…onto the clobbering writer's own record, not over it");
});

test("stampImplState writes only the impl_ namespace", (t) => {
  const home = scratchHome(t);
  const file = writeRecord(home, "run-1");
  dispatchRuns.stampImplState(home, "run-1", { impl_state: "candidate", terminal_state: "failed", gate_state: "passed" });
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.impl_state, "candidate");
  assert.strictEqual(rec.terminal_state, undefined, "the outcome dimension is not this writer's to touch");
  assert.strictEqual(rec.gate_state, undefined, "nor is the gate dimension");
  assert.strictEqual(dispatchRuns.stampImplState(home, "run-1", { terminal_state: "failed" }), null, "a patch with nothing impl_ in it is a no-op");
});

test("a settled impl_state is final — but a re-pin, which carries none, still lands", (t) => {
  const home = scratchHome(t);
  const file = writeRecord(home, "run-1", { impl_state: "exhausted" });
  dispatchRuns.stampImplState(home, "run-1", { impl_state: "candidate" });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).impl_state, "exhausted", "a refusal is never laundered into a submission");
  // §3.3: a re-pin never touches impl_state, so it is not blocked by one.
  dispatchRuns.stampImplState(home, "run-1", { impl_candidate: mint() });
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.impl_state, "exhausted");
  assert.strictEqual(rec.impl_candidate.candidate_id, mint().candidate_id, "the tip moves, the verdict does not");
  // An UNSETTLED state is not final: a stage that never reported can be settled.
  writeRecord(home, "run-2", { impl_state: "running" });
  dispatchRuns.stampImplState(home, "run-2", { impl_state: "candidate" });
  assert.strictEqual(JSON.parse(fs.readFileSync(dispatchRuns.runPaths(home, "run-2").record, "utf8")).impl_state, "candidate");
});

test("a whole-record write by an in-process writer carries the impl_ namespace across", (t) => {
  const home = scratchHome(t);
  const file = writeRecord(home, "run-1");
  const handle = { paths: dispatchRuns.runPaths(home, "run-1"), record: JSON.parse(fs.readFileSync(file, "utf8")) };
  // The stage stamps out of band, AFTER the handle's in-memory copy was taken…
  dispatchRuns.stampImplState(home, "run-1", { impl_state: "candidate", impl_candidate: mint() });
  // …and the supervisor then lands its verified outcome from that stale copy.
  dispatchRuns.updateRun(handle, { terminal_state: "reported" });
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.terminal_state, "reported");
  assert.strictEqual(rec.impl_state, "candidate", "the candidate is not erased by a later whole-record write");
  assert.ok(rec.impl_candidate);
});

// ---------------------------------------------- the settled-record race fix --
//
// issue-spor-pin-candidate-settled-record-stamp-race: the CLOSURE
// (`makeGateDeps`'s `pinCandidate` in bin/spor.js — the caller of
// `gateRunner.pinCandidate` and `stampImplState` above, neither of which alone
// reproduces the bug), against a REAL git repo and a REAL run-record file, the
// same "only the real door proves it" scoping the escalation/demote tests use.

function realGateDeps(t, { home, entry, factory = { trustedRef: "main" }, record, warn = () => {} }) {
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  return sporCli.makeGateDeps(cfg, { record, entry, factory, slug: "demo", log: () => {}, warn, home });
}

test("a late first pin arriving after impl_state already settled elsewhere is refused whole, not laundered in", async (t) => {
  const { dir } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = scratchHome(t);
  const runId = "11111111-1111-1111-1111-111111111111";
  // The settling path this reproduces never goes through pinCandidate at all
  // (two workers adopting one orphaned pipeline; the winner's `exhausted`
  // lands via stampImplState directly) — so the record is settled with NO
  // impl_candidate ever recorded, which is exactly what makes the late
  // first pin read as `folded.change === "created"`.
  const file = writeRecord(home, runId, { impl_state: "exhausted" });
  const record = { cwd: dir, run_id: runId, harness: "claude-code" };
  const entry = { run_id: runId, node_id: "task-x", project: "demo" };
  const warnings = [];
  const deps = realGateDeps(t, { home, entry, record, warn: (l) => warnings.push(l) });

  const change = await deps.changedPaths({ trustedRef: "main" });
  assert.strictEqual(change.ok, true, change.reason);
  const result = await deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });

  assert.strictEqual(result.ok, true, "a refusal here is a no-op, not a pipeline failure");
  assert.strictEqual(result.change, "refused-settled");
  assert.strictEqual(result.candidate, null, "nothing was ever pinned for this record");
  assert.ok(
    warnings.some((w) => /impl_state already settled/.test(w) && /exhausted/.test(w)),
    "the refusal is logged, not silent"
  );

  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(rec.impl_state, "exhausted", "the terminal verdict stands untouched");
  assert.strictEqual(rec.impl_run_id, undefined, "no live-run metadata is stamped beside a settled verdict");
  assert.strictEqual(rec.impl_attempt, undefined);
  assert.strictEqual(rec.impl_pool, undefined);
  assert.strictEqual(rec.impl_candidate, undefined, "no candidate is fabricated for a stage that never actually submitted one");
});

test("a legitimate re-pin after settling still lands — only a late FIRST pin is refused", async (t) => {
  const { dir, g } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = scratchHome(t);
  const runId = "22222222-2222-2222-2222-222222222222";
  writeRecord(home, runId);
  const record = { cwd: dir, run_id: runId, harness: "claude-code" };
  const entry = { run_id: runId, node_id: "task-x", project: "demo" };
  const deps = realGateDeps(t, { home, entry, record });

  await deps.changedPaths({ trustedRef: "main" });
  const first = await deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.change, "created");
  const file = dispatchRuns.runPaths(home, runId).record;
  const afterFirst = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(afterFirst.impl_run_id, runId);
  assert.strictEqual(afterFirst.impl_pool, "implementation");

  // The stage settles — via the boundary, not via pinCandidate — while a fix
  // cycle then moves the tree. This is the documented steady state
  // (stampImplState's own header comment): the verdict is final, but the
  // TIP still moves.
  dispatchRuns.stampImplState(home, runId, { impl_state: "candidate" });
  fs.writeFileSync(path.join(dir, "c.txt"), "three\n");
  g("add", "-A");
  g("commit", "-q", "-m", "a fix cycle");

  await deps.changedPaths({ trustedRef: "main" });
  const second = await deps.pinCandidate({ submittedBy: { stage: "fix", cycle: 1, rescue: 0 } });
  assert.strictEqual(second.ok, true);
  assert.notStrictEqual(second.change, "refused-settled", "a re-pin — not a first pin — must not be caught by the settled-record guard");

  const afterSecond = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(afterSecond.impl_state, "candidate", "the verdict is still final");
  assert.strictEqual(afterSecond.impl_candidate.candidate_id, second.candidate.candidate_id, "…but the tip moved with the fix");
  assert.strictEqual(afterSecond.impl_run_id, runId, "the submission's own dimensions are untouched by the fixer's re-pin");
  assert.strictEqual(afterSecond.impl_pool, "implementation");
});

// ---------------------------------------------------- the pipeline wiring --

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test" });
  assert.deepStrictEqual(errors, [], errors.join("; "));
  return factory;
}

const PASSING = {
  factory: "test",
  trusted_ref: "main",
  gates: [{ id: "suite", kind: "command", command: "npm test" }],
};

function pipelineDeps(pins) {
  return {
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    changedPaths: async () => ({ ok: true, paths: ["lib/a.js"], head: COMMIT, base: BASE_SHA }),
    runSuite: async () => ({ ok: true }),
    recordFact: async () => ({ ok: true }),
    escalate: async () => ({ ok: true, id: "task-esc" }),
    demote: async () => ({ ok: true, demoted: true, note: "" }),
    pinCandidate: async ({ submittedBy }) => {
      pins.push(submittedBy);
      return { ok: true, candidate: mint(), change: pins.length === 1 ? "created" : "unchanged" };
    },
  };
}

test("a factory that declares no implementation stage pins nothing at all", async () => {
  const pins = [];
  const res = await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf(PASSING),
    deps: pipelineDeps(pins),
  });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(pins, [], "no implementation: block, no pin, no stamp — byte-identical to before the stage existed");
});

test("a declared implementation stage pins at the submission read, naming the step", async () => {
  const pins = [];
  const res = await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf({ ...PASSING, implementation: { profile: "profile-impl" } }),
    deps: pipelineDeps(pins),
  });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(pins, [{ stage: "implementation", cycle: 0, rescue: 0 }]);
});

test("a pin that refuses is logged and the tree is judged regardless", async () => {
  const lines = [];
  const deps = pipelineDeps([]);
  deps.pinCandidate = async () => ({ ok: false, reason: "the tree has no identity" });
  const res = await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf({ ...PASSING, implementation: { profile: "profile-impl" } }),
    deps,
    log: (l) => lines.push(l),
  });
  assert.strictEqual(res.state, "passed", "the candidate is a record OF what was judged, not a precondition for judging it");
  assert.ok(lines.some((l) => /no candidate could be pinned/.test(l)));
});

test("the implementer's commit-or-discard round-trip pins as the SUBMISSION, not a fix", async () => {
  const pins = [];
  const deps = pipelineDeps(pins);
  let reads = 0;
  // The opening read finds a dirty tree; the round-trip commits; the re-read
  // is the first successful pin — and it is the implementation stage's own.
  deps.changedPaths = async () => {
    reads += 1;
    return reads === 1
      ? { ok: false, dirty: true, reason: "the run left uncommitted changes" }
      : { ok: true, paths: ["lib/a.js"], head: COMMIT, base: BASE_SHA };
  };
  deps.fix = async () => ({ ok: true, runId: "run-roundtrip" });
  const res = await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf({ ...PASSING, implementation: { profile: "profile-impl" } }),
    deps,
  });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(pins.map((p) => p.stage), ["implementation"]);
});

test("a re-pin names the run that actually made the commit", async () => {
  const seen = [];
  const deps = pipelineDeps([]);
  deps.pinCandidate = async ({ submittedBy, runId }) => {
    seen.push({ stage: submittedBy.stage, runId });
    return { ok: true, candidate: mint(), change: seen.length === 1 ? "created" : "unchanged" };
  };
  let suites = 0;
  deps.runSuite = async () => (suites++ === 0 ? { ok: false, output: "boom" } : { ok: true });
  deps.fix = async () => ({ ok: true, runId: "run-fix" });
  await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf({ ...PASSING, gates: [{ id: "suite", kind: "command", command: "npm test", cycles: 1 }], implementation: { profile: "profile-impl" } }),
    deps,
  });
  assert.deepStrictEqual(seen, [
    { stage: "implementation", runId: null }, // the implementation run is the record being stamped
    { stage: "fix", runId: "run-fix" },
  ]);
});

test("a fix cycle re-pins, and the re-pin names the fix rather than the submission", async () => {
  const pins = [];
  const deps = pipelineDeps(pins);
  let suites = 0;
  deps.runSuite = async () => (suites++ === 0 ? { ok: false, output: "boom" } : { ok: true });
  deps.fix = async () => ({ ok: true, runId: "run-fix" });
  const res = await gateRunner.runGatePipeline({
    item: { node_id: "task-x", run_id: "run-1", attempt: 1 },
    factory: factoryOf({ ...PASSING, gates: [{ id: "suite", kind: "command", command: "npm test", cycles: 1 }], implementation: { profile: "profile-impl" } }),
    deps,
  });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(pins.map((p) => p.stage), ["implementation", "fix"]);
  assert.strictEqual(pins[1].cycle, 1, "the re-pin names which cycle moved the tree");
});

// ------------------------ REAL pinCandidate wiring: the stamp must be heard --
//
// issue-spor-pin-candidate-silent-stamp-failure: bin/spor.js's own
// `pinCandidate` closures (makeGateDeps' and its makeIntegrationDeps twin)
// used to discard dispatchRuns.stampImplState's return value and report
// `{ok: true, ...}` unconditionally — so a write failure (an unreadable run
// record, a mid-write exception) was masked: the candidate was minted but
// never landed, and `spor runs`/`spor work --status` would show a stale or
// missing impl_candidate with no way to tell something went wrong. These
// drive the REAL bin/spor.js closures (not gate-runner.js's own pin wrapper,
// which the tests above already cover with a fake dep) against a real git
// repo, forcing the failure with the simplest reproduction of "an unreadable
// run record": no run-record file was ever written for this run_id.

test("REGRESSION issue-spor-pin-candidate-silent-stamp-failure: makeGateDeps' pinCandidate reports ok:false, not a silent success, when the run record cannot be stamped", async (t) => {
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const { dir } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = scratchHome(t);
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const entry = { run_id: "22222222-3333-4444-5555-000000000001", node_id: "task-x", project: "demo", attempt: 1 };
  const record = { cwd: dir };
  const factory = { trustedRef: "main" };
  const deps = sporCli.makeGateDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });

  const changed = await deps.changedPaths({ trustedRef: "main" });
  assert.strictEqual(changed.ok, true, changed.reason);

  assert.strictEqual(dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record), null, "sanity: no run record was ever written for this run_id");
  const res = await deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(res.ok, false, "an unreadable run record must never be reported as a successful pin");
  assert.match(res.reason, /could not be stamped/);
});

test("REGRESSION issue-spor-pin-candidate-silent-stamp-failure: makeIntegrationDeps' pinCandidate reports ok:false, not a silent success, when the run record cannot be stamped", async (t) => {
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const { dir } = realRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = scratchHome(t);
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const entry = { run_id: "22222222-3333-4444-5555-000000000002", node_id: "task-x", project: "demo", attempt: 1 };
  const record = { cwd: dir };
  const factory = { integration: { targetRef: "main" }, trustedRef: "main" };
  const deps = sporCli.makeIntegrationDeps(cfg, { record, entry, factory, slug: "demo", passthrough: {}, warn: () => {}, sleep: async () => {}, log: () => {}, home });

  const changed = await deps.changedTree();
  assert.strictEqual(changed.ok, true, changed.reason);

  assert.strictEqual(dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record), null, "sanity: no run record was ever written for this run_id");
  const res = await deps.pinCandidate({ submittedBy: { stage: "integration-fix", cycle: 1, rescue: 0 } });
  assert.strictEqual(res.ok, false, "an unreadable run record must never be reported as a successful pin");
  assert.match(res.reason, /could not be stamped/);
});

// ------------------------------------------------------ the CLI surfaces --

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { spawnSync } = require("node:child_process");

function bareEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME" || k === "CLAUDE_CONFIG_DIR") continue;
    env[k] = v;
  }
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  return Object.assign(env, extra);
}

function spor(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bareEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }) });
}

test("spor runs surfaces the stage and the tip candidate, in text and in --json", (t) => {
  const home = scratchHome(t);
  const tip = candidate.repinCandidate(mint(), mint({ tree: "e".repeat(40), commit: "f".repeat(40) })).candidate;
  writeRecord(home, "11111111-2222-3333-4444-555555555555", {
    harness: "claude-code",
    launch_mode: "supervised-jsonl",
    created_at: "2026-09-05T10:00:00.000Z",
    terminal_state: "reported",
    terminal_enforced: true,
    terminal_note: "reported",
    impl_state: "running",
    impl_attempt: 1,
    impl_pool: "implementation",
    impl_run_id: "11111111-2222-3333-4444-555555555555",
    impl_candidate: tip,
    impl_candidates: [mint(), tip],
  });
  const text = spor(["runs"], home);
  assert.strictEqual(text.status, 0, text.stderr);
  // An UNSETTLED stage says so, for the same reason `terminal_enforced` prints
  // `(unenforced)`: a stage nobody finished is not a verdict.
  assert.match(text.stdout, /stage: {6}running \(unsettled — no stage verdict yet\) — implementation pool, attempt 1/);
  assert.match(text.stdout, new RegExp(`candidate: {2}${tip.candidate_id}\\s+tree e{12}\\s+commit f{12}`));
  assert.match(text.stdout, /unpublished/);
  assert.match(text.stdout, /re-pinned 1x/);

  const json = spor(["runs", "--json"], home);
  assert.strictEqual(json.status, 0, json.stderr);
  const rec = JSON.parse(json.stdout).runs[0];
  assert.strictEqual(rec.impl_state, "running");
  assert.strictEqual(rec.impl_candidate.candidate_id, tip.candidate_id);
  assert.strictEqual(rec.impl_candidate.supersedes, mint().candidate_id);
  assert.strictEqual(rec.impl_candidates.length, 2, "the chain rides out additively — --json needs no new code at all");
});

test("a legacy run — no impl_ fields at all — prints exactly as it always did", (t) => {
  const home = scratchHome(t);
  writeRecord(home, "99999999-8888-7777-6666-555555555555", {
    harness: "claude-code",
    launch_mode: "supervised-jsonl",
    created_at: "2026-09-05T10:00:00.000Z",
    terminal_state: "resolved",
    terminal_enforced: true,
    terminal_note: "resolved",
    resolved_by: "dec-x",
  });
  const text = spor(["runs"], home);
  assert.strictEqual(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /stage: /);
  assert.doesNotMatch(text.stdout, /candidate: /);
  const rec = JSON.parse(spor(["runs", "--json"], home).stdout).runs[0];
  assert.strictEqual(rec.impl_state, undefined, "a record with none of them is a legacy run");
});

test("spor work --status prints the tip beside the slot that is gating it", (t) => {
  const home = scratchHome(t);
  const runId = "abcdabcd-1111-2222-3333-444444444444";
  const tip = mint();
  writeRecord(home, runId, { impl_state: "running", impl_candidate: tip });
  const workDir = path.join(home, "journal", "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "w1.work.json"),
    JSON.stringify({
      worker_id: "w1",
      pid: 999999999, // gone: the status reads STALE, which still renders every slot
      updated_at: new Date().toISOString(), // …but only a record with a timestamp survives the sweep
      state: "running",
      project: "demo",
      concurrency: 1,
      active: [],
      gating: [{ node_id: "task-x", run_id: runId, started_at: "2026-09-05T10:00:00.000Z" }],
    })
  );
  const r = spor(["work", "--status"], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /gating: {3}task-x/);
  assert.match(r.stdout, new RegExp(`candidate: ${tip.candidate_id}`));
  // ...and the worker status file itself is untouched by the stage: the
  // candidate is read off the RUN record (WORKERS.md §10.12).
  const onDisk = JSON.parse(fs.readFileSync(path.join(workDir, "w1.work.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(onDisk.gating[0]).sort(), ["node_id", "run_id", "started_at"]);
});
