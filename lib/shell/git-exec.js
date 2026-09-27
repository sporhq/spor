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

// The one git spawn primitive: env-scrubbed, never throws. Returns the raw
// spawnSync result ({status, stdout, stderr, error, ...}); callers shape the
// return to their own convention (a full result vs. stdout-or-null). `cwd` is
// applied AFTER `...opts` so a caller-supplied opts.cwd can never silently
// override the directory this module exists to make authoritative.
function gitSpawn(cwd, args, opts = {}) {
  return spawnSync("git", args, { encoding: "utf8", ...opts, cwd, env: gitEnv(opts.env) });
}

// The one `git rev-parse --show-toplevel --git-common-dir` probe every
// worktree-root resolver needs — scripts/engines/util.js's inferenceRoot()
// and linkedWorktreeMainRoot(), and lib/config.js's gitMainRoot() — each used
// to spawn their own copy of this (util.js's with the arguments in one order,
// config.js's with them swapped), so a single CLI start ran it twice for the
// same cwd (task-spor-cli-lazy-load-modules). Both now read through this one,
// process-lifetime cache keyed by cwd, so the second caller's identical query
// is free. A git failure (not a repo, no git, cwd unset) caches
// `{top: null, common: null}` too, so a non-repo cwd never spawns twice
// either. `--path-format=absolute` matches what both callers already asked
// for.
const _toplevelCommonCache = new Map();
function gitToplevelAndCommonDir(cwd, opts = {}) {
  const key = String(cwd || "");
  if (_toplevelCommonCache.has(key)) return _toplevelCommonCache.get(key);
  let result = { top: null, common: null };
  const r = gitSpawn(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  });
  if (r.status === 0) {
    // Strip a trailing \r per line, not just the trailing newline: some
    // Windows git builds emit CRLF here.
    const [top, common] = (r.stdout || "").split("\n").map((l) => l.replace(/\r$/, "").trim());
    result = { top: top || null, common: common || null };
  }
  _toplevelCommonCache.set(key, result);
  return result;
}

module.exports = { gitEnv, gitSpawn, gitToplevelAndCommonDir, GIT_LOCATION_ENV };
