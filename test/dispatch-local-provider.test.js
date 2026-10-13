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
    // Terminal AND settled: a supervised record goes terminal carrying a
    // provisional outcome and the contract's verdict merges in a beat later
    // (`contract_pending`), so the golden is read only once that landed.
    return ["done", "failed", "failed_launch", "vanished"].includes(rec.state) && rec.contract_pending === false ? rec : null;
  }, { timeoutMs: 30000, intervalMs: 50 });
}

// Replace every volatile value with a placeholder so two launches of the same
// fixture compare byte-for-byte on everything that is NOT volatile.
function normalize(text, { runId, home, repo, stub }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let t = String(text);
  t = t.split(runId).join("<RUN>");
  // Every spelling of a scratch path: on Windows os.tmpdir() can be an 8.3
  // short path (RUNNER~1) that git and the CLI report in its long form, which
  // only the native realpath recovers.
  const spellings = (p) => [...new Set([p, fs.realpathSync.native(p)])].sort((a, b) => b.length - a.length);
  for (const [value, mark] of [[home, "<HOME>"], [repo, "<REPO>"], [stub, "<STUB>"]]) {
    for (const p of spellings(value)) {
      t = t.split(JSON.stringify(p).slice(1, -1)).join(mark);
      t = t.split(p).join(mark);
    }
  }
  if (process.platform === "win32") {
    // The goldens are recorded on POSIX: a path under a placeholder is spelled
    // with `/`, and the Windows stub is the `.cmd` wrapper around the `.js`.
    t = t.replace(/(<HOME>|<REPO>|<STUB>)((?:\\\\|\\)[^"\s]*)/g, (_, mark, rest) => mark + rest.replace(/\\\\|\\/g, "/"));
    t = t.split("claude-golden.cmd").join("claude-golden.js");
  }
  // The scratch repo's inferred project slug (its kebab-cased basename).
  t = t.split(path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).join("<SLUG>");
  t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>");
  t = t.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  // `rev` (the count of record puts) IS normalized: the launcher's pid stamp
  // and the supervisor's own writes race under load (4 or 5 puts for the
  // same launch), so pinning it literally flakes the full suite.
  t = t.replace(new RegExp(`"(runner_pid|child_pid|runner_started_ticks|child_started_ticks|rev)": \\d+`, "g"), '"$1": <N>');
  t = t.replace(new RegExp(esc(process.execPath), "g"), "<NODE>");
  return t;
}

// The two golden shapes: a free-text task into a worktree, and a NODE dispatch
// into the shared checkout (`--no-worktree`, the other half of submit's
// branches, with the node fields on the record and job file).
const GOLDENS = {
  worktree: {
    file: GOLDEN,
    args: ["dispatch", "golden provider equivalence task", "--no-brief", "--worktree", "--name", "golden-run"],
    worktree: true,
  },
  node: {
    file: path.join(__dirname, "fixtures", "providers", "local-golden-node.json"),
    args: ["dispatch", "task-golden", "--no-brief", "--no-worktree", "--name", "golden-run"],
    worktree: false,
  },
};

// A stub harness body that runs only once the prompt on stdin is fully read. A
// stub that exits without reading it races the supervisor's prompt write, and
// under load the write loses: EPIPE, and a run that exited 0 is recorded
// `failed` / "write EPIPE" (issue-spor-dispatch-local-provider-golden-epipe,
// the same race as issue-spor-agent-dispatch-runner-test-309-load-flake). These
// tests are about the launch, not that race.
function afterPrompt(body) {
  return `process.stdin.resume(); process.stdin.on("end", () => {\n${body}\n});`;
}

// One golden dispatch with a stub harness, observed to its terminal record.
// Returns the normalized capture.
function goldenDispatch(shape = GOLDENS.worktree) {
  const home = scratchHome();
  const repo = gitRepo();
  fs.writeFileSync(
    path.join(home, "nodes", "task-golden.md"),
    `---\nid: task-golden\ntype: task\nrepo: golden\ntitle: Golden provider equivalence node\nsummary: A fixture task the golden node dispatch runs, stamped to the scratch repo.\ndate: 2026-10-01\n---\nDo the golden work.\n`,
  );
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { repos: { golden: repo } } }));
  // The node shape dispatches INTO the mapped checkout, whose identity must
  // match the node's `repo: golden` stamp (the slug→path corruption guard).
  if (!shape.worktree) fs.writeFileSync(path.join(repo, ".spor"), "project: golden\n");
  const stub = writeSpawnableNodeStub(home, "claude-golden", afterPrompt('process.stdout.write(""); process.exit(0);'));
  const runner = capturingRunner(home);
  const r = runCli(
    shape.args,
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
        branch: shape.worktree ? git(repo, ["rev-parse", "--abbrev-ref", "golden-run"]).trim() : null,
      },
    };
    return { capture, home, repo };
  });
}

