"use strict";

// OpenCode + GitHub Copilot CLI adapter coverage for the shared coding-agent
// dispatch registry (task-spor-dispatch-adapters-opencode-copilot). Hermetic by
// construction: every test here drives a real child process but a FAKE harness
// executable, so a CI runner with neither CLI installed runs the whole file.
//
// Know what that buys and what it does NOT. The stubs accept any argv and emit
// exactly the events the adapters parse, so these tests prove the SUPERVISOR
// plumbing — argv reaching the child, prompt on stdin, session binding, report
// capture, terminal records, refusals — and the argv assertions below are
// change-DETECTORS pinning the flags, not evidence the flags are right. Nothing
// here can verify the real CLI contract: that `opencode run` with no positional
// reads stdin, that `copilot` with no subcommand and no `-p` does too, or that
// `--auto` / `--allow-all` / `--no-ask-user` / `--output-format json` are
// spelled the way these adapters spell them. That is the job of the opt-in live
// suites (e2e-opencode-dispatch.test.js, e2e-copilot-dispatch.test.js), which
// CI SKIPS — so a flag renamed upstream stays green here and surfaces first on
// a provisioned box. Run those before trusting an adapter change.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses.js");
const { getHarness, harnesses } = dispatchHarnesses;
const { writeSpawnableNodeStub, pathWithOnlyGit } = require("./helpers/portable.js");

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

// One scratch graph home + target checkout carrying a task and a profile that
// selects `harness`. The declared capability map is what keeps profile
// satisfiability from refusing before the launch path is reached.
function fixture(harness) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `spor-${harness}-dispatch-`));
  const nodes = path.join(home, "nodes");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `spor-${harness}-target-`));
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, `task-${harness}.md`), `---
id: task-${harness}
type: task
repo: demo
title: Implement the ${harness} dispatch fixture
summary: Exercise the ${harness} dispatch adapter in a scratch checkout.
status: open
date: 2026-08-22
---
Exercise the adapter.
`);
  fs.writeFileSync(path.join(nodes, `profile-${harness}.md`), `---
id: profile-${harness}
type: profile
title: ${harness} test profile
summary: A profile selecting ${harness} for the dispatch test.
harness: ${harness}
model: profile-model
date: 2026-08-22
---
${harness} test profile.
`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { capabilities: { declared: { harnesses: [harness] } } },
  }, null, 2) + "\n");
  return { home, nodes, repo };
}

// Fake harnesses that speak each CLI's real JSONL shape (captured from
// opencode 1.18.0 and copilot 1.0.75) and record how they were invoked.
const STUB_TAIL = `
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    prompt,
    pwd: process.env.PWD || null,
    sporToken: process.env.SPOR_TOKEN || null,
    internalChildToken: process.env.SPOR_DISPATCH_CHILD_TOKEN || null,
  }, null, 2));
`;

function harnessStub(home, harness, { exitCode = 0, delayMs = 0, stderr = "" } = {}) {
  const emit = harness === "opencode"
    ? `
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_fixture", part: { type: "step-start" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", text: "not the final word" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", text: "stub final report" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: "ses_fixture", part: { type: "step-finish" } }) + "\\n");
`
    : `
  process.stdout.write(JSON.stringify({ type: "session.mcp_servers_loaded", data: { servers: [] }, ephemeral: true }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "not the final word" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant.message", data: { messageId: "m2", content: "stub final report" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", sessionId: "copilot-session-fixture", exitCode: ${exitCode} }) + "\\n");
`;
  return writeSpawnableNodeStub(home, `${harness}-stub`, `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
${STUB_TAIL}${emit}
  if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)} + "\\n");
  setTimeout(() => process.exit(${exitCode}), ${delayMs});
});
`);
}

const SESSIONS = { opencode: "ses_fixture", copilot: "copilot-session-fixture" };
const CMD_ENV = { opencode: "SPOR_OPENCODE_CMD", copilot: "SPOR_COPILOT_CMD" };

async function waitFor(read, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function awaitJson(file) {
  return waitFor(() => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  });
}

function awaitRecord(home, predicate, opts) {
  const runDir = path.join(home, "journal", "dispatch");
  return waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const file = fs.readdirSync(runDir).find((name) => name.endsWith(".run.json"));
    if (!file) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8")); } catch { return null; }
    return predicate(record) ? record : null;
  }, opts);
}

// ---- the registry contract -------------------------------------------------

