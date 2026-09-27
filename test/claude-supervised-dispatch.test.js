"use strict";

// The claude-code adapter's SUPERVISED launch (task-spor-claude-adapter-
// headless-supervised): `claude -p --output-format stream-json --verbose` under
// the shared supervisor, prompt on stdin, session and final report read off the
// event stream — the same arm codex/opencode/copilot already run in — with the
// native `claude --bg` launch kept as an explicit opt-in. All ordinary tests
// use a real child process but a fake claude executable that speaks the
// stream-json shapes measured against Claude Code 2.1.259.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses.js");
const { getHarness } = dispatchHarnesses;
const { writeSpawnableNodeStub } = require("./helpers/portable.js");
const { waitFor, awaitJson } = require("./helpers/launch.js");

const SESSION = "3d168405-2df8-43be-bf82-1b0802e376ce";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: "utf8" });
}

function runAsync(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-claude-sup-"));
  const nodes = path.join(home, "nodes");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-claude-sup-target-"));
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-cc.md"), `---
id: task-cc
type: task
repo: demo
title: Implement the Claude Code supervised dispatch fixture
summary: Exercise the supervised claude-code dispatch adapter in a scratch checkout.
status: open
date: 2026-09-03
---
Exercise the adapter.
`);
  fs.writeFileSync(path.join(nodes, "profile-codex.md"), `---
id: profile-codex
type: profile
title: Codex test profile
summary: A profile selecting Codex, to prove --bg refuses a harness with no background mode.
harness: codex
date: 2026-09-03
---
Codex test profile.
`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { capabilities: { declared: { harnesses: ["claude-code", "codex"] } } },
  }, null, 2) + "\n");
  return { home, nodes, repo };
}

// A fake `claude` that behaves like print mode: reads the whole prompt from
// stdin, records its invocation, then emits the stream-json events a real run
// does — `system`/`init` first (every event carries `session_id`), an
// `assistant` message, and the terminal `result`.
function claudeStreamStub(home, { delayMs = 0, exitCode = 0, resultText = "stub final report", isError = false, assistantText = "working on it" } = {}) {
  return writeSpawnableNodeStub(home, "claude-stream-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify({
    args,
    cwd: process.cwd(),
    prompt,
    sporToken: process.env.SPOR_TOKEN || null,
    internalChildToken: process.env.SPOR_DISPATCH_CHILD_TOKEN || null,
  }, null, 2));
  const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  w({ type: "system", subtype: "init", cwd: process.cwd(), session_id: ${JSON.stringify(SESSION)}, model: "stub" });
  w({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] }, session_id: ${JSON.stringify(SESSION)} });
  w({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(assistantText)} }] }, session_id: ${JSON.stringify(SESSION)} });
  w({ type: "result", subtype: ${isError ? '"error_during_execution"' : '"success"'}, is_error: ${isError ? "true" : "false"}, result: ${JSON.stringify(resultText)}, session_id: ${JSON.stringify(SESSION)} });
  setTimeout(() => process.exit(${exitCode}), ${delayMs});
});
`);
}

function runRecordFile(home) {
  const runDir = path.join(home, "journal", "dispatch");
  return waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const f = fs.readdirSync(runDir).find((file) => file.endsWith(".run.json"));
    return f ? path.join(runDir, f) : null;
  });
}

// ---- the registry contract -------------------------------------------------

