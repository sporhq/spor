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

function jobFixture(scriptBody, prompt) {
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
