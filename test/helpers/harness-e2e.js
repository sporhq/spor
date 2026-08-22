"use strict";

// Shared scaffolding for the per-harness live dispatch smoke suites
// (task-spor-dispatch-adapters-opencode-copilot). Each harness gets its OWN
// test file — the suites are dedicated, as the acceptance bar requires — but
// the skip discipline, scratch fixture, and record polling are identical, and
// duplicating them per harness is how they drift apart.
//
// The discipline these encode, from test/e2e-claude.test.js: a suite that
// needs a real third-party binary must SELF-SKIP when that binary is absent or
// SPOR_E2E=0, so CI on a runner with none of these tools installed stays green,
// while a provisioned box gets real coverage.

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "..", "bin", "spor.js");
const u = require("../../scripts/engines/util.js");
const { getHarness } = require("../../lib/shell/dispatch-harnesses.js");
const { loadConfig } = require("../../lib/config.js");

// The launcher this suite drives. Explicit-first, exactly like the adapter:
// the suite's own SPOR_E2E_<X>_BIN, then the adapter's ordinary resolution
// (SPOR_<X>_CMD, then `dispatch.bin.<harness>` through the real cascade), then
// PATH. A bare name that never resolves means "not installed here" and the
// suite skips — so it must consult the SAME cascade `spor dispatch` does, or a
// box provisioned only via `dispatch.bin.<harness>` would skip a suite it can
// actually run.
function harnessCommand(harness, binEnv) {
  const pinned = process.env[binEnv];
  if (pinned) return pinned;
  const configured = getHarness(harness).command(process.env, loadConfig({ cwd: process.cwd() }));
  if (configured.includes("/") || configured.includes("\\")) return configured;
  return u.whichSync(configured) || null;
}

function skipReason(harness, { optInEnv, npmScript, binEnv }) {
  if (process.env.SPOR_E2E === "0") return "SPOR_E2E=0";
  const optedIn = process.env[optInEnv] === "1" || process.env.npm_lifecycle_event === npmScript;
  if (!optedIn) return `live ${harness} dispatch requires npm run ${npmScript} (or ${optInEnv}=1)`;
  const cmd = harnessCommand(harness, binEnv);
  if (!cmd) return `${harness} CLI is not installed`;
  const version = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 60000 });
  if (version.error || version.status !== 0) {
    return `could not execute ${harness} CLI: ${(version.error && version.error.message) || version.stderr}`;
  }
  return false;
}

function announce(harness, { binEnv }) {
  const cmd = harnessCommand(harness, binEnv);
  const version = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 60000 }).stdout.trim();
  console.error(`# e2e: ${harness} ${version || "version unknown"} (${cmd})`);
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
}

// A scratch graph home + git checkout carrying one task and one profile that
// selects `harness`. `title` is what the harness is actually asked to do.
function fixture(harness, { title, body }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `spor-e2e-${harness}-home-`));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `spor-e2e-${harness}-repo-`));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${harness} dispatch E2E fixture\n`);
  git(repo, ["init", "-q"]);
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Spor E2E", "-c", "user.email=spor-e2e@example.invalid", "commit", "-qm", "fixture"]);

  fs.writeFileSync(path.join(nodes, `task-${harness}-e2e.md`), `---
id: task-${harness}-e2e
type: task
repo: ${harness}-e2e
title: ${title}
summary: A live ${harness} CLI smoke test for the spor dispatch adapter.
status: open
date: 2026-08-22
---
${body}
`);
  fs.writeFileSync(path.join(nodes, `profile-${harness}-e2e.md`), `---
id: profile-${harness}-e2e
type: profile
title: Live ${harness} E2E profile
summary: Selects the ${harness} CLI for the live dispatch smoke test.
harness: ${harness}
date: 2026-08-22
---
Live test profile.
`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { capabilities: { declared: { harnesses: [harness] } } },
  }, null, 2) + "\n");
  return { home, repo, nodes };
}

// Launch the REAL binary through the genuine `spor dispatch` client path. The
// launcher is handed through the adapter's own absolute-path override, which is
// how a dispatch on a box whose install prefix never reaches a non-interactive
// PATH has to work.
function dispatch(harness, { home, repo, cmdEnv, binEnv, extraArgs = [] }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  Object.assign(env, {
    SPOR_HOME: home,
    XDG_CONFIG_HOME: home,
    [cmdEnv]: harnessCommand(harness, binEnv),
    SPOR_FAKE_AGENTS_JSON: "[]",
  });
  const args = [
    CLI, "dispatch", `task-${harness}-e2e`, "--dir", repo,
    "--profile", `profile-${harness}-e2e`, "--no-brief", "--no-worktree",
    ...extraArgs,
  ];
  return spawnSync(process.execPath, args, { env, cwd: repo, encoding: "utf8", timeout: 60000 });
}

async function waitFor(read, { timeoutMs = 300000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// The run record the supervisor writes, once it reports a TERMINAL outcome.
// Polling the record (not the harness's own stdout framing) is the point: it is
// the durable client-side artifact `spor runs` reads.
async function awaitTerminalRecord(home, opts) {
  const runDir = path.join(home, "journal", "dispatch");
  const recordPath = await waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const file = fs.readdirSync(runDir).find((name) => name.endsWith(".run.json"));
    return file ? path.join(runDir, file) : null;
  }, { timeoutMs: 60000 });
  assert.ok(recordPath, "dispatch should create a supervised run record");
  const record = await waitFor(() => {
    let current;
    try { current = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch { return null; }
    return ["done", "failed", "failed_launch", "vanished"].includes(current.state) ? current : null;
  }, opts);
  return { record, recordPath };
}

// The LAST final-message text in the run's own JSONL log, per the adapter's own
// `reportFromEvent`. Asserting the report EQUALS this makes the report check
// structural rather than "the file is non-empty": it catches a report that was
// never written, written empty, written from the FIRST matching event instead
// of the last, or truncated in transit — none of which a truthiness check
// would notice.
//
// Be clear about what it does NOT catch. It replays the same predicate the
// runner used, so if the harness's event SCHEMA changes underneath — say
// OpenCode's `text` parts become streaming deltas rather than the complete
// messages they are today — both sides pick the same trailing fragment and
// this still passes. Detecting that needs an oracle outside the log, which
// this suite does not have; the guard against it is reading the shipped
// report after a version bump, not this assertion.
function lastFinalMessage(harness, record) {
  const adapter = getHarness(harness);
  const text = logOf(record);
  let last = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const claimed = adapter.reportFromEvent(event);
    if (typeof claimed === "string" && claimed) last = claimed;
  }
  return last;
}

function logOf(record) {
  return record && record.log_path && fs.existsSync(record.log_path)
    ? fs.readFileSync(record.log_path, "utf8")
    : "(log missing)";
}

module.exports = {
  CLI, skipReason, announce, fixture, dispatch, awaitTerminalRecord, waitFor, logOf,
  harnessCommand, lastFinalMessage,
};
