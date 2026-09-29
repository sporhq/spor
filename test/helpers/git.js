// Shared gitInit test helper (task-spor-test-suite-git-init-consolidation):
// config.test.js, project-identity.test.js, and graph-sharing.test.js each
// hand-rolled their own copy of "make a git repo at `dir`, with a fixed
// author/committer identity so commits work with no global git config".
//
// It is also the ONE place a test fixture's git environment is built
// (task-spor-acceptance-suites-on-isolated-ci-runners): `gitEnv()` strips
// git's repo-local variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … — the
// pinned GIT_LOCAL_ENV_VARS set in lib/shell/git-exec.js) before adding the fixed
// identity, so a fixture run straight from a git hook or `git bisect run`
// (`node --test test/foo.test.js`, bypassing scripts/test-run.js's own
// scrub) still cannot reach the host repo
// (issue-spor-server-tests-inherit-git-env-corrupt-host-repo).

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const { envWithoutRepoLocalVars } = require("../../lib/shell/git-exec.js");

const IDENTITY = {
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
};

// A git environment for a scratch-repo fixture: `base` (default the process
// env) minus git's repo-local variables, plus the fixed identity and `extra`.
function gitEnv(extra = {}, base = process.env) {
  return { ...envWithoutRepoLocalVars(base), ...IDENTITY, ...extra };
}

const GIT_ENV = gitEnv();

// Creates `dir` (recursively) and runs `git init` in it, returning a `g`
// helper for running further git commands against it, e.g. g(['add', '.'])
// or g(['commit', '-q', '-m', 'msg']). Pass an explicit `cwd` as the second
// arg to run against a different directory (e.g. a worktree under `dir`).
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (args, cwd = dir) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(["init", "-q"]);
  return g;
}

module.exports = { gitInit, gitEnv };
