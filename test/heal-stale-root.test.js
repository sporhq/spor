// heal-stale-root.test.js — the orchestrator's root-reset guard
// (task-spor-orchestrator-merge-gate-stale-index-heal).
//
// The oracle is a REAL throwaway git repo replaying the exact shape the incidents
// took (norm-qa-replay-genuine-paths): a CAS `git update-ref refs/heads/main <new>`
// that advances the ref while the index and working tree stay at the old commit.
// What is asserted is the verdict + exit code + what is actually left on disk —
// never the wording of the report.
//
// The two halves of the contract are pinned separately, because they fail in
// opposite directions and only one of them is recoverable:
//   - a stale path IS healed (a miss costs a manual sync),
//   - a WIP path is NEVER touched (a wrong heal destroys work that exists nowhere
//     else) — every negative below exists to pin that side.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const GUARD = path.join(__dirname, "..", "scripts", "heal-stale-root.js");

// ---------- a throwaway repo ----------

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function initRepo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-"));
  const args = ["init", "-q", "-b", "main"];
  if (opts.objectFormat) args.push("--object-format", opts.objectFormat);
  args.push(dir);
  execFileSync("git", args, { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  return dir;
}
function write(dir, p, body) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), body);
}
function commit(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD").trim();
}
function read(dir, p) {
  return fs.readFileSync(path.join(dir, p), "utf8");
}
function statusOf(dir) {
  return git(dir, "status", "--porcelain", "--untracked-files=no").trim();
}

// The incident shape: build the merged commit on a branch, then advance main to
// it with the CAS update-ref the orchestrator uses, leaving this checkout's index
// and working tree at the pre-merge commit. Returns {base, tip}.
function casAdvance(dir, mutate, msg = "merged work") {
  const base = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "-b", "landing");
  mutate();
  const tip = commit(dir, msg);
  git(dir, "checkout", "-q", "main"); // back to the pre-merge tree
  git(dir, "update-ref", "refs/heads/main", tip, base); // the ref moves; the tree does not
  git(dir, "branch", "-q", "-D", "landing");
  return { base, tip };
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [GUARD, "--repo", dir, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runJson(dir, ...args) {
  const r = run(dir, "--json", ...args);
  return { ...r, json: JSON.parse(r.stdout) };
}
function runWithEnv(dir, env, ...args) {
  const r = spawnSync(process.execPath, [GUARD, "--repo", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------- the clean case ----------

test("a clean root is IN-SYNC and exits 0", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");

  const r = runJson(dir);
  assert.equal(r.json.verdict, "IN-SYNC");
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.stale, []);
  assert.deepEqual(r.json.wip, []);
});

test("untracked files are not tracked modifications — the root still reads IN-SYNC", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  write(dir, ".claude/settings.local.json", "{}\n"); // the metadata the norm says to ignore

  const r = runJson(dir);
  assert.equal(r.json.verdict, "IN-SYNC");
  assert.equal(r.status, 0);
});

// ---------- the incident: a CAS advance leaves a stale index ----------

test("the CAS-advance stale index reads STALE in a dry run, and changes nothing", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  const base = commit(dir, "init");
  const { tip } = casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));

  // The pre-condition the guard exists for: main moved, the tree did not.
  assert.notEqual(statusOf(dir), "");
  assert.equal(read(dir, "a.js"), "one\n");

  const r = runJson(dir);
  assert.equal(r.json.verdict, "STALE");
  assert.equal(r.status, 1); // not in sync yet — a dry run heals nothing
  assert.deepEqual(r.json.stale.map((s) => s.path), ["a.js"]);
  assert.deepEqual(r.json.wip, []);
  assert.equal(r.json.head, tip);
  assert.equal(r.json.base, base, "the stale base is the commit the tree is sitting at");
  assert.equal(read(dir, "a.js"), "one\n", "a dry run must not write");
});

test("--apply heals the stale index: the root ends at main, clean, exit 0", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.healed, ["a.js"]);
  assert.equal(read(dir, "a.js"), "one\ntwo\n", "the merged content is restored");
  assert.equal(statusOf(dir), "", "index and working tree both match main");
});

// Each path's own newest match legitimately differs when the root lags SEVERAL
// merges: a path the later merges never touched also matches the newer commits.
// The common base has to be found by re-testing every path per ancestor, or the
// evidence line disappears in exactly the multi-merge-lag case it exists for.
test("a root lagging several merges still names the commit it is sitting at", () => {
  const dir = initRepo();
  write(dir, "a.js", "a0\n");
  write(dir, "b.js", "b0\n");
  const c0 = commit(dir, "init");
  write(dir, "a.js", "a1\n");
  commit(dir, "a only"); // b.js's c0 state also matches here — its newest match
  write(dir, "b.js", "b1\n");
  commit(dir, "b only");
  git(dir, "checkout", "-q", c0, "--", "a.js", "b.js"); // index+tree back to c0: the lagging-root shape

  const r = runJson(dir);
  assert.equal(r.json.verdict, "STALE");
  assert.deepEqual(r.json.stale.map((s) => s.path).sort(), ["a.js", "b.js"]);
  assert.equal(r.json.base, c0, "the one ancestor that explains every stale path");
});

