"use strict";

// Opt-in end-to-end smoke test for the REAL OpenCode CLI dispatch adapter
// (task-spor-dispatch-adapters-opencode-copilot). Like the Codex twin, this
// consumes the operator's existing OpenCode authentication and may call the
// live model service, so `npm test` skips it and `npm run test:e2e:opencode`
// opts in. Verified against opencode 1.18.0.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const e2e = require("./helpers/harness-e2e.js");

const OPTS = {
  optInEnv: "SPOR_E2E_OPENCODE",
  npmScript: "test:e2e:opencode",
  binEnv: "SPOR_E2E_OPENCODE_BIN",
  cmdEnv: "SPOR_OPENCODE_CMD",
};

const skip = e2e.skipReason("opencode", OPTS);
if (!skip) e2e.announce("opencode", OPTS);

test("real OpenCode CLI completes a profile-selected spor dispatch in a scratch repo", { skip }, async () => {
  const { home, repo } = e2e.fixture("opencode", {
    title: "Create opencode-dispatch-e2e.txt containing exactly SPOR_OPENCODE_DISPATCH_E2E and do not change any other file",
    body: "Create the requested sentinel file and make no other changes.",
  });
  const extraArgs = process.env.SPOR_E2E_OPENCODE_MODEL ? ["--model", process.env.SPOR_E2E_OPENCODE_MODEL] : [];
  const launched = e2e.dispatch("opencode", { home, repo, ...OPTS, extraArgs });
  assert.strictEqual(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /OpenCode supervisor/, "the launcher hands off to the supervised runner");

  const { record } = await e2e.awaitTerminalRecord(home);
  assert.ok(record, "a real OpenCode run should reach a terminal state");
  assert.strictEqual(record.state, "done", `OpenCode failed (${record.error || "no recorded error"}):\n${e2e.logOf(record)}`);
  assert.strictEqual(record.exit_code, 0);
  assert.strictEqual(record.harness, "opencode");
  assert.ok(record.started_at, "the supervisor observed the run START");
  assert.ok(record.finished_at, "and observed it TERMINATE");
  assert.strictEqual(record.termination_signal, "supervised-exit");
  assert.ok(record.session_id, "the session id should be bound from real OpenCode JSONL");
  assert.ok(fs.existsSync(record.report_path), "the adapter should write a report file");
  const expectedReport = e2e.lastFinalMessage("opencode", record);
  assert.ok(expectedReport, "the real run emitted at least one final-message event");
  assert.strictEqual(
    fs.readFileSync(record.report_path, "utf8").trimEnd(), expectedReport.trimEnd(),
    "the report is the LAST final message of the real run, not a streaming fragment"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(repo, "opencode-dispatch-e2e.txt"), "utf8").trim(),
    "SPOR_OPENCODE_DISPATCH_E2E"
  );
  assert.ok(!fs.existsSync(path.join(repo, ".spor")), "the smoke test should not modify unrelated files");
});

// The failure half of the contract: a run that ends badly must leave a DURABLE
// terminal reason behind, never disappear (inc-spor-dispatch-session-vanished-
// 2026-07-18). An unavailable model is the cheapest way to make the real binary
// exit non-zero without depending on anything the model chooses to do.
test("a failing real OpenCode run terminalizes with a retained reason, not a vanished session", { skip }, async () => {
  const { home, repo } = e2e.fixture("opencode", {
    title: "Do nothing at all",
    body: "This run is expected to fail before it does any work.",
  });
  const launched = e2e.dispatch("opencode", {
    home, repo, ...OPTS,
    extraArgs: ["--model", "spor-e2e/definitely-not-a-model"],
  });
  assert.strictEqual(launched.status, 0, launched.stderr);

  const { record } = await e2e.awaitTerminalRecord(home);
  assert.ok(record, "the supervisor should reach a terminal state on a failing child");
  assert.strictEqual(record.state, "failed", `expected a failed run, got ${record.state}:\n${e2e.logOf(record)}`);
  assert.notStrictEqual(record.exit_code, 0);
  assert.ok(record.termination_reason, "the terminal reason is retained on the record");
  assert.ok(record.termination_signal, "and classified");
  assert.notStrictEqual(record.termination_class, "completed");
});
