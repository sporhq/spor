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

test("HEAD 405 falls back to authenticated bounded GET and releases every response body", async () => {
  for (const [status, expected] of [[401, false], [403, false], [405, false], [404, true], [200, true], [206, true]]) {
    const calls = [], released = [];
    const result = await availability.probeHttpStore("https://example.test/store", { bearer: "probe-token", fetcher: async (_url, options) => {
      calls.push(options);
      const responseStatus = options.method === "HEAD" ? 405 : status;
      return { status: responseStatus, ok: responseStatus >= 200 && responseStatus < 300, body: { cancel: async () => released.push(options.method) } };
    } });
    assert.equal(result.ok, expected, `GET ${status}`);
    assert.deepEqual(calls.map(c => c.method), ["HEAD", "GET"]);
    assert.deepEqual(released, ["HEAD", "GET"]);
    assert.equal(calls[1].headers.Authorization, "Bearer probe-token");
    assert.equal(calls[1].headers.Range, "bytes=0-0");
    assert.equal(calls[1].signal, calls[0].signal, "one deadline spans the fallback");
    assert.equal(calls[1].redirect, "error");
    assert.ok(calls.every(c => c.body === undefined));
  }
});

test("propose checks its local target before probing the remote and recovers without fetching", async () => {
  const f = fixture(); let local = false; const calls = [];
  const definition = { integration: { mode: "propose", targetRef: "origin/main" } };
  const git = (_cwd, args, opts) => {
    calls.push(args);
    assert.equal(opts.timeout, availability.PROBE_TIMEOUT_MS);
    return { status: args[0] === "rev-parse" && !local ? 1 : 0 };
  };
  const missing = await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not resolve/);
  assert.deepEqual(calls, [["rev-parse", "--verify", "origin/main^{commit}"]]);
  local = true; calls.length = 0;
  assert.equal((await availability.probeFactoryAvailability({ ...f.args, factory: definition }, { git })).ok, true);
  assert.deepEqual(calls, [["rev-parse", "--verify", "origin/main^{commit}"], ["ls-remote", "--exit-code", "origin", "refs/heads/main"]]);
});

test("candidate remote probe stays below its output bound with thousands of advertised refs", async () => {
  const f = fixture();
  const { gitSpawn } = require("../lib/shell/git-exec.js");
  const init = gitSpawn(f.cwd, ["init", "--bare", "--initial-branch=main"]);
  assert.equal(init.status, 0, init.stderr);
  const hash = "a".repeat(40);
  fs.writeFileSync(path.join(f.cwd, "packed-refs"), ["# pack-refs with: peeled fully-peeled sorted", `${hash} refs/heads/main`, ...Array.from({ length: 7000 }, (_, i) => `${hash} refs/tags/advertised-${String(i).padStart(5, "0")}`)].join("\n") + "\n");
  const all = gitSpawn(f.cwd, ["ls-remote", f.cwd], { maxBuffer: 256 * 1024 });
  assert.notEqual(all.status, 0, "fixture reproduces unbounded advertisement overflow");
  const calls = [];
  const git = (cwd, args, opts) => {
    if (args[0] === "remote") return { status: 0, stdout: "https://example.test/repo.git" };
    calls.push(args);
    return gitSpawn(cwd, [args[0], f.cwd, ...args.slice(2)], opts);
  };
  const result = await availability.probeFactoryAvailability({ ...f.args, factory: factory({ publish: "branch", remote: "origin" }) }, { git });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(calls, [["ls-remote", "origin", "HEAD"]]);
});

function isolatedSshEnv(t) {
  const keys = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY", "SPOR_ATTESTATION_KEY"];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
}
function sshFixture(t, { hanging = false } = {}) {
  const f = fixture();
  const { gitSpawn } = require("../lib/shell/git-exec.js");
  const init = gitSpawn(f.cwd, ["init", "--bare", "--initial-branch=main"]);
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(f.cwd, "refs", "heads", "main"), "a".repeat(40) + "\n");
  assert.equal(gitSpawn(f.cwd, ["remote", "add", "origin", "probe.invalid:repo"]).status, 0);
  const record = path.join(f.home, "ssh-invocation.json");
  const wrapper = path.join(f.home, "configured ssh wrapper");
  const body = hanging
    ? `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid,child:child.pid})); setInterval(()=>{},1000);`
    : `let tty = false; try { const fd = fs.openSync('/dev/tty','r'); fs.closeSync(fd); tty = true; } catch {}\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),tty,terminal:process.env.GIT_TERMINAL_PROMPT,askpass:process.env.GIT_ASKPASS,sshAskpass:process.env.SSH_ASKPASS,requireAskpass:process.env.SSH_ASKPASS_REQUIRE,display:process.env.DISPLAY,signing:process.env.SPOR_ATTESTATION_KEY,command:process.env.GIT_SSH_COMMAND,ssh:process.env.GIT_SSH,variant:process.env.GIT_SSH_VARIANT}));\nconst r = require('node:child_process').spawnSync('git',['upload-pack',${JSON.stringify(f.cwd)}],{stdio:'inherit'}); process.exit(r.status ?? 1);`;
  fs.writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs');\n${body}\n`, { mode: 0o700 });
  return { ...f, record, wrapper, gitSpawn };
}

