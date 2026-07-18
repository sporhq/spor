// scripts/engines/infer-commits.js — the engine that scores this session's
// untrailered commits and proposes confident links through the capture path
// (task-cc-commit-inference). See test/commit-inference.test.js for the pure
// scorer; this exercises the engine's HTTP side: the /v1/capture body it
// actually sends (issue-spor-infer-commits-project-explicit-missing).
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const { inferCommits } = require("../scripts/engines/infer-commits.js");

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-infer-commits-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const home = path.join(root, "graph");
  fs.mkdirSync(home, { recursive: true });
  return { repo, home };
}

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

// Records every request; answers 200 with a body shaped like a real
// /v1/capture response (see test/hookcli.test.js's stubServer).
function stubServer() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "captured", ids: ["x"], nodes: [], summary: "ok" }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("infer-commits: /v1/capture body marks project_explicit false (ambient slug, not a --project declaration)", async () => {
  const { repo, home } = scratch();
  // A branch named after the candidate node id is a confident link on the
  // branch-id signal alone (see test/commit-inference.test.js), independent
  // of message/file overlap — keeps this test about the capture body, not
  // the scorer's heuristics.
  git(repo, ["init", "-q", "-b", "task-test-node"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "x");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "wip"]);
  const sha = git(repo, ["rev-parse", "HEAD"]).trim();

  const journal = path.join(repo, "journal.jsonl");
  fs.writeFileSync(journal, JSON.stringify({ tool: "git-commit", sha, nodes: [] }) + "\n");

  const { srv, hits, base } = await stubServer();
  const saved = {
    SPOR_SERVER: process.env.SPOR_SERVER,
    SPOR_INFER_COMMITS: process.env.SPOR_INFER_COMMITS,
    SPOR_HOME: process.env.SPOR_HOME,
  };
  process.env.SPOR_SERVER = base;
  process.env.SPOR_INFER_COMMITS = "1";
  process.env.SPOR_HOME = home;
  try {
    await inferCommits({
      repo,
      journal,
      index: "task-test-node — Some candidate title\n",
      slug: "projx",
      session: "sess-infer",
    });
  } finally {
    srv.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const cap = hits.find((h) => h.url === "/v1/capture");
  assert.ok(cap, "inferCommits POSTed the confident proposal to /v1/capture");
  const sent = JSON.parse(cap.body);
  assert.strictEqual(sent.context.project, "projx");
  assert.strictEqual(
    sent.context.project_explicit,
    false,
    "commit inference derives project from the ambient cwd slug, never a user --project declaration — " +
      "omitting this let the ELABORATE fold falsely warn of a project mismatch"
  );
});