test("the two new harnesses are ADDITIVE registry entries under the same uniform contract", () => {
  assert.deepStrictEqual(
    harnesses().map((adapter) => adapter.id),
    ["claude-code", "codex", "opencode", "copilot"],
    "the shipped adapters keep their identity and order; the new ones are appended"
  );
  for (const adapter of harnesses()) {
    assert.strictEqual(typeof adapter.command, "function", `${adapter.id} resolves a binary`);
    assert.strictEqual(typeof adapter.buildArgs, "function", `${adapter.id} builds argv`);
    assert.strictEqual(typeof adapter.validateOptions, "function", `${adapter.id} validates flags`);
    assert.strictEqual(typeof adapter.identityNote, "string", `${adapter.id} describes its own identity mechanism`);
    assert.ok(adapter.activeDiscovery && adapter.activeDiscovery.kind, `${adapter.id} declares active-run discovery`);
    assert.ok(["native-background", "supervised-jsonl"].includes(adapter.launchMode));
  }
  for (const id of ["opencode", "copilot"]) {
    const adapter = getHarness(id);
    assert.strictEqual(adapter.launchMode, "supervised-jsonl", `${id} reuses the Codex launch mode`);
    assert.strictEqual(adapter.activeDiscovery.kind, "run-records");
    assert.strictEqual(typeof adapter.sessionFromEvent, "function");
    assert.strictEqual(typeof adapter.reportFromEvent, "function");
  }
  assert.strictEqual(getHarness("gemini"), null, "a harness with no adapter still never silently substitutes");
});

test("the shipped claude-code and codex launch behavior is byte-identical", () => {
  assert.deepStrictEqual(
    getHarness("claude-code").buildArgs({
      name: "n", model: "m", permissionMode: "p", agent: "a", mcpConfig: "/mcp.json", prompt: "P",
    }),
    ["--bg", "--name", "n", "--model", "m", "--permission-mode", "p", "--agent", "a",
      "--mcp-config", "/mcp.json", "--strict-mcp-config", "P"]
  );
  assert.deepStrictEqual(
    getHarness("codex").buildArgs({ model: "m", reportPath: "/r.md" }),
    ["--ask-for-approval", "never", "exec", "--json", "--sandbox", "workspace-write",
      "--output-last-message", "/r.md", "--model", "m", "-"]
  );
  assert.strictEqual(getHarness("claude-code").command({}), "claude");
  assert.strictEqual(getHarness("codex").command({}), "codex");
  assert.strictEqual(getHarness("claude-code").command({ SPOR_CLAUDE_CMD: "/x/claude" }), "/x/claude");
  assert.strictEqual(getHarness("codex").command({ SPOR_CODEX_CMD: "/x/codex" }), "/x/codex");
  assert.strictEqual(getHarness("codex").reportFromEvent, undefined, "Codex still writes its own report file");
});

test("each new adapter builds the documented headless argv and keeps the prompt off argv", () => {
  const CWD = dispatchHarnesses.CWD_PLACEHOLDER;
  assert.deepStrictEqual(
    getHarness("opencode").buildArgs({ model: "m", reportPath: "/r.md", prompt: "secret briefing" }),
    ["run", "--format", "json", "--auto", "--dir", CWD, "--model", "m"]
  );
  assert.deepStrictEqual(getHarness("opencode").buildArgs({}), ["run", "--format", "json", "--auto", "--dir", CWD]);
  assert.deepStrictEqual(
    getHarness("copilot").buildArgs({ model: "m", reportPath: "/r.md", prompt: "secret briefing" }),
    ["--output-format", "json", "--allow-all", "--no-ask-user", "--no-color", "--model", "m"]
  );
  assert.deepStrictEqual(
    getHarness("copilot").buildArgs({}),
    ["--output-format", "json", "--allow-all", "--no-ask-user", "--no-color"]
  );
  for (const id of ["opencode", "copilot"]) {
    const args = getHarness(id).buildArgs({ prompt: "secret briefing", reportPath: "/r.md" });
    assert.ok(!args.some((a) => a.includes("secret briefing")), `${id} never puts the prompt in argv`);
  }
});

test("session and report extraction follow each CLI's real event shape", () => {
  const oc = getHarness("opencode");
  assert.strictEqual(oc.sessionFromEvent({ type: "step_start", sessionID: "ses_a" }), "ses_a");
  assert.strictEqual(oc.sessionFromEvent({ type: "step_start" }), null);
  assert.strictEqual(oc.reportFromEvent({ type: "text", part: { text: "hi" } }), "hi");
  assert.strictEqual(oc.reportFromEvent({ type: "step_finish", part: { text: "hi" } }), null);
  assert.strictEqual(oc.reportFromEvent({ type: "text", part: {} }), null);

  const cp = getHarness("copilot");
  assert.strictEqual(cp.sessionFromEvent({ type: "result", sessionId: "s1" }), "s1");
  assert.strictEqual(cp.sessionFromEvent({ type: "assistant.message", data: {} }), null);
  assert.strictEqual(cp.reportFromEvent({ type: "assistant.message", data: { content: "hi" } }), "hi");
  assert.strictEqual(cp.reportFromEvent({ type: "result", sessionId: "s1" }), null);
  for (const adapter of [oc, cp]) {
    assert.strictEqual(adapter.sessionFromEvent(null), null);
    assert.strictEqual(adapter.reportFromEvent(null), null);
  }
});

