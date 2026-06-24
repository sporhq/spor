"use strict";

const fs = require("node:fs");
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
};