test("claude-code is a supervised-jsonl adapter, and no adapter has a native launch any more", () => {
  const adapter = getHarness("claude-code");
  assert.strictEqual(adapter.launchMode, "supervised-jsonl", "joins the supervised arm");
  assert.strictEqual(adapter.identityMode, "mcp-file", "identity still rides the 0600 --mcp-config");
  assert.strictEqual(adapter.activeDiscovery.kind, "run-records", "discovered from its run record, not by polling claude agents");
  assert.strictEqual(typeof adapter.sessionFromEvent, "function");
  assert.strictEqual(typeof adapter.reportFromEvent, "function");
  assert.deepStrictEqual(
    adapter.buildArgs({ name: "n", model: "m", permissionMode: "p", agent: "a", mcpConfig: "/mcp.json", prompt: "P" }),
    ["-p", "--output-format", "stream-json", "--verbose", "--name", "n", "--model", "m", "--permission-mode", "p", "--agent", "a", "--mcp-config", "/mcp.json", "--strict-mcp-config"],
    "print mode with the stream-json contract (--verbose is required by claude -p); the prompt is NOT an argv element"
  );
  // The registry itself is unchanged in identity and order.
  assert.deepStrictEqual(dispatchHarnesses.harnesses().map((a) => a.id), ["claude-code", "codex", "opencode", "copilot"]);

  // The native `claude --bg` launch is retired (task-spor-deprecate-native-bg-dispatch):
  // no adapter carries a background variant, and the variant plumbing is gone.
  for (const a of dispatchHarnesses.harnesses()) {
    assert.strictEqual(a.nativeVariant, undefined, `${a.id} has no native launch`);
    assert.strictEqual(a.launchMode, "supervised-jsonl", `${a.id} launches supervised`);
    assert.notStrictEqual((a.activeDiscovery || {}).kind, "cli-json", `${a.id} is never discovered by polling a harness CLI`);
  }
  assert.strictEqual(dispatchHarnesses.launchVariant, undefined);
  assert.strictEqual(dispatchHarnesses.discoveryAdapters, undefined);
});

test("claude-code reads its session from any stream event and its report from result/assistant text", () => {
  const { sessionFromEvent, reportFromEvent } = getHarness("claude-code");
  assert.strictEqual(sessionFromEvent({ type: "system", subtype: "init", session_id: SESSION }), SESSION);
  assert.strictEqual(sessionFromEvent({ type: "result", session_id: SESSION }), SESSION);
  assert.strictEqual(sessionFromEvent({ type: "assistant", session_id: "" }), null);
  assert.strictEqual(sessionFromEvent({ type: "assistant" }), null);
  assert.strictEqual(sessionFromEvent(null), null);

  assert.strictEqual(reportFromEvent({ type: "result", subtype: "success", is_error: false, result: "pong" }), "pong");
  assert.strictEqual(reportFromEvent({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }), null, "an error result is never the report — the contract would read it as a clean `reported`");
  assert.strictEqual(reportFromEvent({ type: "result", subtype: "success" }), null);
  assert.strictEqual(
    reportFromEvent({ type: "assistant", message: { content: [{ type: "text", text: "first" }, { type: "tool_use", name: "Bash" }, { type: "text", text: "last" }] } }),
    "last",
    "the last text block of an assistant message"
  );
  assert.strictEqual(reportFromEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }), null, "a thinking-only event carries no report");
  assert.strictEqual(reportFromEvent({ type: "system", subtype: "init" }), null);
  assert.strictEqual(reportFromEvent({ type: "rate_limit_event" }), null);
  assert.strictEqual(reportFromEvent(null), null);
});

// ---- the launch --------------------------------------------------------------

