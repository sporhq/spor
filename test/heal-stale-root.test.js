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
function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-heal-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
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
