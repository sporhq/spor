"use strict";
// The attempt bundle and `spor attempt build|run` (task-spor-attempt-bundle-run,
// PROVIDERS.md §13): the portable bundle a provider ships into its environment,
// and the in-environment runner that executes it with the unchanged harness
// adapters, streaming observe-result status lines and leaving a result
// manifest whose candidate it published honestly.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { gitEnv } = require("./helpers/git.js");
const { hermeticEnv } = require("./helpers/env.js");
const { writeSpawnableNodeStub } = require("./helpers/portable");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "spor.js");
const pc = require("../lib/kernel/provider-contract.js");
const bundleLib = require("../lib/shell/attempt-bundle.js");
const executionStore = require("../lib/shell/execution-store.js");

const REMOTE_URL = "https://git.attempt.invalid/demo.git";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...gitEnv(), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A scratch graph home holding the item and a factory, a repo `demo` mapped to
// it whose origin is an https URL, and a bare repo that URL is rewritten onto
// (only in the RUNNER's environment, through GIT_CONFIG_GLOBAL — the build
// must see the https URL to pin it). Opens a local execution for the item.
async function fixture() {
  const home = tmp("spor-attempt-home-");
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes);
  fs.writeFileSync(path.join(nodes, "task-attempt-demo.md"),
    "---\nid: task-attempt-demo\ntype: task\nrepo: demo\ntitle: Demo attempt task\nsummary: A fixture task the attempt bundle round trip runs.\nstatus: open\ndate: 2026-10-09\n---\nAdd a file.\n");
  const payload = { gates: [{ id: "noop", kind: "command", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` }] };
  fs.writeFileSync(path.join(nodes, "factory-demo.md"),
    `---\nid: factory-demo\ntype: factory\ntitle: The demo factory\nsummary: The pipeline the attempt fixture names.\nstatus: active\ndate: 2026-10-09\n---\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`);
  const repo = tmp("spor-attempt-demo-");
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, ".spor"), "project: demo\n");
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "root"]);
  git(repo, ["remote", "add", "origin", REMOTE_URL]);
  const bare = tmp("spor-attempt-origin-");
  git(bare, ["init", "-q", "--bare"]);
  git(repo, ["push", "-q", bare, "main"]);
  const gitconfig = path.join(home, "runner.gitconfig");
  fs.writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = ${REMOTE_URL}\n`);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { repos: { demo: repo } } }));
  const store = executionStore.localExecutionEngine({ home, tenant: "local", worker: "worker-a", instance: "inst-a" });
  const opened = await store.open({ node_id: "task-attempt-demo", factory: "factory-demo", boundary: "gates" });
  assert.ok(opened.ok, JSON.stringify(opened));
  // The stub harness: commits a file in its cwd (the pinned checkout) and
  // reports through the claude stream-json result event.
  const stub = writeSpawnableNodeStub(home, "claude-attempt", `
    const { spawnSync } = require("child_process");
    const fs = require("fs");
    let prompt = "";
    process.stdin.on("data", (c) => (prompt += c));
    process.stdin.on("end", () => {
      fs.writeFileSync("ADDED.txt", "from the stub\\n");
      const g = (...a) => spawnSync("git", ["-c", "user.name=Stub", "-c", "user.email=stub@example.com", ...a], { stdio: "ignore" }).status;
      if (g("add", "ADDED.txt") || g("commit", "-q", "-m", "stub work")) process.exit(3);
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-attempt" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "result", result: "did the work; prompt had " + prompt.length + " bytes" }) + "\\n");
      process.exit(0);
    });
  `);
  return { home, repo, bare, gitconfig, stub, execution: opened.execution };
}

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: hermeticEnv({ XDG_CONFIG_HOME: env.SPOR_HOME, ...env }), cwd, timeout: 240000 });
}