test("a stale root spanning many paths heals every one and names one common base", () => {
  const dir = initRepo();
  write(dir, "a.js", "a0\n");
  write(dir, "lib/b.js", "b0\n");
  write(dir, "c.md", "c0\n");
  const base = commit(dir, "init");
  casAdvance(dir, () => {
    write(dir, "a.js", "a1\n");
    write(dir, "lib/b.js", "b1\n");
    write(dir, "c.md", "c1\n");
  });

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(r.json.base, base);
  assert.deepEqual(r.json.healed.sort(), ["a.js", "c.md", "lib/b.js"]);
  assert.equal(statusOf(dir), "");
});

test("a file the merge ADDED, missing from the stale tree, is restored", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "new.js", "brand new\n"));

  assert.equal(fs.existsSync(path.join(dir, "new.js")), false, "the stale tree predates the file");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, "new.js"), "brand new\n");
});

test("the unstaged shape (index refreshed, working tree behind) heals too", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));
  git(dir, "reset", "-q", "--mixed", "HEAD"); // index now matches main; the file does not

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, "a.js"), "one\ntwo\n");
  assert.equal(statusOf(dir), "");
});

// ---------- the side that must never be wrong: genuine WIP ----------

test("genuine WIP is ROOT-UNSYNCED and is never touched, even with --apply", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  write(dir, "a.js", "one\nwork in progress\n"); // novel content, committed nowhere

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, []);
  assert.deepEqual(r.json.wip.map((w) => w.path), ["a.js"]);
  assert.equal(read(dir, "a.js"), "one\nwork in progress\n", "WIP survives");
});

test("staged WIP is refused as firmly as unstaged WIP", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  write(dir, "a.js", "one\nstaged work\n");
  git(dir, "add", "a.js");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(read(dir, "a.js"), "one\nstaged work\n");
});

test("stale and WIP in one root: the stale path heals, the WIP path survives, exit stays 1", () => {
  const dir = initRepo();
  write(dir, "a.js", "a0\n");
  write(dir, "b.js", "b0\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "a1\n"));
  write(dir, "b.js", "b0\nlive work\n"); // a parallel job's edit, on top of the stale root

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED", "the root is not fully in sync, so the caller must not reset it");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, ["a.js"]);
  assert.equal(read(dir, "a.js"), "a1\n", "the surgical heal still ran");
  assert.equal(read(dir, "b.js"), "b0\nlive work\n", "the live edit is untouched");
  assert.deepEqual(r.json.wip.map((w) => w.path), ["b.js"]);
});

test("a file mixing stale content with a genuine edit is refused (the documented residual)", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));
  write(dir, "a.js", "one\nedited on top of the stale file\n");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(read(dir, "a.js"), "one\nedited on top of the stale file\n");
});

test("a staged add of a path absent at HEAD is never healed — the heal would be a delete", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  write(dir, "brand-new.js", "uncommitted new work\n");
  git(dir, "add", "brand-new.js");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(read(dir, "brand-new.js"), "uncommitted new work\n", "the file is still there");
  assert.deepEqual(r.json.wip.map((w) => w.path), ["brand-new.js"]);
});

// git detects renames on the WORKTREE side too, putting the rename letter in the
// SECOND column and still emitting the extra source-path field: " R g.txt\0f.txt\0".
// A parser that only consumes the extra field for xy[0] reads `f.txt` as the next
// status record and reports a path named "xt" — a phantom, in the one report a
// human reads before authorizing a destructive reset.
test("a worktree-side rename does not desync the -z parse into a phantom path", () => {
  const dir = initRepo();
  write(dir, "f.txt", "content\n");
  commit(dir, "init");
  fs.renameSync(path.join(dir, "f.txt"), path.join(dir, "g.txt"));
  git(dir, "add", "-N", "g.txt"); // intent-to-add: git now reports " R f.txt -> g.txt"
  // The rename letter must land in the SECOND column — that is the whole point of
  // the fixture, so assert it against the untrimmed status.
  assert.match(git(dir, "status", "--porcelain", "-uno"), /^ R f\.txt -> g\.txt$/m,
    "the fixture really is a worktree-side rename");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  const reported = r.json.wip.map((w) => w.path).concat(r.json.stale.map((s) => s.path));
  for (const p of reported) {
    assert.equal(["f.txt", "g.txt"].includes(p), true, `reported a path that is not in the repo: ${p}`);
  }
});