for (const transport of ["environment-command", "core-command", "ssh-executable", "tortoiseplink-variant"]) {
  test(`availability uses configured ${transport} through actual Git without a network connection`, { skip: process.platform === "win32" }, async t => {
    isolatedSshEnv(t);
    const f = sshFixture(t);
    const command = `'${f.wrapper.replaceAll("'", "'\\''")}' --configured-route`;
    process.env.GIT_SSH_VARIANT = transport === "tortoiseplink-variant" ? "tortoiseplink" : "simple";
    if (transport === "core-command") assert.equal(f.gitSpawn(f.cwd, ["config", "core.sshCommand", command]).status, 0);
    else if (transport === "ssh-executable") process.env.GIT_SSH = f.wrapper;
    else process.env.GIT_SSH_COMMAND = command;
    process.env.GIT_ASKPASS = "/must-not-run";
    process.env.SSH_ASKPASS = "/must-not-run";
    process.env.SSH_ASKPASS_REQUIRE = "force";
    process.env.DISPLAY = ":must-not-open";
    process.env.SPOR_ATTESTATION_KEY = "must-not-reach-transport";
    const result = await availability.probeFactoryAvailability({ ...f.args, factory: { integration: { mode: "push", targetRef: "origin/main" } } });
    assert.equal(result.ok, true, result.reason);
    const observed = JSON.parse(fs.readFileSync(f.record, "utf8"));
    assert.equal(observed.tty, false);
    assert.equal(observed.terminal, "0");
    assert.equal(observed.askpass, ""); assert.equal(observed.sshAskpass, "");
    assert.equal(observed.requireAskpass, "never"); assert.equal(observed.display, undefined);
    assert.equal(observed.signing, undefined);
    assert.equal(observed.variant, process.env.GIT_SSH_VARIANT);
    assert.equal(observed.command, process.env.GIT_SSH_COMMAND);
    assert.equal(observed.ssh, process.env.GIT_SSH);
    assert.equal(observed.args.some(arg => arg.includes("BatchMode")), false, "do not translate arbitrary transport commands into OpenSSH");
    if (transport !== "ssh-executable") assert.ok(observed.args.includes("--configured-route"));
    if (transport === "tortoiseplink-variant") assert.ok(observed.args.includes("-batch"), "Git's own variant behavior is retained");
  });
}

test("availability timeout kills the owned POSIX Git/SSH group including a child holding output pipes", { skip: process.platform !== "linux", timeout: 15000 }, async t => {
  isolatedSshEnv(t);
  const f = sshFixture(t, { hanging: true });
  process.env.GIT_SSH_COMMAND = `'${f.wrapper.replaceAll("'", "'\\''")}'`;
  process.env.GIT_SSH_VARIANT = "simple";
  let observed;
  t.after(() => {
    if (!observed && fs.existsSync(f.record)) observed = JSON.parse(fs.readFileSync(f.record, "utf8"));
    for (const pid of observed ? [observed.pid, observed.child] : []) { try { process.kill(pid, "SIGKILL"); } catch {} }
  });
  const start = Date.now();
  const result = await availability.probeFactoryAvailability({ ...f.args, factory: { integration: { mode: "push", targetRef: "origin/main" } } });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.ok(elapsed >= 4500 && elapsed < 10000, `five-second probe returned in ${elapsed}ms`);
  observed = JSON.parse(fs.readFileSync(f.record, "utf8"));
  const terminated = pid => {
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "); }
    catch (e) { if (e.code === "ENOENT") return true; throw e; }
  };
  for (let attempt = 0; attempt < 50 && ![observed.pid, observed.child].every(terminated); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(terminated(observed.pid), "SSH wrapper is no longer running");
  assert.ok(terminated(observed.child), "inherited-pipe child is no longer running");
});
