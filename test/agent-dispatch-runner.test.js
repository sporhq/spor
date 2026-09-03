"use strict";

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  atomicJson,
  portableSpawn,
  readJson,
  runJob,
} = require("../lib/shell/agent-dispatch-runner.js");
const { writeSpawnableNodeStub } = require("./helpers/portable.js");

function jobFixture(scriptBody, prompt, { scratchPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-runner-test-"));
  const command = writeSpawnableNodeStub(dir, "agent-child", scriptBody);
  const record = path.join(dir, "run.run.json");
  const job = path.join(dir, "run.job.json");
  const promptPath = path.join(dir, "run.prompt");
  const log = path.join(dir, "run.log");
  const report = path.join(dir, "run.report.md");
  fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
  atomicJson(record, {
    run_id: "runner-test",
    name: "task-runner-test",
    harness: "codex",
    state: "launching",
    cwd: dir,
    log_path: log,
    report_path: report,
  });
  atomicJson(job, {
    run_id: "runner-test",
    harness: "codex",
    command,
    args: [],
    cwd: dir,
    record_path: record,
    prompt_path: promptPath,
    log_path: log,
    report_path: report,
    ...(scratchPath ? { scratch_path: scratchPath } : {}),
  });
  return { dir, job, log, record };
}

test("portableSpawn resolves Windows PATHEXT shims before selecting ComSpec", () => {
  const calls = [];
  const sentinel = {};
  const opts = { env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, cwd: "C:\\repo" };
  const result = portableSpawn("codex", ["exec", "-"], opts, {
    platform: "win32",
    which: (command) => {
      assert.strictEqual(command, "codex");
      return "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    },
    spawn: (...args) => {
      calls.push(args);
      return sentinel;
    },
  });
  assert.strictEqual(result, sentinel);
  assert.deepStrictEqual(calls, [[
    "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/s", "/c", "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", "exec", "-"],
    opts,
  ]]);
});

test("early child exit during a large prompt records a terminal failure instead of crashing on EPIPE", async () => {
  const fixture = jobFixture("process.exit(7);", "x".repeat(8 * 1024 * 1024));
  const code = await runJob(fixture.job);
  const record = readJson(fixture.record);
  assert.strictEqual(code, 7);
  assert.strictEqual(record.state, "failed");
  assert.strictEqual(record.exit_code, 7);
  assert.ok(record.finished_at, "the run reached a terminal journal state");
});

// inc-spor-dispatch-session-vanished-2026-07-18: an observed exit still has to
// retain WHY, and separate the environment's failures from the work's.
test("supervisor finalization classifies every terminal state, and keeps the reason", async () => {
  const ok = await runJob(jobFixture("process.exit(0);", "p\n").job);
  assert.strictEqual(ok, 0);

  const failed = jobFixture("process.exit(3);", "p\n");
  await runJob(failed.job);
  const failedRec = readJson(failed.record);
  assert.strictEqual(failedRec.termination_class, "failed");
  assert.match(failedRec.termination_reason, /exited 3/);

  const missing = jobFixture("process.exit(0);", "p\n");
  fs.unlinkSync(path.join(missing.dir, "run.prompt"));
  assert.strictEqual(await runJob(missing.job), 2);
  const missingRec = readJson(missing.record);
  assert.strictEqual(missingRec.state, "failed_launch");
  assert.strictEqual(missingRec.termination_class, "launch");
  assert.ok(missingRec.termination_reason);
});

test("a supervised child killed by provider credit exhaustion is an ENVIRONMENT failure, not a failed implementation", async () => {
  const fixture = jobFixture(`
const fs = require("node:fs");
fs.writeSync(2, "API Error: your account is out of usage credits\\n");
process.exit(1);
`, "p\n");
  await runJob(fixture.job);
  const record = readJson(fixture.record);
  assert.strictEqual(record.state, "failed");
  assert.strictEqual(record.termination_class, "environment");
  assert.strictEqual(record.termination_signal, "credit-exhausted");
  assert.match(record.termination_reason, /out of usage credits/);
});

// issue-spor-dispatch-observed-exit-unbounded-tail-classification: the
// observed-exit path must classify only the log's TRAILING window, exactly
// like the derived (supervisor-gone) path — an early, recovered-from rate
// limit must not overshadow a genuine failure the run went on to hit.
test("an observed exit does not let an early, recovered-from rate limit overshadow a later genuine failure", async () => {
  const fixture = jobFixture(`
const fs = require("node:fs");
fs.writeSync(2, "API Error: rate_limit_error, retrying\\n");
for (let i = 0; i < 200; i++) fs.writeSync(1, "resumed after backoff, run " + i + "\\n");
fs.writeSync(2, "Tests failed: 3 failing, 0 passing\\n");
process.exit(1);
`, "p\n");
  await runJob(fixture.job);
  const record = readJson(fixture.record);
  assert.strictEqual(record.state, "failed");
  assert.strictEqual(record.termination_class, "failed", "the recovered-from rate limit must not be read as this run's cause of death");
  assert.strictEqual(record.termination_signal, "nonzero-exit");
  assert.match(record.termination_reason, /exited 1/);
});

test("runJob drains child stdio, parses the final session event, and flushes the journal before returning", async () => {
  const fixture = jobFixture(`
const fs = require("node:fs");
const event = JSON.stringify({ type: "item.completed", payload: "x".repeat(1000) }) + "\\n";
for (let i = 0; i < 4096; i++) fs.writeSync(1, event);
fs.writeSync(1, JSON.stringify({ type: "thread.started", thread_id: "thread-at-stream-tail" }) + "\\n");
fs.writeSync(2, "STDERR-AT-STREAM-TAIL\\n");
`, "prompt\n");
  const code = await runJob(fixture.job);
  assert.strictEqual(code, 0);
  const record = readJson(fixture.record);
  assert.strictEqual(record.state, "done");
  assert.strictEqual(record.session_id, "thread-at-stream-tail");
  const log = fs.readFileSync(fixture.log, "utf8");
  assert.match(log, /"thread_id":"thread-at-stream-tail"/);
  assert.match(log, /STDERR-AT-STREAM-TAIL/);
  assert.ok(log.length > 4 * 1024 * 1024, "the complete buffered stream is durable at return");
});

// --- nested Codex-from-Codex sandbox isolation ------------------------------
// (task-spor-nested-codex-dispatch-sandbox-isolation,
// dec-spor-nested-codex-supervisor-provisions-codex-home)

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (had) process.env[key] = prior;
    else delete process.env[key];
  });
}

