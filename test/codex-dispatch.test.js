"use strict";

// Codex adapter coverage for the shared coding-agent dispatch registry. All
// ordinary tests use a real child process but a fake Codex executable; the
// opt-in live CLI smoke test lives in e2e-codex-dispatch.test.js.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { getHarness, harnesses, codexPrepareRun } = require("../lib/shell/dispatch-harnesses.js");
const { writeSpawnableNodeStub, writeNodeScript } = require("./helpers/portable.js");
const { waitFor, awaitJson, awaitRecord, stubExitTail } = require("./helpers/launch.js");

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: cleanEnv(env),
    encoding: "utf8",
  });
}

function runAsync(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: cleanEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-dispatch-"));
  const nodes = path.join(home, "nodes");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-target-"));
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-codex.md"), `---
id: task-codex
type: task
repo: demo
title: Implement the Codex dispatch fixture
summary: Exercise the Codex dispatch adapter in a scratch checkout.
status: open
date: 2026-07-19
---
Exercise the adapter.
`);
  fs.writeFileSync(path.join(nodes, "profile-codex.md"), `---
id: profile-codex
type: profile
title: Codex test profile
summary: A profile selecting Codex for the dispatch test.
harness: codex
model: profile-model
date: 2026-07-19
---
Codex test profile.
`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { capabilities: { declared: { harnesses: ["codex"] } } },
  }, null, 2) + "\n");
  return { home, nodes, repo };
}

function codexStub(home, { delayMs = 0, exitCode = 0, holdFile = null } = {}) {
  return writeSpawnableNodeStub(home, "codex-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const reportAt = args.indexOf("--output-last-message");
  const report = reportAt >= 0 ? args[reportAt + 1] : null;
  if (report) fs.writeFileSync(report, "stub final report\\n");
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify({
    args,
    cwd: process.cwd(),
    prompt,
    sporToken: process.env.SPOR_TOKEN || null,
    substrateToken: process.env.SUBSTRATE_TOKEN || null,
    mcpToken: process.env.SPOR_DISPATCH_MCP_TOKEN || null,
    internalChildToken: process.env.SPOR_DISPATCH_CHILD_TOKEN || null,
  }, null, 2));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-fixture" }) + "\\n");
  ${stubExitTail({ holdFile, exitCode, delayMs })}
});
`);
}

test("dispatch harness registry exposes one uniform adapter contract", () => {
  // The registry is open by design (dec-spor-dispatch-harness-adapter-contract):
  // new harnesses are ADDITIVE entries, so this asserts the two this file owns
  // are present and unchanged rather than that they are the only ones. The
  // whole-registry shape is asserted in opencode-copilot-dispatch.test.js.
  const ids = harnesses().map((adapter) => adapter.id);
  assert.deepStrictEqual(ids.slice(0, 2), ["claude-code", "codex"]);
  for (const adapter of harnesses()) {
    assert.strictEqual(typeof adapter.command, "function", `${adapter.id} resolves a binary`);
    assert.strictEqual(typeof adapter.buildArgs, "function", `${adapter.id} builds argv`);
    assert.strictEqual(typeof adapter.validateOptions, "function", `${adapter.id} validates flags`);
    assert.ok(adapter.activeDiscovery && adapter.activeDiscovery.kind, `${adapter.id} declares active-run discovery`);
    assert.ok(["native-background", "supervised-jsonl"].includes(adapter.launchMode));
  }
  assert.strictEqual(getHarness("gemini"), null, "unsupported harnesses never silently substitute");
});