// ---- launcher resolution ---------------------------------------------------
// The brew-prefix trap this task exists for: a binary reachable only from an
// interactive shell passes a hand-check and ENOENTs on every real dispatch, so
// resolution must be EXPLICIT-first and a failure must name what it tried.

test("a launcher resolves env > dispatch.bin.<harness> > the bare name on PATH", () => {
  const cfg = { get: (key) => (key === "dispatch.bin.opencode" ? "/from/config/opencode" : undefined) };
  assert.strictEqual(getHarness("opencode").command({}, null), "opencode", "no override falls back to PATH");
  assert.strictEqual(getHarness("opencode").command({}, cfg), "/from/config/opencode");
  assert.strictEqual(
    getHarness("opencode").command({ SPOR_OPENCODE_CMD: "/from/env/opencode" }, cfg),
    "/from/env/opencode",
    "env outranks the config cascade, matching the shipped SPOR_*_CMD seams"
  );
  assert.strictEqual(getHarness("copilot").command({ SPOR_COPILOT_CMD: "/x/copilot" }), "/x/copilot");
  assert.deepStrictEqual(
    dispatchHarnesses.describeHarnessBin(getHarness("copilot"), { env: {}, cfg: null }),
    { command: "copilot", source: "PATH", explicit: false, onPath: true }
  );
  assert.deepStrictEqual(
    dispatchHarnesses.describeHarnessBin(getHarness("copilot"), { env: { SPOR_COPILOT_CMD: "/x/copilot" } }),
    { command: "/x/copilot", source: "$SPOR_COPILOT_CMD", explicit: true, onPath: false }
  );
  // A CONFIGURED bare name is still a PATH lookup, so it keeps the PATH
  // preflight rather than being waved through as "explicitly configured".
  assert.deepStrictEqual(
    dispatchHarnesses.describeHarnessBin(getHarness("copilot"), { env: { SPOR_COPILOT_CMD: "copilot" } }),
    { command: "copilot", source: "$SPOR_COPILOT_CMD", explicit: true, onPath: true }
  );
});

test("an explicit launcher override is checked at its own path, and a broken one does NOT fall back to PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-harness-bin-"));
  const real = writeSpawnableNodeStub(dir, "opencode", "process.exit(0);");
  const which = (cmd) => (cmd === "opencode" ? "/somewhere/on/path/opencode" : null);

  assert.strictEqual(dispatchHarnesses.harnessAvailable("opencode", { env: {}, which }), true);
  assert.strictEqual(
    dispatchHarnesses.harnessAvailable("opencode", { env: { SPOR_OPENCODE_CMD: real }, which }),
    true,
    "an override that exists is available even when PATH would also answer"
  );
  assert.strictEqual(
    dispatchHarnesses.harnessAvailable("opencode", { env: { SPOR_OPENCODE_CMD: path.join(dir, "absent") }, which }),
    false,
    "a launcher you NAMED and that is not there is an error, not a reason to guess at PATH"
  );
  assert.strictEqual(dispatchHarnesses.harnessAvailable("opencode", { env: {}, which: () => null }), false);
});

