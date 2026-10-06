// PreToolUse engine (issue-spor-dispatch-worktree-absolute-path-bypass): the
// dispatch/delegation worktree isolation guard. A delegated agent's cwd-based
// isolation is a linked git worktree; this engine denies a
// Write/Edit/NotebookEdit or Bash `git commit`/`add`/`apply` whose resolved
// target (or effective working tree) lands in the shared main checkout
// instead of the session's own worktree.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const { gitEnv } = require("./helpers/git.js");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { hermeticEnv } = require("./helpers/env.js");
const os = require("node:os");
const path = require("node:path");
const { runHook } = require("./helpers/portable");
const pt = require("../scripts/engines/pre-tool.js");

function freshEnv(home) {
  const env = hermeticEnv({ SPOR_HOME: home });
  env.SPOR_ENABLED = "1"; // opt in (task-spor-plugin-opt-in-default)
  return env;
}

// A main repo plus a linked worktree NESTED under it at
// `.claude/worktrees/<name>` — the real dispatch layout (see this repo's own
// CLAUDE.md), and important for test fidelity: since the worktree lives
// INSIDE the main checkout's directory tree, a plain "is this under the main
// checkout" prefix test would also reject legitimate in-worktree writes, so
// this nesting is what actually exercises violatesIsolation's worktree-
// subtree exclusion (a sibling-directory worktree would pass every test
// trivially, even with that exclusion removed).
function scratchWorktree() {
  // Canonical (long-form) base: the engine answers with git's resolved
  // spelling, and os.tmpdir() is an 8.3 short name on the Windows CI runner.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "spor-pretool-")));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  const g = (args, cwd = main) => {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(["init", "-q"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "init"]);
  const wt = path.join(main, ".claude", "worktrees", "issue-under-test");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  g(["worktree", "add", "-q", wt, "-b", "wtbranch", "HEAD"]);
  return { base, main: fs.realpathSync(main), wt: fs.realpathSync(wt), g };
}

// ---------------------------------------------------------------------------
// Unit-level: the engine module directly.

test("detectWorktreeSession: null for a plain repo, null for a non-repo cwd", () => {
  const { base, main } = scratchWorktree();
  assert.equal(pt.detectWorktreeSession(main), null);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "spor-pretool-bare-"));
  assert.equal(pt.detectWorktreeSession(bare), null);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

