"use strict";
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const availability = require("../lib/shell/factory-availability.js");
const publish = require("../lib/shell/candidate-publish.js");
const cli = require("../bin/spor.js");
const loop = require("../lib/shell/work-loop.js");
const { loadConfig } = require("../lib/config.js");
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-availability-"));
  const cwd = path.join(home, "repo"); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { repos: { demo: cwd } } }));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  return { home, cwd, cfg, args: { repo: "demo", cwd, graphHome: home, mode: "local" } };
}
const factory = (candidate) => ({ id: "factory-test", implementation: { profile: "profile-astra", candidate }, gates: [] });

test("publication distinguishes invalid declarations from runtime store outages and rechecks recovery", async () => {
  const f = fixture();
  const store = path.join(f.home, "store"); fs.writeFileSync(store, "temporarily occupied by a file");
  const definition = factory({ publish: "bundle", bundleStore: pathToFileURL(store).href });
  const bad = publish.publishSatisfiability(definition, { graphHome: f.home });
  assert.equal(bad.ok, false); assert.equal(bad.configurationErrors.length, 0); assert.equal(bad.unavailable.length, 1);
  const before = await availability.probeFactoryAvailability({ ...f.args, factory: definition });
  assert.equal(before.ok, false); assert.match(before.reason, /not writable/);
  fs.unlinkSync(store);
  assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition })).ok, true);
  for (const uri of ["https://example.test/store", "file:///tmp/.git/store", "s3://bucket/store"]) {
    const invalid = publish.publishSatisfiability(factory({ publish: "bundle", bundleStore: uri }), { graphHome: f.home, mode: "local" });
    assert.equal(invalid.ok, false); assert.ok(invalid.configurationErrors.length, uri);
  }
});

test("each repo must have its own usable remote; network probes are bounded, read-only, and credential scrubbed", async () => {
  const f = fixture();
  const calls = [];
  let up = false;
  const git = (cwd, args, opts) => {
    calls.push({ cwd, args, opts });
    if (args[0] === "remote") return { status: cwd === f.cwd ? 0 : 2, stdout: "https://example.test/project.git" };
    return { status: up ? 0 : 2, stdout: "" };
  };
  const definition = factory({ publish: "branch", remote: "origin" });
  const mixed = publish.publishSatisfiability(definition, { graphHome: f.home, repoPaths: { demo: f.cwd, missing: "/missing" }, git });
  assert.equal(mixed.ok, true); assert.ok(mixed.warnings.length);
  const single = publish.publishSatisfiability(definition, { graphHome: f.home, repoPaths: { missing: "/missing" }, git });
  assert.equal(single.ok, false); assert.equal(single.configurationErrors.length, 0);
  const key = process.env.SPOR_ATTESTATION_KEY; process.env.SPOR_ATTESTATION_KEY = "judge-only";
  try {
    assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git })).ok, false);
    up = true;
    assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git })).ok, true);
  } finally { if (key === undefined) delete process.env.SPOR_ATTESTATION_KEY; else process.env.SPOR_ATTESTATION_KEY = key; }
  for (const call of calls.filter((c) => c.args[0] === "ls-remote")) {
    assert.equal(call.opts.timeout, 5000);
    assert.equal(call.opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(call.opts.env.SPOR_ATTESTATION_KEY, undefined);
    assert.ok(Object.values(call.opts.env).includes("core.hooksPath"));
  }
  assert.ok(calls.every((c) => ["remote", "ls-remote"].includes(c.args[0])));
});

test("local and remote integration targets are checked before claim and recover on a later probe", async () => {
  const f = fixture(); let up = false; const calls = [];
  const git = (cwd, args) => { calls.push(args); return { status: up ? 0 : 2 }; };
  for (const mode of ["local", "push", "propose"]) {
    const definition = { integration: { mode, targetRef: mode === "local" ? "main" : "origin/main" } };
    up = false; assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git })).ok, false);
    up = true; assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git })).ok, true);
  }
  assert.deepEqual(calls[0], ["rev-parse", "--verify", "main^{commit}"]);
  assert.deepEqual(calls[2], ["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
});

