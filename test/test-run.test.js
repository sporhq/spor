// The suite runner behind `npm test` / `npm run test:shard`
// (scripts/test-run.js, task-spor-test-suite-runtime-budget): it assembles the
// `node --test` command line (preloads, concurrency, shard) and passes
// everything else through.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const RUNNER = path.join(__dirname, "..", "scripts", "test-run.js");
const { buildArgs, crashOnly, withCrashReporter, suiteEnv, verdictLine } = require(RUNNER);
const { gitEnv, gitInit } = require("./helpers/git");

// This file runs as a runner CHILD; a nested runner that inherited the marker
// would behave as a child too.
function runnerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

test("the default run is the whole suite with every preload and one file per core (never fewer than two)", () => {
  const args = withEnv("SPOR_TEST_CONCURRENCY", undefined, () => buildArgs([]));
  const preloads = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--require") preloads.push(args[i + 1]);
  assert.deepStrictEqual(preloads, [
    "./test/helpers/tmp-cleanup.js",
    "./test/helpers/interrupt-notice.js",
    "./test/helpers/compile-cache.js",
  ]);
  assert.ok(args.includes("--test"));
  const width = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  assert.ok(args.includes(`--test-concurrency=${Math.max(2, width)}`), args.join(" "));
  assert.strictEqual(args[args.length - 1], "test/*.test.js");
  assert.ok(!args.some((a) => a.startsWith("--test-shard")));
});

test("a shard is accepted as --shard i/n, --shard=i/n, or a bare i/n (`npm run test:shard -- 2/4`)", () => {
  for (const form of [["--shard", "2/4"], ["--shard=2/4"], ["2/4"]]) {
    const args = buildArgs(form);
    assert.ok(args.includes("--test-shard=2/4"), `${form.join(" ")}: ${args.join(" ")}`);
    assert.strictEqual(args[args.length - 1], "test/*.test.js", "sharding still covers the whole suite's file list");
  }
});

test("explicit files and --test flags pass through; an explicit concurrency wins over the default and the env", () => {
  const args = withEnv("SPOR_TEST_CONCURRENCY", "7", () =>
    buildArgs(["--test-concurrency=1", "--test-name-pattern=foo", "test/a.test.js", "test/b.test.js"])
  );
  assert.ok(args.includes("--test-concurrency=1"));
  assert.ok(!args.includes("--test-concurrency=7"));
  assert.ok(args.includes("--test-name-pattern=foo"));
  assert.deepStrictEqual(args.slice(-2), ["test/a.test.js", "test/b.test.js"]);
  assert.ok(!args.includes("test/*.test.js"));
  // A flag's value given as its own word is the flag's, never a file: the
  // default file list must survive it.
  const spaced = withEnv("SPOR_TEST_CONCURRENCY", undefined, () =>
    buildArgs(["--test-name-pattern", "lock", "--test-concurrency", "4", "--test-reporter", "dot"])
  );
  assert.deepStrictEqual(spaced.slice(spaced.indexOf("--test-name-pattern")), [
    "--test-name-pattern", "lock", "--test-concurrency", "4", "--test-reporter", "dot", "test/*.test.js",
  ]);
  assert.ok(!spaced.some((a) => /^--test-concurrency=/.test(a)), "an explicit spaced concurrency still wins");
  const fromEnv = withEnv("SPOR_TEST_CONCURRENCY", "3", () => buildArgs([]));
  assert.ok(fromEnv.includes("--test-concurrency=3"));
});