test("the machine-capability probe honours an explicit launcher override, from env AND from the config cascade", () => {
  const u = require("../scripts/engines/util.js");
  const graphHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-probe-bin-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-probe-launcher-"));
  const stub = writeSpawnableNodeStub(dir, "copilot", "process.exit(0);");
  const before = process.env.SPOR_COPILOT_CMD;
  try {
    // Without the override the probe answers from PATH alone; with it, the box
    // reports the harness so satisfiability cannot refuse before the launcher
    // it was told about is ever tried.
    process.env.SPOR_COPILOT_CMD = stub;
    assert.ok(u.probeCapabilities(graphHome).harnesses.includes("copilot"));
    process.env.SPOR_COPILOT_CMD = path.join(dir, "absent");
    assert.ok(!u.probeCapabilities(graphHome).harnesses.includes("copilot"));
    delete process.env.SPOR_COPILOT_CMD;

    // The config route has to work through a cascade PASSED IN by the caller.
    // The `spor` CLI resolves a Config per command and never installs it as
    // util's module-level active config, so a probe that read the active one
    // would see null on exactly the CLI paths that matter and drop this route
    // — dispatch would then refuse on satisfiability for the very launcher it
    // had been configured with.
    const cfg = { get: (key) => (key === "dispatch.bin.copilot" ? stub : undefined) };
    assert.ok(u.probeCapabilities(graphHome, { cfg }).harnesses.includes("copilot"));
    const broken = { get: (key) => (key === "dispatch.bin.copilot" ? path.join(dir, "absent") : undefined) };
    assert.ok(!u.probeCapabilities(graphHome, { cfg: broken }).harnesses.includes("copilot"));
  } finally {
    if (before === undefined) delete process.env.SPOR_COPILOT_CMD;
    else process.env.SPOR_COPILOT_CMD = before;
  }
});

// The end-to-end proof of the same thing through the REAL CLI: with the
// launcher nowhere on PATH but named in the user config, the dispatch must
// reach the launch rather than being refused by a capability probe that
// disagrees with the resolver running in the same process.
test("a dispatch whose launcher is only in the config cascade is NOT refused on satisfiability", async () => {
  const harness = "opencode";
  const { home, repo } = fixture(harness);
  const outfile = path.join(home, "config-route.json");
  const stub = harnessStub(home, harness, { delayMs: 50 });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  // Drop the DECLARED harness so the probe is the only thing that can satisfy
  // the profile — otherwise the declaration would mask a broken probe.
  cfg.dispatch.capabilities.declared = {};
  cfg.dispatch.bin = { [harness]: stub };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");

  const result = run(
    ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGit(), OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr, /can't satisfy profile/);
  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the configured launcher is the one that actually ran");
  assert.strictEqual(invocation.cwd, repo);
});

test("an absent default launcher is refused with a message naming the path tried and both override routes", () => {
  for (const harness of ["opencode", "copilot"]) {
    const missing = getHarness(harness).missingBinary;
    assert.match(missing, new RegExp(`tried '${harness}' on PATH`), `${harness} names what it tried`);
    assert.match(missing, new RegExp(`dispatch\\.bin\\.${harness}`), `${harness} names the config key`);
    assert.match(missing, new RegExp(CMD_ENV[harness]), `${harness} names the env override`);
  }
});

test("a real dispatch whose launcher is nowhere on PATH refuses BEFORE launching, naming the path it tried", () => {
  for (const harness of ["opencode", "copilot"]) {
    const { home, repo } = fixture(harness);
    // A PATH with only git on it: nothing resolves the bare launcher name, which
    // is precisely the shape a dispatched run sees on a box whose install prefix
    // reaches only an interactive shell.
    const result = run(
      ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, "--no-brief"],
      { SPOR_HOME: home, PATH: pathWithOnlyGit() }
    );
    assert.strictEqual(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`tried '${harness}' on PATH`));
    assert.match(result.stderr, new RegExp(`dispatch\\.bin\\.${harness}`));
    assert.ok(
      !fs.existsSync(path.join(home, "journal", "dispatch")),
      "nothing is launched and no run record is opened"
    );
  }
});

// ---- the dispatch path -----------------------------------------------------

