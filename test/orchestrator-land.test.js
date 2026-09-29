// .claude/skills/spor-orchestrator/scripts/land.sh — the orchestrator's
// landing primitive that replaced scripts/heal-stale-root.js
// (task-spor-orchestrator-land-from-detached-worktree-retire-healer): the
// ancestry guard, parking a checkout that has the target branch checked out,
// the CAS, and verification in a fresh detached worktree.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { gitInit, gitEnv } = require("./helpers/git.js");

const LAND = path.join(__dirname, "..", ".claude", "skills", "spor-orchestrator", "scripts", "land.sh");
const skip = process.platform === "win32" ? "land.sh is bash operator tooling" : false;

// A repo whose root checkout sits on `main` (the shape that used to go stale),
// plus a feature branch one commit ahead of main in its own worktree.
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-land-"));
  const root = path.join(base, "root");
  const g = gitInit(root);
  g(["checkout", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "one"]);
  const wt = path.join(base, "feature");
  g(["worktree", "add", "-q", "-b", "feature", wt]);
  fs.writeFileSync(path.join(wt, "a.txt"), "two\n");
  g(["add", "a.txt"], wt);
  g(["commit", "-q", "-m", "two"], wt);
  const sha = (ref, cwd = root) => g(["rev-parse", ref], cwd).trim();
  tmpBase = base;
  return { base, root, wt, g, sha };
}

// TMPDIR points into the fixture so a kept verify worktree is cleaned with it.
let tmpBase = os.tmpdir();
function land(args) {
  return spawnSync("bash", [LAND, ...args], { encoding: "utf8", env: gitEnv({ TMPDIR: tmpBase }) });
}

test("lands a descendant tip, parking the root detached and advancing it by git checkout", { skip }, () => {
  const { root, g, sha } = fixture();
  fs.writeFileSync(path.join(root, "wip.txt"), "untracked WIP\n");
  const old = sha("main");
  const tip = sha("feature");
  const r = land(["--repo", root, "--tip", "feature"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `LANDED old=${old} new=${tip} parked=${root}`);
  assert.equal(sha("main"), tip);
  // The root no longer follows main (so a later ref move cannot make it lie),
  // but it WAS advanced to the landed tip — dispatch cuts new worktrees from
  // its HEAD — and the unrelated WIP rode along.
  assert.notEqual(spawnSync("git", ["-C", root, "symbolic-ref", "-q", "HEAD"], { env: gitEnv() }).status, 0);
  assert.equal(sha("HEAD"), tip);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "two\n");
  assert.equal(g(["status", "--porcelain"]), "?? wip.txt\n");
});

test("a parked root whose local change is in the way stays behind, change intact", { skip }, () => {
  const { root, g, sha } = fixture();
  fs.writeFileSync(path.join(root, "a.txt"), "local edit\n"); // a.txt is what the tip changes
  const old = sha("main");
  const tip = sha("feature");
  const r = land(["--repo", root, "--tip", "feature"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `LANDED old=${old} new=${tip} parked=${root} behind=${root}`);
  assert.equal(sha("main"), tip, "the land itself went through");
  assert.equal(sha("HEAD"), old, "the root stays detached at the commit its tree holds");
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "local edit\n");
  assert.equal(g(["status", "--porcelain"]), " M a.txt\n", "status shows exactly the real WIP");
});

test("later lands keep advancing an already-parked root; a behind root is retried", { skip }, () => {
  const { root, wt, g, sha } = fixture();
  assert.equal(land(["--repo", root, "--tip", "feature"]).status, 0);
  const first = sha("main");
  // A second branch lands while the root is already detached.
  fs.writeFileSync(path.join(wt, "c.txt"), "c\n");
  g(["add", "c.txt"], wt);
  g(["commit", "-q", "-m", "three"], wt);
  const second = sha("HEAD", wt);
  let r = land(["--repo", root, "--tip", second]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `LANDED old=${first} new=${second}`);
  assert.equal(sha("HEAD"), second, "dispatch's base (the root HEAD) follows every land");
  // Now a local change blocks the next advance, then clears: the land after retries it.
  fs.writeFileSync(path.join(wt, "c.txt"), "c2\n");
  g(["commit", "-q", "-am", "four"], wt);
  fs.writeFileSync(path.join(root, "c.txt"), "in the way\n");
  r = land(["--repo", root, "--tip", sha("HEAD", wt)]);
  assert.match(r.stdout, / behind=/);
  assert.equal(sha("HEAD"), second);
  g(["checkout", "-q", "--", "c.txt"]);
  fs.writeFileSync(path.join(wt, "d.txt"), "d\n");
  g(["add", "d.txt"], wt);
  g(["commit", "-q", "-m", "five"], wt);
  r = land(["--repo", root, "--tip", sha("HEAD", wt)]);
  assert.doesNotMatch(r.stdout, /behind=/);
  assert.equal(sha("HEAD"), sha("main"));
});

test("a detached root on its own commit off the target line is left alone", { skip }, () => {
  const { root, g, sha } = fixture();
  g(["checkout", "-q", "--detach"]);
  fs.writeFileSync(path.join(root, "mine.txt"), "mine\n");
  g(["add", "mine.txt"]);
  g(["commit", "-q", "-m", "a human's detached commit"]);
  const mine = sha("HEAD");
  const r = land(["--repo", root, "--tip", "feature"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sha("HEAD"), mine);
});

test("refuses a tip that does not descend from the target, landing nothing", { skip }, () => {
  const { root, wt, g, sha } = fixture();
  // Advance main past the feature branch's base: feature is now a stale ancestor-based tip.
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  g(["add", "b.txt"]);
  g(["commit", "-q", "-m", "main moved"]);
  const old = sha("main");
  const r = land(["--repo", root, "--tip", sha("HEAD", wt)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^REFUSED reason=not-descendant/);
  assert.equal(sha("main"), old, "main did not rewind");
});

test("NOOP when the target is already at the tip; unresolvable tip refuses", { skip }, () => {
  const { root } = fixture();
  assert.match(land(["--repo", root, "--tip", "main"]).stdout, /^NOOP /);
  const r = land(["--repo", root, "--tip", "no-such-branch"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^REFUSED reason=unresolvable/);
});

test("--verify runs in a fresh detached worktree at the landed tip", { skip }, () => {
  const { root, sha } = fixture();
  const tip = sha("feature");
  const ok = land(["--repo", root, "--tip", "feature", "--verify", 'test "$(cat a.txt)" = two && test "$(git rev-parse HEAD)" = ' + tip]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /verify=passed$/m);
  assert.doesNotMatch(ok.stdout, /worktree=/, "the passing worktree is removed");
});

test("a failing --verify reports VERIFY-FAILED (the swap landed) and keeps the worktree", { skip }, () => {
  const { root, sha } = fixture();
  const r = land(["--repo", root, "--tip", "feature", "--verify", "exit 7"]);
  assert.equal(r.status, 3);
  const m = r.stdout.match(/^VERIFY-FAILED old=\S+ new=(\S+) worktree=(\S+)/);
  assert.ok(m, r.stdout);
  assert.equal(m[1], sha("main"));
  assert.ok(fs.existsSync(path.join(m[2], "a.txt")), "worktree kept for inspection");
});