for (const [name, shape] of Object.entries(GOLDENS)) {
  test(`golden (${name}): the local provider's dispatch is byte-identical to the pre-refactor launch`, async () => {
    const { capture } = await goldenDispatch(shape);
    if (process.env.SPOR_GOLDEN_RECORD === "1") {
      fs.mkdirSync(path.dirname(shape.file), { recursive: true });
      fs.writeFileSync(shape.file, JSON.stringify(capture, null, 2) + "\n");
      return;
    }
    const golden = JSON.parse(fs.readFileSync(shape.file, "utf8"));
    for (const key of ["stdout", "stderr", "record", "job", "prompt", "journal", "worktree"]) {
      assert.deepStrictEqual(capture[key], golden[key], `${key} differs from the recorded golden`);
    }
  });
}

// ------------------------------------------------------------- conformance

const conf = require("../lib/shell/provider-conformance");
const sat = require("../lib/kernel/satisfiability");
const pc = require("../lib/kernel/provider-contract");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses");
const { loadConfig } = require("../lib/config.js");
const { createLocalProvider } = require("../lib/shell/providers/local.js");
const providers = require("../lib/shell/providers/index.js");
const cli = require(CLI);

// The real local provider over a scratch home: the CLI's own worktree and
// supervisor helpers as its host, a scratch repo mapped as `conformance` with
// an https origin (a manifest's candidate must be fetchable off the
// environment), and three stub harnesses — one that commits and exits, one
// that holds until it is signalled, and one that commits and THEN holds (a
// candidate a cancel must still leave collectable). `providerOpts` reach
// createLocalProvider (the platform whose stop doors it uses, the grace).
function conformanceSetup(providerOpts = {}) {
  const home = scratchHome("spor-lprov-conf-");
  const repo = gitRepo("spor-lprov-conf-repo-");
  git(repo, ["remote", "add", "origin", "https://conformance.spor.invalid/conformance.git"]);
  // The origin is REACHABLE: collect publishes the candidate branch there and
  // reads it back before naming it (task-spor-attempt-bundle-run): the
  // remote's PUSH url is a scratch bare repo, its fetch url (the locator a
  // manifest names) stays https.
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "spor-lprov-origin-"));
  git(origin, ["init", "-q", "--bare"]);
  git(repo, ["config", "remote.origin.pushurl", origin]);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { repos: { conformance: repo }, capabilities: { declared: { harnesses: ["claude-code"] } } },
  }));
  const cfg = loadConfig({ cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, HOME: home }) });
  const stubs = {
    complete: writeSpawnableNodeStub(home, "claude-complete", afterPrompt(`
      const { spawnSync } = require("child_process");
      const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "conformance candidate"], { cwd: process.cwd(), stdio: "ignore" });
      process.exit(r.status === 0 ? 0 : 3);
    `)),
    hold: writeSpawnableNodeStub(home, "claude-hold", "setInterval(() => {}, 1000);"),
    commitHold: writeSpawnableNodeStub(home, "claude-commit-hold", afterPrompt(`
      const { spawnSync } = require("child_process");
      spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "cancelled candidate"], { cwd: process.cwd(), stdio: "ignore" });
      setInterval(() => {}, 1000);
    `)),
  };
  const lines = { out: [], err: [] };
  const provider = createLocalProvider({
    cfg,
    host: {
      out: (m) => lines.out.push(m),
      err: (m) => lines.err.push(m),
      createDispatchWorktree: cli.createDispatchWorktree,
      removeDispatchWorktree: cli.removeDispatchWorktree,
      launchSupervisedHarness: cli.launchSupervisedHarness,
    },
    ...providerOpts,
  });
  const adapter = dispatchHarnesses.getHarness("claude-code");
  let n = 0;
  const driver = {
    attempt(base, behavior) {
      const name = `conf-${base.execution_id.slice(5, 13)}-${++n}`;
      const args = adapter.buildArgs({
        name, model: null, permissionMode: null, agent: null, mcpConfig: null, sandbox: null, approvalPolicy: null,
        reportPath: dispatchHarnesses.REPORT_PLACEHOLDER, sporMcp: null, readOnly: null,
      });
      return {
        ...base,
        local: {
          repoDir: repo, name, slug: "conformance", nodeId: null, useWorktree: true,
          launch: {
            adapter, command: stubs[behavior], args, readOnly: false, name, nodeId: null,
            prompt: `conformance ${behavior} ${base.execution_id}`, server: null, localNodesDir: cfg.nodesDir(),
            childToken: null, mcpToken: null, bindToken: null, renewToken: null, renewNode: null, releaseNode: null,
            project: "conformance", itemRepo: null, itemCommits: null, resolvedProfile: null, recordFields: null,
          },
        },
      };
    },
    candidate: () => null,
    crash(handle) {
      const rec = dispatchRuns.readRecord(home, provider.runIdOf(handle));
      if (rec && rec.runner_pid) process.kill(rec.runner_pid, "SIGKILL");
    },
    environments: () => provider.environments(),
    pollIntervalMs: 100,
    maxPolls: 600,
  };
  return { home, repo, origin, cfg, provider, driver, lines };
}

