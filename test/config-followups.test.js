"use strict";
// Client-config follow-ups (task-spor-client-config-followups-throttle-hint-defaults):
// the tenant-refusal log throttle is keyed per refusal, and session-start
// hints (writing nothing) when an enabled repo has no dispatch.repos entry.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");
const { defaultOf } = require("../lib/config-keys.js");
const { WORK_DEFAULTS } = require("../lib/shell/work-loop.js");

const HOOK = path.join(__dirname, "..", "bin", "spor-hook.js");

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cfgfu-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}
function hook(event, cwd, env) {
  return spawnSync(process.execPath, [HOOK, event, "--host", "claude-code"], {
    input: JSON.stringify({ cwd, session_id: "s1" }),
    env,
    encoding: "utf8",
  });
}

test("tenant-refusal throttle is per refusal: a second org is not hidden by the first", () => {
  const { home, cwd } = scratch();
  const base = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1", SPOR_AGENT_RUN: "1" };
  hook("session-start", cwd, hermeticEnv({ ...base, SPOR_ORG: "acme" }));
  hook("session-start", cwd, hermeticEnv({ ...base, SPOR_ORG: "acme" }));
  hook("session-start", cwd, hermeticEnv({ ...base, SPOR_ORG: "beta" }));
  const stamps = fs.readdirSync(path.join(home, "journal")).filter((f) => f.startsWith("tenant-refused-"));
  assert.strictEqual(stamps.length, 2);
  const log = fs.readFileSync(path.join(home, "journal", "remote.log"), "utf8");
  assert.strictEqual((log.match(/'acme'/g) || []).length, 1, "same refusal throttled");
  assert.match(log, /'beta'/);
});

test("session-start hints when the repo has no dispatch.repos entry, and writes nothing", () => {
  const { home, cwd } = scratch();
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1", SPOR_DISTILLING: "1" });
  const r = hook("session-start", cwd, env);
  assert.match(r.stdout, /spor repos add projx/);
  const cfgFile = path.join(home, "config.json");
  const written = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  assert.ok(!(written.dispatch && written.dispatch.repos), "session-start registered no repo");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { repos: { projx: cwd } } }));
  assert.doesNotMatch(hook("session-start", cwd, env).stdout, /spor repos add/);
});

test("callers read defaults from the key table", () => {
  assert.strictEqual(WORK_DEFAULTS.intervalMs, defaultOf("work.intervalMs"));
  assert.strictEqual(WORK_DEFAULTS.runIdleMs, defaultOf("work.runIdleMs"));
  assert.throws(() => defaultOf("no.such.key"));
});
