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