test("Codex profile dry-run uses adapter argv and model precedence", () => {
  const { home, repo } = fixture();
  const common = ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief", "--print"];
  const fromProfile = run(common, { SPOR_HOME: home });
  assert.strictEqual(fromProfile.status, 0, fromProfile.stderr);
  assert.match(fromProfile.stdout, /harness: codex/);
  assert.match(fromProfile.stdout, /codex --ask-for-approval never exec --json --sandbox workspace-write/);
  assert.match(fromProfile.stdout, /--model profile-model/);

  const override = run([...common, "--model", "flag-model"], { SPOR_HOME: home });
  assert.strictEqual(override.status, 0, override.stderr);
  assert.match(override.stdout, /--model flag-model/);
  assert.doesNotMatch(override.stdout, /--model profile-model/);
});

// task-spor-review-gate-stateful-bounded: a review gate's dispatch runs
// READ-ONLY in the implementer's live checkout. `--read-only` is the harness-
// neutral spelling; the adapter supplies the posture, and it overrides a
// write-capable --sandbox/--permission-mode a worker's passthrough may carry.
test("--read-only dispatches Codex under --sandbox read-only, overriding a passthrough sandbox or bypass", () => {
  const { home, repo } = fixture();
  const common = ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief", "--print", "--read-only"];
  const plain = run(common, { SPOR_HOME: home });
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /codex --ask-for-approval never exec --json --sandbox read-only/);
  assert.doesNotMatch(plain.stderr, /warning: --read-only/);

  const overridden = run([...common, "--sandbox", "danger-full-access"], { SPOR_HOME: home });
  assert.strictEqual(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /--sandbox read-only/);
  assert.match(overridden.stderr, /warning: --read-only overrides --sandbox danger-full-access/);

  // A passthrough bypassPermissions would translate to danger-full-access;
  // the explicit read-only posture wins, without the translation warning.
  const bypass = run([...common, "--permission-mode", "bypassPermissions"], { SPOR_HOME: home });
  assert.strictEqual(bypass.status, 0, bypass.stderr);
  assert.match(bypass.stdout, /--sandbox read-only/);
  assert.doesNotMatch(bypass.stdout, /danger-full-access/);

  for (const adapter of harnesses()) {
    if (adapter.id === "codex") assert.deepStrictEqual(adapter.readOnly, { sandbox: "read-only" });
    if (adapter.id === "claude-code") assert.deepStrictEqual(adapter.readOnly, { permissionMode: "plan" });
    if (adapter.id === "opencode") assert.deepStrictEqual(adapter.readOnly, { agent: "plan" });
    if (adapter.id === "copilot") assert.deepStrictEqual(adapter.readOnly, { denyTools: ["write", "shell"] });
  }
});

test("Codex adapter launches detached, captures JSONL session, prompt, cwd, and report", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "codex-invocation.json");
  // The stub does not exit until the test releases it, so "dispatch returned
  // before the run ended" is an ORDERING fact — the run record cannot be
  // terminal while the child is still held — not a wall-clock bound a loaded
  // box turns into a flake (issue-spor-declared-harness-dispatch-timing-flake).
  const release = path.join(home, "release-the-stub");
  const stub = codexStub(home, { holdFile: release });
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex supervisor (launching|running)/, "dispatch returns after the launch handshake, not after the run");

  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the detached stub ran");
  assert.strictEqual(invocation.cwd, repo);
  assert.deepStrictEqual(invocation.args.slice(0, 6), [
    "--ask-for-approval", "never", "exec", "--json", "--sandbox", "workspace-write",
  ]);
  assert.ok(invocation.args.includes("profile-model"));
  assert.strictEqual(invocation.args.at(-1), "-");
  assert.match(invocation.prompt, /Implement the Codex dispatch fixture/);

  const live = await awaitRecord(home, () => true);
  assert.ok(live, "the supervisor opened a run record");
  assert.notStrictEqual(live.state, "done", "the run is still going after dispatch has returned — the launcher did not wait for it");

  fs.writeFileSync(release, "");
  const finished = await awaitRecord(home, (record) => record.state === "done");
  assert.ok(finished, "supervisor records terminal success");
  assert.strictEqual(finished.harness, "codex");
  assert.strictEqual(finished.session_id, "codex-thread-fixture");
  assert.strictEqual(finished.exit_code, 0);
  assert.strictEqual(fs.readFileSync(finished.report_path, "utf8"), "stub final report\n");
});

