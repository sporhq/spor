// Unit coverage for the path canonicalization helpers behind the Windows
// short-path fix (issue-spor-windows-ci-short-path-mismatch): u.canonPath /
// u.toRepoRel / u.repoRelative. The contract is LITERAL-FIRST — the plain
// path.relative spelling is preferred, and both sides are canonicalized ONLY
// when the literal walks out of the repo (the os.tmpdir 8.3 short-vs-long
// split). That keeps the common path byte-identical and, crucially, preserves
// in-repo symlink spellings so a coupling glob authored against an alias keeps
// matching.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const u = require("../scripts/engines/util.js");

function scratch(prefix) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return root;
}

test("toRepoRel: an in-repo file keeps its literal spelling (no canonicalization)", () => {
  const top = scratch("spor-relpath-");
  fs.mkdirSync(path.join(top, "src"), { recursive: true });
  const file = path.join(top, "src", "code.js");
  assert.equal(u.toRepoRel(top, file), "src/code.js");
  assert.equal(u.repoRelative(top, file), "src/code.js");
});

test("toRepoRel: a not-yet-created target still derives (canonicalizes the ancestor)", () => {
  const top = scratch("spor-relpath-");
  // src/new.js does not exist on disk — the derivation must not throw or bail.
  assert.equal(u.toRepoRel(top, path.join(top, "src", "new.js")), "src/new.js");
});

