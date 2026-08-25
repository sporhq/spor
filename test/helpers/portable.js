"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const HOOK_JS = path.join(ROOT, "bin", "spor-hook.js");

function runHook(args, input, env, opts = {}) {
  return spawnSync(process.execPath, [HOOK_JS, ...args], {
    input,
    env,
    encoding: "utf8",
    ...opts,
  });
}

function spawnHook(args, input, env, opts = {}) {
  const stdio = opts.stdio || ["pipe", "pipe", "ignore"];
  const child = spawn(process.execPath, [HOOK_JS, ...args], {
    env,
    cwd: opts.cwd,
    stdio,
  });
  if (input !== undefined && child.stdin) child.stdin.end(input);
  return child;
}

function writeNodeScript(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body.replace(/\r\n/g, "\n")}\n`);
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* Windows does not need executable bits. */
  }
  return file;
}

function nodeCommand(file) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

function writeSpawnableNodeStub(dir, name, body) {
  const js = writeNodeScript(path.join(dir, `${name}.js`), body);
  if (process.platform !== "win32") return js;
  const cmd = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\nexit /b %errorlevel%\r\n`);
  return cmd;
}

function writeFakePathBin(dir, name, body = "") {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const f = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(f, `@echo off\r\n${body || "echo stub"}\r\n`);
    return f;
  }
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body || "echo stub"}\n`);
  try {
    fs.chmodSync(f, 0o755);
  } catch {}
  return f;
}

function pathWithOnlyGit() {
  const u = require(path.join(ROOT, "scripts", "engines", "util.js"));
  const git = u.whichSync("git");
  return git ? path.dirname(git) : process.env.PATH || "";
}

// PATH for tests that must hide every real launcher from resolution while
// still letting a `#!/usr/bin/env node` stub execute: git's dir plus a
// scratch dir holding ONLY a `node` link to the running interpreter. Needed
// because pathWithOnlyGit() alone is environment-dependent — on a dev box
// node often sits beside git in /usr/bin so shebangs resolve anyway, but on
// the CI runner node lives in the hostedtoolcache dir and a detached stub
// dies instantly (issue-spor-dispatch-test-ci-node-shebang-path). On Windows
// the stubs are .cmd wrappers naming process.execPath absolutely, so the
// node entry is unnecessary but harmless.
function pathWithOnlyGitAndNode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-nodebin-"));
  const target = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
  try {
    fs.symlinkSync(process.execPath, target);
  } catch {
    try {
      fs.copyFileSync(process.execPath, target);
      fs.chmodSync(target, 0o755);
    } catch {
      /* fall through — callers get git-only PATH, same as before */
    }
  }
  return `${pathWithOnlyGit()}${path.delimiter}${dir}`;
}

module.exports = {
  ROOT,
  HOOK_JS,
  runHook,
  spawnHook,
  writeNodeScript,
  nodeCommand,
  writeSpawnableNodeStub,
  writeFakePathBin,
  pathWithOnlyGit,
  pathWithOnlyGitAndNode,
};
