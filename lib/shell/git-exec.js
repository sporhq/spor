// shell/git-exec.js — the one env-scrubbed git spawn behind every git call in
// the client CLI/library/hook surface (dec-spor-dispatch-git-location-env-
// scrub): bin/spor.js, scripts/engines/util.js, and every lib/*.js git reader
// (gittime, history, changes, queue, config) import this instead of spawning
// git directly. Git takes its repository location from GIT_DIR/GIT_WORK_TREE/
// GIT_COMMON_DIR before it ever discovers one from cwd/-C, so a leaked var
// silently retargets a git call at the wrong repo — the exact vulnerability
// that let an ambient GIT_DIR misdirect gittime's timestamp/history reads and
// the CLI's repo inference (issue-spor-gittime-git-env-inheritance).
// GIT_INDEX_FILE is deliberately kept: git sets it to a partial commit's
// staging index while running a pre-commit hook, and `spor check --staged`
// depends on running against exactly that index (see bin/spor.js's cmdCheck).
"use strict";

const { spawnSync } = require("child_process");

const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

// Windows env names are case-insensitive and `{...env}` keeps whatever spelling
// the parent used, so `delete out.GIT_DIR` can miss a `git_dir` that git itself
// still honors — match case-insensitively there. On POSIX only the exact
// spelling is git's, and deleting a look-alike would gratuitously alter the
// child's env (the plugin runs natively on Windows, macOS and Linux).
function gitEnv(env = process.env) {
  const out = { ...env };
  const isLocationVar =
    process.platform === "win32"
      ? (k) => GIT_LOCATION_ENV.includes(k.toUpperCase())
      : (k) => GIT_LOCATION_ENV.includes(k);
  for (const k of Object.keys(out)) if (isLocationVar(k)) delete out[k];
  return out;
}

// The WIDE scrub: every repo-local variable `git rev-parse --local-env-vars`
// enumerates. gitEnv above stays narrow on purpose (it must keep
// GIT_INDEX_FILE for `spor check --staged`); this one is for a caller that has
// no business inheriting ANY of them — scripts/test-run.js (a suite launched
// from a git hook or `git bisect run` would otherwise hand its scratch-repo
// fixtures the HOST repo, issue-spor-server-tests-inherit-git-env-corrupt-host-repo)
// and test/helpers/git.js, the one place a fixture's git env is built. An
// inherited GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/
// GIT_GRAFT_FILE/GIT_SHALLOW_FILE misdirects object lookups exactly as an
// inherited GIT_DIR misdirects the whole repo. The list is PINNED, not probed
// live, so a misconfigured `git` on PATH cannot shrink it;
// test/git-exec.test.js re-derives the live set and asserts it is a subset of
// this pin, so a future git adding a variable fails loudly instead of leaking.
// (Moved here from the retired scripts/heal-stale-root.js,
// task-spor-orchestrator-land-from-detached-worktree-retire-healer.)
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

function envWithoutRepoLocalVars(env = process.env) {
  const out = { ...env };
  const isRepoLocalVar =
    process.platform === "win32"
      ? (k) => GIT_LOCAL_ENV_VARS.includes(k.toUpperCase())
      : (k) => GIT_LOCAL_ENV_VARS.includes(k);
  for (const k of Object.keys(out)) if (isRepoLocalVar(k)) delete out[k];
  return out;
}

// The one git spawn primitive: env-scrubbed, never throws. Returns the raw
// spawnSync result ({status, stdout, stderr, error, ...}); callers shape the
// return to their own convention (a full result vs. stdout-or-null). `cwd` is
// applied AFTER `...opts` so a caller-supplied opts.cwd can never silently
// override the directory this module exists to make authoritative.
function gitSpawn(cwd, args, opts = {}) {
  return spawnSync("git", args, { encoding: "utf8", ...opts, cwd, env: gitEnv(opts.env) });
}

// gitOracle(cwd, args, {missCodes, ...opts}) -> {state, result} — a git probe
// whose answer is TYPED, never a bare boolean: `hit` (exit 0), `miss` (git ran
// and answered no: an exit code in `missCodes`, default [1] — what
// `rev-parse --verify --quiet` and `merge-base --is-ancestor` use for "no"),
// or `error` (git could not answer: a spawn failure, a signal — the `timeout`
// firing is a SIGTERM — or any other exit). Folding `error` into `miss` is the
// soft-miss bug class (task-spor-git-shell-fail-closed-oracles): a loaded box's
// EAGAIN or a probe timeout reads as "the ref does not exist" and a caller
// acts on an answer nobody gave. `error` is never cacheable.
function gitOracle(cwd, args, opts = {}) {
  const { missCodes = [1], ...spawnOpts } = opts;
  const result = gitSpawn(cwd, args, spawnOpts);
  let state = "error";
  if (!result.error && !result.signal) {
    if (result.status === 0) state = "hit";
    else if (missCodes.includes(result.status)) state = "miss";
  }
  return { state, result };
}

// The one `git rev-parse --show-toplevel --git-common-dir` probe every
// worktree-root resolver needs — scripts/engines/util.js's inferenceRoot()
// and linkedWorktreeMainRoot(), and lib/config.js's gitMainRoot() — each used
// to spawn their own copy of this (util.js's with the arguments in one order,
// config.js's with them swapped), so a single CLI start ran it twice for the
// same cwd (task-spor-cli-lazy-load-modules). Both now read through this one,
// process-lifetime cache keyed by cwd, so the second caller's identical query
// is free. A definitive MISS (git ran and exited 128: not a repo) caches
// `{top: null, common: null}` too, so a non-repo cwd never spawns twice
// either — but a probe that could not answer (a spawn failure, a timeout, a
// signal) returns the same nulls UNCACHED, so one transient failure on a
// loaded box is not remembered for the rest of the process as "not a repo". `--path-format=absolute` matches what both callers already asked
// for.
const _toplevelCommonCache = new Map();
function gitToplevelAndCommonDir(cwd, opts = {}) {
  const key = String(cwd || "");
  if (_toplevelCommonCache.has(key)) return _toplevelCommonCache.get(key);
  let result = { top: null, common: null };
  const { state, result: r } = gitOracle(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
    missCodes: [128],
  });
  if (state === "error") return result;
  if (state === "hit") {
    // Strip a trailing \r per line, not just the trailing newline: some
    // Windows git builds emit CRLF here.
    const [top, common] = (r.stdout || "").split("\n").map((l) => l.replace(/\r$/, "").trim());
    result = { top: top || null, common: common || null };
  }
  _toplevelCommonCache.set(key, result);
  return result;
}

module.exports = {
  gitEnv,
  gitSpawn,
  gitOracle,
  gitToplevelAndCommonDir,
  envWithoutRepoLocalVars,
  GIT_LOCATION_ENV,
  GIT_LOCAL_ENV_VARS,
};