test("a nested dispatch under a read-only CODEX_HOME starts successfully in an isolated writable one, and the real home is never written to", async (t) => {
  if (process.platform === "win32") return; // chmod-based read-only has no meaning there
  if (process.getuid && process.getuid() === 0) return; // root writes through any permission bits

  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-real-home-"));
  fs.writeFileSync(path.join(realHome, "auth.json"), '{"token":"real-secret"}\n');
  fs.writeFileSync(path.join(realHome, "config.toml"), "model = \"o-real\"\n");
  const before = fs.readdirSync(realHome).sort();
  fs.chmodSync(realHome, 0o500); // read + execute only — no new files can land here
  t.after(() => { try { fs.chmodSync(realHome, 0o700); } catch { /* best-effort */ } });

  const scratchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-scratch-parent-")), "run.scratch");
  const fixture = jobFixture(`
const fs = require("node:fs");
fs.writeFileSync(process.env.OUTFILE, JSON.stringify({
  codexHome: process.env.CODEX_HOME || null,
  hasState: fs.existsSync(require("node:path").join(process.env.CODEX_HOME || "", "state")),
  auth: fs.readFileSync(require("node:path").join(process.env.CODEX_HOME, "auth.json"), "utf8"),
}));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "nested-thread" }) + "\\n");
`, "p\n", { scratchPath });
  const outfile = path.join(fixture.dir, "invocation.json");

  await withEnv("CODEX_HOME", realHome, async () => {
    process.env.OUTFILE = outfile;
    try {
      const code = await runJob(fixture.job);
      assert.strictEqual(code, 0);
    } finally {
      delete process.env.OUTFILE;
    }
  });

  const record = readJson(fixture.record);
  assert.strictEqual(record.state, "done");

  const invocation = JSON.parse(fs.readFileSync(outfile, "utf8"));
  assert.notStrictEqual(invocation.codexHome, realHome, "the child ran under an isolated CODEX_HOME, not the read-only real one");
  assert.strictEqual(invocation.codexHome, scratchPath);
  assert.strictEqual(invocation.hasState, true, "the isolated home carries its own state/ dir");
  assert.strictEqual(invocation.auth, '{"token":"real-secret"}\n', "auth is read-only PROJECTED from the real home, not absent");

  // The real home was never written to: same file list, same content.
  assert.deepStrictEqual(fs.readdirSync(realHome).sort(), before);
  fs.chmodSync(realHome, 0o700); // restore before reading, for the content check below
  assert.strictEqual(fs.readFileSync(path.join(realHome, "auth.json"), "utf8"), '{"token":"real-secret"}\n');

  // Temporary state does not outlive the run.
  assert.strictEqual(fs.existsSync(scratchPath), false, "the isolated CODEX_HOME is cleaned up once the run finishes");
});

