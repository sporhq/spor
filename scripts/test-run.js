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
// The runner parent is a pass-through: stdio is inherited, a signal we
// receive is forwarded to the `node --test` child (so an outer timeout still
// reaches the runner that reports cancelled files), and we exit with its code.
// Two things it adds on the way (task-spor-acceptance-suites-on-isolated-ci-runners):
//   - A SCRUBBED environment. git's repo-local variables (GIT_DIR,
//     GIT_WORK_TREE, GIT_INDEX_FILE, … — the `git rev-parse --local-env-vars`
//     set) are removed before `node --test` starts, so no test process and no
//     CLI or git it spawns can inherit them. A suite launched from a git hook
//     or a `git bisect run` otherwise hands its scratch-repo fixtures the HOST
//     repo's location: they commit onto the host and rewrite its config
//     (issue-spor-server-tests-inherit-git-env-corrupt-host-repo). Scrubbing
//     once at the root makes that class impossible for every fixture, however
//     it builds its own env.
//   - A LOUD verdict. The last line on stderr always names the outcome — exit
//     code or signal, wall time, shard — and under GitHub Actions a failure is
//     also an `::error` annotation, so a red run can never be silent
//     (issue-spor-server-ci-run-tiers-silent-failure).
//   - A NAMED crash. A file whose process dies outside any test (OOM kill,
//     signal, uncaught exit) reads as a bare "test failed". The crash reporter
//     (test/helpers/crash-reporter.js) records each such file's exit code/signal
//     and stderr tail, the closing summary prints them, and a run lost ONLY to
//     such crashes (runner exited 1 normally, no failing test, <= MAX_RERUN
//     files, every one killed by a recorded SIGKILL/SIGTERM/SIGABRT — a plain
//     exit code is deterministic and stays red) re-runs exactly those files
//     together ONCE under a fresh TMPDIR and passes only if that is green; a
//     stop of the wrapper is never a pass — FLAKY + `::warning`, never silent. SPOR_TEST_RERUN_CRASHED=0
//     is strict (task-split-spor-bf14e0e45235,
//     dec-spor-server-run-tiers-crash-only-rerun is the server twin).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { envWithoutRepoLocalVars } = require("../lib/shell/git-exec.js");

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

const MAX_RERUN = 12;
// Only a recorded signal kill is a crash worth a second try: a plain exit code
// is deterministic (dec-spor-crash-rerun-signal-kills-only-keyed-on-exit-record).
const RERUN_SIGNALS = new Set(["SIGKILL", "SIGTERM", "SIGABRT"]);

// `extra.files` replaces the file list and drops the shard (a re-run names its
// files explicitly).
function buildArgs(argv, extra = {}) {
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
  if (shard && !extra.files) args.push(`--test-shard=${shard}`);
  args.push(...pass);
  args.push(...(extra.files || (files.length ? files : ["test/*.test.js"])));
  return args;
}

// Add the crash reporter beside the human one, unless the caller chose its own
// reporter. Node's default is spec on a TTY (and from 23 on); tap before that.
function withCrashReporter(args, reportFile) {
  if (args.some((a) => a === "--test-reporter" || a.startsWith("--test-reporter="))) return args;
  const major = Number(process.versions.node.split(".")[0]);
  const human = process.stdout.isTTY || major >= 23 ? "spec" : "tap";
  const reporters = [
    `--test-reporter=${human}`, "--test-reporter-destination=stdout",
    "--test-reporter=./test/helpers/crash-reporter.js", "--test-reporter-destination=stdout",
  ];
  const at = args.indexOf("--test") + 1;
  return [...args.slice(0, at), ...reporters, ...args.slice(at)];
}

