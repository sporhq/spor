"use strict";
// lib/shell/dispatch.js — the plan / preview / guard / execute split of
// `spor dispatch` (task-spor-extract-dispatch-and-work-from-bin-spor), driven
// directly against a fake host. The CLI-level behavior is test/dispatch.test.js;
// this file pins the STRUCTURE: the plan phase reaches no side-effecting host
// helper, and each phase stops where it says it does.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config.js");
const dispatchLib = require("../lib/shell/dispatch.js");
const { hermeticEnv } = require("./helpers/env.js");

// The helpers only the execute phase (or a FORK B re-route) may reach.
const EFFECTS = [
  "acquireLocalDispatchLock", "autoRouteToFleetHost", "claimDispatch", "createDispatchWorktree", "launchSupervisedHarness",
  "mintAgentToken", "onboardRepo", "removeDispatchWorktree", "reportFleetHosts", "writeDispatchMcpConfig",
];

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-dplan-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-dplan-repo-"));
  const cfg = loadConfig({ cwd: dir, env: hermeticEnv({ SPOR_HOME: home, HOME: home }) });
  return { home, dir, cfg };
}

// A host whose reads answer from fixtures and whose side-effecting helpers
// record the call and throw, so a plan that reaches one fails loudly.
function fakeHost(dir, over = {}) {
  const calls = [];
  const lines = { out: [], err: [] };
  const host = {
    err: (m) => lines.err.push(m),
    out: (m) => lines.out.push(m),
    agentIdGuess: () => null,
    badNodeIdReason: () => null,
    compileBriefing: async () => "",
    dirHostsSlug: () => true,
    dispatchAgentId: () => null,
    dispatchDeclineFindingCheck: () => null,
    dispatchReadinessCheck: () => null,
    dispatchResolutionReason: () => null,
    dispatchWorktreeDir: (d, n) => path.join(d, ".claude", "worktrees", n),
    dispatchedAgents: () => new Map(),
    harnessReadOnlyPostures: () => "none",
    hasCmd: () => true,
    isAgentId: (id) => /^agent-[a-z0-9-]+$/.test(id),
    liveWorkspaceWriters: () => [],
    nodeUnreadable: () => false,
    releaseLocalDispatchLock: () => {},
    renderLaunchArg: (a) => a,
    renderTemplate: (t) => ({ text: t, unknown: [] }),
    resolveDir: () => ({ dir, slug: "demo", source: "--dir" }),
    resolveDispatchProfile: async () => null,
    resolveNode: async () => null,
    shellQuote: (a) => a,
    targetRepoDispatchCfg: () => ({ worktree: null, worktreeSetup: null }),
    topQueueItem: async () => null,
    worktreeName: (n) => n,
  };
  for (const k of EFFECTS) {
    host[k] = () => {
      calls.push(k);
      throw new Error(`plan phase reached side-effecting host.${k}`);
    };
  }
  Object.assign(host, over);
  return { host, calls, lines };
}

test("createDispatcher refuses a host missing a helper, naming it", () => {
  const { host } = fakeHost("/tmp");
  delete host.resolveDir;
  assert.throws(() => dispatchLib.createDispatcher(host), /host is missing resolveDir/);
});

test("the host contract lists exactly what the module destructures", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "shell", "dispatch.js"), "utf8");
  const block = src.match(/const \{\n([\s\S]*?)\n {2}\} = host;/);
  assert.ok(block, "createDispatcher destructures its host");
  const names = block[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(names.slice().sort(), [...dispatchLib.HOST_FUNCTIONS].sort());
});

test("planDispatch: a free-text dispatch plans without touching any side-effecting helper or file", async () => {
  const { home, dir, cfg } = scratch();
  const { host, calls } = fakeHost(dir);
  const before = fs.readdirSync(home).sort();
  const plan = await dispatchLib.createDispatcher(host).planDispatch(cfg, { values: {}, positionals: ["write", "the", "thing"] });
  assert.strictEqual(typeof plan, "object", "a plan, not a refusal code");
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(fs.readdirSync(home).sort(), before, "the plan phase writes nothing under the home");
  assert.strictEqual(plan.name, "write the thing");
  assert.strictEqual(plan.res.dir, dir);
  assert.strictEqual(plan.harness, "claude-code");
  assert.match(plan.prompt, /write the thing/);
  assert.strictEqual(plan.dryRun, false);
});

test("planDispatch: a node-derived refusal returns an exit code before profile resolution", async () => {
  const { dir, cfg } = scratch();
  let profileResolved = false;
  const { host, calls, lines } = fakeHost(dir, {
    resolveNode: async (_cfg, id) => ({ id, title: "T", repo: "demo", raw: "" }),
    dispatchResolutionReason: () => "status done",
    resolveDispatchProfile: async () => {
      profileResolved = true;
      return null;
    },
  });
  const code = await dispatchLib.createDispatcher(host).planDispatch(cfg, { values: {}, positionals: ["task-demo-x"] });
  assert.strictEqual(code, 1);
  assert.strictEqual(profileResolved, false);
  assert.deepStrictEqual(calls, []);
  assert.match(lines.err.join("\n"), /task-demo-x is already resolved \(status done\) — not dispatching/);
});

test("planDispatch never asks profile resolution to persist its probe; the plan carries it", async () => {
  const { dir, cfg } = scratch();
  const seen = [];
  const probed = { harnesses: ["claude-code"] };
  const { host } = fakeHost(dir, {
    resolveDispatchProfile: async (_cfg, opts) => {
      seen.push(opts.persistProbe);
      return { id: "profile-x", source: "--profile", found: true, profile: { harness: "claude-code" }, verdict: { ok: true, reasons: [] }, probed };
    },
  });
  const plan = await dispatchLib.createDispatcher(host).planDispatch(cfg, { values: { profile: "profile-x" }, positionals: ["write", "the", "thing"] });
  assert.deepStrictEqual(seen, [false]);
  assert.strictEqual(plan.profileCheck.probed, probed);
});

test("refuseDispatch: an unsatisfiable profile refuses (local mode reaches no fleet helper)", async () => {
  const { dir, cfg } = scratch();
  const { host, calls, lines } = fakeHost(dir, {
    resolveDispatchProfile: async () => ({ id: "profile-x", source: "--profile", found: true, profile: { harness: "claude-code" }, verdict: { ok: false, reasons: ["harness codex not available here"] } }),
  });
  const d = dispatchLib.createDispatcher(host);
  const plan = await d.planDispatch(cfg, { values: { profile: "profile-x" }, positionals: ["write", "the", "thing"] });
  assert.strictEqual(await d.refuseDispatch(cfg, plan), 1);
  assert.deepStrictEqual(calls, []);
  assert.match(lines.err.join("\n"), /can't satisfy profile profile-x/);
});

test("previewDispatch renders the plan and exits 0 with no side effect", async () => {
  const { dir, cfg } = scratch();
  const { host, calls, lines } = fakeHost(dir);
  const d = dispatchLib.createDispatcher(host);
  const plan = await d.planDispatch(cfg, { values: { print: true }, positionals: ["write", "the", "thing"] });
  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(d.previewDispatch(cfg, plan), 0);
  assert.deepStrictEqual(calls, []);
  assert.match(lines.out.join("\n"), /--- prompt ---[\s\S]*write the thing/);
});
