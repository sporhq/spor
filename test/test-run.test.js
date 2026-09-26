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
const { buildArgs } = require(RUNNER);

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