test("claude-code declares a failure from an is_error result, and from nothing else", () => {
  const { failureFromEvent } = getHarness("claude-code");
  assert.strictEqual(typeof failureFromEvent, "function");
  assert.deepStrictEqual(
    failureFromEvent({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 500" }),
    { reason: "error_during_execution: API Error: 500" }
  );
  assert.deepStrictEqual(
    failureFromEvent({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit the turn cap", " and stopped "] }),
    { reason: "error_max_turns: hit the turn cap; and stopped" },
    "an `errors` list stands in for a missing result string"
  );
  assert.deepStrictEqual(failureFromEvent({ type: "result", is_error: true }), { reason: "error" }, "a bare error result still declares failure");
  assert.strictEqual(failureFromEvent({ type: "result", subtype: "success", is_error: false, result: "pong" }), null);
  assert.strictEqual(failureFromEvent({ type: "result", subtype: "success", result: "pong" }), null);
  assert.strictEqual(failureFromEvent({ type: "assistant", message: { content: [{ type: "text", text: "is_error: true" }] } }), null, "only a result event can declare it");
  assert.strictEqual(failureFromEvent({ type: "system", subtype: "init" }), null);
  assert.strictEqual(failureFromEvent(null), null);
  // Codex declares its own (`turn.failed`, codex-dispatch.test.js); the two
  // secondary CLIs still declare none.
  for (const id of ["opencode", "copilot"]) {
    assert.strictEqual(getHarness(id).failureFromEvent, undefined, `${id} declares no stream failure — its supervision is byte-identical`);
  }
});

// issue-spor-codex-usage-limit-outage-read-as-a-code-failure: Codex had no
// declaration hook at all, so its `turn.failed` was invisible to the supervisor
// and a provider outage settled as a bare `nonzero-exit`.
test("codex declares a failure from turn.failed, and from nothing else", () => {
  const { failureFromEvent } = getHarness("codex");
  assert.strictEqual(typeof failureFromEvent, "function");
  assert.deepStrictEqual(
    failureFromEvent({ type: "turn.failed", error: { message: "You've hit your usage limit." } }),
    { reason: "turn.failed: You've hit your usage limit." },
    "the provider's own wording is retained (upstream's adapter prefixes the event name)"
  );
  assert.deepStrictEqual(failureFromEvent({ type: "turn.failed" }), { reason: "turn.failed" }, "a bare turn.failed still declares failure");
  assert.deepStrictEqual(failureFromEvent({ type: "turn.failed", error: {} }), { reason: "turn.failed" });
  // The bare `error` event precedes turn.failed carrying the same text, but the
  // supervisor cannot UNSET a declaration once made, so declaring on it would
  // fail a run that recovered — and suppress the report of a review that passed.
  assert.strictEqual(failureFromEvent({ type: "error", message: "transient tool error" }), null, "a bare error event is not terminal for the turn");
  assert.strictEqual(failureFromEvent({ type: "turn.completed", usage: {} }), null);
  assert.strictEqual(failureFromEvent({ type: "item.completed", item: { type: "agent_message", text: "turn.failed" } }), null, "only the event itself can declare it");
  assert.strictEqual(failureFromEvent({ type: "thread.started", thread_id: "th-1" }), null);
  assert.strictEqual(failureFromEvent(null), null);
});

test("a supervised claude-code run ending in an is_error result classifies FAILED with the error text as the reason — no report, never `reported`", async () => {
  // Exit 0 on purpose: the exit code must not be what saves this case, the
  // declared error result alone has to.
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-invocation.json");
  const stub = claudeStreamStub(home, { delayMs: 100, exitCode: 0, isError: true, resultText: "API Error: 500 Internal Server Error" });
  const result = run(
    ["dispatch", "task-cc", "--dir", repo, "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(await awaitJson(outfile), "the detached stub ran");

  const recordPath = await runRecordFile(home);
  assert.ok(recordPath);
  const settled = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.contract_pending === false ? record : null;
  });
  assert.ok(settled, "the run settled");
  assert.strictEqual(settled.state, "failed");
  assert.strictEqual(settled.exit_code, 0, "the child exited 0 — the error result is what failed the run");
  assert.strictEqual(settled.termination_class, "failed");
  assert.strictEqual(settled.termination_signal, "error-result");
  assert.match(settled.termination_reason, /error_during_execution: API Error: 500 Internal Server Error/, "the error text is retained as the reason");
  assert.strictEqual(settled.terminal_state, "failed", "never `reported` — an error result has no report to file");
  assert.ok(!fs.existsSync(settled.report_path), "no report file is written for an errored session");
  assert.match(fs.readFileSync(settled.log_path, "utf8"), /"is_error":true/, "the log still holds the whole stream, error event included");
});

test("a supervised claude-code run whose is_error result carries a recognized environment signal keeps that classification", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-invocation.json");
  const stub = claudeStreamStub(home, { delayMs: 100, exitCode: 1, isError: true, resultText: "Credit balance is too low" });
  const result = run(
    ["dispatch", "task-cc", "--dir", repo, "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(await awaitJson(outfile), "the detached stub ran");
  const recordPath = await runRecordFile(home);
  const settled = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.contract_pending === false ? record : null;
  });
  assert.ok(settled);
  assert.strictEqual(settled.state, "failed");
  assert.strictEqual(settled.exit_code, 1);
  assert.strictEqual(settled.termination_class, "environment", "an environment signal in the error text still wins over the generic reading");
  assert.strictEqual(settled.termination_signal, "credit-exhausted");
  assert.strictEqual(settled.terminal_state, "failed");
  assert.ok(!fs.existsSync(settled.report_path), "no report either way");
});

test("assistant prose preceding an is_error result never classifies the run: only the declared error text is read for environment signals", async () => {
  // The assistant turn quotes an environment phrase (it was asked about
  // credits, or read the words in a file); the harness then declares a plain
  // error. The log tail holds both — the declaration alone is the evidence.
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-invocation.json");
  const stub = claudeStreamStub(home, {
    delayMs: 100, exitCode: 1, isError: true,
    assistantText: "Checking the docs: the API replies 'Credit balance is too low' when an org runs dry.",
    resultText: "Tool execution failed: permission denied",
  });
  const result = run(
    ["dispatch", "task-cc", "--dir", repo, "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(await awaitJson(outfile), "the detached stub ran");
  const recordPath = await runRecordFile(home);
  const settled = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.contract_pending === false ? record : null;
  });
  assert.ok(settled);
  assert.match(fs.readFileSync(settled.log_path, "utf8"), /Credit balance is too low/, "the prose IS in the log tail the old scan read");
  assert.strictEqual(settled.state, "failed");
  assert.strictEqual(settled.termination_class, "failed", "prose before the error result is not the run's cause of death");
  assert.strictEqual(settled.termination_signal, "error-result");
  assert.match(settled.termination_reason, /error_during_execution: Tool execution failed: permission denied/);
  assert.strictEqual(settled.terminal_state, "failed");
  assert.ok(!fs.existsSync(settled.report_path));
});

test("a default claude-code dispatch launches supervised: print-mode argv, prompt on stdin, session and report off the stream", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-invocation.json");
  const stub = claudeStreamStub(home, { delayMs: 100 });
  const result = run(
    ["dispatch", "task-cc", "--dir", repo, "--model", "haiku", "--permission-mode", "bypassPermissions", "--no-brief"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Code supervisor (running|done)/);
  assert.match(result.stdout, /^report: {2}/m, "a report path is announced — the channel a native launch never had");

  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the detached stub ran");
  assert.strictEqual(invocation.cwd, repo);
  assert.deepStrictEqual(invocation.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(invocation.args.includes("--name") && invocation.args.includes("task-cc"));
  assert.ok(invocation.args.includes("--model") && invocation.args.includes("haiku"));
  assert.ok(invocation.args.includes("--permission-mode") && invocation.args.includes("bypassPermissions"));
  assert.ok(!invocation.args.includes("--bg"), "not the native launch");
  assert.ok(!invocation.args.some((a) => /Work on task-cc/.test(a)), "the prompt never enters argv");
  assert.match(invocation.prompt, /Work on task-cc/, "the prompt arrived on stdin");
  assert.strictEqual(invocation.sporToken, null, "local mode hands the run no token");

  const recordPath = await runRecordFile(home);
  assert.ok(recordPath);
  const finished = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.state === "done" ? record : null;
  });
  assert.ok(finished, "the supervisor records terminal success when the child exits");
  assert.strictEqual(finished.harness, "claude-code");
  assert.strictEqual(finished.launch_mode, "supervised-jsonl");
  assert.strictEqual(finished.session_id, SESSION, "bound from the stream's session_id, not from polling claude agents");
  assert.strictEqual(finished.exit_code, 0);
  assert.strictEqual(finished.termination_signal, "supervised-exit");
  assert.strictEqual(fs.readFileSync(finished.report_path, "utf8"), "stub final report\n", "the result event's text is the report");
  // Settled (contract_pending cleared) with the local-mode reading: the
  // target has no resolver, so it is unenforced `reported` — the same contract
  // every other supervised harness gets, never the native launch's blanket
  // "outside the terminal-state contract".
  const settled = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record.contract_pending === false ? record : null;
  });
  assert.ok(settled);
  assert.strictEqual(settled.terminal_state, "reported");
  assert.doesNotMatch(settled.terminal_note || "", /native-background runs are outside the terminal-state contract/);
});