test("a staged rename is refused without inspecting content", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  git(dir, "mv", "a.js", "renamed.js");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(dir, "renamed.js")), true);
  assert.equal(r.json.wip.length, 1);
});

test("emptying a file is not evidence of a rewind, even when an ancestor held it empty", () => {
  const dir = initRepo();
  write(dir, "a.js", ""); // the ancestor version IS empty
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "filled in\n"));

  // The tree is genuinely stale here, but empty content is indistinguishable from
  // a truncation, so the guard refuses it: a missed heal, never a wrong one.
  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(read(dir, "a.js"), "");
});

test("the empty-blob guard still holds in a sha256 repo, where the sha1 empty-blob OID never appears", () => {
  let dir;
  try {
    dir = initRepo({ objectFormat: "sha256" });
  } catch {
    return; // this git build has no sha256 support; skip rather than fail
  }
  write(dir, "a.js", ""); // the ancestor version IS empty
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "filled in\n"));

  // Were the guard still keyed to the hardcoded sha1 empty-blob OID, it would
  // never match this repo's sha256 empty blob, so isEmptyBlob would always read
  // false and the truncation would be misclassified as a stale rewind and healed
  // away — the data-loss bug this test pins shut.
  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(read(dir, "a.js"), "");
});

test("stale content older than the lookback window is refused, not healed", () => {
  const dir = initRepo();
  // Each commit gives a.js a distinct version, so "v0" identifies exactly one
  // ancestor — three back, outside a --lookback 1 window.
  write(dir, "a.js", "v0\n");
  commit(dir, "init");
  write(dir, "a.js", "v1\n");
  commit(dir, "second");
  write(dir, "a.js", "v2\n");
  commit(dir, "third");
  casAdvance(dir, () => write(dir, "a.js", "v3\n"));
  git(dir, "checkout", "-q", "HEAD~3", "--", "a.js"); // put a.js back to its oldest version

  const near = runJson(dir, "--lookback", "10");
  assert.equal(near.json.verdict, "STALE", "inside the window it is recognized");

  const far = runJson(dir, "--lookback", "1", "--apply");
  assert.equal(far.json.verdict, "ROOT-UNSYNCED");
  assert.equal(far.status, 1);
  assert.equal(read(dir, "a.js"), "v0\n", "outside the window the guard refuses to heal");
});

// ---------- probes that fail, rather than answer ----------

test("a file that exists but cannot be read is refused, not mistaken for a deleted one", () => {
  if (process.platform === "win32") return; // chmod 000 does not withhold read there
  // …and it does not withhold read from uid 0 either: as root the probe SUCCEEDS,
  // the file classifies WIP for the ordinary reason, and this test would pass
  // green without ever exercising the UNKNOWN branch it exists to pin.
  if (process.getuid && process.getuid() === 0) return;
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "unreadable.js", "added by the merge\n"));
  // Live content the guard must not clobber, in a file it cannot hash. Read as
  // "absent" it would match the ancestor that predates the path and be healed —
  // overwriting what is sitting right here.
  write(dir, "unreadable.js", "LIVE WORK\n");
  fs.chmodSync(path.join(dir, "unreadable.js"), 0o000);

  try {
    const r = runJson(dir, "--apply");
    assert.equal(r.json.verdict, "ROOT-UNSYNCED");
    assert.equal(r.status, 1);
    assert.deepEqual(r.json.healed, []);
  } finally {
    fs.chmodSync(path.join(dir, "unreadable.js"), 0o644);
  }
  assert.equal(read(dir, "unreadable.js"), "LIVE WORK\n", "the unreadable file is untouched");
});

test("a directory standing where a tracked file belongs is refused", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "b.js", "added by the merge\n"));
  fs.mkdirSync(path.join(dir, "b.js")); // not a file: uninspectable, not absent

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(fs.statSync(path.join(dir, "b.js")).isDirectory(), true);
});

// Locks in literal semantics for a wildcard-shaped name. It passes without
// :(literal) too — git falls back to matching the name exactly because a tree
// entry of that name exists — so this pins the BEHAVIOUR rather than the fix: if
// a future change ever fed this tool a path git could not match literally, a
// glob would silently widen the blast radius of a checkout and this fails.
test("a glob-shaped filename is matched literally — a stale path never drags a WIP neighbour with it", () => {
  if (process.platform === "win32") return; // `?` is not a legal filename character
  const dir = initRepo();
  write(dir, "a?.js", "q0\n"); // a filename that is also a pathspec wildcard
  write(dir, "ab.js", "ab0\n"); // the file that wildcard matches
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a?.js", "q1\n"));
  write(dir, "ab.js", "ab0\nlive work\n");

  const r = runJson(dir, "--apply");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, ["a?.js"]);
  assert.equal(read(dir, "a?.js"), "q1\n", "the stale path healed");
  assert.equal(read(dir, "ab.js"), "ab0\nlive work\n", "its glob-neighbour's live work survived");
});

