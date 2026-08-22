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
