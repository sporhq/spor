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

// ------------------------------------------------------------- conformance

const conf = require("../lib/shell/provider-conformance");
const sat = require("../lib/kernel/satisfiability");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses");
const { loadConfig } = require("../lib/config.js");
const { createLocalProvider } = require("../lib/shell/providers/local.js");
const providers = require("../lib/shell/providers/index.js");
const cli = require(CLI);

// The real local provider over a scratch home: the CLI's own worktree and
// supervisor helpers as its host, a scratch repo mapped as `conformance` with
// an https origin (a manifest's candidate must be fetchable off the
// environment), and two stub harnesses — one that commits and exits, one that
// holds until it is signalled.
function conformanceSetup() {
  const home = scratchHome("spor-lprov-conf-");
  const repo = gitRepo("spor-lprov-conf-repo-");
  git(repo, ["remote", "add", "origin", "https://conformance.spor.invalid/conformance.git"]);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { repos: { conformance: repo }, capabilities: { declared: { harnesses: ["claude-code"] } } },
  }));
  const cfg = loadConfig({ cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, HOME: home }) });
  const stubs = {
    complete: writeSpawnableNodeStub(home, "claude-complete", `
      const { spawnSync } = require("child_process");
      const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "conformance candidate"], { cwd: process.cwd(), stdio: "ignore" });
      process.exit(r.status === 0 ? 0 : 3);
    `),
    hold: writeSpawnableNodeStub(home, "claude-hold", "setInterval(() => {}, 1000);"),
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
  return { home, repo, cfg, provider, driver, lines };
}

test("the local provider passes the conformance suite over real supervisor launches", async () => {
  const { home, provider, driver } = conformanceSetup();
  const report = await conf.runConformance(provider, { home, driver, matcher: sat.satisfiesAttempt });
  assert.deepStrictEqual(report.results.filter((r) => !r.ok || r.skipped), [], JSON.stringify(report.results, null, 2));
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.results.map((r) => r.name), [...conf.SCENARIO_NAMES]);
  assert.strictEqual(provider.environments(), 0, "every scenario released what it submitted");
});

test("the local provider's collect names the candidate the harness committed, through the repo's origin", async () => {
  const { home, repo, provider, driver } = conformanceSetup();
  const r = await conf.runScenario(provider, "observe-collect", { home, driver, matcher: sat.satisfiesAttempt });
  assert.strictEqual(r.skipped, undefined);
  // Drive one more attempt by hand to look at the manifest itself.
  const base = {
    contract_version: 1, attempt_id: "w:1", execution_id: `exec-${"a".repeat(16)}`, fence: 1, tenant: "t", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: [],
    repos: [{ slug: "conformance", commit: "b".repeat(40), branch: "x" }], egress: { allow: [] }, secrets: [],
    spor: { server: "https://spor.invalid", token_ref: "spor-attempt-token://x/1" }, deadline: new Date(Date.now() + 60000).toISOString(),
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
  assert.ok(col.manifest.log_refs[0].startsWith("file://"), "the log is referenced");
  const rel = (await provider.request({ contract_version: 1, id: "x", op: "release", params: { handle } })).result;
  assert.deepStrictEqual(rel, { released: true, worktree: { removed: true } });
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", attempt.local.name)), "release removed the worktree");
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
  assert.match(providers.providerRefusal(declared, providers.resolveProviderId(declared, "stdio")), /dispatch\.provider\.stdio is declared, but provider bindings are not shipped yet/);
  assert.throws(() => providers.createProvider("stdio", { cfg: declared, host: {} }), /no binding for execution provider 'stdio'/);
});

test("spor dispatch --provider missing refuses loudly naming the id, before any side effect", () => {
  const home = scratchHome();
  const repo = gitRepo();
  const r = runCli(["dispatch", "some task text", "--no-brief", "--print", "--provider", "missing"], { SPOR_HOME: home }, repo);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot dispatch: unknown execution provider 'missing' \(from --provider\)/);
  assert.ok(!fs.existsSync(path.join(home, "journal")), "nothing was written");
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