test("a filename that looks like pathspec magic is handled literally", () => {
  if (process.platform === "win32") return; // `:` is not a legal filename character
  const dir = initRepo();
  write(dir, ":colon.js", "c0\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, ":colon.js", "c1\n"));

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, ":colon.js"), "c1\n");
});

test("paths with spaces and unicode survive the -z status parse", () => {
  const dir = initRepo();
  write(dir, "a file with spaces.md", "s0\n");
  write(dir, "ünïcode/påth.md", "u0\n");
  commit(dir, "init");
  casAdvance(dir, () => {
    write(dir, "a file with spaces.md", "s1\n");
    write(dir, "ünïcode/påth.md", "u1\n");
  });

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, "a file with spaces.md"), "s1\n");
  assert.equal(read(dir, "ünïcode/påth.md"), "u1\n");
});

// issue-spor-heal-stale-root-non-utf8-mangling: a path is a sequence of bytes,
// not text, and git enforces no encoding on it. This filename's second byte
// (0xe9) is not valid UTF-8 on its own — decoding the tool's git-status output
// as utf8 (the bug) folds it to U+FFFD, a string that can never be matched back
// against the real on-disk path, so the tool refuses forever instead of
// healing. Only Linux filesystems store raw bytes like this; macOS normalizes
// to NFD Unicode and Windows filenames are UTF-16, so neither can even create
// this fixture.
test("a tracked path with non-UTF-8 bytes in its name heals like any other stale path", () => {
  if (process.platform !== "linux") return; // only a Linux filesystem accepts raw non-UTF-8 bytes in a name
  const dir = initRepo();
  const rawName = Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "f\xe9.txt" — \xe9 alone is invalid UTF-8
  const abs = Buffer.concat([Buffer.from(dir), Buffer.from("/"), rawName]);
  // `write()` takes the path as a JS string, which cannot represent these
  // bytes losslessly — write straight to the raw path instead and let
  // commit()'s `git add -A` (no pathspec argv at all) pick it up off disk.
  fs.writeFileSync(abs, "v0\n");
  commit(dir, "init");
  casAdvance(dir, () => fs.writeFileSync(abs, "v1\n"));

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(abs, "utf8"), "v1\n", "the merged content is restored");
  assert.equal(statusOf(dir), "", "index and working tree both match main");
});

test("a repo root whose real path holds non-UTF-8 bytes is refused, not mangled", () => {
  if (process.platform !== "linux") return; // only a Linux filesystem accepts raw non-UTF-8 bytes in a name

  // A fresh, uniquely-named container (mkdtempSync, so the leak-guard sweeps
  // it — see tmp-cleanup — recursively, including the raw-byte child below).
  // The repo is built as an ordinary ascii-named dir first, then RENAMED to a
  // raw-byte name via a pure fs syscall (Buffer path) — the only way to
  // construct this fixture, since naming it through any spawned git/argv call
  // would hit the exact re-encoding trap under test (confirmed empirically:
  // Node re-encodes Buffer argv/cwd to UTF-8 too, so even the test harness
  // cannot spawn against the raw path directly). An ASCII symlink then lets
  // the harness's own spawn stay argv-safe while git's `-C <symlink>` still
  // resolves and prints the raw-byte REAL path for --show-toplevel — the
  // scenario this guards against: an argv-safe --repo input whose resolved
  // toplevel is not.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-rawroot-"));
  const dir = path.join(parent, "repo");
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  write(dir, "a.js", "one\n");
  commit(dir, "init");

  const rawName = Buffer.from([0x66, 0xe9, 0x2e, 0x64]); // "f\xe9.d" — \xe9 alone is invalid UTF-8
  const rawDir = Buffer.concat([Buffer.from(parent), Buffer.from("/"), rawName]);
  fs.renameSync(dir, rawDir);
  const link = path.join(parent, "safelink");
  fs.symlinkSync(rawDir, link);

  const r = run(link);
  assert.equal(r.status, 2, "refuses cleanly rather than mangling the root path and misbehaving");
  assert.match(r.stderr, /not valid UTF-8/);
});

