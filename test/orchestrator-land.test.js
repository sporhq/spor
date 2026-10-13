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
const { spawn, spawnSync } = require("node:child_process");

const { gitInit, gitEnv } = require("./helpers/git.js");

const LAND = path.join(__dirname, "..", ".claude", "skills", "spor-orchestrator", "scripts", "land.sh");
const skip = process.platform === "win32" ? "land.sh is bash operator tooling" : false;

// A repo whose root checkout sits on `main` (the shape that used to go stale),
// plus a feature branch one commit ahead of main in its own worktree.
function fixture() {
  // Realpath'd: land.sh reports paths as git resolves them, and a symlinked
  // temp root (macOS /var -> /private/var) would otherwise differ.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spor-land-")));
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
function land(args, cwd) {
  return spawnSync("bash", [LAND, ...args], { encoding: "utf8", cwd, env: gitEnv({ TMPDIR: tmpBase }) });
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

test("--tip HEAD resolves in the caller's worktree, not in the parked root", { skip }, () => {
  const { root, wt, sha } = fixture();
  const old = sha("main");
  const tip = sha("HEAD", wt);
  const r = land(["--repo", root, "--tip", "HEAD"], wt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `LANDED old=${old} new=${tip} parked=${root}`);
  assert.equal(sha("main"), tip);
});

test("a NOOP says so on stderr, naming where the tip resolved", { skip }, () => {
  const { root } = fixture();
  const r = land(["--repo", root, "--tip", "HEAD"], root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^NOOP /);
  assert.match(r.stderr, /NOOP .*nothing landed/);
});

test("a per-worktree tip from outside the repo is refused as symbolic-tip", { skip }, () => {
  const { root, sha } = fixture();
  const old = sha("main");
  const r = land(["--repo", root, "--tip", "HEAD"], os.tmpdir());
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^REFUSED reason=symbolic-tip/);
  assert.equal(sha("main"), old);
});

test("a failing post-checkout hook on a parked root is advanced but reported on stderr", { skip }, () => {
  const { root, sha } = fixture();
  const hooks = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\n[ \"$3\" = 1 ] && [ \"$2\" != \"$1\" ] && exit 1\nexit 0\n", { mode: 0o755 });
  const r = land(["--repo", root, "--tip", "feature"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /behind=/);
  assert.match(r.stderr, /advanced to .* but git checkout exited/);
  assert.equal(sha("HEAD"), sha("feature"));
  assert.equal(sha("main"), sha("feature"));
});

test("--verify sees SPOR_WORKTREE and SPOR_MAIN_CHECKOUT, like a dispatch worktree-setup hook", { skip }, () => {
  const { root } = fixture();
  const r = land(["--repo", root, "--tip", "feature", "--verify",
    `test "$SPOR_WORKTREE" = "$PWD" && test "$SPOR_MAIN_CHECKOUT" = '${fs.realpathSync(root)}'`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verify=passed$/m);
});

test("--lock-timeout must be whole seconds", { skip }, () => {
  const { root } = fixture();
  assert.equal(land(["--repo", root, "--tip", "feature", "--lock-timeout", "soon"]).status, 2);
});

// Two lands on one repo never overlap: the first holds the per-repo lock
// through its --verify, so a second land.sh — from any worktree — waits on
// it, and refuses as lock-timeout (landing nothing) when the wait runs out
// (issue-spor-orchestrator-land-sh-no-mutual-exclusion). Run for flock and
// for the mkdir fallback a flock-less host takes.
for (const impl of ["flock", "mkdir"]) {
  test(`a second land waits on the first and times out without landing (${impl === "mkdir" ? "pid-symlink" : impl} lock)`, { skip }, async () => {
    const { base, root, wt, g, sha } = fixture();
    const env = gitEnv({ TMPDIR: tmpBase, ...(impl === "mkdir" ? { SPOR_LAND_LOCK: "mkdir" } : {}) });
    const started = path.join(base, "verify-started");
    const release = path.join(base, "verify-release");
    const first = spawn("bash", [LAND, "--repo", root, "--tip", "feature", "--verify",
      `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.1; done`], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out1 = "";
    first.stdout.on("data", (d) => { out1 += d; });
    const done1 = new Promise((resolve) => first.on("exit", resolve));
    try {
      for (let i = 0; i < 300 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(started), "the first land reached its verify");
      const landed = sha("main");
      // A second branch on top of the landed tip: it WOULD land, but the lock is held.
      fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
      g(["add", "b.txt"], wt);
      g(["commit", "-q", "-m", "b"], wt);
      const r = spawnSync("bash", [LAND, "--repo", root, "--tip", "HEAD", "--lock-timeout", "1"], { encoding: "utf8", cwd: wt, env });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^REFUSED reason=lock-timeout/);
      assert.match(r.stderr, /another land holds .*spor-land\.lock/);
      assert.equal(sha("main"), landed, "the waiting land moved nothing");
      fs.writeFileSync(release, "");
      assert.equal(await done1, 0, out1);
      assert.match(out1, /verify=passed/);
      // The lock went with the first land: the second now lands.
      const again = spawnSync("bash", [LAND, "--repo", root, "--tip", "HEAD", "--lock-timeout", "1"], { encoding: "utf8", cwd: wt, env });
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /^LANDED /);
      assert.equal(sha("main"), sha("HEAD", wt));
    } finally {
      fs.writeFileSync(release, "");
      await done1;
    }
  });
}

test("a fallback lock left by a dead holder is broken, not waited on", { skip }, () => {
  const { root, sha } = fixture();
  const lock = path.join(root, ".git", "spor-land.lock.pid");
  const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  fs.symlinkSync(dead, lock);
  const r = spawnSync("bash", [LAND, "--repo", root, "--tip", "feature", "--lock-timeout", "1"],
    { encoding: "utf8", env: gitEnv({ TMPDIR: tmpBase, SPOR_LAND_LOCK: "mkdir" }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(sha("main"), sha("feature"));
  assert.throws(() => fs.lstatSync(lock), /ENOENT/, "the lock is released on exit");
});

test("a fallback lock held by a live process is waited on, not broken", { skip }, () => {
  const { root, sha } = fixture();
  const lock = path.join(root, ".git", "spor-land.lock.pid");
  fs.symlinkSync(String(process.pid), lock);
  const old = sha("main");
  const r = spawnSync("bash", [LAND, "--repo", root, "--tip", "feature", "--lock-timeout", "1"],
    { encoding: "utf8", env: gitEnv({ TMPDIR: tmpBase, SPOR_LAND_LOCK: "mkdir" }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^REFUSED reason=lock-timeout/);
  assert.equal(sha("main"), old);
  assert.equal(fs.readlinkSync(lock), String(process.pid), "a live holder's lock is left alone");
});

test("a background process a git hook leaves behind does not keep the land lock held", { skip }, () => {
  const { base, root, wt, g, sha } = fixture();
  const pidFile = path.join(base, "hook-daemon.pid");
  const hooks = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  // The "daemon" inherits whatever fds the hook had; it records its own pid so
  // the test stops exactly the process it started.
  fs.writeFileSync(path.join(hooks, "post-checkout"),
    `#!/bin/sh\n[ -e '${pidFile}' ] || { sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; }\nexit 0\n`, { mode: 0o755 });
  try {
    assert.equal(land(["--repo", root, "--tip", "feature"]).status, 0);
    assert.ok(fs.existsSync(pidFile), "the hook left its background process");
    fs.writeFileSync(path.join(wt, "e.txt"), "e\n");
    g(["add", "e.txt"], wt);
    g(["commit", "-q", "-m", "e"], wt);
    const r = land(["--repo", root, "--tip", sha("HEAD", wt), "--lock-timeout", "1"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^LANDED /);
  } finally {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
    if (pid) try { process.kill(pid); } catch {}
  }
});