test("a supervised run whose supervisor is KILLED mid-run is reconciled to a terminal state by 'spor runs'", async () => {
  // issue-spor-dispatch-supervised-runs-never-reconciled: the supervisor is
  // detached, so if it dies before finalizing, nothing else ever stamps the
  // record — the run reported `running` forever. SIGKILL is the real shape of
  // that crash: no chance to write anything.
  const { home, repo } = fixture();
  const stub = codexStub(home, { delayMs: 30000 });
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: path.join(home, "codex-killed.json") }
  );
  assert.strictEqual(result.status, 0, result.stderr);

  const runDir = path.join(home, "journal", "dispatch");
  const recordPath = await waitFor(() => {
    const file = fs.existsSync(runDir) && fs.readdirSync(runDir).find((f) => f.endsWith(".run.json"));
    if (!file) return null;
    const record = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8"));
    return record.state === "running" && record.runner_pid && record.child_pid ? path.join(runDir, file) : null;
  });
  assert.ok(recordPath, "the supervisor reported its child running");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (process.platform === "linux") {
    // processStartTicks is Linux-only (/proc); elsewhere it stays null by design.
    assert.ok(
      Number.isFinite(record.runner_started_ticks),
      "a real launch stamps the supervisor's kernel start-time tick count (issue-spor-dispatch-supervisor-identity-stale-timeout)"
    );
  }
  for (const pid of [record.runner_pid, record.child_pid]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const gone = await waitFor(() => {
    try { process.kill(record.runner_pid, 0); return null; } catch { return true; }
  });
  assert.ok(gone, "the supervisor is really dead before reconciliation is asked about it");
  // Age it past the registration grace window — the supervisor is normally given
  // a beat to report before absence counts as death.
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, created_at: "2026-07-18T10:00:00.000Z" }, null, 2) + "\n");

  const shown = run(["runs", "--json"], { SPOR_HOME: home });
  assert.strictEqual(shown.status, 0, shown.stderr);
  const reconciled = JSON.parse(shown.stdout).runs[0];
  assert.strictEqual(reconciled.state, "vanished");
  assert.strictEqual(reconciled.termination_signal, "supervisor-gone");
  assert.match(reconciled.termination_reason, /never recorded an outcome/);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(recordPath, "utf8")).state, "vanished",
    "and the terminal outcome is durable, not just printed"
  );
});

// task-spor-nested-codex-dispatch-sandbox-isolation: a failure PARTWAY through
// provisioning the isolated CODEX_HOME (e.g. one projected file copies, the
// next doesn't) must not leave a half-written scratch dir — with a real
// credential copy inside it — sitting around for the supervisor's own
// catch-and-swallow to only clean up on the 14-day prune sweep.
test("codexPrepareRun cleans up a partially-provisioned scratch dir when projection fails partway", () => {
  if (process.platform === "win32") return; // chmod-based read-only has no meaning there
  if (process.getuid && process.getuid() === 0) return; // root writes through any permission bits

  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-real-home-partial-"));
  fs.writeFileSync(path.join(realHome, "auth.json"), '{"token":"real-secret"}\n');
  fs.writeFileSync(path.join(realHome, "config.toml"), "model = \"o-real\"\n");
  fs.chmodSync(realHome, 0o500);

  const scratchDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-scratch-partial-")), "run.scratch");
  // Force config.toml's copy to fail after auth.json's has already succeeded:
  // pre-seat a DIRECTORY at the destination copyFileSync would otherwise
  // write a file to.
  fs.mkdirSync(path.join(scratchDir, "config.toml"), { recursive: true });

  try {
    assert.throws(() => codexPrepareRun({ env: { CODEX_HOME: realHome }, scratchDir }));
    assert.strictEqual(fs.existsSync(scratchDir), false, "the partial provisioning attempt is fully rolled back, including the already-copied auth.json");
  } finally {
    fs.chmodSync(realHome, 0o700);
  }
});

