"use strict";

// Opt-in end-to-end smoke test for the real Codex CLI dispatch adapter. Unlike
// the hermetic fake-binary suite, this consumes the operator's existing Codex
// authentication and may call the live model service. `npm test` therefore
// skips it; `npm run test:e2e:codex` opts in explicitly.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const u = require("../scripts/engines/util.js");

function codexCommand() {
  return process.env.SPOR_E2E_CODEX_BIN || u.whichSync("codex") || null;
}

function skipReason() {
  if (process.env.SPOR_E2E === "0") return "SPOR_E2E=0";
  const optedIn = process.env.SPOR_E2E_CODEX === "1" || process.env.npm_lifecycle_event === "test:e2e:codex";
  if (!optedIn) return "live Codex dispatch requires npm run test:e2e:codex (or SPOR_E2E_CODEX=1)";
  const cmd = codexCommand();
  if (!cmd) return "codex CLI is not installed";
  const version = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) return `could not execute Codex CLI: ${(version.error && version.error.message) || version.stderr}`;
  return false;
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
}

async function waitFor(read, { timeoutMs = 180000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

const skip = skipReason();
if (!skip) {
  const version = spawnSync(codexCommand(), ["--version"], { encoding: "utf8" }).stdout.trim();
  console.error(`# e2e: ${version || "Codex version unknown"}`);
}

test("real Codex CLI completes a profile-selected spor dispatch in a scratch repo", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-e2e-codex-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-e2e-codex-repo-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# Codex dispatch E2E fixture\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Spor E2E", "-c", "user.email=spor-e2e@example.invalid", "commit", "-qm", "fixture"]);

  fs.writeFileSync(path.join(nodes, "task-codex-e2e.md"), `---
id: task-codex-e2e
type: task
repo: codex-e2e
title: Create codex-dispatch-e2e.txt containing exactly SPOR_CODEX_DISPATCH_E2E and do not change any other file
summary: A live Codex CLI smoke test for the spor dispatch adapter.
status: open
date: 2026-07-19
---
Create the requested sentinel file and make no other changes.
`);
  fs.writeFileSync(path.join(nodes, "profile-codex-e2e.md"), `---
id: profile-codex-e2e
type: profile
title: Live Codex E2E profile
summary: Selects the Codex CLI for the live dispatch smoke test.
harness: codex
date: 2026-07-19
---
Live test profile.
`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { capabilities: { declared: { harnesses: ["codex"] } } },
  }, null, 2) + "\n");

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  Object.assign(env, {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    SPOR_CODEX_CMD: codexCommand(),
    SPOR_FAKE_AGENTS_JSON: "[]",
  });
  const args = [
    CLI, "dispatch", "task-codex-e2e", "--dir", repo,
    "--profile", "profile-codex-e2e", "--no-brief", "--no-worktree",
  ];
  if (process.env.SPOR_E2E_CODEX_MODEL) args.push("--model", process.env.SPOR_E2E_CODEX_MODEL);
  const launched = spawnSync(process.execPath, args, { env, cwd: repo, encoding: "utf8", timeout: 30000 });
  assert.strictEqual(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /Codex supervisor/);

  const runDir = path.join(home, "journal", "dispatch");
  const recordPath = await waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const file = fs.readdirSync(runDir).find((name) => name.endsWith(".run.json"));
    return file ? path.join(runDir, file) : null;
  });
  assert.ok(recordPath, "dispatch should create a supervised run record");
  const record = await waitFor(() => {
    const current = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return ["done", "failed", "failed_launch"].includes(current.state) ? current : null;
  });
  assert.ok(record, "real Codex run should reach a terminal state");
  const log = fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path, "utf8") : "(log missing)";
  assert.strictEqual(record.state, "done", `Codex failed (${record.error || "no recorded error"}):\n${log}`);
  assert.strictEqual(record.exit_code, 0);
  assert.ok(record.session_id, "thread.started should be captured from real Codex JSONL");
  assert.ok(fs.existsSync(record.report_path), "Codex should write its final report");
  assert.strictEqual(fs.readFileSync(path.join(repo, "codex-dispatch-e2e.txt"), "utf8").trim(), "SPOR_CODEX_DISPATCH_E2E");
  assert.ok(!fs.existsSync(path.join(repo, ".spor")), "the smoke test should not modify unrelated files");
});