test("toRepoRel: an in-repo symlinked subtree PRESERVES the alias spelling (literal-first)", () => {
  const top = scratch("spor-relpath-");
  fs.mkdirSync(path.join(top, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(top, "packages", "web", "app.js"), "x");
  try {
    fs.symlinkSync(path.join(top, "packages", "web"), path.join(top, "frontend"), "dir");
  } catch {
    return; // symlinks unavailable on this host
  }
  // Editing through the alias must read as `frontend/...`, not the resolved
  // `packages/web/...` — else a coupling glob on `frontend/**` silently stops
  // matching. The literal path is in-repo, so no canonicalization happens.
  assert.equal(u.toRepoRel(top, path.join(top, "frontend", "app.js")), "frontend/app.js");
});

test("toRepoRel: a base-spelling mismatch (alias vs real top) canonicalizes to stay in-repo", () => {
  const real = scratch("spor-relpath-");
  fs.mkdirSync(path.join(real, "src"), { recursive: true });
  const alias = `${real}-alias`;
  try {
    fs.symlinkSync(real, alias, "dir");
  } catch {
    return; // symlinks unavailable
  }
  // `top` is the real path (as git returns it); `file` is spelled via the alias
  // (as a hook payload built off a short/symlinked cwd would be). The literal
  // path.relative walks out (`../<alias>/src/code.js`); canonicalization pulls
  // it back to the in-repo `src/code.js`.
  const file = path.join(alias, "src", "code.js");
  assert.match(path.relative(real, file), /^\.\./); // precondition: literal walks out
  assert.equal(u.toRepoRel(real, file), "src/code.js");
  assert.equal(u.repoRelative(real, file), "src/code.js");
});

test("repoRelative: a genuinely out-of-repo file resolves to null", () => {
  const top = scratch("spor-relpath-");
  const sibling = scratch("spor-relpath-out-");
  assert.equal(u.repoRelative(top, path.join(sibling, "x.js")), null);
  // the repo root itself is not an in-repo artifact
  assert.equal(u.repoRelative(top, top), null);
});

test("canonPath: idempotent on an already-canonical existing path", () => {
  const top = scratch("spor-relpath-");
  assert.equal(u.canonPath(top), top);
});

test("repoRelativeCandidates: an in-repo symlinked subtree yields BOTH the alias and resolved spellings (task-spor-coupling-matcher-symlink-alias)", () => {
  const top = scratch("spor-relpath-");
  fs.mkdirSync(path.join(top, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(top, "packages", "web", "app.js"), "x");
  try {
    fs.symlinkSync(path.join(top, "packages", "web"), path.join(top, "frontend"), "dir");
  } catch {
    return; // symlinks unavailable on this host
  }
  const candidates = u.repoRelativeCandidates(top, path.join(top, "frontend", "app.js"));
  assert.deepEqual(candidates.sort(), ["frontend/app.js", "packages/web/app.js"].sort());
});

test("repoRelativeCandidates: a base-spelling mismatch keeps BOTH spellings of an in-repo symlink (issue-spor-windows-ci-symlink-alias-candidates-lost)", () => {
  // The windows-latest failure mode, reproduced portably: `top` is the
  // canonical spelling (as git returns it) while `file` reaches the repo
  // through an ALIASED base (standing in for os.tmpdir()'s 8.3 RUNNER~1
  // prefix), AND the in-repo part goes through a tracked symlinked subtree.
  // The literal path.relative walks out; full canonicalization would resolve
  // the in-repo symlink too and lose the alias spelling. Both spellings must
  // survive.
  const real = scratch("spor-relpath-");
  fs.mkdirSync(path.join(real, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(real, "packages", "web", "app.js"), "x");
  const aliasBase = `${real}-alias`;
  try {
    fs.symlinkSync(path.join(real, "packages", "web"), path.join(real, "frontend"), "dir");
    fs.symlinkSync(real, aliasBase, "dir");
  } catch {
    return; // symlinks unavailable on this host
  }
  const file = path.join(aliasBase, "frontend", "app.js");
  assert.match(path.relative(real, file), /^\.\./); // precondition: literal walks out
  const candidates = u.repoRelativeCandidates(real, file);
  assert.deepEqual(candidates, ["frontend/app.js", "packages/web/app.js"]);
});

test("repoRelativeCandidates: an ordinary in-repo file (no symlink) yields one candidate", () => {
  const top = scratch("spor-relpath-");
  fs.mkdirSync(path.join(top, "src"), { recursive: true });
  const file = path.join(top, "src", "code.js");
  assert.deepEqual(u.repoRelativeCandidates(top, file), ["src/code.js"]);
});

test("repoRelativeCandidates: a genuinely out-of-repo file yields no candidates", () => {
  const top = scratch("spor-relpath-");
  const sibling = scratch("spor-relpath-out-");
  assert.deepEqual(u.repoRelativeCandidates(top, path.join(sibling, "x.js")), []);
});

// --- u.gitEnv (issue-spor-dispatch-worktree-wrong-repo-location) -------------
// Git resolves its repo from GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR before it
// discovers one from cwd, so those beat the directory every git call here names
// — gitEnv strips them from the child env. The carve-outs are the point of the
// list: GIT_INDEX_FILE in particular MUST survive (a partial commit's pre-commit
// hook names its temp index that way, and `spor check --staged` reads it).

test("gitEnv: strips the repo-location vars so the named directory wins", () => {
  const out = u.gitEnv({
    PATH: "/usr/bin",
    GIT_DIR: "/elsewhere/.git",
    GIT_WORK_TREE: "/elsewhere",
    GIT_COMMON_DIR: "/elsewhere/.git",
  });
  assert.deepEqual(out, { PATH: "/usr/bin" });
});

test("gitEnv: KEEPS GIT_INDEX_FILE — a partial commit's pre-commit hook names its temp index there", () => {
  const out = u.gitEnv({ GIT_DIR: "/elsewhere/.git", GIT_INDEX_FILE: "/repo/.git/next-index.lock" });
  assert.deepEqual(out, { GIT_INDEX_FILE: "/repo/.git/next-index.lock" });
});

test("gitEnv: an env with nothing to strip is copied through unchanged", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/x", GIT_AUTHOR_NAME: "T" };
  const out = u.gitEnv(env);
  assert.deepEqual(out, env);
  assert.notStrictEqual(out, env, "a copy, never the caller's object");
});