test("Codex adapter rejects Claude-only options before launch", () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "should-not-launch");
  const stub = codexStub(home);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--permission-mode", "acceptEdits", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /flag is Claude Code-specific/);
  assert.ok(!fs.existsSync(outfile));
});

test("Codex adapter still rejects --agent regardless of --permission-mode", () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "should-not-launch");
  const stub = codexStub(home);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--agent", "reviewer", "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /--agent.*Claude Code-specific/);
  assert.ok(!fs.existsSync(outfile));
});

// issue-spor-codex-dispatch-permission-bypass-error: --permission-mode
// bypassPermissions is the one Claude-only value with a real Codex
// equivalent (run fully unattended), so it TRANSLATES with a loud warning
// instead of hard-erroring, while every other permission-mode value keeps
// failing (covered above).
test("Codex dispatch translates --permission-mode bypassPermissions instead of hard-erroring", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "codex-bypass-invocation.json");
  const stub = codexStub(home);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning:.*bypassPermissions.*translating.*danger-full-access.*never/s);

  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the Codex stub launched despite --permission-mode bypassPermissions");
  assert.deepStrictEqual(invocation.args.slice(0, 6), [
    "--ask-for-approval", "never", "exec", "--json", "--sandbox", "danger-full-access",
  ]);
});

test("Codex dispatch preview (--print) shows the translated bypassPermissions argv and warning", () => {
  const { home, repo } = fixture();
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--permission-mode", "bypassPermissions", "--no-brief", "--print"],
    { SPOR_HOME: home }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning:.*bypassPermissions/);
  assert.match(result.stdout, /codex --ask-for-approval never exec --json --sandbox danger-full-access/);
});

test("an explicit --sandbox alongside --permission-mode bypassPermissions is respected, not overridden", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "codex-bypass-explicit-sandbox.json");
  const stub = codexStub(home);
  const result = run(
    [
      "dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex",
      "--permission-mode", "bypassPermissions", "--sandbox", "workspace-write", "--no-brief",
    ],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);

  const invocation = await awaitJson(outfile);
  assert.ok(invocation);
  assert.deepStrictEqual(invocation.args.slice(0, 6), [
    "--ask-for-approval", "never", "exec", "--json", "--sandbox", "workspace-write",
  ]);
});

test("Claude Code dispatch --permission-mode behavior is unchanged", () => {
  const { home, repo } = fixture();
  fs.writeFileSync(path.join(home, "nodes", "profile-claude.md"), `---
id: profile-claude
type: profile
title: Claude Code test profile
summary: A profile selecting Claude Code for the dispatch test.
harness: claude-code
date: 2026-07-19
---
Claude Code test profile.
`);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-claude", "--permission-mode", "bypassPermissions", "--no-brief", "--print"],
    { SPOR_HOME: home }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /warning:.*bypassPermissions/);
  assert.match(result.stdout, /--permission-mode bypassPermissions/);
});