function statusLines(stdout) {
  return stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("round trip: attempt build, then attempt run with a stub harness, yields a run record, a report and a manifest naming the stub's commit", async () => {
  const f = await fixture();
  const out = path.join(f.home, "bundle");
  const b = cli(["attempt", "build", f.execution.execution_id, "--out", out, "--no-brief", "--permission-mode", "bypassPermissions", "--json"], { SPOR_HOME: f.home }, f.repo);
  assert.strictEqual(b.status, 0, b.stdout + b.stderr);
  const built = JSON.parse(b.stdout);
  assert.deepStrictEqual(built.files.sort(), ["attempt.json", "env.json", "prompt/prompt.md", "prompt/session.md", "prompt/task.md", "repos.json"].sort());
  const attempt = JSON.parse(fs.readFileSync(path.join(out, "attempt.json"), "utf8"));
  assert.ok(pc.validate("attempt-spec", attempt).ok, JSON.stringify(pc.validate("attempt-spec", attempt).errors));
  assert.strictEqual(attempt.execution_id, f.execution.execution_id);
  assert.strictEqual(attempt.attempt_id, "inst-a");
  assert.strictEqual(attempt.fence, f.execution.owner.fence);
  assert.strictEqual(attempt.node_id, "task-attempt-demo");
  assert.strictEqual(attempt.harness.id, "claude-code");
  assert.deepStrictEqual(attempt.repos, [{ slug: "demo", commit: git(f.repo, ["rev-parse", "HEAD"]), branch: "spor/task-attempt-demo", url: REMOTE_URL }]);
  assert.deepStrictEqual(attempt.secrets, []);
  assert.match(attempt.spor.server, /^file:\/\//);
  const prompt = fs.readFileSync(path.join(out, "prompt", "prompt.md"), "utf8");
  assert.match(prompt, /task-attempt-demo/);
  assert.match(prompt, /CANDIDATE|commit/i, "the worker contract rides the prompt");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, "env.json"), "utf8")), { harness: { permission_mode: "bypassPermissions" } });

  const runEnv = { SPOR_HOME: f.home, SPOR_CLAUDE_CMD: f.stub, GIT_CONFIG_GLOBAL: f.gitconfig };
  const r = cli(["attempt", "run", out], runEnv, f.home);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const lines = statusLines(r.stdout);
  const statuses = lines.filter((l) => l.kind === "status");
  for (const s of statuses) assert.ok(pc.validate("observe-result", s).ok, `${JSON.stringify(s)}: ${pc.validate("observe-result", s).errors}`);
  for (let i = 1; i < statuses.length; i++) {
    assert.ok(pc.observeTransitionAllowed(statuses[i - 1].state, statuses[i].state), `${statuses[i - 1].state} -> ${statuses[i].state}`);
  }
  assert.deepStrictEqual([...new Set(statuses.map((s) => s.state))].filter((s) => s !== "provisioning"), ["pending", "running", "stopping", "finished"]);
  const fin = statuses[statuses.length - 1];
  assert.deepStrictEqual(fin.exit, { code: 0 });
  assert.ok(fin.run_id, "the status names the run");

  const result = lines[lines.length - 1];
  assert.strictEqual(result.kind, "result");
  const { kind, ...collect } = result;
  assert.ok(pc.validate("collect-result", collect).ok, JSON.stringify(pc.validate("collect-result", collect).errors));
  const stubCommit = git(f.bare, ["rev-parse", "refs/heads/spor/task-attempt-demo"]);
  assert.strictEqual(git(f.bare, ["log", "-1", "--format=%s", stubCommit]), "stub work");
  assert.strictEqual(collect.manifest.candidate.commit, stubCommit, "the manifest names the stub's commit, published to the url");
  assert.deepStrictEqual(collect.manifest.candidate.reference, { kind: "branch", locator: REMOTE_URL, ref: "refs/heads/spor/task-attempt-demo", commit: stubCommit });
  assert.strictEqual(collect.manifest.attempt_id, "inst-a");
  // On disk: the manifest, the report, the log, the status stream, and the run record.
  const res = path.join(f.home, "result");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(res, "manifest.json"), "utf8")), collect);
  assert.match(fs.readFileSync(path.join(res, "report.md"), "utf8"), /did the work/);
  assert.ok(collect.manifest.report_ref.startsWith("file://"));
  const rec = JSON.parse(fs.readFileSync(path.join(f.home, "journal", "dispatch", `${fin.run_id}.run.json`), "utf8"));
  assert.strictEqual(rec.state, "done");
  assert.strictEqual(rec.execution_id, f.execution.execution_id);
  assert.strictEqual(rec.cwd, path.join(f.home, "work", "demo"));
});

