"use strict";
// The `local` execution provider (task-spor-work-local-provider-refactor):
// the worktree + supervisor launch `executeDispatch` used to make inline now
// runs behind the provider contract (lib/shell/providers/local.js), and this
// file holds the proof that nothing observable moved.
//
// 1. The GOLDEN equivalence test. `test/fixtures/providers/local-golden.json`
//    was RECORDED from the pre-refactor executeDispatch (commit 2cef69b, the
//    last one before the provider existed): a fixture dispatch into a scratch
//    git repo with a stub harness, capturing the run record, the job file and
//    the prompt file (copied by a wrapper runner before the real supervisor
//    unlinks them), the journal layout and the dispatch's own stdout. Every
//    volatile value — the run id, the scratch paths, timestamps, pids and
//    start ticks — is normalized to a placeholder, and everything else must be
//    byte-identical. Re-record with SPOR_GOLDEN_RECORD=1 only for a change
//    that DELIBERATELY moves the launch's bytes, and say so in the commit.
// 2. The local provider passes the conformance suite
//    (lib/shell/provider-conformance.js) over REAL supervisor launches.
// 3. Provider resolution: `--provider` > dispatch.provider.default > local, an
//    unknown id refused loudly naming it, by `spor dispatch` and `spor work`.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { gitEnv } = require("./helpers/git.js");
const { hermeticEnv } = require("./helpers/env.js");
const { writeSpawnableNodeStub } = require("./helpers/portable");
const { waitFor } = require("./helpers/launch.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "spor.js");
const RUNNER = path.join(ROOT, "lib", "shell", "agent-dispatch-runner.js");
const GOLDEN = path.join(__dirname, "fixtures", "providers", "local-golden.json");

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

// A scratch repo with one commit, so a worktree can be cut off HEAD.
function gitRepo(prefix = "spor-lprov-repo-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  return fs.realpathSync(dir);
}

function scratchHome(prefix = "spor-lprov-home-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  return home;
}

// A supervisor wrapper that copies the job + prompt files aside BEFORE the
// real supervisor reads (and unlinks) them, then runs the real supervisor in
// this same process so the launch handshake, the record and the log are the
// genuine article.
function capturingRunner(home) {
  const capture = path.join(home, "golden-capture");
  fs.mkdirSync(capture, { recursive: true });
  const body = `
    const fs = require("fs"); const path = require("path");
    const job = process.argv[2];
    const capture = ${JSON.stringify(capture)};
    fs.copyFileSync(job, path.join(capture, "job.json"));
    const parsed = JSON.parse(fs.readFileSync(job, "utf8"));
    fs.copyFileSync(parsed.prompt_path, path.join(capture, "prompt"));
    require(${JSON.stringify(RUNNER)}).runJob(job).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
  `;
  const file = path.join(home, "capturing-runner.js");
  fs.writeFileSync(file, body);
  return { file, capture };
}

function runCli(args, env, cwd) {
  const e = hermeticEnv(env);
  e.XDG_CONFIG_HOME = e.SPOR_HOME;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e, cwd });
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p).split(path.sep).join("/") + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function awaitTerminalRecord(home) {
  return waitFor(() => {
    const dir = path.join(home, "journal", "dispatch");
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    const file = names.find((n) => n.endsWith(".run.json"));
    if (!file) return null;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { return null; }
    return ["done", "failed", "failed_launch", "vanished"].includes(rec.state) ? rec : null;
  }, { timeoutMs: 30000, intervalMs: 50 });
}

// Replace every volatile value with a placeholder so two launches of the same
// fixture compare byte-for-byte on everything that is NOT volatile.
function normalize(text, { runId, home, repo, stub }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let t = String(text);
  t = t.split(runId).join("<RUN>");
  t = t.split(JSON.stringify(home).slice(1, -1)).join("<HOME>");
  t = t.split(JSON.stringify(repo).slice(1, -1)).join("<REPO>");
  t = t.split(JSON.stringify(stub).slice(1, -1)).join("<STUB>");
  t = t.split(home).join("<HOME>").split(repo).join("<REPO>").split(stub).join("<STUB>");
  // The scratch repo's inferred project slug (its kebab-cased basename).
  t = t.split(path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).join("<SLUG>");
  t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>");
  t = t.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  t = t.replace(new RegExp(`"(runner_pid|child_pid|runner_started_ticks|child_started_ticks|rev)": \\d+`, "g"), '"$1": <N>');
  t = t.replace(new RegExp(esc(process.execPath), "g"), "<NODE>");
  return t;
}

// One golden dispatch: a free-text task into a worktree with a stub harness,
// observed to its terminal record. Returns the normalized capture.
function goldenDispatch() {
  const home = scratchHome();
  const repo = gitRepo();
  const stub = writeSpawnableNodeStub(home, "claude-golden", 'process.stdout.write(""); process.exit(0);');
  const runner = capturingRunner(home);
  const r = runCli(
    ["dispatch", "golden provider equivalence task", "--no-brief", "--worktree", "--name", "golden-run"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_DISPATCH_RUNNER_CMD: runner.file },
    repo,
  );
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const m = /^run:\s+([0-9a-f-]{36})/m.exec(r.stdout);
  assert.ok(m, `the dispatch names its run id:\n${r.stdout}`);
  const runId = m[1];
  return awaitTerminalRecord(home).then((record) => {
    assert.ok(record, "the stub run reached a terminal state");
    const ctx = { runId, home, repo, stub };
    const read = (f) => fs.readFileSync(f, "utf8");
    const runDir = path.join(home, "journal", "dispatch");
    const capture = {
      stdout: normalize(r.stdout, ctx),
      stderr: normalize(r.stderr, ctx),
      record: normalize(read(path.join(runDir, `${runId}.run.json`)), ctx),
      job: normalize(read(path.join(runner.capture, "job.json")), ctx),
      prompt: normalize(read(path.join(runner.capture, "prompt")), ctx),
      journal: listTree(path.join(home, "journal")).map((p) => p.split(runId).join("<RUN>")),
      worktree: {
        dir: normalize(path.join(repo, ".claude", "worktrees", "golden-run"), ctx),
        exists: fs.existsSync(path.join(repo, ".claude", "worktrees", "golden-run")),
        branch: git(repo, ["rev-parse", "--abbrev-ref", "golden-run"]).trim(),
      },
    };
    return { capture, home, repo };
  });
}

test("golden: the local provider's dispatch is byte-identical to the pre-refactor launch", async () => {
  const { capture } = await goldenDispatch();
  if (process.env.SPOR_GOLDEN_RECORD === "1") {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(capture, null, 2) + "\n");
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  for (const key of ["stdout", "stderr", "record", "job", "prompt", "journal", "worktree"]) {
    assert.deepStrictEqual(capture[key], golden[key], `${key} differs from the recorded golden`);
  }
});
