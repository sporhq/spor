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
const { getHarness, launchVariant, discoveryAdapters } = dispatchHarnesses;
const { writeSpawnableNodeStub } = require("./helpers/portable.js");
const { waitFor, awaitJson } = require("./helpers/launch.js");

const SESSION = "3d168405-2df8-43be-bf82-1b0802e376ce";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
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

// The native launch's stub: `claude --bg` returns at once, so the launcher
// spawns it SYNCHRONOUSLY and the record is written before it returns — the
// invocation file is complete by the time `run` resolves.
function claudeBgStub(home) {
  return writeSpawnableNodeStub(home, "claude-bg-stub", `
const fs = require("node:fs");
fs.writeFileSync(process.env.OUTFILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }, null, 2));
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

test("claude-code is a supervised-jsonl adapter by default, with the native launch as a declared variant", () => {
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

  const native = adapter.nativeVariant;
  assert.ok(native, "the `claude --bg` launch is kept as a variant");
  assert.strictEqual(native.id, "claude-code");
  assert.strictEqual(native.launchMode, "native-background");
  assert.strictEqual(native.activeDiscovery.kind, "cli-json");
  assert.deepStrictEqual(native.activeDiscovery.args, ["agents", "--json"]);
  assert.strictEqual(native.buildArgs({ prompt: "P" })[0], "--bg");
  assert.strictEqual(native.buildArgs({ prompt: "P" }).at(-1), "P", "the native launch still carries the prompt positionally");
  assert.strictEqual(native.validateOptions({ sandbox: "x" }).message, adapter.validateOptions({ sandbox: "x" }).message, "one option contract for both launches");
  for (const other of ["codex", "opencode", "copilot"]) assert.strictEqual(getHarness(other).nativeVariant, undefined, `${other} has no native launch`);
});

test("launchVariant picks the launch, and discoveryAdapters folds the native variant back in for run discovery", () => {
  const adapter = getHarness("claude-code");
  assert.strictEqual(launchVariant(adapter, null), adapter);
  assert.strictEqual(launchVariant(adapter, "supervised"), adapter);
  assert.strictEqual(launchVariant(adapter, "supervised-jsonl"), adapter);
  assert.strictEqual(launchVariant(adapter, "native-background"), adapter.nativeVariant);
  assert.strictEqual(launchVariant(getHarness("codex"), "native-background"), null, "a harness with no background mode answers null — the caller decides refusal vs no-op");
  assert.strictEqual(launchVariant(adapter, "bogus"), null);
  assert.strictEqual(launchVariant(null, "native-background"), null);
  assert.deepStrictEqual(
    discoveryAdapters().map((a) => `${a.id}:${a.activeDiscovery.kind}`),
    ["claude-code:run-records", "claude-code:cli-json", "codex:run-records", "opencode:run-records", "copilot:run-records"],
    "both claude-code discoveries are consulted, told apart by kind"
  );
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
  for (const id of ["codex", "opencode", "copilot"]) {
    assert.strictEqual(getHarness(id).failureFromEvent, undefined, `${id} declares no stream failure — its supervision is byte-identical`);
  }
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

test("--print previews the supervised launch (prompt on stdin) and, with --bg, the native one", () => {
  const { home, repo } = fixture();
  const sup = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(sup.status, 0, sup.stderr);
  assert.match(sup.stdout, /^run: {4}claude -p --output-format stream-json --verbose --name task-cc {2}# prompt on stdin$/m);
  assert.match(sup.stdout, /^session: \(read from claude -p --output-format stream-json session_id, bound by supervisor\)$/m);

  const bg = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print", "--bg"], { SPOR_HOME: home });
  assert.strictEqual(bg.status, 0, bg.stderr);
  assert.match(bg.stdout, /^run: {4}claude --bg --name task-cc <prompt>$/m);
  assert.match(bg.stdout, /^session: \(allocated by claude --bg at launch, bound after\)$/m);
});

test("--bg opts into the native launch: claude --bg with the prompt positional, a native-background run record", {
  // The stub is a .cmd on Windows, which spawnPortableSync runs through
  // cmd.exe — and cmd.exe ends the command line at the prompt's first newline,
  // so the positional arrives truncated. That is a real limitation of the
  // native launch through a .cmd shim (issue-spor-dispatch-bg-cmd-shim-
  // truncates-multiline-prompt), not something this test can assert around.
  skip: process.platform === "win32" && "a multi-line positional cannot pass through a cmd.exe-run .cmd stub",
}, () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-bg.json");
  const stub = claudeBgStub(home);
  const result = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--bg"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(Claude Code; 'spor runs' for its outcome\)/);
  const invocation = JSON.parse(fs.readFileSync(outfile, "utf8"));
  assert.strictEqual(invocation.args[0], "--bg");
  assert.match(invocation.args.at(-1), /Work on task-cc/, "the native launch carries the prompt positionally");
  const runDir = path.join(home, "journal", "dispatch");
  const record = JSON.parse(fs.readFileSync(path.join(runDir, fs.readdirSync(runDir).find((f) => f.endsWith(".run.json"))), "utf8"));
  assert.strictEqual(record.launch_mode, "native-background");
});

test("dispatch.claudeLaunchMode: native-background is the standing twin of --bg, and a no-op for a harness with no background mode", () => {
  const { home, repo } = fixture();
  const outfile = path.join(home, "claude-cfg.json");
  const stub = claudeBgStub(home);
  const viaEnv = run(["dispatch", "task-cc", "--dir", repo, "--no-brief"], {
    SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "native-background",
  });
  assert.strictEqual(viaEnv.status, 0, viaEnv.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(outfile, "utf8")).args[0], "--bg");

  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  cfg.dispatch.claudeLaunchMode = "native-background";
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const viaFile = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.stdout, /^run: {4}claude --bg /m, "the user config.json knob routes the same way");

  // The knob is Claude-specific: a Codex dispatch under it stays supervised, unrefused.
  const codex = run(["dispatch", "task-cc", "--dir", repo, "--profile", "profile-codex", "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /^run: {4}codex .*# prompt on stdin$/m);
  assert.match(codex.stdout, /^session: \(read from codex exec thread.started, bound by supervisor\)$/m);
});

test("an unrecognized dispatch.claudeLaunchMode value warns and is ignored (supervised)", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "task-cc", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "nativebackground" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: dispatch.claudeLaunchMode 'nativebackground' is not recognized/);
  assert.match(r.stdout, /^run: {4}claude -p /m);
});

test("spor work ignores dispatch.claudeLaunchMode: a worker's claude-code run is always supervised", async () => {
  // The worker loop's runs must be followable and judgeable (a report channel,
  // an enforced outcome), so a box-wide native-background knob — which cmdDispatch
  // honours for an interactive dispatch — must not route them to `claude --bg`.
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
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--project", "demo"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outfile, SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "native-background" }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the worker dispatched the task");
  assert.deepStrictEqual(invocation.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"], "supervised, despite the knob");
  const recordPath = await runRecordFile(home);
  assert.strictEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")).launch_mode, "supervised-jsonl");
});

test("an explicit --bg on a harness with no background mode is refused before any side effect", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "task-cc", "--dir", repo, "--profile", "profile-codex", "--no-brief", "--bg"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /cannot use --bg with a Codex dispatch — only Claude Code has a native background/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "nothing launched, no run record");
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
      if (req.method === "POST" && req.url === "/v1/nodes") return j(201, { ok: true, id: "art-report" });
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
