#!/usr/bin/env node
// The suite runner behind `npm test` and `npm run test:shard`
// (task-spor-test-suite-runtime-budget). Zero-dep: it only assembles the
// `node --test` command line and hands the terminal to it.
//
//   node scripts/test-run.js                    # the full suite
//   node scripts/test-run.js --shard 2/4        # one quarter of the FILES
//   node scripts/test-run.js test/foo.test.js   # explicit files (any --test arg passes through)
//
// Why a script and not a longer npm one-liner:
//   - Concurrency. `node --test` defaults to availableParallelism()-1 files at
//     a time, i.e. ONE on a two-core box — the whole suite ran serially on
//     spor-dev and the GitHub runner. The suite is dominated by spawned CLI and
//     git processes plus polls for detached launches, so one file per core
//     keeps the cores busy; SPOR_TEST_CONCURRENCY (or an explicit
//     --test-concurrency) overrides it.
//   - Sharding. `--shard i/n` maps to node's own --test-shard, which splits the
//     sorted FILE list deterministically, so n machines (or n gate jobs) running
//     1/n … n/n cover every test exactly once.
//   - The preloads ride every run: tmp-cleanup, the outer-timeout notice, and
//     the compile cache (test/helpers/compile-cache.js).
//
// The runner parent is a plain pass-through: stdio is inherited, a signal we
// receive is forwarded to the `node --test` child (so an outer timeout still
// reaches the runner that reports cancelled files), and we exit with its code.

"use strict";

const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PRELOADS = [
  "./test/helpers/tmp-cleanup.js",
  "./test/helpers/interrupt-notice.js",
  "./test/helpers/compile-cache.js",
];

// node flags whose value may come as the NEXT word (`--test-name-pattern foo`):
// that word is the flag's value, not a file to run.
const VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-concurrency",
  "--test-timeout",
  "--test-shard",
  "--test-coverage-include",
  "--test-coverage-exclude",
  "--test-coverage-lines",
  "--test-coverage-branches",
  "--test-coverage-functions",
  "--test-isolation",
  "--test-global-setup",
  "--test-rerun-failures",
  "--env-file",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
]);

function usage(msg) {
  if (msg) process.stderr.write(`test-run: ${msg}\n`);
  process.stderr.write("usage: node scripts/test-run.js [--shard <i>/<n>] [node --test args…] [files…]\n");
  process.exit(2);
}

function parseShard(value) {
  const m = /^(\d+)\/(\d+)$/.exec(String(value || ""));
  if (!m) usage(`--shard wants <index>/<total> (1-based), got ${JSON.stringify(value)}`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) usage(`--shard ${value} is out of range (1 <= index <= total)`);
  return `${index}/${total}`;
}

function defaultConcurrency() {
  const env = process.env.SPOR_TEST_CONCURRENCY;
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (!Number.isInteger(n) || n < 1) usage(`SPOR_TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(env)}`);
    return n;
  }
  const width = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus() || []).length || 1;
  return Math.max(2, width);
}

function buildArgs(argv) {
  const pass = [];
  const files = [];
  let shard = null;
  let concurrency = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--shard") shard = parseShard(argv[++i]);
    else if (arg.startsWith("--shard=")) shard = parseShard(arg.slice("--shard=".length));
    else if (/^\d+\/\d+$/.test(arg)) shard = parseShard(arg); // `npm run test:shard -- 2/4`
    else if (arg === "-h" || arg === "--help") usage();
    else if (arg.startsWith("-")) {
      if (arg.startsWith("--test-concurrency")) concurrency = true;
      pass.push(arg);
      if (VALUE_FLAGS.has(arg)) {
        if (i + 1 >= argv.length) usage(`${arg} needs a value`);
        pass.push(argv[++i]);
      }
    } else files.push(arg);
  }
  const args = [];
  for (const p of PRELOADS) args.push("--require", p);
  args.push("--test");
  if (!concurrency) args.push(`--test-concurrency=${defaultConcurrency()}`);
  if (shard) args.push(`--test-shard=${shard}`);
  args.push(...pass);
  args.push(...(files.length ? files : ["test/*.test.js"]));
  return args;
}

function main() {
  const args = buildArgs(process.argv.slice(2));
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  const forward = (sig) => { try { child.kill(sig); } catch { /* already gone */ } };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => forward(sig));
  child.on("error", (err) => {
    process.stderr.write(`test-run: could not start node --test: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

if (require.main === module) main();

module.exports = { buildArgs, parseShard };
