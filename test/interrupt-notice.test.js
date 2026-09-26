// The runner-parent outer-timeout notice (test/helpers/interrupt-notice.js,
// issue-spor-worker-contract-reload-e2e-cancelled-under-load). A SIGTERM to
// the `node --test` parent cancels every unfinished file with "Promise
// resolution is still pending but the event loop has already resolved". The
// helper makes the parent name the real cause on the way out, and must stay
// inert anywhere it would swallow the default termination.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HELPER = path.join(__dirname, "helpers", "interrupt-notice.js");
const NOTICE = /spor test runner: received SIGTERM after \d+s\. The suite was stopped from OUTSIDE/;

// Our own env minus NODE_TEST_CONTEXT: this file runs as a runner CHILD, and a
// nested runner that inherited the marker would behave as a child too.
function runnerEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Spawn, SIGTERM once `ready` shows up on stdout, and resolve with the exit.
// Listeners are attached before anything can fire; the kill deadline is a
// ref'd timer, so a child that never prints `ready` still settles.
function runAndTerm(args, env, ready) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let sent = false;
    const term = () => {
      if (sent) return;
      sent = true;
      child.kill("SIGTERM");
    };
    const deadline = setTimeout(term, 20000);
    child.stdout.on("data", (c) => {
      stdout += c;
      if (ready.test(stdout)) term();
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("a SIGTERM to the runner parent names the outer stop, and the unfinished file still reports the cancellation", { skip: process.platform === "win32" && "no SIGTERM delivery to a child on Windows" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-interrupt-notice-"));
  const file = path.join(dir, "slow.test.js");
  fs.writeFileSync(file, 'require("node:test")("slow", async () => { console.log("READY"); await new Promise((r) => setTimeout(r, 30000)); });\n');
  const r = await runAndTerm(["--require", HELPER, "--test", "--test-reporter=spec", file], runnerEnv(), /READY/);
  assert.match(r.stderr + r.stdout, NOTICE, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /Promise resolution is still pending but the event loop has already resolved/, "the runner's own cancellation still reports");
  assert.notStrictEqual(r.code, 0, "the parent still exits failing: node's own handler runs after the notice");
});

test("outside the runner parent the helper installs nothing, so a plain script still dies of SIGTERM", { skip: process.platform === "win32" && "no SIGTERM delivery to a child on Windows" }, async () => {
  const r = await runAndTerm(["--require", HELPER, "-e", 'console.log("READY"); setTimeout(() => {}, 30000);'], runnerEnv(), /READY/);
  assert.strictEqual(r.signal, "SIGTERM", "the default termination is not swallowed");
  assert.doesNotMatch(r.stderr, NOTICE);
});
