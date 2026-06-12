// Zero-dependency test suite for lib/commit-inference.js
// (task-cc-commit-inference). Run: node --test test/
//
// The module is the high-precision GATE that decides which untrailered
// commit→node pairs are confident enough to PROPOSE through the capture path.
// False links are worse than missed links, so the suite pins both halves:
// a confident match links, and deliberate near-misses must NOT link. It also
// exercises each signal in isolation, the corroboration rule, the configurable
// threshold, idempotency vs already-linked shas, and the CLI.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("node:child_process");

const MOD = path.join(__dirname, "..", "lib", "commit-inference.js");
const { inferLinks, branchKeysFor, referencedPaths, DEFAULT_THRESHOLD } = require(MOD);

// The node the suite infers against: the real task node, abbreviated.
const NODE = {
  id: "task-cc-commit-inference",
  title: "Infer commit→node links through the ingestion path for untrailered commits",
  body: "The distiller hands untrailered shas to the server. See lib/commit-inference.js and scripts/distill.sh; the gate lives in lib/commit-inference.js.",
};

// A second, unrelated node — present in every candidate set so we also assert
// the scorer does not spray links across the whole graph.
const OTHER = {
  id: "dec-provider-neutral-catalogue",
  title: "Catalogue is provider-neutral with composed pricing",
  body: "Pricing is composed from plan parts.",
};

function infer(commit, opts) {
  return inferLinks(commit, [NODE, OTHER], opts);
}

// --------------------------------------------------------------------------
// the two required cases: a confident match, and a deliberate near-miss
// --------------------------------------------------------------------------

test("confident match: branch names the work AND message overlaps → links", () => {
  const commit = {
    sha: "a3f8c2d91b04e576a3f8c2d91b04e576a3f8c2d9",
    repo: "spor",
    branch: "overnight/commit-inference",
    message: "implement commit inference scorer for untrailered commits",
    files: ["lib/commit-inference.js", "test/commit-inference.test.js"],
  };
  const { proposals, threshold } = infer(commit);
  assert.equal(threshold, DEFAULT_THRESHOLD);
  assert.equal(proposals.length, 1, "exactly one node should match");
  const p = proposals[0];
  assert.equal(p.nodeId, "task-cc-commit-inference");
  assert.ok(p.score >= threshold, `score ${p.score} ≥ ${threshold}`);
  assert.equal(p.confidence, "high");
  // The proposal must explain itself (evidence INTO the ingestion decision).
  const kinds = p.signals.map((s) => s.kind).sort();
  assert.ok(kinds.includes("branch-id-tail"), "branch-id-tail signal fired");
  assert.ok(kinds.includes("file-path"), "file-path signal fired");
  assert.match(p.evidence, /needs review/i);
  assert.match(p.evidence, /task-cc-commit-inference/);
  assert.equal(p.sha, commit.sha);
  assert.equal(p.repo, "spor");
});

test("near-miss: incidental token overlap on a generic branch must NOT link", () => {
  // main branch, a README touch, and a subject that happens to share a couple
  // of common-ish words with the title — but no strong, forgery-resistant
  // signal. This is precisely the case where a wrong link would poison the
  // graph, so it must fall below threshold.
  const commit = {
    sha: "deadbeefcafe1234deadbeefcafe1234deadbeef",
    repo: "spor",
    branch: "main",
    message: "links section in the docs for untrailered notes path",
    files: ["README.md", "docs/notes.md"],
  };
  const { proposals } = infer(commit);
  assert.deepEqual(proposals, [], "no proposal — weak overlap alone never links");
});

// --------------------------------------------------------------------------
// each strong signal alone is sufficient; the weak one alone is not
// --------------------------------------------------------------------------

test("branch names the full node id → links on the branch signal alone", () => {
  const commit = {
    sha: "1111111111111111111111111111111111111111",
    repo: "spor",
    branch: "task-cc-commit-inference",
    message: "wip",
    files: ["unrelated/file.txt"],
  };
  const p = infer(commit).proposals;
  assert.equal(p.length, 1);
  assert.equal(p[0].confidence, "high");
  assert.equal(p[0].signals[0].kind, "branch-id");
});

test("verbatim cited file path → links on the file signal alone", () => {
  const commit = {
    sha: "2222222222222222222222222222222222222222",
    repo: "spor",
    branch: "feature/x", // no branch match
    message: "tidy up", // no message match
    files: ["lib/commit-inference.js"],
  };
  const p = infer(commit).proposals;
  assert.equal(p.length, 1);
  assert.equal(p[0].nodeId, "task-cc-commit-inference");
  assert.ok(p[0].signals.some((s) => s.kind === "file-path"));
});

test("message↔title overlap alone is capped below threshold → no link", () => {
  // Strong lexical overlap with the title, but no branch and no cited file.
  const commit = {
    sha: "3333333333333333333333333333333333333333",
    repo: "spor",
    branch: "main",
    message: "infer links through the ingestion path for untrailered commits",
    files: ["src/whatever.py"],
  };
  const { proposals } = infer(commit);
  assert.deepEqual(proposals, [], "message overlap must corroborate, never decide alone");
});