test("a tarball bundle round-trips byte-for-byte through readBundle", async () => {
  const f = await fixture();
  const tarPath = path.join(f.home, "attempt.tar");
  const b = cli(["attempt", "build", f.execution.execution_id, "--out", tarPath, "--no-brief"], { SPOR_HOME: f.home }, f.repo);
  assert.strictEqual(b.status, 0, b.stdout + b.stderr);
  const read = bundleLib.readBundle(tarPath);
  assert.ok(read.ok, JSON.stringify(read.errors));
  const v = bundleLib.verifyBundle(read.bundle, { raw: read.raw, env: {} });
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(read.bundle.attempt.execution_id, f.execution.execution_id);
});

function goodBundle(over = {}) {
  const attempt = {
    contract_version: 1, attempt_id: "inst-a", execution_id: `exec-${"a".repeat(16)}`, fence: 1, tenant: "local", node_id: "task-x",
    harness: { id: "claude-code" }, mcp: [], skills: [], plugins: [], tools: ["git"],
    repos: [{ slug: "demo", commit: "b".repeat(40), branch: "spor/task-x", url: REMOTE_URL }],
    egress: { allow: [] }, secrets: [], spor: { server: "https://api.spor.invalid", token_ref: "spor-attempt-token://x/1" },
    deadline: "2030-01-01T00:00:00Z", isolation: "container", prompt_bundle_ref: bundleLib.IN_BUNDLE_PROMPT_REF,
    ...over,
  };
  return bundleLib.createBundle({ attempt, prompt: "do the thing" });
}

test("verifyBundle refuses a bundle carrying a plaintext secret value, naming where and never echoing it", () => {
  assert.deepStrictEqual(bundleLib.verifyBundle(goodBundle(), { env: {} }).errors, []);
  const token = "ghp_" + "Z".repeat(36);
  const cases = [
    goodBundle({ secrets: [{ name: "GITHUB_TOKEN", ref: "vault://x/gh", value: token }] }),
    goodBundle({ secrets: [{ name: "GITHUB_TOKEN", ref: token }] }),
    goodBundle({ spor: { server: "https://api.spor.invalid", token_ref: "spor-attempt-token://x/1", token: "opaque-but-a-value" } }),
    { ...goodBundle(), env: { env: { GITHUB_TOKEN: "anything" } } },
    { ...goodBundle(), env: { env: { HARMLESS: token } } },
    bundleLib.createBundle({ attempt: goodBundle().attempt, prompt: `use ${token} to push` }),
  ];
  for (const b of cases) {
    const v = bundleLib.verifyBundle(b, { env: {} });
    assert.strictEqual(v.ok, false, JSON.stringify(b));
    assert.strictEqual(v.secret, true, v.errors.join("; "));
    assert.ok(!v.errors.join(" ").includes(token), "the refusal never echoes the value");
  }
  // A value this process holds as its own Spor credential is a leak too.
  const held = "spor-tok-1234567890";
  const leaking = bundleLib.createBundle({ attempt: goodBundle().attempt, prompt: `token ${held}` });
  assert.strictEqual(bundleLib.verifyBundle(leaking, { env: { SPOR_TOKEN: held } }).secret, true);
});

test("attempt run refuses a bundle carrying a secret before anything is checked out or launched", async () => {
  const home = tmp("spor-attempt-secret-");
  const bundle = goodBundle({ secrets: [{ name: "GITHUB_TOKEN", ref: "vault://x/gh", value: "plaintext" }] });
  bundleLib.writeBundle(bundle, path.join(home, "b"));
  const r = cli(["attempt", "run", path.join(home, "b")], { SPOR_HOME: home }, home);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const lines = statusLines(r.stdout);
  assert.deepStrictEqual(lines.map((l) => l.kind === "status" ? l.state : l.kind), ["failed", "result"]);
  assert.match(lines[0].detail, /carries a secret value/);
  assert.ok(pc.validate("observe-result", lines[0]).ok);
  assert.strictEqual(lines[1].manifest, null);
  assert.ok(!fs.existsSync(path.join(home, "work")), "nothing was checked out");
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "nothing was launched");
});