for (const harness of ["opencode", "copilot"]) {
  test(`${harness} profile dry-run uses adapter argv and model precedence`, () => {
    const { home, repo } = fixture(harness);
    const common = ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, "--no-brief", "--print"];
    const fromProfile = run(common, { SPOR_HOME: home });
    assert.strictEqual(fromProfile.status, 0, fromProfile.stderr);
    assert.match(fromProfile.stdout, new RegExp(`harness: ${harness}`));
    assert.match(fromProfile.stdout, /# prompt on stdin/);
    assert.doesNotMatch(fromProfile.stdout, /__SPOR_/, "the preview renders placeholders readably");
    assert.match(fromProfile.stdout, /--model profile-model/);

    const override = run([...common, "--model", "flag-model"], { SPOR_HOME: home });
    assert.strictEqual(override.status, 0, override.stderr);
    assert.match(override.stdout, /--model flag-model/);
    assert.doesNotMatch(override.stdout, /--model profile-model/);
  });

  test(`${harness} adapter launches detached, binds its session, and writes the report from its event stream`, async () => {
    const { home, repo } = fixture(harness);
    const outfile = path.join(home, "invocation.json");
    // The stub stays alive well past the launch handshake, so a launcher that
    // waited for the RUN could not come in under the bound below.
    const stub = harnessStub(home, harness, { delayMs: 3000 });
    const started = Date.now();
    const result = run(
      ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, "--no-brief"],
      { SPOR_HOME: home, [CMD_ENV[harness]]: stub, OUTFILE: outfile }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(
      Date.now() - started < 2500,
      "dispatch returns after the launch handshake, not after the 3s run"
    );
    assert.match(result.stdout, /supervisor (launching|running|done)/);

    const invocation = await awaitJson(outfile);
    assert.ok(invocation, "the detached stub ran");
    assert.strictEqual(invocation.cwd, repo);
    assert.ok(
      !invocation.args.some((a) => a.startsWith("__SPOR_")),
      "launcher-supplied placeholders are substituted before the harness sees them"
    );
    if (harness === "opencode") {
      assert.deepStrictEqual(
        invocation.args.slice(0, 6),
        ["run", "--format", "json", "--auto", "--dir", repo],
        "OpenCode is told its directory explicitly — it reads $PWD, not getcwd()"
      );
      assert.strictEqual(
        invocation.pwd, repo,
        "and its adapter pins $PWD to match, so anything the run shells out to agrees"
      );
    } else {
      assert.notStrictEqual(
        invocation.pwd, repo,
        "an adapter that declares no prepareRun keeps the launch environment it always had — the PWD pin is OpenCode's, not the supervisor's"
      );
    }
    assert.match(invocation.prompt, new RegExp(`Implement the ${harness} dispatch fixture`));
    assert.ok(invocation.args.includes("profile-model"), "the profile's model reaches the real invocation");
    assert.ok(!invocation.args.some((a) => a.includes("Implement the")), "the prompt never enters argv");

    const finished = await awaitRecord(home, (r) => r.state === "done", { timeoutMs: 15000 });
    assert.ok(finished, "the supervisor records terminal success");
    assert.strictEqual(finished.harness, harness);
    assert.strictEqual(finished.launch_mode, "supervised-jsonl");
    assert.strictEqual(finished.session_id, SESSIONS[harness], "the session is bound from the harness's own JSONL");
    assert.strictEqual(finished.exit_code, 0);
    assert.strictEqual(finished.termination_signal, "supervised-exit");
    assert.strictEqual(
      fs.readFileSync(finished.report_path, "utf8"), "stub final report\n",
      "the LAST final-message event wins, matching --output-last-message semantics"
    );
  });

  test(`a non-zero ${harness} exit surfaces as a durable terminal reason, not a vanished session`, async () => {
    const { home, repo } = fixture(harness);
    const stub = harnessStub(home, harness, { exitCode: 7, stderr: "harness blew up" });
    const result = run(
      ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, "--no-brief"],
      { SPOR_HOME: home, [CMD_ENV[harness]]: stub, OUTFILE: path.join(home, "failing.json") }
    );
    assert.strictEqual(result.status, 0, result.stderr);

    const record = await awaitRecord(home, (r) => ["failed", "failed_launch", "vanished"].includes(r.state));
    assert.ok(record, "the supervisor reaches a terminal state on a failing child");
    assert.strictEqual(record.state, "failed");
    assert.strictEqual(record.exit_code, 7);
    assert.strictEqual(record.termination_class, "failed");
    assert.strictEqual(record.termination_signal, "nonzero-exit");
    assert.match(record.termination_reason, /exited 7/);

    const shown = run(["runs", "--json"], { SPOR_HOME: home });
    assert.strictEqual(shown.status, 0, shown.stderr);
    assert.strictEqual(JSON.parse(shown.stdout).runs[0].termination_signal, "nonzero-exit");
  });

  test(`${harness} rejects flags that belong to another harness, before any launch`, () => {
    const { home, repo } = fixture(harness);
    const outfile = path.join(home, "should-not-launch");
    const stub = harnessStub(home, harness);
    for (const [flag, value, owner] of [
      ["--permission-mode", "bypassPermissions", "Claude Code"],
      ["--agent", "reviewer", "Claude Code"],
      ["--sandbox", "workspace-write", "Codex"],
      ["--approval-policy", "never", "Codex"],
    ]) {
      const result = run(
        ["dispatch", `task-${harness}`, "--dir", repo, "--profile", `profile-${harness}`, flag, value, "--no-brief"],
        { SPOR_HOME: home, [CMD_ENV[harness]]: stub, OUTFILE: outfile }
      );
      assert.strictEqual(result.status, 1, `${flag} should be refused`);
      assert.match(result.stderr, new RegExp(`that flag is ${owner}-specific`));
      assert.ok(!fs.existsSync(outfile), `${flag} must be refused before the harness is launched`);
    }
  });
}
