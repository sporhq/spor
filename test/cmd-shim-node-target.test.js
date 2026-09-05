"use strict";

// resolveCmdShimNodeTarget (bin/spor.js) is the fix for
// issue-spor-dispatch-bg-cmd-shim-truncates-multiline-prompt: on Windows,
// spawnPortableSync runs a `.cmd`/`.bat` launcher through cmd.exe, and
// cmd.exe ends the command line at the first newline in it — so a multi-line
// positional argument (the dispatch prompt) arrives at the wrapped program
// truncated to its first line. Most such shims are themselves nothing but a
// `node <script> %*` launcher, so parsing the shim's own text to recover that
// pair lets the caller spawn the real node executable directly instead —
// bypassing cmd.exe's re-tokenization entirely. This function does no
// platform gating itself (only its caller, spawnPortableSync, does), so it is
// exercised here on every platform.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveCmdShimNodeTarget } = require("../bin/spor.js");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-cmdshim-"));
}

test("resolveCmdShimNodeTarget: npm's cmd-shim template resolves to node.exe + the wrapped script", () => {
  const dir = scratch();
  const scriptDir = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, "cli.js");
  fs.writeFileSync(script, "// stub cli\n");
  const nodeExe = path.join(dir, "node.exe");
  fs.writeFileSync(nodeExe, "");
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /B",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    "",
    '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    "",
  ].join("\r\n"));

  const target = resolveCmdShimNodeTarget(shim);
  assert.ok(target, "matches the cmd-shim shape");
  assert.strictEqual(target.command, nodeExe, "prefers the sibling node.exe cmd-shim itself would have picked");
  assert.strictEqual(target.scriptPath, script);
});

test("resolveCmdShimNodeTarget: a test-harness-style stub (absolute node path, %~dp0 script) resolves directly", () => {
  const dir = scratch();
  const script = path.join(dir, "claude-bg-stub.js");
  fs.writeFileSync(script, "// stub\n");
  const nodeAbs = path.join(dir, "fake-node-bin");
  fs.writeFileSync(nodeAbs, "");
  const shim = path.join(dir, "claude-bg-stub.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"${nodeAbs}" "%~dp0claude-bg-stub.js" %*\r\nexit /b %errorlevel%\r\n`);

  const target = resolveCmdShimNodeTarget(shim);
  assert.ok(target, "matches the simple node-stub shape");
  assert.strictEqual(target.command, nodeAbs, "uses the absolute node path named in the shim, not a sibling/PATH lookup");
  assert.strictEqual(target.scriptPath, script);
});

test("resolveCmdShimNodeTarget: falls back to a PATH-resolved node when no sibling node.exe exists and the shim names bare `node`", () => {
  const dir = scratch();
  const scriptDir = path.join(dir, "node_modules", "somepkg");
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, "bin.js");
  fs.writeFileSync(script, "// stub\n");
  const shim = path.join(dir, "somepkg.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"node" "%~dp0node_modules\\somepkg\\bin.js" %*\r\n`);

  const target = resolveCmdShimNodeTarget(shim);
  assert.ok(target, "matches even with a bare `node` program token");
  assert.strictEqual(target.scriptPath, script);
  assert.ok(target.command, "falls back to a resolvable node command rather than throwing");
});

test("resolveCmdShimNodeTarget: this repo's own generated shims (bin/spor.cmd) name `node` UNQUOTED, ahead of the quoted script", () => {
  const dir = scratch();
  const script = path.join(dir, "spor.js");
  fs.writeFileSync(script, "// stub\n");
  const shim = path.join(dir, "spor.cmd");
  fs.writeFileSync(shim, [
    "@echo off",
    "where node >nul 2>nul || exit /b 0",
    'node "%~dp0spor.js" %*',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"));

  const target = resolveCmdShimNodeTarget(shim);
  assert.ok(target, "matches the bareword-`node` shape this repo's own .cmd wrappers use");
  assert.strictEqual(target.scriptPath, script);
  assert.ok(target.command, "falls back to a resolvable node command since `node` alone isn't a file on disk");
});

test("resolveCmdShimNodeTarget: an unrelated batch script (not a node launcher) is left alone", () => {
  const dir = scratch();
  const shim = path.join(dir, "custom.cmd");
  fs.writeFileSync(shim, "@echo off\r\necho hello world\r\n");
  assert.strictEqual(resolveCmdShimNodeTarget(shim), null);
});

test("resolveCmdShimNodeTarget: a shim naming a script that doesn't exist on disk is refused, not guessed at", () => {
  const dir = scratch();
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, '@echo off\r\n"node" "%~dp0node_modules\\missing\\cli.js" %*\r\n');
  assert.strictEqual(resolveCmdShimNodeTarget(shim), null, "the referenced script was never written, so this isn't the shape it looks like");
});

test("resolveCmdShimNodeTarget: a nonexistent shim path returns null instead of throwing", () => {
  assert.strictEqual(resolveCmdShimNodeTarget(path.join(os.tmpdir(), "spor-cmdshim-does-not-exist.cmd")), null);
});
