#!/usr/bin/env node
// stdio-echo — the reference execution provider for spor's subprocess binding
// (PROVIDERS.md §12). Zero dependencies; declare it on a machine with
//
//   "dispatch": { "provider": { "stdio-echo": {
//     "command": "node", "args": ["/abs/path/provider.js", "--root", "/abs/scratch"] } } }
//
// and check it with `spor provider check stdio-echo`. Each attempt "runs" in
// its own scratch directory under --root: a runner process (this file again,
// `--run <dir>`) commits the attempt spec to a fresh git repo there, and that
// commit is the candidate. It runs no harness and resolves no secret — it echoes.
// A real provider swaps the runner for `spor attempt run <bundle>` in its
// environment. An attempt whose prompt_bundle_ref has a `/hold/` segment keeps
// running until cancelled, so the conformance suite can exercise cancel.
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ID = "stdio-echo";
const now = () => new Date().toISOString();

if (process.argv[2] === "--run") runAttempt(process.argv[3]);
else serve();

// ---- the environment side: what `spor attempt run` would do, in miniature.
function runAttempt(dir) {
  const attempt = JSON.parse(fs.readFileSync(path.join(dir, "attempt.json"), "utf8"));
  if (/\/hold\//.test(attempt.prompt_bundle_ref)) {
    process.stdin.resume(); // hold until cancelled, or until the provider is gone
    process.stdin.on("end", () => process.exit(0));
    return;
  }
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "ATTEMPT.json"), `${JSON.stringify(attempt, null, 2)}\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: ID, GIT_AUTHOR_EMAIL: `${ID}@spor.invalid`, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  Object.assign(env, { GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_DATE: env.GIT_AUTHOR_DATE });
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: work, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", attempt.repos[0].branch);
  git("add", "ATTEMPT.json");
  git("commit", "-q", "-m", `echo ${attempt.attempt_id}`);
  const result = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
}

// ---- the provider side: one request line in, one response line out.
function serve() {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? process.argv[i + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "spor-stdio-echo-"));
  fs.mkdirSync(root, { recursive: true });
  const envs = new Map(); // handle id -> environment
  const byKey = new Map(); // idempotency key -> handle id
  const released = new Set();
  let seq = 0;

  class Refusal extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const find = ({ handle }) => {
    const env = handle && handle.provider === ID && envs.get(handle.id);
    if (!env) throw new Refusal("unknown_handle", `no environment ${JSON.stringify(handle)}`);
    return env;
  };
  const view = (e) => ({ state: e.state, since: e.since, ...(e.exit ? { exit: e.exit } : {}) });
  const settle = (e, state, exit) => Object.assign(e, { state, since: now(), ...(exit ? { exit } : {}) });

  const ops = {
    hello: (p) => {
      if (p.contract_version !== 1) throw new Refusal("contract_version_unsupported", `${ID} speaks contract_version 1`);
      return { contract_version: 1, provider_id: ID };
    },
    describe: () => ({
      provider_id: ID,
      contract_version: 1,
      capabilities: { harnesses: ["echo"], tools: ["git", "node"], repos: ["*"], egress: [], isolation: ["worktree"], secret_delivery: [], lifecycle: ["cancel", "force-cancel"], max_deadline_ms: 3600000 },
    }),
    submit: ({ attempt, idempotency_key: key }) => {
      const canon = JSON.stringify(attempt);
      if (byKey.has(key)) {
        const e = envs.get(byKey.get(key));
        if (e.canon !== canon) throw new Refusal("idempotency_conflict", `key ${key} was accepted for a different attempt`);
        return { handle: e.handle, accepted_at: e.accepted_at, existing: true };
      }
      const id = `echo-${process.pid}-${++seq}`;
      const dir = path.join(root, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "attempt.json"), canon);
      const e = { handle: { provider: ID, id }, canon, attempt, dir, accepted_at: now() };
      settle(e, "running");
      e.child = spawn(process.execPath, [__filename, "--run", dir], { stdio: ["pipe", "ignore", "inherit"] });
      e.child.on("exit", (code, signal) => {
        e.child = null;
        if (e.state === "running" || e.state === "stopping") settle(e, "finished", signal ? { signal } : { code });
      });
      envs.set(id, e);
      byKey.set(key, id);
      return { handle: e.handle, accepted_at: e.accepted_at, existing: false };
    },
    observe: (p) => view(find(p)),
    collect: (p) => {
      const e = find(p);
      const repo = e.attempt.repos[0];
      const file = path.join(e.dir, "result.json");
      if (e.state !== "finished" || !fs.existsSync(file)) return { manifest: null, no_candidate: { reason: `no candidate (environment ${e.state})` } };
      if (!repo.url) return { manifest: null, no_candidate: { reason: `repo ${repo.slug} has no url to publish the candidate to` } };
      const { commit, tree } = JSON.parse(fs.readFileSync(file, "utf8"));
      const reference = { kind: "branch", locator: repo.url, ref: `refs/heads/${repo.branch}`, commit };
      const { attempt_id, execution_id, fence } = e.attempt;
      return { manifest: { attempt_id, execution_id, fence, candidate: { repo: repo.slug, commit, tree, branch: repo.branch, reference } } };
    },
    cancel: (p) => {
      const e = find(p);
      if (["finished", "failed", "lost"].includes(e.state)) return { state: e.state };
      if (p.force) {
        settle(e, "finished", { signal: "SIGKILL" });
        if (e.child) e.child.kill("SIGKILL");
      } else {
        settle(e, "stopping");
        if (e.child) e.child.kill("SIGTERM");
      }
      return { state: e.state };
    },
    release: (p) => {
      if (p.handle && released.has(p.handle.id)) return { released: true };
      const e = find(p);
      if (e.child) e.child.kill("SIGKILL");
      fs.rmSync(e.dir, { recursive: true, force: true });
      envs.delete(e.handle.id);
      released.add(e.handle.id);
      return { released: true };
    },
  };

  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) answer(line);
    }
  });
  process.stdin.on("end", () => {
    for (const e of envs.values()) if (e.child) e.child.kill("SIGKILL");
    if (i < 0) fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });

  function answer(line) {
    let msg = {};
    let res;
    try {
      msg = JSON.parse(line);
      if (!ops[msg.op]) throw new Refusal("unsupported_operation", `${msg.op} is not implemented`);
      res = { id: msg.id, ok: true, result: ops[msg.op](msg.params || {}) };
    } catch (err) {
      res = { id: msg.id || "unknown", ok: false, error: { code: err.code || "internal", message: err.message, retryable: false } };
    }
    process.stdout.write(`${JSON.stringify(res)}\n`);
  }
}