test("the local provider passes the conformance suite over real supervisor launches", async () => {
  const { home, provider, driver } = conformanceSetup();
  const report = await conf.runConformance(provider, { home, driver, matcher: sat.satisfiesAttempt });
  // `local` takes no attempt-token delivery — its harness runs under this
  // worker's own launch (PROVIDERS.md §4.3) — so credential-rotation is the one
  // scenario it skips, and it says why.
  assert.deepStrictEqual(report.results.filter((r) => !r.ok || (r.skipped && r.name !== "credential-rotation")), [], JSON.stringify(report.results, null, 2));
  assert.match(report.results.find((r) => r.name === "credential-rotation").skipped, /does not advertise lifecycle 'deliver_credential'/);
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.results.map((r) => r.name), [...conf.SCENARIO_NAMES]);
  assert.strictEqual(provider.environments(), 0, "every scenario released what it submitted");
});

test("the local provider's collect publishes the candidate the harness committed to the repo's origin, then names it", async () => {
  const { home, repo, origin, provider, driver } = conformanceSetup();
  const r = await conf.runScenario(provider, "observe-collect", { home, driver, matcher: sat.satisfiesAttempt });
  assert.strictEqual(r.skipped, undefined);
  // Drive one more attempt by hand to look at the manifest itself.
  const base = {
    contract_version: 1, attempt_id: "w:1", execution_id: `exec-${"a".repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  };
  const attempt = driver.attempt(base, "complete");
  const res = await provider.request({ contract_version: 1, id: "r1", op: "submit", params: { attempt, idempotency_key: "manual-key-1" } });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const handle = res.result.handle;
  assert.strictEqual(handle.provider, "local");
  assert.ok(fs.existsSync(path.join(home, "journal", "dispatch", `${handle.id}.run.json`)), "the handle id IS the run id");
  let obs;
  for (let i = 0; i < 600; i++) {
    obs = (await provider.request({ contract_version: 1, id: "o", op: "observe", params: { handle } })).result;
    if (obs.state === "finished") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(obs.state, "finished", JSON.stringify(obs));
  assert.deepStrictEqual(obs.exit, { code: 0 });
  const col = (await provider.request({ contract_version: 1, id: "c", op: "collect", params: { handle } })).result;
  assert.ok(col.manifest, JSON.stringify(col));
  const head = git(repo, ["rev-parse", attempt.local.name]).trim();
  assert.strictEqual(col.manifest.candidate.commit, head);
  assert.strictEqual(col.manifest.candidate.branch, attempt.local.name);
  assert.deepStrictEqual(col.manifest.candidate.reference, {
    kind: "branch", locator: "https://conformance.spor.invalid/conformance.git", ref: `refs/heads/${attempt.local.name}`, commit: head,
  });
  assert.strictEqual(git(origin, ["rev-parse", `refs/heads/${attempt.local.name}`]).trim(), head, "the branch was pushed to the origin before the manifest named it");
  assert.ok(col.manifest.log_refs[0].startsWith("file://"), "the log is referenced");
  const rel = (await provider.request({ contract_version: 1, id: "x", op: "release", params: { handle } })).result;
  assert.deepStrictEqual(rel, { released: true, worktree: { removed: true } });
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", attempt.local.name)), "release removed the worktree");
});

test("the local provider strips a credential from the origin URL before it reaches a manifest; the launch block is part of the idempotency identity", async () => {
  const { repo, provider, driver } = conformanceSetup();
  git(repo, ["remote", "set-url", "origin", "https://ci-bot:s3cr3t-tok@conformance.spor.invalid/conformance.git"]);
  const base = {
    contract_version: 1, attempt_id: "w:1", execution_id: `exec-${"c".repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  };
  const attempt = driver.attempt(base, "complete");
  const submit = (a, id) => provider.request({ contract_version: 1, id, op: "submit", params: { attempt: a, idempotency_key: "cred-key-1" } });
  const res = await submit(attempt, "s1");
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const handle = res.result.handle;
  try {
    // The same attempt read back from a persisted request (the adapter is now plain JSON) is a replay.
    const replay = await submit(JSON.parse(JSON.stringify(attempt)), "s2");
    assert.strictEqual(replay.ok, true, JSON.stringify(replay));
    assert.strictEqual(replay.result.existing, true);
    // A different LAUNCH under the accepted key is a conflict, not a replay.
    const other = { ...attempt, local: { ...attempt.local, launch: { ...attempt.local.launch, prompt: "a different prompt" } } };
    const conflict = await submit(other, "s3");
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.error.code, "idempotency_conflict");
    let obs;
    for (let i = 0; i < 600; i++) {
      obs = (await provider.request({ contract_version: 1, id: "o", op: "observe", params: { handle } })).result;
      if (obs.state === "finished") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(obs.state, "finished", JSON.stringify(obs));
    const col = (await provider.request({ contract_version: 1, id: "c", op: "collect", params: { handle } })).result;
    assert.ok(col.manifest, JSON.stringify(col));
    assert.strictEqual(col.manifest.candidate.reference.locator, "https://conformance.spor.invalid/conformance.git");
    assert.doesNotMatch(JSON.stringify(col), /s3cr3t|ci-bot/);
    assert.deepStrictEqual(pc.validate("collect-result", col).errors, []);
  } finally {
    await provider.request({ contract_version: 1, id: "x", op: "release", params: { handle } });
  }
});

// Submit a completing attempt, wait for it to finish, collect, release.
async function runToCollect(provider, driver, key) {
  const base = {
    contract_version: 1, attempt_id: "w:1", execution_id: `exec-${"d".repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  };
  const res = await provider.request({ contract_version: 1, id: "s", op: "submit", params: { attempt: driver.attempt(base, "complete"), idempotency_key: key } });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const handle = res.result.handle;
  try {
    let obs;
    for (let i = 0; i < 600; i++) {
      obs = (await provider.request({ contract_version: 1, id: "o", op: "observe", params: { handle } })).result;
      if (obs.state === "finished") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(obs.state, "finished", JSON.stringify(obs));
    return (await provider.request({ contract_version: 1, id: "c", op: "collect", params: { handle } })).result;
  } finally {
    await provider.request({ contract_version: 1, id: "x", op: "release", params: { handle } });
  }
}

test("the local provider WITHHOLDS an origin URL it cannot prove credential-free: no locator, no manifest, no leak (issue-spor-provider-url-redaction-fail-open)", async () => {
  const { repo, provider, driver } = conformanceSetup();
  git(repo, ["remote", "set-url", "origin", "https://ci-bot:s3cr3t tok@conformance.spor.invalid/conformance.git"]);
  const col = await runToCollect(provider, driver, "withhold-key-1");
  assert.strictEqual(col.manifest, null, JSON.stringify(col));
  assert.match(col.no_candidate.reason, /cannot be proven free of credentials/);
  assert.doesNotMatch(JSON.stringify(col), /s3cr3t|ci-bot/);
  assert.deepStrictEqual(pc.validate("collect-result", col).errors, []);
});

test("the local provider says a filesystem-path origin is not portable, rather than blaming a credential", async () => {
  const { repo, origin, provider, driver } = conformanceSetup();
  git(repo, ["remote", "set-url", "origin", origin]);
  const col = await runToCollect(provider, driver, "path-key-1");
  assert.strictEqual(col.manifest, null, JSON.stringify(col));
  assert.match(col.no_candidate.reason, /is not an absolute URI/);
  assert.doesNotMatch(col.no_candidate.reason, /credentials/);
});

test("the local provider names the CONFIGURED origin url, not this box's insteadOf rewrite of it", async () => {
  const { home, repo, provider, driver } = conformanceSetup();
  // The fetch url is rewritten onto a local path for this box only; the push
  // still goes to the pushurl bare repo.
  const elsewhere = fs.mkdtempSync(path.join(home, "rewritten-"));
  git(repo, ["config", `url.${elsewhere}.insteadOf`, "https://conformance.spor.invalid/"]);
  assert.strictEqual(git(repo, ["remote", "get-url", "origin"]).trim().startsWith(elsewhere), true, "the rewrite is in force");
  const col = await runToCollect(provider, driver, "raw-key-1");
  assert.ok(col.manifest, JSON.stringify(col));
  assert.strictEqual(col.manifest.candidate.reference.locator, "https://conformance.spor.invalid/conformance.git");
  assert.deepStrictEqual(pc.validate("collect-result", col).errors, []);
});

test("createLocalProvider refuses a host missing a helper, naming it", () => {
  const { cfg } = conformanceSetup();
  assert.throws(() => createLocalProvider({ cfg, host: { out() {}, err() {}, createDispatchWorktree() {}, removeDispatchWorktree() {} } }), /host is missing launchSupervisedHarness/);
});

test("the local provider's describe() is the one spor capabilities providers prints", () => {
  const { home, cfg } = conformanceSetup();
  const r = runCli(["capabilities", "providers", "--json"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const [printed] = JSON.parse(r.stdout).providers;
  const described = require("../lib/shell/providers/local.js").localProviderDescribe(cfg);
  assert.deepStrictEqual(printed.capabilities.isolation, ["worktree"]);
  assert.deepStrictEqual(printed.capabilities.repos, ["conformance"]);
  assert.deepStrictEqual(printed.capabilities.harnesses, described.capabilities.harnesses);
  assert.deepStrictEqual(printed.capabilities.secret_delivery, []);
});

// ---------------------------------------------------------------- resolution

test("resolveProviderId: --provider > dispatch.provider.default > local; an unknown id is a refusal naming it", () => {
  const home = scratchHome();
  const cfgOf = (file) => {
    if (file) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(file));
    return loadConfig({ cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, HOME: home }) });
  };
  assert.deepStrictEqual(providers.resolveProviderId(cfgOf(null)), { id: "local", source: "default" });
  assert.deepStrictEqual(providers.resolveProviderId(cfgOf(null), "local"), { id: "local", source: "--provider" });
  const configured = cfgOf({ dispatch: { provider: { default: "sandbox" } } });
  assert.deepStrictEqual(providers.resolveProviderId(configured), { id: "sandbox", source: "dispatch.provider.default" });
  assert.match(providers.providerRefusal(configured, providers.resolveProviderId(configured)), /^unknown execution provider 'sandbox' \(from dispatch\.provider\.default\) — the providers this machine can run under: local$/);
  assert.deepStrictEqual(providers.resolveProviderId(configured, "local"), { id: "local", source: "--provider" });
  assert.strictEqual(providers.providerRefusal(configured, { id: "local", source: "--provider" }), null);
  const declared = cfgOf({ dispatch: { provider: { stdio: { command: "x" } } } });
  assert.match(providers.providerRefusal(declared, providers.resolveProviderId(declared, "stdio")), /dispatch\.provider\.stdio is declared — `spor provider check stdio` runs the conformance suite against it — but a dispatch cannot launch under a declared provider yet/);
  assert.doesNotMatch(providers.providerRefusal(declared, providers.resolveProviderId(declared, "stdio")), /not shipped/);
  assert.throws(() => providers.createProvider("stdio", { cfg: declared, host: {} }), /no binding for execution provider 'stdio'/);
});

test("spor dispatch --provider missing refuses loudly naming the id, before any side effect", () => {
  const home = scratchHome();
  const repo = gitRepo();
  const r = runCli(["dispatch", "some task text", "--no-brief", "--print", "--provider", "missing"], { SPOR_HOME: home }, repo);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot dispatch: unknown execution provider 'missing' \(from --provider\)/);
  assert.ok(!fs.existsSync(path.join(home, "journal")), "nothing was written");
  // An EMPTY flag value (an unset shell variable, quoted) names nothing and is
  // refused too — never read as unset and routed to the default.
  const empty = runCli(["dispatch", "some task text", "--no-brief", "--print", "--provider", ""], { SPOR_HOME: home }, repo);
  assert.strictEqual(empty.status, 1, empty.stdout + empty.stderr);
  assert.match(empty.stderr, /cannot dispatch: an empty execution provider id \(from --provider\)/);
  const emptyWork = runCli(["work", "--print", "--provider", ""], { SPOR_HOME: home }, repo);
  assert.strictEqual(emptyWork.status, 1, emptyWork.stdout + emptyWork.stderr);
  assert.match(emptyWork.stderr, /spor work: an empty execution provider id \(from --provider\)/);
});

test("spor dispatch --print: the default provider adds no line; an explicit one is named", () => {
  const home = scratchHome();
  const repo = gitRepo();
  const plain = runCli(["dispatch", "some task text", "--no-brief", "--print"], { SPOR_HOME: home }, repo);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /^provider:/m);
  const explicit = runCli(["dispatch", "some task text", "--no-brief", "--print", "--provider", "local"], { SPOR_HOME: home }, repo);
  assert.strictEqual(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /^provider: local  \(via --provider\)$/m);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { provider: { default: "local" } } }));
  const configured = runCli(["dispatch", "some task text", "--no-brief", "--print"], { SPOR_HOME: home }, repo);
  assert.strictEqual(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /^provider: local  \(via dispatch\.provider\.default\)$/m);
});

test("spor work --provider missing refuses to start, naming the id; dispatch.provider.default is honored the same way", () => {
  const home = scratchHome();
  const repo = gitRepo();
  const r = runCli(["work", "--print", "--provider", "missing"], { SPOR_HOME: home }, repo);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /spor work: unknown execution provider 'missing' \(from --provider\)/);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { provider: { default: "elsewhere" } } }));
  const c = runCli(["work", "--print"], { SPOR_HOME: home }, repo);
  assert.strictEqual(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, /spor work: unknown execution provider 'elsewhere' \(from dispatch\.provider\.default\)/);
  const ok = runCli(["work", "--print", "--provider", "local"], { SPOR_HOME: home }, repo);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
});

test("a committable .spor.json cannot bind an execution provider (machine-local like dispatch.harness)", () => {
  const home = scratchHome();
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { provider: { default: "missing" } } }));
  const r = runCli(["dispatch", "some task text", "--no-brief", "--print"], { SPOR_HOME: home }, repo);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^provider:/m);
});

test("a record the local provider closes carries the outcome dimension: cancelled on cancel, vanished on a crashed release", async () => {
  const { home, provider, driver } = conformanceSetup();
  const base = (n) => ({
    contract_version: 1, attempt_id: `w:${n}`, execution_id: `exec-${String(n).repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  });
  const req = async (op, params, id = op) => {
    const res = await provider.request({ contract_version: 1, id, op, params });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    return res.result;
  };
  const untilRunning = async (handle) => {
    for (let i = 0; i < 600; i++) {
      const o = await req("observe", { handle });
      if (o.state === "running") return o;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail("never reached running");
  };
  const record = (handle) => JSON.parse(fs.readFileSync(path.join(home, "journal", "dispatch", `${handle.id}.run.json`), "utf8"));
  // A crashed supervisor's harness child must not outlive release. On Windows
  // the OS already took it down with the supervisor (libuv's child job is
  // kill-on-close), so there is nothing of ours left to reap — only to confirm
  // gone: no longer answering, or its pid now naming another process. An
  // unreadable start time alone proves nothing, so it is never accepted.
  const childGoneOnRelease = async (rec, msg) => {
    if (process.platform === "win32" && rec.child_reaped !== true) {
      const pi = require("../lib/shell/process-identity.js");
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) {
        const now = pi.aliveProbe(rec.child_pid) ? pi.processStartTicks(rec.child_pid) : null;
        gone = !pi.aliveProbe(rec.child_pid) || (now != null && Number.isFinite(rec.child_started_ticks) && now !== rec.child_started_ticks);
        if (!gone) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(gone, msg);
    } else {
      assert.strictEqual(rec.child_reaped, true, msg);
    }
  };
  // A forced cancel: the record is closed as a cancel, with the unenforced
  // outcome every other terminal writer stamps, and the reaped child noted.
  const a = await req("submit", { attempt: driver.attempt(base(1), "hold"), idempotency_key: "shape-cancel" });
  await untilRunning(a.handle);
  const c = await req("cancel", { handle: a.handle, force: true });
  assert.strictEqual(c.state, "finished");
  const cancelled = record(a.handle);
  assert.strictEqual(cancelled.state, "failed");
  assert.strictEqual(cancelled.termination_class, "cancelled");
  assert.strictEqual(cancelled.termination_signal, "provider-force-cancel");
  assert.strictEqual(cancelled.terminal_state, "failed");
  assert.strictEqual(cancelled.terminal_enforced, false);
  assert.match(cancelled.terminal_note, /cancelled through the local provider/);
  assert.strictEqual(cancelled.child_reaped, true);
  await req("release", { handle: a.handle });

  // A crashed supervisor released: never cancelled, so the record reads
  // vanished — a crash torn down, not a cancel.
  const b = await req("submit", { attempt: driver.attempt(base(2), "hold"), idempotency_key: "shape-crash" });
  await untilRunning(b.handle);
  driver.crash(b.handle);
  for (let i = 0; i < 600; i++) {
    if ((await req("observe", { handle: b.handle })).state === "lost") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual((await req("observe", { handle: b.handle })).state, "lost");
  const rel = await req("release", { handle: b.handle });
  assert.strictEqual(rel.released, true);
  const vanished = record(b.handle);
  assert.strictEqual(vanished.state, "vanished");
  assert.strictEqual(vanished.termination_class, "vanished");
  assert.strictEqual(vanished.termination_signal, "supervisor-gone");
  assert.strictEqual(vanished.terminal_state, "failed");
  assert.strictEqual(vanished.terminal_enforced, false);
  await childGoneOnRelease(vanished, "the orphaned harness child was reaped on release");

  // A FORCED cancel of a crashed run takes the same reading through the
  // other door: lost, closed as a vanish, never a cancel.
  const d = await req("submit", { attempt: driver.attempt(base(3), "hold"), idempotency_key: "shape-crash-cancel" });
  await untilRunning(d.handle);
  driver.crash(d.handle);
  for (let i = 0; i < 600; i++) {
    if ((await req("observe", { handle: d.handle })).state === "lost") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const forced = await req("cancel", { handle: d.handle, force: true });
  assert.strictEqual(forced.state, "lost");
  const crashedForced = record(d.handle);
  assert.strictEqual(crashedForced.state, "vanished");
  assert.strictEqual(crashedForced.termination_class, "vanished");
  await childGoneOnRelease(crashedForced, "the crashed run's harness child was reaped on a forced cancel");
  await req("release", { handle: d.handle });

  // A GRACEFUL cancel whose supervisor dies on the signal: the record is
  // closed as the cancel it was, with the outcome dimension.
  const e = await req("submit", { attempt: driver.attempt(base(4), "hold"), idempotency_key: "shape-graceful" });
  await untilRunning(e.handle);
  assert.strictEqual((await req("cancel", { handle: e.handle, force: false })).state, "stopping");
  let settled;
  for (let i = 0; i < 600; i++) {
    settled = await req("observe", { handle: e.handle });
    if (settled.state !== "stopping") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(settled.state, "finished", JSON.stringify(settled));
  const graceful = record(e.handle);
  assert.strictEqual(graceful.termination_class, "cancelled");
  assert.strictEqual(graceful.terminal_state, "failed");
  assert.strictEqual(graceful.terminal_enforced, false);
  await req("release", { handle: e.handle });
  assert.strictEqual(provider.environments(), 0);
});

// A graceful cancel is the same wind-down on every platform
// (issue-spor-windows-local-provider-graceful-cancel-hard-terminates):
// stopping, then finished, the record closed as a cancel with its outcome
// dimension, the harness gone, and the candidate the run committed before the
// stop still collected into a manifest. `win32` is the provider's stop doors
// as Windows has them — the stop file alone, no signal (a Windows SIGTERM is a
// TerminateProcess no handler sees) — driven on EVERY OS so POSIX CI proves
// the supervisor's own wind-down too; on the Windows shard it is the native
// path.
async function gracefulCancelWindDown(t, providerOpts) {
  const { home, provider, driver } = conformanceSetup(providerOpts);
  const n = providerOpts.platform === "win32" ? 6 : 5;
  const base = {
    contract_version: 1, attempt_id: `w:${n}`, execution_id: `exec-${String(n).repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  };
  const req = async (op, params) => {
    const res = await provider.request({ contract_version: 1, id: op, op, params });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    return res.result;
  };
  const sub = await req("submit", { attempt: driver.attempt(base, "commitHold"), idempotency_key: `wind-down-${n}` });
  t.after(() => provider.impl.release({ handle: sub.handle }).catch(() => {}));
  const baseHead = git(sub.env.cwd, ["rev-parse", "HEAD"]).trim();
  assert.ok(await waitFor(() => git(sub.env.cwd, ["rev-parse", "HEAD"]).trim() !== baseHead, { timeoutMs: 60000, intervalMs: 100 }), "the stub committed its candidate");
  const record = () => dispatchRuns.readRecord(home, sub.handle.id);
  assert.strictEqual(record().state, "running");
  const childPid = record().child_pid;

  assert.strictEqual((await req("cancel", { handle: sub.handle, force: false })).state, "stopping");
  const seen = new Set();
  let settled;
  for (let i = 0; i < 600; i++) {
    settled = await req("observe", { handle: sub.handle });
    seen.add(settled.state);
    if (settled.state !== "stopping") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(settled.state, "finished", JSON.stringify(settled));
  assert.deepStrictEqual([...seen].filter((s) => s !== "stopping" && s !== "finished"), [], "only stopping, then finished");
  const rec = await waitFor(() => (record().contract_pending === true ? null : record()), { timeoutMs: 30000, intervalMs: 50 });
  assert.ok(rec, "the terminal-state contract settled");
  assert.strictEqual(rec.state, "failed");
  assert.strictEqual(rec.termination_class, "cancelled");
  assert.match(rec.termination_reason, /cancelled through the local provider \(graceful\)/);
  assert.strictEqual(rec.terminal_state, "failed");
  assert.strictEqual(rec.terminal_enforced, false);
  // WHO closed the record names the door the stop came through: the
  // supervisor itself (the stop file), or the provider after the supervisor
  // died on the POSIX group signal.
  assert.strictEqual(rec.termination_signal, providerOpts.platform === "win32" ? "stop-requested" : "provider-cancel");
  assert.strictEqual(fs.existsSync(dispatchRuns.runPaths(home, sub.handle.id).stop), providerOpts.platform === "win32", "the stop file is Windows' door; POSIX signals");
  assert.ok(await waitFor(() => !dispatchRuns.pidAlive(childPid), { timeoutMs: 15000, intervalMs: 100 }), "the harness is gone");

  const collected = await req("collect", { handle: sub.handle });
  assert.ok(collected.manifest, JSON.stringify(collected));
  assert.strictEqual(collected.manifest.candidate.commit, git(sub.env.cwd, ["rev-parse", "HEAD"]).trim());
  assert.notStrictEqual(collected.manifest.candidate.commit, baseHead);
  assert.strictEqual((await req("release", { handle: sub.handle })).released, true);
}

test("a graceful cancel through the local provider winds down on this platform: stopping -> finished, a cancelled record, a manifest", async (t) => {
  await gracefulCancelWindDown(t, { platform: process.platform });
});

test("a graceful cancel with Windows' stop doors (the stop file alone, no signal) gets the same wind-down from the supervisor itself", async (t) => {
  await gracefulCancelWindDown(t, { platform: "win32" });
});

test("a graceful cancel the supervisor does not answer inside the grace window falls back to a terminate, closed as the cancel it was", async (t) => {
  const home = scratchHome("spor-lprov-grace-");
  const cfg = loadConfig({ cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, HOME: home }) });
  // A "supervisor" that never polls the stop file: a live process of ours
  // named by a run record this provider stamped (adopted by handle).
  const deaf = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(deaf.pid, "SIGKILL"); } catch { /* gone */ } });
  assert.ok(await waitFor(() => dispatchRuns.pidAlive(deaf.pid), { timeoutMs: 10000, intervalMs: 50 }));
  const runId = "deaf-run";
  const paths = dispatchRuns.runPaths(home, runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  const ticks = dispatchRuns.processStartTicks(deaf.pid);
  fs.writeFileSync(paths.record, JSON.stringify({
    run_id: runId, state: "running", created_at: new Date().toISOString(), runner_pid: deaf.pid,
    ...(ticks != null ? { runner_started_ticks: ticks } : {}),
    provider_attempt: { provider: "local", idempotency_key: "deaf-key", attempt: {} },
  }));
  const host = { out() {}, err() {}, createDispatchWorktree: cli.createDispatchWorktree, removeDispatchWorktree: cli.removeDispatchWorktree, launchSupervisedHarness: cli.launchSupervisedHarness };
  let clock = Date.now();
  const provider = createLocalProvider({ cfg, host, platform: "win32", stopGraceMs: 30000, now: () => new Date(clock).toISOString() });
  const handle = { provider: "local", id: runId };
  assert.strictEqual((await provider.impl.cancel({ handle, force: false })).state, "stopping");
  assert.ok(fs.existsSync(paths.stop), "the stop was requested through the file");
  assert.ok(dispatchRuns.pidAlive(deaf.pid), "no signal went out with Windows' doors");
  assert.strictEqual((await provider.impl.observe({ handle })).state, "stopping", "inside the grace window the stop is still pending");
  clock += 30000;
  const end = await provider.impl.observe({ handle });
  assert.strictEqual(end.state, "finished", JSON.stringify(end));
  assert.ok(await waitFor(() => !dispatchRuns.pidAlive(deaf.pid), { timeoutMs: 10000, intervalMs: 50 }), "the deaf supervisor was terminated");
  const rec = dispatchRuns.readRecord(home, runId);
  assert.strictEqual(rec.termination_class, "cancelled");
  assert.strictEqual(rec.termination_signal, "provider-cancel");
  assert.strictEqual(rec.signal, "SIGKILL");
  assert.strictEqual(rec.terminal_enforced, false);
});

test("a restarted local provider adopts what an earlier process submitted: lookup and submit by the persisted key, observe and release by handle — one run (task-spor-work-attempt-handle-adoption)", async () => {
  const { home, cfg, provider, driver } = conformanceSetup();
  const base = {
    contract_version: 1, attempt_id: "w:adopt", execution_id: `exec-${"c".repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
    isolation: "worktree", prompt_bundle_ref: "https://x.invalid/p.tar",
  };
  const attempt = driver.attempt(base, "hold");
  const key = `exec-${"c".repeat(16)}/a1/1/w:adopt`;
  const first = await provider.impl.submit({ attempt, idempotency_key: key });
  const rec = dispatchRuns.readRecord(home, first.handle.id);
  assert.strictEqual(rec.provider_attempt.idempotency_key, key, "the key rides the run record's creation write");
  assert.strictEqual(rec.provider_attempt.attempt.execution_id, base.execution_id);
  assert.strictEqual("local" in rec.provider_attempt.attempt, false, "the live launch block is never persisted");

  // The "restart": a fresh provider instance with an empty handle table.
  const host = { out() {}, err() {}, createDispatchWorktree: cli.createDispatchWorktree, removeDispatchWorktree: cli.removeDispatchWorktree, launchSupervisedHarness: cli.launchSupervisedHarness };
  const again = createLocalProvider({ cfg, host });
  const found = again.impl.lookup({ idempotency_key: key });
  assert.deepStrictEqual(found && found.handle, first.handle);
  assert.strictEqual(again.impl.lookup({ idempotency_key: "never-submitted-key" }), null);
  const resent = await again.impl.submit({ attempt, idempotency_key: key });
  assert.strictEqual(resent.existing, true);
  assert.deepStrictEqual(resent.handle, first.handle);
  assert.strictEqual(dispatchRuns.readRunRecords(home).length, 1, "no second run was launched");
  let obs;
  for (let i = 0; i < 600; i++) {
    obs = await again.impl.observe({ handle: first.handle });
    if (obs.state === "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(obs.state, "running");
  const rel = await again.impl.release({ handle: first.handle });
  assert.deepStrictEqual(rel, { released: true, worktree: { removed: true } });
  assert.ok(dispatchRuns.TERMINAL_STATES.has(dispatchRuns.readRecord(home, first.handle.id).state));
});