test("an ordinary (writable) CODEX_HOME passes straight through — no isolation, no new directory", async () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-writable-home-"));
  const scratchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-codex-scratch-parent-")), "run.scratch");
  const fixture = jobFixture(`
const fs = require("node:fs");
fs.writeFileSync(process.env.OUTFILE, JSON.stringify({ codexHome: process.env.CODEX_HOME || null }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "writable-thread" }) + "\\n");
`, "p\n", { scratchPath });
  const outfile = path.join(fixture.dir, "invocation.json");

  await withEnv("CODEX_HOME", realHome, async () => {
    process.env.OUTFILE = outfile;
    try {
      const code = await runJob(fixture.job);
      assert.strictEqual(code, 0);
    } finally {
      delete process.env.OUTFILE;
    }
  });

  const invocation = JSON.parse(fs.readFileSync(outfile, "utf8"));
  assert.strictEqual(invocation.codexHome, realHome, "CODEX_HOME is passed through unchanged when the real home is writable");
  assert.strictEqual(fs.existsSync(scratchPath), false, "nothing is provisioned for the byte-identical non-nested path");
});

// issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-background-job (F2):
// the supervisor keeps only the LAST text as the report, so an early message
// — a rescue's diagnosis block, emitted before a long verification — is only
// on the run log. runReportTexts reads every candidate back off that log
// through the same adapter hook, in stream order, skipping what is not a
// JSON event (stderr interleaved into the log) and what carries no text.
test("runReportTexts reads every final-message candidate back off the run log, in order, fail-soft", () => {
  const { runReportTexts, runPaths, atomicJson: writeJson } = require("../lib/shell/agent-dispatch-runner.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-runner-texts-"));
  const log = path.join(dir, "run.log");
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    log,
    line({ type: "system", subtype: "init", session_id: "s1" }) +
      line({ type: "assistant", message: { content: [{ type: "text", text: 'Diagnosed.\n```json\n{"diagnosis":"early","category":"real-defect"}\n```' }] } }) +
      "warning: some stderr noise the child printed\n" +
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }) +
      line({ type: "assistant", message: { content: [{ type: "text", text: "The suite is running in the background; I'll commit once it notifies me." }] } }) +
      line({ type: "result", subtype: "success", is_error: false, result: "The suite is running in the background; I'll commit once it notifies me." }) +
      "{not json at all\n"
  );
  assert.deepStrictEqual(runReportTexts({ harness: "claude-code", log_path: log }), [
    'Diagnosed.\n```json\n{"diagnosis":"early","category":"real-defect"}\n```',
    "The suite is running in the background; I'll commit once it notifies me.",
    "The suite is running in the background; I'll commit once it notifies me.",
  ]);
  // No log, no adapter, an unreadable log → nothing, never a throw.
  assert.deepStrictEqual(runReportTexts({ harness: "claude-code" }), []);
  assert.deepStrictEqual(runReportTexts({ harness: "no-such-harness", log_path: log }), []);
  assert.deepStrictEqual(runReportTexts({ harness: "claude-code", log_path: path.join(dir, "missing.log") }), []);
  assert.deepStrictEqual(runReportTexts(null), []);
  // A DECLARED harness has no registry entry: its declaration is read from the
  // run's job file under `home` (the same file the supervisor rebuilt it from).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-runner-texts-home-"));
  const p = runPaths(home, "run-declared");
  fs.mkdirSync(path.dirname(p.job), { recursive: true });
  const declaration = { id: "fake", command: "/bin/fake", args: [], label: "Fake", session: [], report: { from: "lastText", text: ["message.text"] } };
  writeJson(p.job, { run_id: "run-declared", harness: "fake", harness_declaration: declaration });
  fs.writeFileSync(log, line({ kind: "message", message: { text: "first" } }) + line({ kind: "message", message: { text: "last" } }));
  assert.deepStrictEqual(runReportTexts({ run_id: "run-declared", harness: "fake", log_path: log }, { home }), ["first", "last"]);
  assert.deepStrictEqual(runReportTexts({ run_id: "run-declared", harness: "fake", log_path: log }), [], "without a home the declaration cannot be found");
});

