"use strict";
// spawnCaptureSync (task-spor-generalize-spawn-capture-sync): a child that leaves
// a background daemon holding its stdout/stderr must not stall the capture.
const test = require("node:test");
const assert = require("node:assert");
const { spawnCaptureSync } = require("../bin/spor.js");

test("returns at child exit while a detached grandchild holds the output", () => {
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setTimeout(()=>{}, 15000)"], { stdio: "inherit", detached: true }).unref();
    process.stdout.write("out");
    process.stderr.write("oops");
    process.exit(3);`;
  const t0 = Date.now();
  const r = spawnCaptureSync(process.execPath, ["-e", script], { timeout: 10000 });
  assert.ok(Date.now() - t0 < 8000, "must not wait for the daemon");
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, "out");
  assert.strictEqual(r.stderr, "oops");
});