test("attempt run fails before launch, with the reason, when a repo cannot be checked out at its pinned commit", async () => {
  const f = await fixture();
  const out = path.join(f.home, "bundle");
  assert.strictEqual(cli(["attempt", "build", f.execution.execution_id, "--out", out, "--no-brief"], { SPOR_HOME: f.home }, f.repo).status, 0);
  // Pin a commit the origin never received.
  fs.writeFileSync(path.join(f.repo, "g.txt"), "unpushed\n");
  git(f.repo, ["add", "g.txt"]);
  git(f.repo, ["commit", "-q", "-m", "local only"]);
  const unpushed = git(f.repo, ["rev-parse", "HEAD"]);
  for (const name of ["attempt.json", "repos.json"]) {
    const file = path.join(out, name);
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    v.repos[0].commit = unpushed;
    fs.writeFileSync(file, JSON.stringify(v));
  }
  const r = cli(["attempt", "run", out], { SPOR_HOME: f.home, SPOR_CLAUDE_CMD: f.stub, GIT_CONFIG_GLOBAL: f.gitconfig }, f.home);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const lines = statusLines(r.stdout);
  const failed = lines.find((l) => l.state === "failed");
  assert.match(failed.detail, new RegExp(`repo 'demo' cannot be checked out at the pinned commit ${unpushed.slice(0, 12)}: .*does not hold that commit`));
  assert.deepStrictEqual(lines.filter((l) => l.kind === "status").map((l) => l.state), ["pending", "provisioning", "failed"]);
  assert.ok(!fs.existsSync(path.join(f.home, "journal", "dispatch")), "nothing was launched");
  assert.match(lines[lines.length - 1].no_candidate.reason, /cannot be checked out/);
});

test("verifyBundle refuses pins that disagree with the attempt and unknown settings", () => {
  const b = goodBundle();
  b.repos.repos[0].commit = "c".repeat(40);
  assert.match(bundleLib.verifyBundle(b, { env: {} }).errors.join("; "), /disagrees with attempt\.json's pin/);
  const s = { ...goodBundle(), env: { harness: { permission_mode: "plan", command: "rm -rf /" } } };
  assert.match(bundleLib.verifyBundle(s, { env: {} }).errors.join("; "), /env\.json harness: unknown key 'command'/);
});

test("attempt run: a SIGTERM winds the run down through stopping, and the exit mirrors the absent manifest", async () => {
  const f = await fixture();
  const out = path.join(f.home, "bundle");
  assert.strictEqual(cli(["attempt", "build", f.execution.execution_id, "--out", out, "--no-brief"], { SPOR_HOME: f.home }, f.repo).status, 0);
  const hold = writeSpawnableNodeStub(f.home, "claude-hold", "setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [CLI, "attempt", "run", out], { env: hermeticEnv({ SPOR_HOME: f.home, XDG_CONFIG_HOME: f.home, SPOR_CLAUDE_CMD: hold, GIT_CONFIG_GLOBAL: f.gitconfig }), cwd: f.home });
  let stdout = "";
  let signalled = false;
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", (c) => {
    stdout += c;
    if (!signalled && /"state":"running"/.test(stdout)) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  assert.ok(signalled, stdout + stderr);
  assert.strictEqual(code, 1, stdout);
  const lines = statusLines(stdout);
  const states = lines.filter((l) => l.kind === "status").map((l) => l.state);
  assert.ok(states.includes("stopping"), states.join(","));
  assert.strictEqual(states[states.length - 1], "finished");
  assert.strictEqual(lines[lines.length - 1].manifest, null);
  assert.match(lines[lines.length - 1].no_candidate.reason, /still the attempt's base commit/);
});
