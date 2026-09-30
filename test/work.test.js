"use strict";
// `spor work` as plan / preview / execute over an injected host
// (lib/shell/work.js, task-spor-extract-work-loop-plan-execute-and-outcome-door).
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createWorker, HOST_FUNCTIONS } = require("../lib/shell/work.js");
const { loadConfig } = require("../lib/config.js");

function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function fakeHost(over = {}) {
  const calls = [];
  const lines = { out: [], err: [] };
  const host = {};
  for (const k of HOST_FUNCTIONS) {
    host[k] = (...args) => {
      calls.push([k, args]);
      throw new Error(`the plan phase must not call ${k}`);
    };
  }
  Object.assign(host, {
    out: (s) => lines.out.push(s),
    err: (s) => lines.err.push(s),
    dispatchAgentId: () => null,
    isAgentId: (s) => /^agent-[a-z0-9-]+$/.test(String(s)),
    factoryScopeSlug: (repos) => (repos.length === 1 ? repos[0] : null),
    integrationSatisfiability: (cfg, factory, opts) => {
      calls.push(["integrationSatisfiability", [opts]]);
      return { ok: true, reasons: [] };
    },
  }, over);
  return { host, calls, lines };
}

const scratch = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-plan-"));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
  return { home, cfg };
};

test("createWorker refuses a host missing a helper, naming it", () => {
  const { host } = fakeHost();
  delete host.pollWorkRuns;
  assert.throws(() => createWorker(host), /missing pollWorkRuns/);
});

test("planWork refuses every malformed option at once, before any factory is read", async () => {
  const { home, cfg } = scratch();
  const { host, lines } = fakeHost();
  const code = await createWorker(host).planWork(cfg, { values: { max: "abc", interval: "3000000", accept: "maybe", factory: "factory-x" } });
  assert.equal(code, 1);
  assert.equal(lines.err.length, 3, lines.err.join("\n"));
  assert.deepEqual(listAll(home), []);
});

test("planWork resolves a bare worker's plan without writing anything", async () => {
  const { home, cfg } = scratch();
  const { host } = fakeHost();
  const plan = await createWorker(host).planWork(cfg, { values: { concurrency: "2", "permission-mode": "bypassPermissions", worktree: true } });
  assert.equal(typeof plan, "object");
  assert.equal(plan.concurrency, 2);
  assert.equal(plan.factory, null);
  assert.equal(plan.accept, "ready");
  assert.deepEqual(plan.passthrough, { "permission-mode": "bypassPermissions", worktree: true });
  assert.deepEqual(listAll(home), [], "the plan phase wrote nothing");
});

test("planWork loads and validates a factory read-only: the gh probe is not persisted and the bundle store is not created", async () => {
  const { home, cfg } = scratch();
  const store = path.join(home, "not-yet", "candidates");
  const factory = {
    id: "factory-x",
    repos: ["spor"],
    gates: [],
    integration: null,
    completion: { by: "controller", after: "gates" },
    implementation: { candidate: { publish: "bundle", bundleStore: pathToFileURL(store).href } },
  };
  const { host, calls, lines } = fakeHost({ loadFactoryDefinition: async (c, id) => (id === "factory-x" ? { factory } : { errors: ["no"] }) });
  const plan = await createWorker(host).planWork(cfg, { values: { factory: "factory-x" } });
  assert.equal(typeof plan, "object", lines.err.join("\n"));
  assert.equal(plan.factory, factory);
  assert.equal(plan.slug, "spor", "a single-repo factory narrows the default scope token");
  assert.deepEqual(calls.find((c) => c[0] === "integrationSatisfiability")[1][0], { persistProbe: false });
  assert.equal(fs.existsSync(store), false, "the bundle store is checked, never created, by the plan");
  assert.deepEqual(listAll(home), []);
});

test("planWork refuses a factory that does not load, and a worker never starts ungated", async () => {
  const { cfg } = scratch();
  const { host, lines } = fakeHost({ loadFactoryDefinition: async () => ({ factory: null, errors: ["gates: missing"] }) });
  assert.equal(await createWorker(host).planWork(cfg, { values: { factory: "factory-bad" } }), 1);
  assert.match(lines.err.join("\n"), /cannot be used[\s\S]*gates: missing[\s\S]*does not run ungated/);
});