test("--print previews the supervised launch (prompt on stdin); --bg is refused even on a preview", () => {
  const { home, repo } = fixture();
  const sup = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(sup.status, 0, sup.stderr);
  assert.match(sup.stdout, /^run: {4}claude -p --output-format stream-json --verbose --name task-cc {2}# prompt on stdin$/m);
  assert.match(sup.stdout, /^session: \(read from claude -p --output-format stream-json session_id, bound by supervisor\)$/m);

  const bg = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print", "--bg"], { SPOR_HOME: home });
  assert.strictEqual(bg.status, 1);
  assert.match(bg.stderr, /'spor dispatch --bg' \(the native claude --bg launch\) is retired/);
  assert.doesNotMatch(bg.stdout, /^run: /m, "no launch preview for a refused dispatch");
});

test("--bg is refused before any side effect, for every harness — nothing launched, no run record", () => {
  const { home, repo } = fixture();
  const configBefore = fs.readFileSync(path.join(home, "config.json"), "utf8");
  for (const extra of [[], ["--profile", "profile-codex"]]) {
    const outfile = path.join(home, "claude-invocation.json");
    const r = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--bg", ...extra], { SPOR_HOME: home, SPOR_CLAUDE_CMD: claudeStreamStub(home), OUTFILE: outfile });
    assert.strictEqual(r.status, 1, `${extra.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, /is retired — every dispatch now runs supervised/);
    assert.match(r.stderr, /run 'claude --bg' yourself/, "points at the attachable alternative");
    assert.ok(!fs.existsSync(outfile), "the harness never ran");
    assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "no run record");
    assert.strictEqual(fs.readFileSync(path.join(home, "config.json"), "utf8"), configBefore, "no config write (repo registration, capability probe)");
  }
});

test("a legacy native-background record rides `spor runs --json` verbatim, asymmetric fields included, beside a supervised one", async () => {
  // WORKERS.md §8 documents the two launch modes as carrying DIFFERENT field
  // sets, and a consumer reads an absent field as absent rather than as a
  // violation (issue-spor-unjudgeable-type-leases-never-released F3). No new
  // native record is ever written (the launch is retired), but a legacy one
  // still in the journal must come out of `spor runs` as it went in.
  const { home } = fixture();
  const runDir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(runDir, { recursive: true });
  const launchedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "legacy.run.json"), JSON.stringify({
    run_id: "legacy", node_id: "task-cc", name: "task-cc", harness: "claude-code", launch_mode: "native-background",
    state: "running", cwd: home, model: "opus", created_at: launchedAt, launched_at: launchedAt, launcher_exit: 0,
  }));
  const shown = (h) => {
    const r = run(["runs", "--json"], { SPOR_HOME: h });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).runs[0];
  };
  const nativeJson = shown(home);
  assert.strictEqual(nativeJson.launch_mode, "native-background");
  assert.strictEqual(nativeJson.state, "running", "inside its retirement horizon, still believed");
  assert.strictEqual(nativeJson.model, "opus");
  assert.ok(Object.prototype.hasOwnProperty.call(nativeJson, "launched_at"));
  assert.ok(!Object.prototype.hasOwnProperty.call(nativeJson, "started_at"));

  const sup = fixture();
  const supOut = path.join(sup.home, "claude-invocation.json");
  const supResult = run(
    ["dispatch", "task-cc", "--dir", sup.repo, "--no-brief", "--permission-mode", "bypassPermissions", "--model", "opus"],
    { SPOR_HOME: sup.home, SPOR_CLAUDE_CMD: claudeStreamStub(sup.home, { delayMs: 50 }), OUTFILE: supOut }
  );
  assert.strictEqual(supResult.status, 0, supResult.stderr);
  assert.ok(await awaitJson(supOut), "the supervised stub ran");
  const supPath = await runRecordFile(sup.home);
  const settled = await waitFor(() => {
    const record = JSON.parse(fs.readFileSync(supPath, "utf8"));
    return record.contract_pending === false ? record : null;
  });
  assert.ok(settled, "the supervised run settled");
  const supJson = shown(sup.home);
  assert.strictEqual(supJson.launch_mode, "supervised-jsonl");
  assert.ok(Object.prototype.hasOwnProperty.call(supJson, "started_at"), "supervised: the supervisor stamps the child's real start");
  assert.ok(!Object.prototype.hasOwnProperty.call(supJson, "launched_at"), "supervised: `launched_at` is the native field");
  assert.ok(!Object.prototype.hasOwnProperty.call(supJson, "model"), "supervised: the model rides the argv, not the record");
});

test("a standing dispatch.claudeLaunchMode: native-background is retired: warned about, ignored, the dispatch runs supervised", () => {
  const { home, repo } = fixture();
  const viaEnv = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "native-background" });
  assert.strictEqual(viaEnv.status, 0, viaEnv.stderr);
  assert.match(viaEnv.stderr, /dispatch.claudeLaunchMode 'native-background' is retired/);
  assert.match(viaEnv.stdout, /^run: {4}claude -p /m);

  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  cfg.dispatch.claudeLaunchMode = "native-background";
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const viaFile = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.stderr, /is retired/, "the user config.json knob is ignored the same way");
  assert.match(viaFile.stdout, /^run: {4}claude -p /m);
});

test("an unrecognized dispatch.claudeLaunchMode value warns and is ignored (supervised)", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "nativebackground" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: dispatch.claudeLaunchMode 'nativebackground' is not recognized \(supervised is the only launch mode\)/);
  assert.match(r.stdout, /^run: {4}claude -p /m);
});

test("spor work ignores dispatch.claudeLaunchMode: a worker's claude-code run is always supervised", async () => {
  // The worker loop's runs must be followable and judgeable (a report channel,
  // an enforced outcome); the retired native-background knob is said once at
  // worker start and never routes a run to `claude --bg`.
  const { home, repo } = fixture();
  fs.writeFileSync(path.join(home, "nodes", "agent-box.md"), "---\nid: agent-box\ntype: agent\ntitle: box\nsummary: A test agent identity.\ndate: 2026-09-03\n---\nTest agent.\n");
  fs.writeFileSync(path.join(home, "nodes", "task-cc.md"), fs.readFileSync(path.join(home, "nodes", "task-cc.md"), "utf8").replace(
    "status: open\n", "status: open\nedges:\n  - {type: assigned, to: agent-box}\n"
  ));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  cfg.dispatch.repos = { demo: repo };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const outfile = path.join(home, "work-invocation.json");
  const stub = claudeStreamStub(home);
  const r = run(
    // `--permission-mode bypassPermissions` is the worker preflight's price of
    // entry on Claude Code (task-spor-worker-preflight-validation): an
    // unattended dispatch with no unattended posture is refused before its
    // claim. The subject here is the LAUNCH MODE, so give it a posture and let
    // the knob be the only thing under test.
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--project", "demo", "--permission-mode", "bypassPermissions"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "native-background" }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the worker dispatched the task");
  assert.deepStrictEqual(invocation.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"], "supervised, despite the knob");
  const recordPath = await runRecordFile(home);
  assert.strictEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")).launch_mode, "supervised-jsonl");
});

test("a supervised claude-code run whose supervisor is KILLED mid-run is finalized by 'spor runs' exactly as a codex run is", async () => {
  const { home, repo } = fixture();
  const stub = claudeStreamStub(home, { delayMs: 30000 });
  const result = run(["dispatch", "task-cc", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: path.join(home, "killed.json") });
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
  for (const pid of [record.runner_pid, record.child_pid]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const gone = await waitFor(() => {
    try { process.kill(record.runner_pid, 0); return null; } catch { return true; }
  });
  assert.ok(gone);
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, created_at: "2026-07-18T10:00:00.000Z" }, null, 2) + "\n");

  // No `claude agents --json` is needed (or available — SPOR_CLAUDE_CMD points
  // at the stream stub, which is not a listing) to close a supervised record.
  const shown = run(["runs", "--json"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(shown.status, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout);
  assert.strictEqual(parsed.reconciled, true, "no native record is left un-reconciled by a missing agent listing");
  const reconciled = parsed.runs[0];
  assert.strictEqual(reconciled.harness, "claude-code");
  assert.strictEqual(reconciled.state, "vanished");
  assert.strictEqual(reconciled.termination_signal, "supervisor-gone");
  assert.strictEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")).state, "vanished", "durable, not just printed");
});

// Claude Code 2.x leaves a persistent background daemon, and a `--mcp-config`
// server is a child of the run too; either can inherit the child's stdout/
// stderr and keep the PIPES open after `claude -p` itself has exited
// (test/helpers/claude-e2e.js resolves on `exit` for exactly this reason). A
// supervisor that finalized only on `close` would then hold the run — and its
// work-loop slot and lease — open forever. Model it: a child that hands its
// stdout to a detached grandchild sleeping well past the test, then exits 0.
function pipeHoldingStub(home) {
  return writeSpawnableNodeStub(home, "claude-pipe-holder", `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  w({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION)} });
  w({ type: "result", subtype: "success", is_error: false, result: "held-pipe report", session_id: ${JSON.stringify(SESSION)} });
  // The lingering "daemon": inherits BOTH pipes and outlives this process.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
  holder.unref();
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify({ holderPid: holder.pid }));
  process.exit(0);
});
`);
}

test("a claude-code run whose pipes are held open after exit still finalizes within the drain grace", async () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "holder.json");
  const stub = pipeHoldingStub(home);
  const result = run(["dispatch", "task-cc", "--dir", repo, "--no-brief"], {
    SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile, SPOR_DISPATCH_PIPE_DRAIN_MS: "500",
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const holder = await awaitJson(outfile);
  assert.ok(holder && holder.holderPid, "the pipe-holding grandchild started");
  try {
    const recordPath = await runRecordFile(home);
    const started = Date.now();
    const finished = await waitFor(() => {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      return record.state === "done" && record.contract_pending === false ? record : null;
    }, { timeoutMs: 10000 });
    assert.ok(finished, "the run went terminal even though the grandchild still holds stdout/stderr");
    assert.ok(Date.now() - started < 8000, "within seconds, not a watchdog window");
    assert.strictEqual(finished.exit_code, 0);
    assert.strictEqual(finished.session_id, SESSION, "everything read before the exit was kept");
    assert.strictEqual(fs.readFileSync(finished.report_path, "utf8"), "held-pipe report\n");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const runnerPid = record.runner_pid || finished.runner_pid;
    assert.ok(runnerPid, "sanity: the record names its supervisor");
    const runnerGone = await waitFor(() => {
      try { process.kill(runnerPid, 0); return null; } catch { return true; }
    });
    assert.ok(runnerGone, "the supervisor process itself exits, not kept alive by the inherited fds");
    // The holder is still alive — the test never depended on it dying.
    assert.doesNotThrow(() => process.kill(holder.holderPid, 0), "sanity: the grandchild is still holding the pipes");
  } finally {
    try { process.kill(holder.holderPid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("pipeDrainGraceMs: the default, an env override, and garbage", () => {
  const runner = require("../lib/shell/agent-dispatch-runner.js");
  assert.strictEqual(runner.PIPE_DRAIN_GRACE_MS, 3000);
  assert.strictEqual(runner.pipeDrainGraceMs({}), 3000);
  assert.strictEqual(runner.pipeDrainGraceMs({ SPOR_DISPATCH_PIPE_DRAIN_MS: "250" }), 250);
  assert.strictEqual(runner.pipeDrainGraceMs({ SPOR_DISPATCH_PIPE_DRAIN_MS: "0" }), 0);
  assert.strictEqual(runner.pipeDrainGraceMs({ SPOR_DISPATCH_PIPE_DRAIN_MS: "soon" }), 3000);
  assert.strictEqual(runner.pipeDrainGraceMs({ SPOR_DISPATCH_PIPE_DRAIN_MS: "-5" }), 3000);
});

test("the same-machine duplicate guard sees a live supervised claude-code run through its run record", async () => {
  const { home, repo } = fixture();
  const stub = claudeStreamStub(home, { delayMs: 30000 });
  const first = run(["dispatch", "task-cc", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: path.join(home, "first.json") });
  assert.strictEqual(first.status, 0, first.stderr);
  const recordPath = await runRecordFile(home);
  const record = await waitFor(() => {
    const r = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return r.state === "running" ? r : null;
  });
  assert.ok(record);
  try {
    const dup = run(["dispatch", "task-cc", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: path.join(home, "dup.json") });
    assert.strictEqual(dup.status, 1);
    assert.match(dup.stderr, /task-cc already has a background agent in flight on this machine/);
  } finally {
    for (const pid of [record.runner_pid, record.child_pid]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

// ---- remote: identity and the late bind, now from the stream -----------------

test("remote claude-code dispatch carries the agent token in a 0600 --mcp-config, binds the stream session, and renews the lease to it", async () => {
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
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.method === "GET" && req.url === "/v1/nodes/task-cc") return j(200, { raw: fs.readFileSync(path.join(home, "nodes", "task-cc.md"), "utf8") });
      if (req.method === "POST" && req.url === "/v1/nodes/task-cc/claim") return j(200, { ok: true, lease: { by: "person-test" } });
      if (req.method === "POST" && req.url === "/v1/agents/agent-test/token") return j(200, { token: "agent-secret-token" });
      if (req.method === "POST" && ["/v1/agents/session", "/v1/nodes/task-cc/renew", "/v1/nodes/task-cc/release"].includes(req.url)) return j(200, { ok: true });
      // POST /v1/nodes is the batch door (API.md §4): a genuine response
      // always carries a per-entry `results` array, which is what
      // `nodeWriteLanded` (lib/shell/dispatch-terminal.js) reads to confirm
      // the write landed — a bare `{ok, id}` with no `results` is not a
      // shape the real API returns.
      if (req.method === "POST" && req.url === "/v1/nodes") return j(201, { results: [{ ok: true, status: "created", id: "art-report" }] });
      return j(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outfile = path.join(home, "remote-invocation.json");
  const stub = claudeStreamStub(home);
  try {
    const result = await runAsync(
      ["dispatch", "task-cc", "--dir", repo, "--no-brief"],
      { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "person-token", SPOR_CLAUDE_CMD: stub, OUTFILE: outfile }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent: {2}agent-test \(writes attributed agent-on-behalf-of-you; run session bound after launch\)/);
    const invocation = await awaitJson(outfile);
    const mi = invocation.args.indexOf("--mcp-config");
    assert.ok(mi >= 0, "--mcp-config present");
    assert.ok(invocation.args.includes("--strict-mcp-config"), "--strict-mcp-config present");
    const mcpFile = invocation.args[mi + 1];
    const conf = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    assert.strictEqual(conf.mcpServers.spor.headers.Authorization, "Bearer agent-secret-token", "the agent-scoped bearer rides the mcp-config file");
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(mcpFile).mode & 0o777, 0o600, "mcp-config is 0600");
    assert.strictEqual(invocation.sporToken, "agent-secret-token", "the spor CLI inside the run is agent-attributed too");
    assert.strictEqual(invocation.internalChildToken, null);
    assert.ok(!invocation.args.some((arg) => arg.includes("agent-secret-token")), "the bearer never enters argv");

    const bound = await waitFor(() => hits.find((hit) => hit.url === "/v1/agents/session"));
    const renewed = await waitFor(() => hits.find((hit) => hit.url === "/v1/nodes/task-cc/renew"));
    assert.ok(bound, "the supervisor bound the run session");
    assert.ok(renewed, "and renewed the lease to it");
    assert.strictEqual(bound.auth, "Bearer agent-secret-token");
    assert.deepStrictEqual(JSON.parse(bound.body), { session: SESSION }, "the session is the stream's session_id");
    assert.deepStrictEqual(JSON.parse(renewed.body), { session: SESSION });

    const recordPath = await runRecordFile(home);
    const settled = await waitFor(() => {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      return record.state === "done" && record.contract_pending === false ? record : null;
    });
    assert.ok(settled, "the terminal-state contract ran for the claude-code run");
    assert.strictEqual(settled.terminal_enforced, true, "an ENFORCED verdict — what a native launch could never have");
    assert.strictEqual(settled.terminal_state, "reported", "no resolver on the target => reported, with a filed report");
    assert.match(settled.report_node_id, /^art-dispatch-report-/, "the filed report artifact is named on the record");
    const recordText = fs.readFileSync(recordPath, "utf8");
    assert.doesNotMatch(recordText, /agent-secret-token|person-token/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