test("a repo root ending in a multi-byte UTF-8 character is not falsely refused", () => {
  // Regression: the root path is read losslessly via latin1 (gitPaths), one
  // code unit per raw byte, then validated as UTF-8 — but the validation used
  // to run JS's `.trim()` directly on that latin1 string first. `.trim()`
  // strips any Unicode-whitespace CODE POINT, including U+00A0 (NBSP); byte
  // 0xA0 is latin1's decode of U+00A0, and 0xA0 is also the ordinary
  // continuation byte of many common 2-byte UTF-8 characters — "à" encodes as
  // 0xC3 0xA0. A repo root ending in "à" (or any character sharing that last
  // byte) had its real trailing byte silently stripped as if it were
  // whitespace, corrupting a perfectly valid UTF-8 path into an incomplete
  // sequence and refusing it.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-utf8root-"));
  const dir = path.join(parent, "repo-à"); // "à" = 0xC3 0xA0; last byte 0xA0
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  write(dir, "a.js", "one\n");
  commit(dir, "init");

  const r = runJson(dir);
  assert.equal(r.json.verdict, "IN-SYNC");
  assert.equal(r.status, 0);
});

// ---------- differences content identity cannot see ----------

test("an uncommitted chmod +x is not 'already at HEAD' — the exec bit survives", () => {
  if (process.platform === "win32") return; // no exec bit to lose
  const dir = initRepo();
  write(dir, "run.sh", "#!/bin/sh\necho hi\n");
  commit(dir, "init");
  fs.chmodSync(path.join(dir, "run.sh"), 0o755); // uncommitted, and invisible to the blob

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, []);
  assert.equal(fs.statSync(path.join(dir, "run.sh")).mode & 0o111, 0o111, "the exec bit survives");
});

// The intersection that a "consult mode only when content evidence is exhausted"
// guard misses: the CONTENT is genuinely stale (so a content-only comparison
// finds its ancestor and clears the path), while an uncommitted chmod rides along
// on the same file and dies in the heal. Identity has to be (mode, blob) for both
// halves at once, not blob with mode as a fallback.
test("a stale path carrying an uncommitted chmod +x is refused — the mode rides with the content", () => {
  if (process.platform === "win32") return; // no exec bit to lose
  const dir = initRepo();
  write(dir, "run.sh", "v0\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "run.sh", "v1\n")); // content is now genuinely stale
  fs.chmodSync(path.join(dir, "run.sh"), 0o755); // …and someone made it executable, uncommitted

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, []);
  assert.equal(fs.statSync(path.join(dir, "run.sh")).mode & 0o111, 0o111, "the exec bit survives");
  assert.equal(read(dir, "run.sh"), "v0\n", "and the file is left alone entirely");
});

// core.fileMode=false is the Windows default, and it means git ignores the exec
// bit entirely: it never reports a chmod as a modification and keeps the mode the
// index recorded. Reading the bit off disk there invents a difference git does not
// see — a committed 100755 script checks out as 0644, matches no ancestor, and
// reads as novel work. Every exec file a merge touched would wedge the sync.
test("with core.fileMode=false the exec bit is not evidence, so a stale path still heals", () => {
  const dir = initRepo();
  write(dir, "run.sh", "v0\n");
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);
  commit(dir, "init"); // committed as 100755
  git(dir, "config", "core.fileMode", "false");
  casAdvance(dir, () => write(dir, "run.sh", "v1\n"));
  fs.chmodSync(path.join(dir, "run.sh"), 0o644); // the filesystem "loses" the bit

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, "run.sh"), "v1\n");
});

// git accepts 0/off/no/FALSE/'' for false, not just the literal spelling, and it
// resolves every one of them. A string compare against "false" honors an exec bit
// git is ignoring — the wedge above, re-opened for four spellings out of five.
for (const spelling of ["0", "off", "no", "FALSE"]) {
  test(`core.fileMode=${spelling} is false too, so a stale exec file still heals`, () => {
    const dir = initRepo();
    write(dir, "run.sh", "v0\n");
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    commit(dir, "init");
    git(dir, "config", "core.fileMode", spelling);
    casAdvance(dir, () => write(dir, "run.sh", "v1\n"));
    fs.chmodSync(path.join(dir, "run.sh"), 0o644);

    const r = runJson(dir, "--apply");
    assert.equal(r.json.verdict, "HEALED");
    assert.equal(r.status, 0);
  });
}

// git records 100755 off the OWNER exec bit alone (S_IXUSR). A 0o111 mask calls a
// group-exec-only file 100755 while git records 100644 — an invented difference
// that refuses a healable path.
test("a group-exec-only file is not 100755 — git reads the owner bit, so we do", () => {
  if (process.platform === "win32") return;
  const dir = initRepo();
  write(dir, "f.sh", "v0\n");
  commit(dir, "init"); // 0644 -> git records 100644
  casAdvance(dir, () => write(dir, "f.sh", "v1\n"));
  fs.chmodSync(path.join(dir, "f.sh"), 0o654); // group-exec on, owner-exec off
  assert.match(git(dir, "ls-files", "-s", "f.sh"), /^100644 /, "git still records 100644");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED", "the path is stale and git sees no mode change");
  assert.equal(r.status, 0);
});

