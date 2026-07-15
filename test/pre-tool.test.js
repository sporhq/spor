// PreToolUse engine (issue-spor-dispatch-worktree-absolute-path-bypass): the
// dispatch/delegation worktree isolation guard. A delegated agent's cwd-based
// isolation is a linked git worktree; this engine denies a
// Write/Edit/NotebookEdit or Bash `git commit`/`add`/`apply` whose resolved
// target (or effective working tree) lands in the shared main checkout
// instead of the session's own worktree.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runHook } = require("./helpers/portable");
const pt = require("../scripts/engines/pre-tool.js");

function freshEnv(home) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("SUBSTRATE_")) delete env[k];
    if (k.startsWith("SPOR_") && k !== "SPOR_HOME") delete env[k];
  }
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-pretool-"));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  const g = (args, cwd = main) => {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
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
