// validate-missing-graph.test.js — lib/validate.js's DIRECT entry
// (issue-spor-validate-enoent-remote-no-local-nodes) on a machine with no
// local graph at all: no --nodes, no SPOR_HOME, and no ~/.spor or ~/.substrate
// under the resolved home (the remote-mode shape — the team graph lives on the
// server, so this box was never given a local nodes/ dir). Before the fix,
// readdirSync in shell/files.js threw a raw ENOENT straight out of
// graph.validateGraph, printing a full stack trace instead of a clean message.
// `spor validate` itself is unaffected (bin/spor.js's cmdValidate fetches the
// team graph via GET /v1/export before ever calling this entry in remote
// mode) — this test is specifically about running the file directly.

require("./helpers/tmp-cleanup");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VALIDATE = path.join(__dirname, "..", "lib", "validate.js");

function envWithHome(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = home;
  return env;
}

test("direct entry: no local graph prints a clean message and exits non-zero, no stack trace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-no-graph-"));
  const r = spawnSync(process.execPath, [VALIDATE], { encoding: "utf8", env: envWithHome(home) });

  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, /no local graph at .*; in remote mode run `spor validate`/);
  assert.doesNotMatch(r.stderr, /at Object\.readdirSync|node:internal|\.js:\d+:\d+\)/);
  assert.doesNotMatch(r.stderr, /Error: ENOENT/);
});
