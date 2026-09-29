// lib/shell/git-exec.js — the wide repo-local env scrub (moved here from the
// retired scripts/heal-stale-root.js) and the typed git oracle
// (task-spor-orchestrator-land-from-detached-worktree-retire-healer).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  gitOracle,
  gitToplevelAndCommonDir,
  envWithoutRepoLocalVars,
  GIT_LOCAL_ENV_VARS,
} = require("../lib/shell/git-exec.js");
const { gitInit } = require("./helpers/git.js");

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-git-exec-"));
  const g = gitInit(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "one"]);
  return dir;
}

test("GIT_LOCAL_ENV_VARS covers every var the live git reports via --local-env-vars", () => {
  // Pins the scrub against reality: a future git adding a repo-local variable
  // fails here loudly instead of riding through unscrubbed.
  const dir = scratchRepo();
  const live = execFileSync("git", ["-C", dir, "rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    env: envWithoutRepoLocalVars(),
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(live.length > 0, "sanity: git reported no local env vars at all");
  for (const v of live) {
    assert.ok(GIT_LOCAL_ENV_VARS.includes(v), `git now reports ${v} via --local-env-vars; add it to GIT_LOCAL_ENV_VARS in lib/shell/git-exec.js`);
  }
});

test("envWithoutRepoLocalVars strips the whole class and keeps everything else", () => {
  const env = { PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "keep" };
  for (const v of GIT_LOCAL_ENV_VARS) env[v] = "/leak";
  const out = envWithoutRepoLocalVars(env);
  for (const v of GIT_LOCAL_ENV_VARS) assert.ok(!(v in out), `${v} survived the scrub`);
  assert.deepEqual(out, { PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "keep" });
  assert.equal(env.GIT_DIR, "/leak", "the input env is not mutated");
});

test("gitOracle types its answer: hit / miss / error, never a folded boolean", () => {
  const dir = scratchRepo();
  assert.equal(gitOracle(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).state, "hit");
  assert.equal(gitOracle(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/nope^{commit}"]).state, "miss");
  // Exit 128 (a fatal usage error) is not the probe's "no" — it is git failing.
  assert.equal(gitOracle(dir, ["rev-parse", "--verify", "--no-such-flag-zzz"]).state, "error");
  // A cwd that does not exist is a spawn failure, not an answer.
  assert.equal(gitOracle(path.join(dir, "missing"), ["rev-parse", "HEAD"]).state, "error");
  // missCodes widens what counts as a definitive no.
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-git-exec-norepo-"));
  assert.equal(gitOracle(notRepo, ["rev-parse", "--show-toplevel"], { missCodes: [128], env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(notRepo) } }).state, "miss");
});

test("gitToplevelAndCommonDir does not cache a probe that could not answer", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-git-exec-late-"));
  const dir = path.join(base, "repo");
  // The cwd does not exist yet: the spawn fails, which is an ERROR, not "not a
  // repo" — so it must not be remembered.
  assert.deepEqual(gitToplevelAndCommonDir(dir), { top: null, common: null });
  fs.mkdirSync(dir);
  const g = gitInit(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "one"]);
  const { top, common } = gitToplevelAndCommonDir(dir);
  assert.equal(fs.realpathSync(top), fs.realpathSync(dir));
  assert.ok(common && common.endsWith(".git"), `common dir: ${common}`);
});