test("detectWorktreeSession: identifies a linked worktree session and its main checkout", () => {
  const { base, main, wt } = scratchWorktree();
  const session = pt.detectWorktreeSession(wt);
  assert.ok(session);
  assert.equal(session.worktreeTop, wt);
  assert.equal(session.mainTop, main);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Write with an absolute path into the shared checkout is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Write",
    tool_input: { file_path: path.join(main, "f.txt"), content: "x" },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /shared checkout/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Edit/NotebookEdit of the same relative file inside the worktree passes through", async () => {
  const { base, wt } = scratchWorktree();
  const editOut = await pt.preTool({
    cwd: wt,
    tool_name: "Edit",
    tool_input: { file_path: "f.txt", old_string: "hi", new_string: "bye" },
  });
  assert.equal(editOut, null);
  const nbOut = await pt.preTool({
    cwd: wt,
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: path.join(wt, "nb.ipynb"), new_source: "1+1" },
  });
  assert.equal(nbOut, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: an absolute NotebookEdit path into the shared checkout is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: path.join(main, "nb.ipynb"), new_source: "1+1" },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a scratch/temp path outside both trees passes through unchanged", async () => {
  const { base, wt } = scratchWorktree();
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Write",
    tool_input: { file_path: path.join(os.tmpdir(), "spor-scratch-unrelated.txt"), content: "x" },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Bash `cd <main> && git commit` is denied, naming the worktree path", async () => {
  const { base, main, wt, g } = scratchWorktree();
  fs.writeFileSync(path.join(main, "g.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `cd ${main} && git add -A && git commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /worktree/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Bash `git --work-tree=<main> commit` is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "wt-flag.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `git --work-tree=${main} add -A && git --work-tree=${main} commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a subshell `(cd <main> && git commit ...)` is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "sub.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `(cd ${main} && git add -A && git commit -m x)` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `sh -c \"cd <main> && git commit ...\"` and `eval \"...\"` wrappers are denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "wrap1.txt"), "x");
  const shOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `sh -c "cd ${main} && git add -A && git commit -m x"` },
  });
  assert.ok(shOut);
  assert.equal(shOut.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(main, "wrap2.txt"), "x");
  const evalOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `eval "cd ${main} && git add -A && git commit -m x"` },
  });
  assert.ok(evalOut);
  assert.equal(evalOut.hookSpecificOutput.permissionDecision, "deny");

  // The same wrapper form used harmlessly inside the worktree still passes.
  fs.writeFileSync(path.join(wt, "wrap3.txt"), "x");
  const shOkOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `sh -c "git add -A && git commit -m x"` },
  });
  assert.equal(shOkOut, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `bash -lc \"...\"` (clustered short flags, -c not first) is denied; a harmless -lc inside the worktree passes", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "lc1.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `bash -lc "cd ${main} && git add -A && git commit -m x"` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(main, "lc2.txt"), "x");
  const zshOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `zsh -lc "cd ${main} && git commit -am x"` },
  });
  assert.ok(zshOut);
  assert.equal(zshOut.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(wt, "lc3.txt"), "x");
  const okOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `bash -lc "git add -A && git commit -m x"` },
  });
  assert.equal(okOut, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `GIT_WORK_TREE=<main> GIT_DIR=<main>/.git git commit` (env-var prefix) is denied; the same prefix inside the worktree passes", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "env1.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: {
      command: `GIT_WORK_TREE=${main} GIT_DIR=${main}/.git git add -A && GIT_WORK_TREE=${main} GIT_DIR=${main}/.git git commit -m x`,
    },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(wt, "env2.txt"), "x");
  const okOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `GIT_WORK_TREE=${wt} GIT_DIR=${wt}/.git git add -A && GIT_WORK_TREE=${wt} GIT_DIR=${wt}/.git git commit -m x` },
  });
  assert.equal(okOut, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `GIT_WORK_TREE=<main> git -C <worktree> commit` is denied (env GIT_WORK_TREE overrides -C, matching real git precedence)", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "prec1.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: {
      command: `GIT_WORK_TREE=${main} git -C ${wt} add -A && GIT_WORK_TREE=${main} git -C ${wt} commit -m x`,
    },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: an explicit --work-tree flag overrides a GIT_WORK_TREE env var pointed at the worktree itself (flag wins, matching real git)", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "prec2.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `GIT_WORK_TREE=${wt} git --work-tree=${main} -C ${wt} add -A && GIT_WORK_TREE=${wt} git --work-tree=${main} -C ${wt} commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `env GIT_WORK_TREE=<main> git commit` (explicit env wrapper) is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "envcmd.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `env GIT_WORK_TREE=${main} git add -A && env GIT_WORK_TREE=${main} git commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(wt, "envcmd2.txt"), "x");
  const okOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: "env FOO=bar git add -A && env FOO=bar git commit -m x" },
  });
  assert.equal(okOut, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a quoted commit message that merely looks like an env assignment (FOO=bar as the FIRST word) is not mis-parsed as a temp-env prefix", async () => {
  const { base, wt } = scratchWorktree();
  fs.writeFileSync(path.join(wt, "notenv.txt"), "x");
  // FOO=bar here is a real (harmless) shell env assignment with no command
  // after it in its own segment — must not throw or falsely deny.
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `FOO=bar && git add -A && git commit -m x` },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a single `&` background separator or `|` pipe still denies (not just `&&`/`||`)", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "amp.txt"), "x");
  const ampOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `cd ${main} & git commit -am x` },
  });
  assert.ok(ampOut);
  assert.equal(ampOut.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(main, "pipe.txt"), "x");
  const pipeOut = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `echo done | git -C ${main} commit -am x` },
  });
  assert.ok(pipeOut);
  assert.equal(pipeOut.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: `cd -- <main>` (end-of-options marker) and a no-space `&&` are still denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "dashdash.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `cd -- ${main} && git add -A && git commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(main, "nospace.txt"), "x");
  const out2 = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `cd ${main}&&git commit -am x` },
  });
  assert.ok(out2);
  assert.equal(out2.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a quoted commit message containing shell-operator characters is not mis-parsed", async () => {
  const { base, wt } = scratchWorktree();
  fs.writeFileSync(path.join(wt, "msg.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `git add -A && git commit -m "fix (bug) && cleanup; more"` },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Bash `git -C <main> commit` is denied", async () => {
  const { base, main, wt } = scratchWorktree();
  fs.writeFileSync(path.join(main, "h.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: `git -C ${main} add -A && git -C ${main} commit -m x` },
  });
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Bash git commit inside the worktree itself passes through", async () => {
  const { base, wt } = scratchWorktree();
  fs.writeFileSync(path.join(wt, "i.txt"), "x");
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: "git add -A && git commit -m x" },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: Bash commands unrelated to git pass through", async () => {
  const { base, wt } = scratchWorktree();
  const out = await pt.preTool({
    cwd: wt,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: pattern-based process kills are denied; PID/pgid kills pass", async () => {
  const { base, wt, main } = scratchWorktree();
  const run = (command, cwd = wt) => pt.preTool({ cwd, tool_name: "Bash", tool_input: { command } });
  for (const c of [
    'pkill -f "node --test"',
    "killall node",
    "sudo pkill node",
    "FOO=1 /usr/bin/pkill -9 node",
    "npm test; pkill -f x",
    'sh -c "pkill -f foo"',
    "kill $(pgrep -f node)",
    "kill -9 `pgrep node`",
    "pgrep -f node | xargs kill",
    "timeout 5 pkill x",
    "sudo -u foo pkill x",
    "env -i pkill x",
    "\\pkill x",
    "for i in 1; do pkill x; done",
    "kill $(pidof node)",
    'kill "$(pgrep node)"',
    'eval "kill $(pgrep node)"',
    "sh -c 'kill $(pgrep node)'",
    "pgrep x | while read p; do kill $p; done",
    "pgrep x | while read p\ndo kill $p\ndone",
    "pgrep x | while read p; do\n kill $p\ndone",
    'kill "`pgrep foo`"',
    "# don't\nkill $(pgrep foo)",
    "echo it's; kill $(pgrep foo)",
    "ps aux | grep x | awk '{print $2}' | xargs kill",
    "find . -exec sh -c 'pgrep x | xargs kill' \\;",
    "watch -n5 'pgrep -f node | xargs kill'",
    "flock /tmp/l -c 'pgrep x | xargs kill'",
    "su -c 'pgrep x | xargs kill'",
    "bash -c -- 'kill $(pgrep node)'",
    "watch 'pkill -f node'",
    "find . -exec pkill -f {} \\;",
    // issue-spor-kill-guard-structural-selector-to-kill-flow: selector->kill data
    // flow through process substitution, xargs-run shell bodies and wrappers.
    "xargs kill < <(pgrep node)",
    "while read p; do kill $p; done < <(pgrep node)",
    'pgrep node | xargs sh -c "kill $@" sh',
    'pgrep node | xargs -I{} sh -c "kill {}"',
    "pgrep node | xargs -I {} sh -c 'kill {}'",
    "watch pkill node",
    "flock f pkill node",
    "flock -w 5 /tmp/l pkill node",
    "nice -n 5 pkill node",
    "nohup pkill node",
    "timeout -s KILL 5 pkill node",
    "su -c 'pkill node' root",
    "runuser -u nobody -- pkill node",
    "env -S 'pkill node'",
    "busybox pkill node",
    "for p in $(pgrep node); do kill $p; done",
    "pids=$(pgrep node); kill $pids",
    "p=$(pgrep node) && sudo kill -9 \"$p\"",
    "read -r p < <(pgrep node); kill $p",
    "mapfile -t ps < <(pgrep node); kill \"${ps[@]}\"",
    "pgrep node > >(xargs kill)",
    "pgrep node | tee >(xargs kill)",
    "xargs -a <(pgrep node) kill",
    "parallel kill ::: $(pgrep node)",
    "kill $(pgrep node | head -1)",
    "kill $(echo $(pgrep node))",
    "pgrep node | grep -v 1 | xargs -n1 kill",
    "{ xargs kill; } < <(pgrep node)",
    "xargs kill <<< \"$(pgrep node)\"",
    "xargs kill <<EOF\n$(pgrep node)\nEOF",
    "bash <<EOF\npkill node\nEOF",
    "pgrep node | sh -c 'xargs kill'",
    "find . -exec sh -c 'kill $(pgrep x)' \\;",
    "(pgrep node | xargs kill)",
    "if true; then pgrep node | xargs kill; fi",
    "f() { pkill node; }; f",
    "case x in x) pkill node;; esac",
    "pgrep node |\nxargs kill",
    "ps -eo pid,cmd | awk '/node/{print $1}' | xargs kill",
    'p="$(pgrep foo)"; kill $p',
    "ps -eopid,args | grep node | awk '{print $1}' | xargs kill",
    "ps aux --sort -pcpu | grep node | awk '{print $2}' | xargs kill",
    // Operator decision (2026-10-06): ANSI-C quoting, coproc and dynamic
    // bodies — the parser must not let through what main's raw check denied.
    String.raw`echo $'\'' ; pkill node`,
    String.raw`$'pkill' node`,
    String.raw`$'\x70kill' -f node`,
    "echo $'it\\'s'; pkill node",
    "coproc pkill node",
    "coproc X { pkill node; }",
    "coproc kill $(pgrep node)",
    'cmd="pkill node"; bash -c "$cmd"',
    "eval \"$(echo 'pkill node')\"",
    "c='pkill -f node'; eval \"$c\"",
    "$(echo 'pkill node')",
    "echo 'pkill node' | sh",
    "source <(echo 'pkill node')",
    "x=kill; $x $(pgrep node)",
    "echo 'pkill node' | xargs -I{} sh -c {}",
    "echo 'pkill -f x' | xargs sh -c",
    // ... and fails CLOSED on kill input it cannot parse cleanly.
    "kill $(pgrep node",
    "for p in 1; do pkill x",
    'echo "kill $(pgrep x)',
    "pgrep x | xargs kill '",
    "kill `pgrep x",
    // The raw backstop: pkill/killall anywhere, or kill + a selector, outside
    // the (literal) argument of a known data command, is denied.
    'git commit -m "avoid kill $(pgrep x)"', // the $(…) runs: not data
    "pgrep x | while read p; do echo $p; done; kill 4242",
    "cat > n.md <<EOF\npkill -f x\nEOF",
    "gh issue create --body 'pgrep x | xargs kill'",
    "man pkill",
    "command -v pkill",
    'node --test --test-name-pattern "pkill denied" x.test.js',
    "pids=$(pgrep node); echo $pids; kill 4242",
    "pgrep node >/dev/null && kill 4242",
  ]) {
    const out = await run(c);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", c);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /process guard/, c);
  }
  for (const c of [
    "kill -- -12345",
    "kill 4242",
    "pgrep -f node",
    'git commit -m "pkill is banned"',
    "echo 'pkill'",
    "echo 'kill $(pgrep node)'",
    "git commit -m 'avoid kill $(pgrep x)'",
    "git commit -am 'avoid pkill -f'",
    "git commit --message='pkill is banned'",
    "git commit -m \"$(cat <<'EOF'\nfix: deny pkill and kill $(pgrep x)\nEOF\n)\"",
    "git log -S'pkill' --oneline",
    "grep -rn 'pkill\\|kill $(pgrep' scripts",
    "grep -e 'killall' -e 'pkill' -r .",
    "echo $'pkill is banned'",
    "printf '%s\\n' 'pkill -f node'",
    "git log --grep='pgrep x | xargs kill'",
    "docker ps -q | xargs docker kill",
    "grep -n 'kill $(pgrep' f",
    "kill -- -\"$(cat f.pgid)\"",
    "kill \"$(cat app.pid)\"",
    "kill -- -$(ps -o pgid= -p 4242 | tr -d ' ')",
    "pgrep -f node | wc -l",
    "docker kill $(docker ps -q)",
    "echo 'xargs kill < <(pgrep node)'",
    'git commit -m "fix: while read p; do kill $p; done < <(pgrep x)"',
    "cat <<'EOF' | sh -c 'cat >notes.md'\npgrep x | xargs kill\nEOF",
    'printf "%s\\n" "pgrep node | xargs sh -c \'kill $@\'"',
    "systemctl kill foo.service",
    "kill $( cat app.pid )",
    "kill $(cat app.pid; )",
    "kill -- -\"$(\n  cat f.pgid\n  )\"",
    "arr=( $(cat pids) ); kill \"${arr[@]}\"",
    "local -a p=( 1 ); kill 1",
    "bash -c 'kill $( cat app.pid )'",
    "grep -R pkill .",
    "grep -rn killall scripts",
    "git log --grep=pkill",
    "git log -Spkill --oneline",
    "git commit -m pkill",
    "git commit --message=pkill",
    "echo pkill",
    "printf pkill",
  ])
    assert.equal(await run(c), null, c);
  // Unquoted data words stay denied wherever the word is EXECUTED or expands.
  for (const c of [
    "echo pkill; pkill node",
    "echo $(pkill node)",
    "echo `pkill node`",
    "echo pkill && pkill -f x",
    "grep foo pkill",
    "grep -R foo . | xargs pkill",
    "git log --grep=x; pkill node",
    "echo $(echo pkill) | sh",
    "shopt -s expand_aliases\nalias echo=\necho pkill -f zzz",
  ])
    assert.equal((await run(c))?.hookSpecificOutput?.permissionDecision, "deny", c);
  assert.equal(await run("pkill node", main), null, "non-worktree session is a no-op");
  fs.rmSync(base, { recursive: true, force: true });
});

test("preTool: a non-worktree session (plain repo cwd) never denies, even for the same file", async () => {
  const { base, main } = scratchWorktree();
  const out = await pt.preTool({
    cwd: main,
    tool_name: "Write",
    tool_input: { file_path: path.join(main, "f.txt"), content: "x" },
  });
  assert.equal(out, null);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Integration: through the real dispatcher (bin/spor-hook pre-tool), the full
// host envelope contract.

test("dispatcher: pre-tool denies an absolute-path Edit into the shared checkout, and byte-identically no-ops outside a worktree session", () => {
  const { base, main, wt } = scratchWorktree();
  const home = path.join(base, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });

  const denied = runHook(
    ["pre-tool", "--host", "claude-code"],
    JSON.stringify({
      cwd: wt,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(main, "f.txt"), old_string: "hi", new_string: "bye" },
    }),
    freshEnv(home)
  );
  assert.strictEqual(denied.status, 0, denied.stderr);
  const json = JSON.parse(denied.stdout);
  assert.strictEqual(json.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.strictEqual(json.hookSpecificOutput.permissionDecision, "deny");

  // The identical relative edit, resolved inside the worktree, produces no
  // output at all (fail-open contract: nothing to say means silence).
  const allowed = runHook(
    ["pre-tool", "--host", "claude-code"],
    JSON.stringify({
      cwd: wt,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "f.txt", old_string: "hi", new_string: "bye" },
    }),
    freshEnv(home)
  );
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  assert.strictEqual(allowed.stdout, "");

  // A non-worktree session touching the very same absolute path sees zero
  // behavioral change from before this engine existed.
  const nonWorktree = runHook(
    ["pre-tool", "--host", "claude-code"],
    JSON.stringify({
      cwd: main,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(main, "f.txt"), old_string: "hi", new_string: "bye" },
    }),
    freshEnv(home)
  );
  assert.strictEqual(nonWorktree.status, 0, nonWorktree.stderr);
  assert.strictEqual(nonWorktree.stdout, "");

  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatcher: pre-tool denies a Bash git commit that resolves to the shared checkout", () => {
  const { base, main, wt } = scratchWorktree();
  const home = path.join(base, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(main, "j.txt"), "x");

  const denied = runHook(
    ["pre-tool", "--host", "claude-code"],
    JSON.stringify({
      cwd: wt,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `cd ${main} && git add -A && git commit -m x` },
    }),
    freshEnv(home)
  );
  assert.strictEqual(denied.status, 0, denied.stderr);
  const json = JSON.parse(denied.stdout);
  assert.strictEqual(json.hookSpecificOutput.permissionDecision, "deny");

  fs.writeFileSync(path.join(wt, "k.txt"), "x");
  const allowed = runHook(
    ["pre-tool", "--host", "claude-code"],
    JSON.stringify({
      cwd: wt,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git add -A && git commit -m x" },
    }),
    freshEnv(home)
  );
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  assert.strictEqual(allowed.stdout, "");

  fs.rmSync(base, { recursive: true, force: true });
});

test("shell-ast: parsing never throws and always terminates on malformed input", () => {
  const { parse } = require("../scripts/engines/shell-ast");
  const alphabet = ["(", ")", "$(", "<(", ">(", "`", "'", '"', "\\", "{", "}", ";", ";;", "|", "&", "\n", "<<", "EOF", "<<<", "if", "then", "fi", "do", "done", "case", "esac", "for", "in", "while", "kill", "pgrep", " ", "x=(", "${"];
  let seed = 42;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let k = 0; k < 2000; k++) {
    let src = "";
    for (let n = rand(30); n > 0; n--) src += alphabet[rand(alphabet.length)];
    const ast = parse(src);
    assert.equal(ast.type, "list", JSON.stringify(src));
    pt.scanBashForPatternKill(src);
  }
  for (const open of ["(", "{ ", "if a; then ", "while a; do ", "a=(", "f() ", "$(", "<("])
    assert.equal(parse(open.repeat(5000) + "x").type, "list", `deep ${open}`);
});

test("shell-ast: records the recoveries it made, and decodes ANSI-C quoting", () => {
  const { parse } = require("../scripts/engines/shell-ast");
  for (const ok of ["for p in 1 2; do echo $p; done", "case x in a|b) echo;; esac", "x $(( (a+b) * 2 ))", "cat <<'EOF'\nhi\nEOF", "echo $'a\\'b'"])
    assert.deepEqual(parse(ok).errors, [], ok);
  for (const bad of ["echo 'x", 'echo "x', "echo `x", "echo $(x", "for p in 1; do echo", "if a; then b", "{ a;", "( a", "cat <<EOF\nx", "echo $'x", "echo ${x"])
    assert.ok(parse(bad).errors.length, bad);
  const w = parse("echo $'\\x70kill' \"a $b c\"").items[0].stages[0].words;
  assert.equal(w[1].text, "pkill");
  assert.equal(w[2].expands, true);
  assert.deepEqual(w[2].qspans, [[18, 20], [22, 24]]);
});
