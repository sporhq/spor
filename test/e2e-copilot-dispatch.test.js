"use strict";

// Opt-in end-to-end smoke test for the REAL GitHub Copilot CLI dispatch adapter
// (task-spor-dispatch-adapters-opencode-copilot). Like the Codex twin, this
// consumes the operator's existing Copilot authentication and may call the live
// model service, so `npm test` skips it and `npm run test:e2e:copilot` opts in.
// No version is pinned here — Copilot auto-updates itself outside CI (observed
// mid-development: 1.0.75 -> 1.0.80 with no operator action, before the adapter
// added `--no-auto-update` to its dispatch argv), so a comment naming a version
// goes stale the next time the CLI updates on its own. `e2e.announce()` records
// what actually ran instead: it prints `# e2e: copilot <version> (<cmd>)` to
// stderr at the start of the suite — read that line for the version a given
// run was verified against.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const e2e = require("./helpers/harness-e2e.js");

const OPTS = {
  optInEnv: "SPOR_E2E_COPILOT",
  npmScript: "test:e2e:copilot",
  binEnv: "SPOR_E2E_COPILOT_BIN",
  cmdEnv: "SPOR_COPILOT_CMD",
};

const skip = e2e.skipReason("copilot", OPTS);
if (!skip) e2e.announce("copilot", OPTS);

test("real GitHub Copilot CLI completes a profile-selected spor dispatch in a scratch repo", { skip }, async () => {
  const { home, repo } = e2e.fixture("copilot", {
    title: "Create copilot-dispatch-e2e.txt containing exactly SPOR_COPILOT_DISPATCH_E2E and do not change any other file",
    body: "Create the requested sentinel file and make no other changes.",
  });
  const extraArgs = process.env.SPOR_E2E_COPILOT_MODEL ? ["--model", process.env.SPOR_E2E_COPILOT_MODEL] : [];
  const launched = e2e.dispatch("copilot", { home, repo, ...OPTS, extraArgs });
  assert.strictEqual(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /GitHub Copilot CLI supervisor/, "the launcher hands off to the supervised runner");

  const { record } = await e2e.awaitTerminalRecord(home);
  assert.ok(record, "a real Copilot run should reach a terminal state");
  assert.strictEqual(record.state, "done", `Copilot failed (${record.error || "no recorded error"}):\n${e2e.logOf(record)}`);
  assert.strictEqual(record.exit_code, 0);
  assert.strictEqual(record.harness, "copilot");
  assert.ok(record.started_at, "the supervisor observed the run START");
  assert.ok(record.finished_at, "and observed it TERMINATE");
  assert.strictEqual(record.termination_signal, "supervised-exit");
  // Copilot stamps its session id only on the terminal `result` event, so this
  // asserts the LATE bind the adapter documents — the supervisor drains the
  // stream and awaits the bind before the record goes terminal.
  assert.ok(record.session_id, "the session id should be bound from the real Copilot result event");
  assert.ok(fs.existsSync(record.report_path), "the adapter should write a report file");
  const expectedReport = e2e.lastFinalMessage("copilot", record);
  assert.ok(expectedReport, "the real run emitted at least one final-message event");
  assert.strictEqual(
    fs.readFileSync(record.report_path, "utf8").trimEnd(), expectedReport.trimEnd(),
    "the report is the LAST final message of the real run, not a streaming fragment"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(repo, "copilot-dispatch-e2e.txt"), "utf8").trim(),
    "SPOR_COPILOT_DISPATCH_E2E"
  );
  assert.ok(!fs.existsSync(path.join(repo, ".spor")), "the smoke test should not modify unrelated files");
});

// The failure half of the contract: a run that ends badly must leave a DURABLE
// terminal reason behind, never disappear (inc-spor-dispatch-session-vanished-
// 2026-07-18). An unavailable model is the cheapest way to make the real binary
// exit non-zero without depending on anything the model chooses to do — and for
// Copilot it fails BEFORE any `result` event, so it also covers the run that
// terminalizes with no session ever bound.
test("a failing real Copilot run terminalizes with a retained reason, not a vanished session", { skip }, async () => {
  const { home, repo } = e2e.fixture("copilot", {
    title: "Do nothing at all",
    body: "This run is expected to fail before it does any work.",
  });
  const launched = e2e.dispatch("copilot", {
    home, repo, ...OPTS,
    extraArgs: ["--model", "spor-e2e-definitely-not-a-model"],
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
