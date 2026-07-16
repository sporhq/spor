// Shared gitInit test helper (task-spor-test-suite-git-init-consolidation):
// config.test.js, project-identity.test.js, and graph-sharing.test.js each
// hand-rolled their own copy of "make a git repo at `dir`, with a fixed
// author/committer identity so commits work with no global git config".

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
};

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

module.exports = { gitInit };