test("HTTP preflight uses no publication write, refuses auth/outages, and accepts reachable missing probe objects", async () => {
  const calls = [];
  for (const [status, ok] of [[401, false], [403, false], [503, false], [404, true], [200, true]]) {
    const result = await availability.probeHttpStore("https://example.test/store", { bearer: "store-token", fetcher: async (url, opts) => { calls.push({ url, opts }); return { status, ok: status === 200 }; } });
    assert.equal(result.ok, ok);
  }
  assert.equal((await availability.probeHttpStore("https://example.test/store", { fetcher: async () => { throw new Error("offline"); } })).ok, false);
  for (const { opts } of calls) { assert.equal(opts.method, "HEAD"); assert.equal(opts.body, undefined); assert.equal(opts.redirect, "error"); assert.equal(opts.headers.Authorization, "Bearer store-token"); }
});

test("negative availability cache doubles boundedly and resets after recovery or a changed definition", async () => {
  let now = 0, calls = 0, up = false;
  const check = availability.availabilityBackoff({ now: () => now, baseMs: 1000, maxMs: 4000 });
  const probe = async () => { calls++; return { ok: up, reason: "offline" }; };
  assert.equal((await check("repo+a", probe)).retryAfterMs, 1000);
  assert.equal((await check("repo+a", probe)).retryAfterMs, 1000); assert.equal(calls, 1);
  now = 1000; assert.equal((await check("repo+a", probe)).retryAfterMs, 2000);
  now = 3000; assert.equal((await check("repo+a", probe)).retryAfterMs, 4000);
  now = 7000; assert.equal((await check("repo+a", probe)).retryAfterMs, 4000);
  up = true; assert.equal((await check("repo+b", probe)).ok, true, "new definition probes immediately");
  now = 11000; assert.equal((await check("repo+a", probe)).ok, true);
  up = false; assert.equal((await check("repo+a", probe)).retryAfterMs, 1000);
});

test("worker stays alive through unavailable-to-available transition without claiming/holding or substituting profile", async () => {
  const f = fixture(); let now = 100000, checks = 0, launched = 0;
  const definition = factory({ publish: "bundle" });
  const item = { id: "task-demo", project: "demo", readiness: "agent", profile: "profile-declared" };
  const passthrough = { model: "gpt-6-astra" };
  const statuses = [];
  const check = cli.makeFactoryAvailabilityCheck(f.cfg, { passthrough, now: () => now, baseMs: 1000, maxMs: 4000, probe: async () => { checks++; return now >= 103000 ? { ok: true } : { ok: false, reason: "store offline" }; } });
  const dispatch = async (_cfg, selected, routed, ctx) => {
    launched++;
    assert.ok(now >= 103000, "claim/hold door never reached during outage");
    assert.equal(selected.profile, "profile-declared"); assert.deepEqual(routed, passthrough); assert.equal(ctx.factory.implementation.profile, "profile-astra");
    return { ok: true, run: { run_id: "run-one", harness: "fake", launch_mode: "supervised-jsonl" } };
  };
  const control = { stopping: false };
  const final = await loop.runWorkLoop({ opts: { workerId: "availability-test", intervalMs: 1000, maxIntervalMs: 4000, retryAfterMs: 0, max: 1 }, control, deps: {
    now: () => now, candidates: async () => [item],
    dispatch: (it) => cli.dispatchSatisfiableWorkItem(f.cfg, it, passthrough, { checkAvailability: check, dispatch, factory: definition, home: f.home }),
    sleep: async (ms) => { now += ms; if (now > 120000) control.stopping = true; },
    pollRuns: async () => [{ run_id: "run-one", terminal: true, record: { state: "done", terminal_state: "resolved", terminal_enforced: true } }],
    publish: (status) => statuses.push(JSON.parse(JSON.stringify(status))), log: () => {},
  } });
  assert.equal(launched, 1); assert.equal(final.dispatched, 1); assert.ok(checks >= 3);
  const skipped = statuses.flatMap((s) => s.skipped || []);
  assert.ok(skipped.some((s) => s.reason === "store offline" && s.kind === "availability" && Date.parse(s.until) > Date.parse(s.at)));
  assert.equal(fs.existsSync(path.join(f.home, "journal", "dispatch")), false, "unavailable work did not create a run record");
});