// core.symlinks=false is the Windows default without Developer Mode: git
// materializes a tracked symlink as a PLAIN FILE holding the target path, while
// still recording mode 120000. Deriving 100644 from disk refuses it forever.
test("with core.symlinks=false a checked-out symlink is a plain file, and still heals", () => {
  if (process.platform === "win32") return; // building the fixture needs real symlinks first
  const dir = initRepo();
  write(dir, "target.txt", "a\n");
  write(dir, "other.txt", "b\n");
  fs.symlinkSync("target.txt", path.join(dir, "link"));
  commit(dir, "init");
  casAdvance(dir, () => {
    fs.unlinkSync(path.join(dir, "link"));
    fs.symlinkSync("other.txt", path.join(dir, "link"));
  });
  git(dir, "config", "core.symlinks", "false");
  fs.unlinkSync(path.join(dir, "link"));
  fs.writeFileSync(path.join(dir, "link"), "target.txt"); // the blob git stored, as a file
  assert.equal(fs.lstatSync(path.join(dir, "link")).isSymbolicLink(), false, "the fixture is a plain file");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
});

test("with core.fileMode honored, a stale path whose mode also differs is refused", () => {
  if (process.platform === "win32") return; // the filesystem cannot honor it there
  const dir = initRepo();
  write(dir, "run.sh", "v0\n");
  commit(dir, "init"); // committed as 100644
  git(dir, "config", "core.fileMode", "true");
  casAdvance(dir, () => write(dir, "run.sh", "v1\n"));
  fs.chmodSync(path.join(dir, "run.sh"), 0o755); // an uncommitted chmod, which git DOES see here

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(fs.statSync(path.join(dir, "run.sh")).mode & 0o111, 0o111);
});

test("a tracked file swapped for a symlink (typechange) is refused", () => {
  if (process.platform === "win32") return; // symlinks need privilege there
  const dir = initRepo();
  write(dir, "target.txt", "payload\n");
  write(dir, "f.txt", "payload\n"); // same content, so the blob matches through the link
  commit(dir, "init");
  fs.unlinkSync(path.join(dir, "f.txt"));
  fs.symlinkSync("target.txt", path.join(dir, "f.txt"));

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.equal(fs.lstatSync(path.join(dir, "f.txt")).isSymbolicLink(), true, "the symlink survives");
});

test("a stale tracked symlink is compared by its target, so it heals", () => {
  if (process.platform === "win32") return;
  const dir = initRepo();
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
  fs.symlinkSync("a.txt", path.join(dir, "link"));
  commit(dir, "init");
  casAdvance(dir, () => {
    fs.unlinkSync(path.join(dir, "link"));
    fs.symlinkSync("b.txt", path.join(dir, "link")); // the merge repointed it
  });

  // git stores the link's TARGET as its blob; hashing the target's CONTENT would
  // never match, and the guard would wedge on any repo carrying a tracked symlink.
  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(fs.readlinkSync(path.join(dir, "link")), "b.txt");
});

// ---------- clean filters, which launder novel bytes into old blobs ----------

// The blob sha of a working file goes through the .gitattributes clean filters —
// that is what makes it comparable to committed blobs at all — so a LOSSY clean
// filter can normalize genuinely novel bytes down to a stale ancestor's blob.
// Cleared on that evidence, the checkout would destroy the only copy of them.
test("raw WIP bytes that a lossy clean filter normalizes to a stale blob are refused", () => {
  if (process.platform === "win32") return; // the filter is a POSIX sed
  const dir = initRepo();
  git(dir, "config", "filter.strip.clean", "sed -e /PRIVATE/d"); // lossy on purpose
  write(dir, ".gitattributes", "*.txt filter=strip\n");
  write(dir, "a.txt", "v0\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.txt", "v1\n"));
  // Genuine WIP whose CLEANED form equals the stale blob exactly: by filtered
  // content alone this path is indistinguishable from a stale one.
  write(dir, "a.txt", "v0\nPRIVATE: live work, committed nowhere\n");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, []);
  assert.equal(read(dir, "a.txt"), "v0\nPRIVATE: live work, committed nowhere\n", "the raw bytes survive");
});

// The other side of that gate: a ROUND-TRIP conversion (eol=crlf keeps LF blobs
// in the odb and CRLF bytes on disk) makes raw differ from the blob on every
// file it covers, yet the on-disk bytes are exactly what a checkout of the
// matched commit writes. Refusing those would wedge the sync on every text file
// of a Windows checkout — the platform this plugin supports natively.
test("eol=crlf is a round-trip conversion, so a stale path still heals through it", () => {
  const dir = initRepo();
  write(dir, ".gitattributes", "*.txt text eol=crlf\n");
  write(dir, "a.txt", "v0\r\n"); // CRLF on disk; the committed blob is LF
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.txt", "v1\r\n"));

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "HEALED");
  assert.equal(r.status, 0);
  assert.equal(read(dir, "a.txt"), "v1\r\n", "healed to the merged content, in checkout form");
  assert.equal(statusOf(dir), "");
});