// F2's second residual (issue-spor-rescue-and-fix-sessions-end-turn-waiting-
// on-background-job): a DECLARED harness's declaration lived only in the job
// file, which the supervisor deletes at launch — so for every FINISHED
// declared-harness run runReportTexts had nothing to rebuild the adapter from
// and the early block was lost. The supervisor now stamps the declaration on
// the persistent run record before the job file goes; the reader needs no
// home and no job file.
test("runJob carries a declared harness's declaration onto the run record so the log stays readable after the job file is gone", async () => {
  const { runReportTexts } = require("../lib/shell/agent-dispatch-runner.js");
  const declaration = { id: "fake", command: "/bin/fake", args: [], label: "Fake", session: [], report: { from: "lastText", text: ["message.text"] } };
  const fixture = jobFixture(
    'process.stdout.write(JSON.stringify({kind:"message",message:{text:"```json\\n{\\"diagnosis\\":\\"early\\",\\"category\\":\\"prompt\\"}\\n```"}}) + "\\n" + JSON.stringify({kind:"message",message:{text:"I will commit once the suite notifies me."}}) + "\\n"); process.exit(0);',
    "p\n"
  );
  const job = readJson(fixture.job);
  atomicJson(fixture.job, { ...job, harness: "fake", harness_declaration: declaration });
  atomicJson(fixture.record, { ...readJson(fixture.record), harness: "fake" });
  assert.strictEqual(await runJob(fixture.job), 0);
  assert.ok(!fs.existsSync(fixture.job), "the job file is gone after launch");
  const record = readJson(fixture.record);
  assert.deepStrictEqual(record.harness_declaration, declaration, "the declaration rides the record");
  assert.strictEqual(record.state, "done");
  const texts = runReportTexts(record);
  assert.strictEqual(texts.length, 2, `both messages read back off the log with no home and no job file (${JSON.stringify(texts)})`);
  assert.match(texts[0], /"diagnosis":"early"/);
  // A built-in harness stamps nothing (byte-identical).
  const plain = jobFixture("process.exit(0);", "p\n");
  await runJob(plain.job);
  assert.strictEqual(readJson(plain.record).harness_declaration, undefined);
});

// F2's residual: Codex writes its report itself (`--output-last-message`) and
// so declares NO reportFromEvent — which left a Codex rescue's stream with no
// text hook, runReportTexts empty, and the early block lost. The adapter now
// declares the read-only `messageFromEvent` (every `agent_message` item), and
// the reader prefers it; the supervisor still consults only reportFromEvent,
// so what a Codex run's report IS does not change.
test("runReportTexts reads a Codex stream's assistant messages through the read-only message hook", () => {
  const { runReportTexts } = require("../lib/shell/agent-dispatch-runner.js");
  const { getHarness } = require("../lib/shell/dispatch-harnesses.js");
  assert.strictEqual(typeof getHarness("codex").messageFromEvent, "function");
  assert.strictEqual(getHarness("codex").reportFromEvent, undefined, "the supervisor's report hook stays undeclared: Codex writes its own report file");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-runner-codex-texts-"));
  const log = path.join(dir, "run.log");
  const line = (o) => `${JSON.stringify(o)}\n`;
  const early = 'Diagnosed.\n```json\n{"diagnosis":"early","category":"real-defect"}\n```';
  fs.writeFileSync(
    log,
    line({ type: "thread.started", thread_id: "thread-1" }) +
      line({ type: "turn.started" }) +
      line({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } }) +
      line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: early } }) +
      line({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "npm test", status: "completed" } }) +
      line({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "" } }) +
      line({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Now fixing; the long suite is still running in the background." } }) +
      line({ type: "turn.completed", usage: { input_tokens: 1 } })
  );
  assert.deepStrictEqual(runReportTexts({ harness: "codex", log_path: log }), [early, "Now fixing; the long suite is still running in the background."]);
});