function readCrashReport(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Whether a failed run is eligible for the one re-run: the runner exited 1
// normally, no test failed, and a small bounded set of files each died of a
// recorded SIGKILL/SIGTERM/SIGABRT (an exit code, however non-zero, stays red).
function crashOnly({ code, signal }, rep) {
  return !signal && code === 1 && !!rep && rep.failedTests === 0
    && rep.crashed.length > 0 && rep.crashed.length <= MAX_RERUN
    && rep.crashed.every((c) => RERUN_SIGNALS.has(c.signal));
}

function describeCrashes(crashed) {
  const out = [];
  for (const c of crashed) {
    const how = c.signal ? `killed by ${c.signal}` : `exited ${c.exitCode}`;
    out.push(`  crashed outside a test: ${path.relative(ROOT, c.file) || c.file} — ${how}`);
    for (const l of c.stderr || []) out.push(`    | ${l}`);
  }
  return out.join("\n");
}

// The environment every test process runs under: the caller's, minus git's
// repo-local variables (see the header).
function suiteEnv(env = process.env) {
  return envWithoutRepoLocalVars(env);
}

// The one-line verdict printed after `node --test` exits.
function verdictLine({ code, signal, ms, shard }) {
  const where = shard ? ` (shard ${shard})` : "";
  const secs = Math.round(ms / 1000);
  if (signal) return `test-run: FAILED${where} — node --test was killed by ${signal} after ${secs}s`;
  if (code === 0) return `test-run: passed${where} in ${secs}s`;
  return `test-run: FAILED${where} — node --test exited ${code == null ? "without a code" : code} after ${secs}s; the failing tests are listed above`;
}

function report(result, env = process.env) {
  const line = verdictLine(result);
  process.stderr.write(`\n${line}\n`);
  if (env.GITHUB_ACTIONS === "true" && (result.signal || result.code !== 0)) {
    process.stderr.write(`::error title=test suite failed::${line.replace(/^test-run: /, "")}\n`);
  }
}

function runOnce(args, forward, env = suiteEnv()) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit", env });
    forward.child = child;
    child.on("error", (err) => {
      process.stderr.write(`test-run: could not start node --test: ${err.message}\n`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - started }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = buildArgs(argv);
  const shardArg = args.find((a) => a.startsWith("--test-shard="));
  const shard = shardArg ? shardArg.slice("--test-shard=".length) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-"));
  const reportFile = path.join(dir, "crashes.json");
  process.env.SPOR_TEST_CRASH_REPORT = reportFile;
  const forward = { child: null };
  let stopping = false; // a stop between the two runs must not start the re-run
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { stopping = true; try { forward.child.kill(sig); } catch { /* already gone */ } });
  }
  let freshTmp = null; // the re-run's own TMPDIR
  const cleanup = () => {
    for (const d of [dir, freshTmp]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  };
  process.on("exit", cleanup);

  let result = await runOnce(withCrashReporter(args, reportFile), forward);
  const rep = readCrashReport(reportFile);
  let flaky = null;
  if (rep && rep.crashed.length) process.stderr.write(`\ntest-run: ${rep.crashed.length} file(s) died outside a test\n${describeCrashes(rep.crashed)}\n`);
  if (!stopping && crashOnly(result, rep) && process.env.SPOR_TEST_RERUN_CRASHED !== "0") {
    const files = rep.crashed.map((c) => path.relative(ROOT, c.file) || c.file);
    process.stderr.write(`test-run: only file-level crashes — re-running ${files.join(" ")} together once\n`);
    try { fs.rmSync(reportFile, { force: true }); } catch { /* best-effort */ }
    // A fresh TMPDIR: state the first run left behind must not green a failure
    // that only a cold start reproduces.
    freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "spor-test-run-tmp-"));
    const env = { ...suiteEnv(), TMPDIR: freshTmp, TEMP: freshTmp, TMP: freshTmp };
    const again = await runOnce(withCrashReporter(buildArgs(argv, { files }), reportFile), forward, env);
    const rep2 = readCrashReport(reportFile);
    if (rep2 && rep2.crashed.length) process.stderr.write(`\ntest-run: re-run crashed again\n${describeCrashes(rep2.crashed)}\n`);
    if (!stopping && !again.signal && again.code === 0) flaky = { files, ms: result.ms + again.ms };
    result = { ...again, ms: result.ms + again.ms };
  }
  cleanup();
  // A stop is never a pass, even if the child it reached exited 0.
  if (stopping && !result.signal && result.code === 0) result = { ...result, code: 1 };
  if (flaky) {
    const line = `test-run: FLAKY${shard ? ` (shard ${shard})` : ""} — passed only after re-running ${flaky.files.length} crashed file(s) together: ${flaky.files.join(", ")} (${Math.round(flaky.ms / 1000)}s total)`;
    process.stderr.write(`\n${line}\n`);
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stderr.write(`::warning title=test suite flaky::${line.replace(/^test-run: /, "")}\n`);
    }
  } else {
    report({ ...result, shard });
  }
  if (result.signal) {
    process.removeAllListeners(result.signal);
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.code == null ? 1 : result.code);
}

if (require.main === module) main();

module.exports = { buildArgs, crashOnly, describeCrashes, withCrashReporter, parseShard, suiteEnv, verdictLine };