// ---------- a write landing while the heal itself is running ----------

// The heal writes path by path, so a set of stale paths takes real wall-clock —
// with any up-front recheck (whole-set or chunked), a path late in the set would
// sit cleared-but-unwritten for the duration of everything healed before it,
// plenty of room for a concurrent job's write to land and be overwritten. The
// recheck is per-path, immediately before that path's own checkout; a
// post-checkout hook plays the concurrent job deterministically: the FIRST
// path's checkout fires it, and it drops novel content into the LAST path —
// after that path was classified stale, before its own turn to be written.
test("a write landing while earlier paths heal is caught by that path's own recheck", () => {
  if (process.platform === "win32") return; // the concurrent writer is a sh hook
  const dir = initRepo();
  const names = [];
  for (let i = 0; i < 8; i++) names.push(`f${i}.txt`);
  for (const n of names) write(dir, n, `${n} v0\n`);
  commit(dir, "init");
  casAdvance(dir, () => { for (const n of names) write(dir, n, `${n} v1\n`); });
  const last = names[names.length - 1]; // healed last, so its window is widest
  const hook = path.join(dir, ".git", "hooks", "post-checkout");
  // Fire exactly once: an unguarded hook re-fires on every later checkout too,
  // re-creating the WIP right after a checkout destroyed it — and the aftermath
  // is then indistinguishable from the write having been spared.
  fs.writeFileSync(hook, [
    "#!/bin/sh",
    'if [ ! -e .git/raced-once ]; then',
    "  : > .git/raced-once",
    `  printf 'mid-heal WIP\\n' > '${last}'`,
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(hook, 0o755);

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED", "the root is not fully in sync — a write raced the heal");
  assert.equal(r.status, 1);
  assert.equal(r.json.healed.length, names.length - 1, "every path the racer left alone still healed");
  assert.equal(r.json.healed.includes(last), false);
  assert.deepEqual(r.json.wip.map((w) => w.path), [last]);
  assert.equal(read(dir, last), "mid-heal WIP\n", "the mid-heal write survives");
});

// The sharper pin on the same window: the previous test's writer fires between
// two CHECKOUTS, which any implementation with more than one checkout batch
// catches. This one fires DURING the last path's own recheck probe — b.txt's
// clean filter (identity for content, racing side effect) runs inside recheck's
// hash-object and writes novel bytes into a.txt, which by then has already been
// healed. Any design that clears paths first and writes them later (one batched
// checkout, chunked checkouts) has already cleared a.txt and proceeds to
// overwrite that write; only probe-then-immediately-write-per-path leaves it
// standing. The filter CONFIG lands only after casAdvance, so the fixture's own
// commits run with the attribute pointing at a missing filter (a no-op).
test("a write landing inside the very recheck window survives — the heal is per-path", () => {
  if (process.platform === "win32") return; // the racing writer is a sh filter
  const dir = initRepo();
  write(dir, ".gitattributes", "b.txt filter=racer\n");
  write(dir, "a.txt", "a v0\n");
  write(dir, "b.txt", "b v0\n");
  commit(dir, "init");
  casAdvance(dir, () => {
    write(dir, "a.txt", "a v1\n");
    write(dir, "b.txt", "b v1\n");
  });
  // Fires only once a.txt has been healed to v1 — i.e. mid-apply, never during
  // classification (a.txt is still v0 there) and idempotently never again.
  write(dir, ".git/racer.sh", [
    "#!/bin/sh",
    'if [ "$(cat a.txt 2>/dev/null)" = "a v1" ]; then',
    "  printf 'mid-heal WIP\\n' > a.txt",
    "fi",
    "cat",
    "",
  ].join("\n"));
  git(dir, "config", "filter.racer.clean", "sh .git/racer.sh");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED", "a write raced the heal, so the root is not in sync");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, ["b.txt"], "the path the racer left alone healed");
  assert.deepEqual(r.json.wip.map((w) => w.path), ["a.txt"]);
  assert.equal(read(dir, "a.txt"), "mid-heal WIP\n", "the write that landed mid-recheck survives");
  assert.equal(read(dir, "b.txt"), "b v1\n");
});

// ---------- conflicts, which hide their other side in the index ----------

// An add/add conflict reads `AA` — no `U` for a letter-based check to catch — and
// `git stash apply` / `git apply --3way` leave one with NO MERGE_HEAD for the
// in-progress check to catch either. "theirs" then exists ONLY in index stage 3,
// where `git checkout HEAD -- n.txt` silently discards it. read-tree builds the
// state directly, so the fixture is the shape itself rather than a race to
// provoke it.
test("an add/add conflict with no MERGE_HEAD is refused, not collapsed to HEAD", () => {
  const dir = initRepo();
  write(dir, "seed.txt", "x\n");
  const base = commit(dir, "init");
  write(dir, "n.txt", "ours\n");
  const ours = commit(dir, "ours adds n.txt");
  git(dir, "checkout", "-q", "-b", "other", base);
  write(dir, "n.txt", "theirs\n");
  const theirs = commit(dir, "theirs adds n.txt");
  git(dir, "checkout", "-q", "main");
  git(dir, "read-tree", "-m", base, ours, theirs); // unmerged index, worktree untouched

  assert.match(statusOf(dir), /^AA /m, "the fixture really is an unmerged add/add");
  assert.equal(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), false, "and no marker flags it");
  assert.equal(read(dir, "n.txt"), "ours\n", "the working tree agrees with HEAD, so only the index dissents");

  const r = runJson(dir, "--apply");
  assert.equal(r.json.verdict, "ROOT-UNSYNCED");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.healed, []);
  assert.equal(git(dir, "ls-files", "-u").trim().split("\n").length, 2, "both conflict stages survive");
});