test("shared lockfile/barrel basename does NOT count as a file signal", () => {
  // package-lock.json is touched by countless commits; a basename hit on it
  // must not manufacture evidence (the parallel-sessions caveat).
  const node = { id: "task-cc-x", title: "Some unrelated task", body: "see package-lock.json" };
  const commit = {
    sha: "4444444444444444444444444444444444444444",
    repo: "spor",
    branch: "main",
    message: "bump deps",
    files: ["package-lock.json"],
  };
  const { proposals } = inferLinks(commit, [node]);
  assert.deepEqual(proposals, []);
});

// --------------------------------------------------------------------------
// corroboration: two independent mid-strength signals lift over the line
// --------------------------------------------------------------------------

test("branch-tail + message overlap corroborate to clear threshold", () => {
  const commit = {
    sha: "5555555555555555555555555555555555555555",
    repo: "spor",
    branch: "overnight/commit-inference",
    message: "infer links for untrailered commits through ingestion path",
    files: ["src/unrelated.py"], // no file signal
  };
  const p = infer(commit).proposals;
  assert.equal(p.length, 1);
  const kinds = p[0].signals.map((s) => s.kind);
  assert.ok(kinds.includes("branch-id-tail"));
  assert.ok(kinds.includes("message-title"));
});

// --------------------------------------------------------------------------
// configurable threshold
// --------------------------------------------------------------------------

test("threshold is configurable: a strict threshold suppresses a borderline link", () => {
  const commit = {
    sha: "6666666666666666666666666666666666666666",
    repo: "spor",
    branch: "feature/x",
    message: "tidy",
    files: ["lib/commit-inference.js"], // file-path alone = 0.8
  };
  assert.equal(infer(commit, { threshold: 0.7 }).proposals.length, 1);
  assert.equal(infer(commit, { threshold: 0.9 }).proposals.length, 0, "0.8 < 0.9 → suppressed");
});

test("SUBSTRATE_INFER_THRESHOLD env is honored when no opt is passed", () => {
  const commit = {
    sha: "7777777777777777777777777777777777777777",
    repo: "spor",
    branch: "feature/x",
    message: "tidy",
    files: ["lib/commit-inference.js"],
  };
  const prev = process.env.SUBSTRATE_INFER_THRESHOLD;
  try {
    process.env.SUBSTRATE_INFER_THRESHOLD = "0.95";
    assert.equal(infer(commit).proposals.length, 0);
    process.env.SUBSTRATE_INFER_THRESHOLD = "0.5";
    assert.equal(infer(commit).proposals.length, 1);
  } finally {
    if (prev === undefined) delete process.env.SUBSTRATE_INFER_THRESHOLD;
    else process.env.SUBSTRATE_INFER_THRESHOLD = prev;
  }
});

// --------------------------------------------------------------------------
// idempotency + guards
// --------------------------------------------------------------------------

test("a sha already linked (prefix-aware, per repo) is not re-proposed", () => {
  const node = { ...NODE, commits: ["spor@a3f8c2d91b04"] };
  const commit = {
    sha: "a3f8c2d91b04e576a3f8c2d91b04e576a3f8c2d9",
    repo: "spor",
    branch: "task-cc-commit-inference",
    message: "x",
    files: [],
  };
  const { proposals } = inferLinks(commit, [node]);
  assert.deepEqual(proposals, []);
  // same abbreviated sha under a DIFFERENT repo is still a distinct candidate
  const { proposals: other } = inferLinks({ ...commit, repo: "other-repo" }, [node]);
  assert.equal(other.length, 1);
});

test("missing sha or non-array candidates yields no proposals, no throw", () => {
  assert.deepEqual(inferLinks({ repo: "r" }, [NODE]).proposals, []);
  assert.deepEqual(inferLinks({ sha: "abc" }, null).proposals, []);
});

// --------------------------------------------------------------------------
// helper-level units
// --------------------------------------------------------------------------

test("branchKeysFor admits id tails but only when still specific", () => {
  const keys = branchKeysFor("task-cc-commit-inference");
  assert.ok(keys.has("task-cc-commit-inference"));
  assert.ok(keys.has("cc-commit-inference"));
  assert.ok(keys.has("commit-inference"));
  // a one-token tail like "inference" is NOT admitted (would over-match)
  assert.ok(!keys.has("inference"));
  // generic short id: no single-token tail leaks in
  assert.ok(!branchKeysFor("task-cc-fix").has("fix"));
});

test("referencedPaths extracts slash-paths and bare filenames", () => {
  const { paths, basenames } = referencedPaths("see server/sandbox.js and lib/graph.js plus bare validate.js");
  assert.ok(paths.has("server/sandbox.js"));
  assert.ok(paths.has("lib/graph.js"));
  assert.ok(basenames.has("sandbox.js"));
  assert.ok(basenames.has("validate.js"));
});

// --------------------------------------------------------------------------
// CLI parity (the distiller shells out to this, like lib/validate.js)
// --------------------------------------------------------------------------

test("CLI: reads a JSON payload on stdin, writes proposals JSON on stdout", () => {
  const payload = {
    commit: {
      sha: "8888888888888888888888888888888888888888",
      repo: "spor",
      branch: "overnight/commit-inference",
      message: "implement inference",
      files: ["lib/commit-inference.js"],
    },
    candidates: [NODE, OTHER],
  };
  const r = spawnSync("node", [MOD], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].nodeId, "task-cc-commit-inference");
  assert.equal(out.threshold, DEFAULT_THRESHOLD);
});

test("CLI: malformed JSON on stdin exits non-zero with a diagnostic", () => {
  const r = spawnSync("node", [MOD], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad JSON/);
});