test("remote Codex dispatch binds the thread, renews the lease, and keeps its bearer out of durable state", async () => {
  const { home, repo } = fixture();
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  cfg.dispatch.agent = "agent-test";
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", body });
      if (req.method === "GET" && req.url === "/v1/nodes/task-codex") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: fs.readFileSync(path.join(home, "nodes", "task-codex.md"), "utf8") }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/nodes/profile-codex") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: fs.readFileSync(path.join(home, "nodes", "profile-codex.md"), "utf8") }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/nodes/task-codex/claim") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, lease: { by: "person-test" } }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/agents/agent-test/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "agent-secret-token" }));
        return;
      }
      if (req.method === "POST" && ["/v1/agents/session", "/v1/nodes/task-codex/renew"].includes(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outfile = path.join(home, "remote-invocation.json");
  const stub = codexStub(home);
  try {
    const result = await runAsync(
      ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
      {
        SPOR_HOME: home,
        XDG_CONFIG_HOME: home,
        SPOR_SERVER: base,
        SUBSTRATE_TOKEN: "person-token",
        SPOR_CODEX_CMD: stub,
        OUTFILE: outfile,
      }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    const invocation = await awaitJson(outfile);
    assert.strictEqual(invocation.sporToken, "agent-secret-token");
    assert.strictEqual(invocation.substrateToken, "agent-secret-token");
    assert.strictEqual(invocation.mcpToken, "agent-secret-token");
    assert.strictEqual(invocation.internalChildToken, null);
    assert.ok(invocation.args.some((arg) => /bearer_token_env_var/.test(arg)));
    assert.ok(!invocation.args.some((arg) => arg.includes("agent-secret-token")), "bearer never enters argv");

    const bound = await waitFor(() => hits.find((hit) => hit.url === "/v1/agents/session"));
    const renewed = await waitFor(() => hits.find((hit) => hit.url === "/v1/nodes/task-codex/renew"));
    assert.ok(bound);
    assert.ok(renewed);
    assert.strictEqual(bound.auth, "Bearer agent-secret-token");
    assert.deepStrictEqual(JSON.parse(bound.body), { session: "codex-thread-fixture" });
    assert.deepStrictEqual(JSON.parse(renewed.body), { session: "codex-thread-fixture" });

    const runDir = path.join(home, "journal", "dispatch");
    const recordFile = fs.readdirSync(runDir).find((file) => file.endsWith(".run.json"));
    const recordText = fs.readFileSync(path.join(runDir, recordFile), "utf8");
    const logText = fs.readFileSync(path.join(runDir, recordFile.replace(/\.run\.json$/, ".log")), "utf8");
    assert.doesNotMatch(recordText, /agent-secret-token|person-token/);
    assert.doesNotMatch(logText, /agent-secret-token|person-token/);
    assert.ok(!fs.readdirSync(runDir).some((file) => /\.job\.json$|\.prompt$/.test(file)), "ephemeral secret-adjacent inputs are removed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a supervised Codex launch failure releases the lease established by this dispatch", async () => {
  const { home, repo } = fixture();
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      if (req.method === "GET" && req.url === "/v1/nodes/task-codex") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: fs.readFileSync(path.join(home, "nodes", "task-codex.md"), "utf8") }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/nodes/profile-codex") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: fs.readFileSync(path.join(home, "nodes", "profile-codex.md"), "utf8") }));
        return;
      }
      if (req.method === "POST" && ["/v1/nodes/task-codex/claim", "/v1/nodes/task-codex/release"].includes(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runAsync(
      ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
      {
        SPOR_HOME: home,
        XDG_CONFIG_HOME: home,
        SPOR_SERVER: base,
        SPOR_TOKEN: "person-token",
        SPOR_CODEX_CMD: path.join(home, "missing-codex-binary"),
        SPOR_ALLOW_PERSON_TOKEN: "1", // this test exercises the launch-failure release, not identity/mint
      }
    );
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /could not launch/);
    assert.ok(hits.some((hit) => hit.url === "/v1/nodes/task-codex/claim"));
    assert.ok(hits.some((hit) => hit.url === "/v1/nodes/task-codex/release"));
    assert.match(result.stdout, /released the claim/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a supervisor that exits before reporting anything stamps failed_launch, distinct from a child-launch failure (task-spor-dispatch-supervisor-test-seam)", () => {
  // Unlike the missing-codex-binary case above (the runner starts fine and
  // writes failed_launch itself when IT fails to spawn the child), this
  // simulates the runner process itself dying on startup — a startup crash or
  // OOM before it can write anything at all. SPOR_DISPATCH_RUNNER_CMD swaps
  // out the whole supervisor invocation so this is reproducible without
  // waiting for a real crash.
  const { home, repo } = fixture();
  // A plain .js script, not a .cmd wrapper: the seam runs a script under this
  // node on every platform (see dispatchRunnerCommand in bin/spor.js).
  const crashedRunner = writeNodeScript(path.join(home, "runner-crash.js"), "process.exit(1);");
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: codexStub(home), SPOR_DISPATCH_RUNNER_CMD: crashedRunner }
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /could not launch .*: the Codex supervisor exited with code 1 before reporting its child started/);

  const runDir = path.join(home, "journal", "dispatch");
  const recordFile = fs.readdirSync(runDir).find((f) => f.endsWith(".run.json"));
  assert.ok(recordFile, "the launcher still leaves a durable run record");
  const record = JSON.parse(fs.readFileSync(path.join(runDir, recordFile), "utf8"));
  assert.strictEqual(record.state, "failed_launch");
  assert.strictEqual(record.termination_signal, "supervisor-exited-early");
  assert.match(record.termination_reason, /exited with code 1 before reporting its child started/);

  // the ephemeral job/prompt files are cleaned up alongside the abandoned run
  assert.ok(!fs.readdirSync(runDir).some((f) => /\.job\.json$|\.prompt$/.test(f)));
});

test("a launch failure is reported off the supervisor's own handshake, not inferred from how long the run record takes to update it (task-spor-dispatch-launch-handshake)", async () => {
  // The bug this regression test pins: launchSupervisedHarness used to poll
  // the run record for a fixed 20 x 50ms and infer "launched" from silence.
  // Any delay in the record's own write — an async terminal-state write, a
  // slow disk, anything — could silently outlast that window and read as a
  // false success. This stub writes the handshake signal immediately and then
  // WITHHOLDS the record's own `failed_launch` write until the test releases
  // it. Withholding it indefinitely — rather than delaying it past a deadline
  // and timing the return — is what makes this an ordering proof instead of a
  // wall-clock bound a loaded box can flip
  // (art-spor-declared-harness-dispatch-ordering-assertion): a launcher that
  // inferred its verdict from that write could not have returned at all, and
  // the message it did return names the handshake's error, not the write's.
  const { home, repo } = fixture();
  const release = path.join(home, "release-the-record-write");
  const slowRunner = writeNodeScript(path.join(home, "runner-slow-record.js"), `
const fs = require("node:fs");
const fd = Number(process.env.SPOR_DISPATCH_HANDSHAKE_FD);
try {
  fs.writeSync(fd, JSON.stringify({ ok: false, error: "the codex binary does not exist (stub)" }) + "\\n");
} catch {}
try { fs.closeSync(fd); } catch {}
const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
// Simulate the async terminal-state contract call this record write used to be
// gated behind. The 30s backstop is only so a failed test cannot wedge: the
// release file is what normally lands it.
const deadline = Date.now() + 30000;
const poll = () => {
  if (!fs.existsSync(${JSON.stringify(release)}) && Date.now() <= deadline) return void setTimeout(poll, 25);
  fs.writeFileSync(job.record_path, JSON.stringify({
    state: "failed_launch", error: "the codex binary does not exist (stub, delayed write)",
  }, null, 2));
};
poll();
`);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: codexStub(home), SPOR_DISPATCH_RUNNER_CMD: slowRunner }
  );
  assert.strictEqual(result.status, 1);
  // The message came off the handshake — the record write it used to race is
  // still withheld at this point, so a record-derived message would differ (or
  // still read `launching`).
  assert.match(result.stderr, /could not launch .*: the codex binary does not exist \(stub\)/);

  // And the write really was withheld rather than absent: releasing it lands
  // the other message, the one the launcher demonstrably never read.
  fs.writeFileSync(release, "");
  const record = await awaitRecord(home, (r) => /stub, delayed write/.test(r.error || ""));
  assert.ok(record, "the withheld record write lands once released");
});