// ---------- probes that fail must never read as an answer ----------

test("an unreadable git status is refused with exit 2, never reported IN-SYNC", () => {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0) return; // root reads a chmod-000 index anyway
  const dir = initRepo();
  write(dir, "f.txt", "committed\n");
  commit(dir, "init");
  write(dir, "f.txt", "GENUINE UNCOMMITTED WIP\n");
  fs.chmodSync(path.join(dir, ".git", "index"), 0o000); // git status now exits non-zero

  try {
    const r = run(dir, "--json");
    // Reporting IN-SYNC here would exit 0, and exit 0 tells the caller "you may
    // reset --hard": the WIP above dies on a probe failure.
    assert.equal(r.status, 2, "a status we could not read is not a clean status");
    assert.doesNotMatch(r.stdout, /IN-SYNC/);
  } finally {
    fs.chmodSync(path.join(dir, ".git", "index"), 0o644);
  }
  assert.equal(read(dir, "f.txt"), "GENUINE UNCOMMITTED WIP\n");
});

// ---------- ambient git env (issue-spor-gittime-git-env-inheritance) ----------

test("a bogus ambient GIT_DIR does not misdirect the heal — --repo stays authoritative", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));

  // A decoy repo the ambient env points git at. Confirmed unscrubbed git
  // resolves GIT_DIR/GIT_WORK_TREE over both `-C <dir>` and a spawn `cwd` of
  // `dir` — if any spawn here inherited them, every git call would silently
  // run against the decoy instead of the `--repo` argument.
  const decoy = initRepo();
  write(decoy, "b.js", "decoy\n");
  commit(decoy, "decoy init");

  const r = runWithEnv(
    dir,
    { GIT_DIR: path.join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_COMMON_DIR: path.join(decoy, ".git") },
    "--json",
    "--apply"
  );
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(json.verdict, "HEALED");
  assert.equal(read(dir, "a.js"), "one\ntwo\n"); // healed the real repo, not the decoy
  assert.equal(read(decoy, "b.js"), "decoy\n"); // decoy untouched
});

// ---------- invocation ----------

test("a merge in progress refuses with exit 2", () => {
  const dir = initRepo();
  write(dir, "a.js", "base\n");
  commit(dir, "init");
  git(dir, "checkout", "-q", "-b", "side");
  write(dir, "a.js", "side\n");
  commit(dir, "side edit");
  git(dir, "checkout", "-q", "main");
  write(dir, "a.js", "main\n");
  commit(dir, "main edit");
  spawnSync("git", ["-C", dir, "merge", "side"], { encoding: "utf8" }); // conflicts on purpose

  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /merge is in progress/);
});

test("a non-repo and a bad flag exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-norepo-"));
  assert.equal(run(dir).status, 2);

  const repo = initRepo();
  write(repo, "a.js", "one\n");
  commit(repo, "init");
  assert.equal(run(repo, "--nonsense").status, 2);
  assert.equal(run(repo, "--lookback", "0").status, 2);
});

test("the human report names the verdict and the paths", () => {
  const dir = initRepo();
  write(dir, "a.js", "one\n");
  commit(dir, "init");
  casAdvance(dir, () => write(dir, "a.js", "one\ntwo\n"));

  const r = run(dir, "--apply");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^HEALED:/m);
  assert.match(r.stdout, /a\.js/);
});
