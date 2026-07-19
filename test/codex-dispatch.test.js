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
const { getHarness, harnesses } = require("../lib/shell/dispatch-harnesses.js");
const { writeSpawnableNodeStub } = require("./helpers/portable.js");

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

function codexStub(home, { delayMs = 0, exitCode = 0 } = {}) {
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
    mcpToken: process.env.SPOR_DISPATCH_MCP_TOKEN || null,
  }, null, 2));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-fixture" }) + "\\n");
  setTimeout(() => process.exit(${exitCode}), ${delayMs});
});
`);
}

async function waitFor(read, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test("dispatch harness registry exposes one uniform adapter contract", () => {
  assert.deepStrictEqual(harnesses().map((adapter) => adapter.id), ["claude-code", "codex"]);
  for (const adapter of harnesses()) {
    assert.strictEqual(typeof adapter.command, "function", `${adapter.id} resolves a binary`);
    assert.strictEqual(typeof adapter.buildArgs, "function", `${adapter.id} builds argv`);
    assert.strictEqual(typeof adapter.validateOptions, "function", `${adapter.id} validates flags`);
    assert.ok(adapter.activeDiscovery && adapter.activeDiscovery.kind, `${adapter.id} declares active-run discovery`);
    assert.ok(["native-background", "supervised-jsonl"].includes(adapter.launchMode));
  }
  assert.strictEqual(getHarness("opencode"), null, "unsupported harnesses never silently substitute");
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

test("Codex adapter launches detached, captures JSONL session, prompt, cwd, and report", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "codex-invocation.json");
  const stub = codexStub(home, { delayMs: 150 });
  const started = Date.now();
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 2000, "dispatch returns after the launch handshake");
  assert.match(result.stdout, /Codex supervisor (running|done)/);

  const invocation = await waitFor(() => fs.existsSync(outfile) && JSON.parse(fs.readFileSync(outfile, "utf8")));
  assert.ok(invocation, "the detached stub ran");
  assert.strictEqual(invocation.cwd, repo);
  assert.deepStrictEqual(invocation.args.slice(0, 6), [
    "--ask-for-approval", "never", "exec", "--json", "--sandbox", "workspace-write",
  ]);
  assert.ok(invocation.args.includes("profile-model"));
  assert.strictEqual(invocation.args.at(-1), "-");
  assert.match(invocation.prompt, /Implement the Codex dispatch fixture/);

  const runDir = path.join(home, "journal", "dispatch");
  const recordFile = await waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    return fs.readdirSync(runDir).find((file) => file.endsWith(".run.json"));
  });
  assert.ok(recordFile);
  const recordPath = path.join(runDir, recordFile);
  const finished = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.state === "done" ? record : null;
  });
  assert.ok(finished, "supervisor records terminal success");
  assert.strictEqual(finished.harness, "codex");
  assert.strictEqual(finished.session_id, "codex-thread-fixture");
  assert.strictEqual(finished.exit_code, 0);
  assert.strictEqual(fs.readFileSync(finished.report_path, "utf8"), "stub final report\n");
});

test("Codex adapter rejects Claude-only options before launch", () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "should-not-launch");
  const stub = codexStub(home);
  const result = run(
    ["dispatch", "task-codex", "--dir", repo, "--profile", "profile-codex", "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CODEX_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /flag is Claude Code-specific/);
  assert.ok(!fs.existsSync(outfile));
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
        SPOR_TOKEN: "person-token",
        SPOR_CODEX_CMD: stub,
        OUTFILE: outfile,
      }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    const invocation = await waitFor(() => fs.existsSync(outfile) && JSON.parse(fs.readFileSync(outfile, "utf8")));
    assert.strictEqual(invocation.sporToken, "agent-secret-token");
    assert.strictEqual(invocation.mcpToken, "agent-secret-token");
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
