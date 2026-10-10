// scripts/engines/infer-commits.js — the engine that scores this session's
// untrailered commits and proposes confident links through the capture path
// (task-cc-commit-inference). See test/commit-inference.test.js for the pure
// scorer; this exercises the engine's HTTP side: the /v1/capture body it
// actually sends (issue-spor-infer-commits-project-explicit-missing).
require("./helpers/tmp-cleanup");
const test = require("node:test");
const { gitEnv } = require("./helpers/git.js");
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
      ...gitEnv(),
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

// Records every request; answers 200 with a body shaped like a real
// /v1/capture response (see test/hookcli.test.js's stubServer).
function stubServer(answer = { status: "captured", ids: ["x"], nodes: [], summary: "ok" }, status = 200) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
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

// One untrailered commit on a branch named after the candidate, run through
// the engine against `answer`; returns the capture hits and the remote log.
async function runOnce(answer, status = 200) {
  const { repo, home } = scratch();
  git(repo, ["init", "-q", "-b", "task-test-node"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "x");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "wip"]);
  const sha = git(repo, ["rev-parse", "HEAD"]).trim();
  const journal = path.join(repo, "journal.jsonl");
  fs.writeFileSync(journal, JSON.stringify({ tool: "git-commit", sha, nodes: [] }) + "\n");
  const { srv, hits, base } = await stubServer(answer, status);
  const saved = { SPOR_SERVER: process.env.SPOR_SERVER, SPOR_INFER_COMMITS: process.env.SPOR_INFER_COMMITS, SPOR_HOME: process.env.SPOR_HOME };
  Object.assign(process.env, { SPOR_SERVER: base, SPOR_INFER_COMMITS: "1", SPOR_HOME: home });
  const run = () => inferCommits({ repo, journal, index: "task-test-node — Some candidate title\n", slug: "projx", session: "sess-infer" });
  try {
    await run();
    await run(); // a re-run over the same journal
  } finally {
    srv.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  let log = "";
  try {
    log = fs.readFileSync(path.join(home, "journal", "remote.log"), "utf8");
  } catch {}
  return { caps: hits.filter((h) => h.url === "/v1/capture").map((h) => JSON.parse(h.body)), log, home };
}

test("infer-commits: every capture carries a content-addressed idempotency key, stable across re-runs", async () => {
  const { caps } = await runOnce();
  assert.strictEqual(caps.length, 2);
  assert.match(caps[0].idempotency_key, /^[0-9a-f]{64}$/);
  assert.strictEqual(caps[1].idempotency_key, caps[0].idempotency_key, "a re-run replays the same key so the server dedupes it");
});

test("infer-commits: a 200 marked partial is surfaced in the remote log", async () => {
  const { log } = await runOnce({ status: "captured", ids: ["task-a"], partial: true, landed: ["task-a"], deferred: ["task-b"], pending_id: "cap-1" });
  assert.match(log, /partial capture: task-a landed; task-b not written — the text is preserved as cap-1/);
});

const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

test("infer-commits: a transient capture failure is spooled under a key-derived name for the drain, never dropped", async () => {
  // A 5xx the server marks non-replayable is returned at once (no in-call
  // retry); the capture is keyed, so the drain's replay answers the pinned
  // reply rather than filing twice.
  const { caps, log, home } = await runOnce({ error: { code: "internal", message: "boom", retryable: false } }, 500);
  assert.strictEqual(caps.length, 2);
  const spooled = listJson(path.join(home, "outbox"));
  assert.strictEqual(spooled.length, 1, "the re-run rewrites the same key-named spool file");
  assert.match(spooled[0], /^infer-[0-9a-f]{12}-[0-9a-f]{12}\.capture\.json$/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, "outbox", spooled[0]), "utf8")), caps[0]);
  assert.match(log, /spooled to outbox\/infer-/);
});

test("infer-commits: a permanent capture reject is dead-lettered once, not dropped or duplicated by a re-run", async () => {
  const { caps, log, home } = await runOnce({ error: { code: "invalid", message: "nope" } }, 422);
  assert.strictEqual(caps.length, 2);
  assert.deepStrictEqual(listJson(path.join(home, "outbox")), []);
  const dead = listJson(path.join(home, "outbox", "dead"));
  assert.strictEqual(dead.length, 1, "an identical dead-letter is adopted, not suffixed");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, "outbox", "dead", dead[0]), "utf8")), caps[0]);
  assert.match(log, /capture rejected \(http=422\); dead-lettered to outbox\/dead\/infer-/);
});