test("a malformed shard or concurrency is refused with a usage error, never run as the whole suite", () => {
  for (const [args, env] of [
    [["--shard", "0/2"], {}],
    [["--shard", "3/2"], {}],
    [["--shard", "half"], {}],
    [["--shard"], {}],
    [["--test-name-pattern"], {}],
    [[], { SPOR_TEST_CONCURRENCY: "0" }],
    [[], { SPOR_TEST_CONCURRENCY: "lots" }],
  ]) {
    const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", env: runnerEnv(env) });
    assert.strictEqual(r.status, 2, `${JSON.stringify(args)} ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: node scripts\/test-run\.js/);
  }
});

test("shards 1/2 and 2/2 partition the files: every test runs exactly once across them, and a failure still fails its shard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-shard-"));
  const names = ["a", "b", "c", "d"];
  for (const n of names) {
    fs.writeFileSync(path.join(dir, `${n}.test.js`), `require("node:test")("file-${n}", () => {});\n`);
  }
  const files = names.map((n) => path.join(dir, `${n}.test.js`));
  const seen = [];
  for (const shard of ["1/2", "2/2"]) {
    const r = spawnSync(process.execPath, [RUNNER, shard, "--test-reporter=tap", ...files], { encoding: "utf8", env: runnerEnv() });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const ran = [...r.stdout.matchAll(/^ok \d+ - (file-\w)/gm)].map((m) => m[1]);
    assert.ok(ran.length > 0, `shard ${shard} ran nothing:\n${r.stdout}`);
    seen.push(...ran);
  }
  assert.deepStrictEqual(seen.sort(), names.map((n) => `file-${n}`));

  fs.writeFileSync(path.join(dir, "a.test.js"), 'require("node:test")("file-a", () => { throw new Error("boom"); });\n');
  const failing = [1, 2].map((i) =>
    spawnSync(process.execPath, [RUNNER, `${i}/2`, ...files], { encoding: "utf8", env: runnerEnv() }).status
  );
  assert.deepStrictEqual(failing.sort(), [0, 1], "exactly the shard holding the failing file exits 1");
});

test("a SIGTERM to the runner reaches the `node --test` it wraps: the outer-stop notice still names it and the run fails", { skip: process.platform === "win32" && "no SIGTERM delivery to a child on Windows" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-term-"));
  const file = path.join(dir, "slow.test.js");
  fs.writeFileSync(file, 'require("node:test")("slow", async () => { console.log("READY"); await new Promise((r) => setTimeout(r, 30000)); });\n');
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, "--test-reporter=spec", file], { env: runnerEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
      if (/READY/.test(stdout)) term();
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.match(r.stderr + r.stdout, /spor test runner: received SIGTERM after \d+s/, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.code !== 0 || r.signal, `the runner must not exit clean after an outer stop: ${JSON.stringify([r.code, r.signal])}`);
});

// task-spor-acceptance-suites-on-isolated-ci-runners: the suite never inherits
// git's repo-local variables, and it always says how it ended.
const REPO_LOCAL = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_PARAMETERS"];

test("suiteEnv and the fixture gitEnv strip git's repo-local variables and keep everything else", () => {
  const base = { PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0" };
  for (const k of REPO_LOCAL) base[k] = `/decoy/${k}`;
  const env = suiteEnv(base);
  for (const k of REPO_LOCAL) assert.ok(!(k in env), `${k} leaked into the suite env`);
  assert.deepStrictEqual(env, { PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0" });
  assert.ok(base.GIT_DIR, "the caller's env object is not mutated");
  const g = gitEnv({ EXTRA: "1" }, base);
  for (const k of REPO_LOCAL) assert.ok(!(k in g), `${k} leaked into the fixture git env`);
  assert.strictEqual(g.GIT_AUTHOR_NAME, "T");
  assert.strictEqual(g.EXTRA, "1");
});

test("a suite launched with the HOST repo's GIT_DIR in its env cannot see it, so a scratch fixture never writes to the host", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-gitenv-"));
  const host = path.join(dir, "host");
  gitInit(host);
  const hostConfig = fs.readFileSync(path.join(host, ".git", "config"), "utf8");
  const out = path.join(dir, "seen.json");
  const scratch = path.join(dir, "scratch");
  const file = path.join(dir, "leak.test.js");
  // The fixture does exactly what a hand-rolled one does: `git init` + commit
  // in its scratch dir with the ambient env spread in.
  fs.writeFileSync(file, `require("node:test")("leak", () => {
  const cp = require("node:child_process");
  const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ GIT_DIR: process.env.GIT_DIR ?? null, GIT_WORK_TREE: process.env.GIT_WORK_TREE ?? null }));
  fs.mkdirSync(${JSON.stringify(scratch)});
  const env = { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" };
  for (const a of [["init", "-q"], ["config", "spor.leak", "true"], ["commit", "-q", "--allow-empty", "-m", "scratch"]]) {
    const r = cp.spawnSync("git", a, { cwd: ${JSON.stringify(scratch)}, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  }
});
`);
  const r = spawnSync(process.execPath, [RUNNER, file], {
    encoding: "utf8",
    env: runnerEnv({ GIT_DIR: path.join(host, ".git"), GIT_WORK_TREE: host, GIT_INDEX_FILE: path.join(host, ".git", "index") }),
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, "utf8")), { GIT_DIR: null, GIT_WORK_TREE: null });
  assert.strictEqual(fs.readFileSync(path.join(host, ".git", "config"), "utf8"), hostConfig, "the host repo's config was rewritten");
  const hostLog = spawnSync("git", ["-C", host, "rev-list", "--all"], { encoding: "utf8", env: gitEnv() });
  assert.strictEqual(hostLog.status, 0, hostLog.stderr);
  assert.strictEqual(hostLog.stdout.trim(), "", "a scratch commit landed on the host repo");
});

test("the verdict line names the outcome: pass, exit code, or signal, with the shard", () => {
  assert.strictEqual(verdictLine({ code: 0, signal: null, ms: 1400, shard: null }), "test-run: passed in 1s");
  assert.match(verdictLine({ code: 1, signal: null, ms: 65000, shard: "2/4" }), /^test-run: FAILED \(shard 2\/4\) — node --test exited 1 after 65s/);
  assert.match(verdictLine({ code: null, signal: "SIGKILL", ms: 3000, shard: null }), /^test-run: FAILED — node --test was killed by SIGKILL after 3s$/);
});

test("a failing run ends on a FAILED verdict, and under GitHub Actions also on an ::error annotation; a passing one says passed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-loud-"));
  const ok = path.join(dir, "ok.test.js");
  const bad = path.join(dir, "bad.test.js");
  fs.writeFileSync(ok, 'require("node:test")("ok", () => {});\n');
  fs.writeFileSync(bad, 'require("node:test")("bad", () => { throw new Error("boom"); });\n');
  const pass = spawnSync(process.execPath, [RUNNER, ok], { encoding: "utf8", env: runnerEnv({ GITHUB_ACTIONS: "true" }) });
  assert.strictEqual(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stderr, /test-run: passed in \d+s\n$/);
  assert.doesNotMatch(pass.stderr, /::error/);
  const fail = spawnSync(process.execPath, [RUNNER, "1/1", bad], { encoding: "utf8", env: runnerEnv({ GITHUB_ACTIONS: "true" }) });
  assert.strictEqual(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stderr, /test-run: FAILED \(shard 1\/1\) — node --test exited 1 after \d+s/);
  assert.match(fail.stderr, /::error title=test suite failed::FAILED \(shard 1\/1\)/);
  const local = spawnSync(process.execPath, [RUNNER, bad], { encoding: "utf8", env: runnerEnv({ GITHUB_ACTIONS: "" }) });
  assert.strictEqual(local.status, 1);
  assert.doesNotMatch(local.stderr, /::error/, "outside Actions the annotation would be noise");
});

test("crashOnly: only a normal exit 1 with crashed files and no failing test earns the one re-run", () => {
  const rep = { crashed: [{ file: "a.test.js" }], failedTests: 0 };
  assert.strictEqual(crashOnly({ code: 1, signal: null }, rep), true);
  assert.strictEqual(crashOnly({ code: 1, signal: null }, { ...rep, failedTests: 1 }), false);
  assert.strictEqual(crashOnly({ code: 1, signal: "SIGTERM" }, rep), false);
  assert.strictEqual(crashOnly({ code: 2, signal: null }, rep), false);
  assert.strictEqual(crashOnly({ code: 1, signal: null }, null), false);
  assert.strictEqual(crashOnly({ code: 1, signal: null }, { crashed: [], failedTests: 0 }), false);
  const many = { crashed: Array.from({ length: 13 }, () => ({ file: "x" })), failedTests: 0 };
  assert.strictEqual(crashOnly({ code: 1, signal: null }, many), false);
});

test("withCrashReporter adds the reporter pair unless the caller chose a reporter", () => {
  const args = withCrashReporter(buildArgs([]), "/tmp/x");
  assert.ok(args.includes("--test-reporter=./test/helpers/crash-reporter.js"));
  const own = buildArgs(["--test-reporter", "tap"]);
  assert.deepStrictEqual(withCrashReporter(own, "/tmp/x"), own);
});

function runCrashFixture(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-crash-"));
  const file = path.join(dir, "crash.test.js");
  fs.writeFileSync(file, [
    "const t = require('node:test'), fs = require('node:fs');",
    "t.test('a', () => {});",
    `const flag = ${JSON.stringify(path.join(dir, "flag"))};`,
    "if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); console.error('boom line'); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 100); }",
  ].join("\n"));
  const r = spawnSync(process.execPath, [RUNNER, file], { env: runnerEnv(env), encoding: "utf8", timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test("a file killed outside a test is named, re-run once together, and passes as FLAKY", () => {
  const r = runCrashFixture({});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /crashed outside a test: .*crash\.test\.js — killed by SIGKILL/);
  assert.match(r.stderr, /\| boom line/);
  assert.match(r.stderr, /test-run: FLAKY/);
});

test("SPOR_TEST_RERUN_CRASHED=0 is strict: the crash stays red and is still named", () => {
  const r = runCrashFixture({ SPOR_TEST_RERUN_CRASHED: "0" });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /killed by SIGKILL/);
  assert.match(r.stderr, /test-run: FAILED/);
});
