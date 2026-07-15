// `spor check` — the coupling-drift report over a diff
// (task-spor-cli-check-coupling-verb, dec-spor-coupling-norms-declared-first).
// Two layers:
//   1. the kernel/façade (lib/check.js runCheck) — trigger-touched /
//      target-untouched partitioning, cross-repo reminders, and the
//      couples_value_a/b value invariant (agree suppresses, disagree reports,
//      unreadable degrades);
//   2. the CLI arm (bin/spor.js check) — change-set resolution over a real
//      scratch git repo (default / --staged / --files / --range), --strict
//      exit codes, --json shape, and the remote arm over a stub /v1/export.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");

const { runCheck, renderReport } = require("../lib/check.js");
const { exportNodesDir } = require("../lib/tar.js");
const CLI = path.join(__dirname, "..", "bin", "spor.js");

const NORM = (extra = {}) => ({
  id: "norm-x", type: "norm", title: "X couples",
  couples_when: ["src/**"], couples_also: ["API.md"],
  ...extra,
});

// ---------- kernel: runCheck ----------

test("runCheck: trigger touched + target untouched -> untouched finding; touched target -> clean", () => {
  const norms = [NORM()];
  const hit = runCheck({ slug: "projx", changed: ["src/a.js"], norms });
  assert.equal(hit.findings.length, 1);
  assert.equal(hit.findings[0].kind, "untouched");
  assert.deepEqual(hit.findings[0].triggered, ["src/a.js"]);
  assert.deepEqual(hit.findings[0].untouched, ["API.md"]);
  const clean = runCheck({ slug: "projx", changed: ["src/a.js", "API.md"], norms });
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.checked, 1);
});

test("runCheck: no trigger hit -> nothing; foreign-scoped norm -> nothing", () => {
  assert.deepEqual(runCheck({ slug: "projx", changed: ["docs/a.md"], norms: [NORM()] }).findings, []);
  assert.deepEqual(
    runCheck({ slug: "projx", changed: ["src/a.js"], norms: [NORM({ project: "other" })] }).findings,
    []
  );
});

test("runCheck: declared coupling.aliases recover the reverse symlink-alias gap for BOTH triggers and targets (issue-spor-coupling-matcher-reverse-symlink-gap)", () => {
  const aliases = { frontend: "packages/web" };
  // trigger side: the norm's glob is authored against the alias, but the
  // change set (as `git diff --name-only` always reports it) only ever
  // carries the canonical, git-tracked spelling.
  const triggerNorm = NORM({ couples_when: ["frontend/**"], couples_also: ["API.md"] });
  const noAlias = runCheck({ slug: "projx", changed: ["packages/web/app.js"], norms: [triggerNorm] });
  assert.deepEqual(noAlias.findings, [], "undeclared alias: the documented limitation stands, no trigger hit");
  const withAlias = runCheck({
    slug: "projx", changed: ["packages/web/app.js"], norms: [triggerNorm], aliases,
  });
  assert.equal(withAlias.findings.length, 1);
  assert.equal(withAlias.findings[0].kind, "untouched");
  assert.deepEqual(withAlias.findings[0].triggered, ["packages/web/app.js"]);

  // target side: the trigger fires on the canonical spelling, and the target
  // was actually touched too but only under its ALIAS spelling — recognized
  // as satisfied only once the alias is declared.
  const targetNorm = NORM({ couples_when: ["src/**"], couples_also: ["frontend/**"] });
  const changed = ["src/a.js", "packages/web/app.js"];
  const targetUndeclared = runCheck({ slug: "projx", changed, norms: [targetNorm] });
  assert.equal(targetUndeclared.findings.length, 1, "undeclared alias: target looks untouched");
  assert.equal(targetUndeclared.findings[0].kind, "untouched");
  const targetDeclared = runCheck({ slug: "projx", changed, norms: [targetNorm], aliases });
  assert.deepEqual(targetDeclared.findings, [], "declared alias: the target IS recognized as touched");
});

test("runCheck: cross-repo targets are reminders, never findings", () => {
  const norms = [NORM({ couples_also: ["other:docs/engines.md"] })];
  const r = runCheck({ slug: "projx", changed: ["src/a.js"], norms });
  assert.deepEqual(r.findings, []);
  assert.equal(r.reminders.length, 1);
  assert.deepEqual(r.reminders[0].cross_repo, ["other:docs/engines.md"]);
  // mixed: an untouched same-repo target IS a finding, carrying the cross-repo list
  const mixed = runCheck({
    slug: "projx", changed: ["src/a.js"],
    norms: [NORM({ couples_also: ["API.md", "other:docs/engines.md"] })],
  });
  assert.equal(mixed.findings.length, 1);
  assert.deepEqual(mixed.findings[0].untouched, ["API.md"]);
  assert.deepEqual(mixed.findings[0].cross_repo, ["other:docs/engines.md"]);
  assert.deepEqual(mixed.reminders, []);
});

const FILES = { ".nvmrc": "v24.2.0\n", Dockerfile: "FROM node:24\n" };
const readFrom = (files) => (rel) => files[rel] ?? null;
const VNORM = (extra = {}) =>
  NORM({
    couples_when: [".nvmrc"], couples_also: ["Dockerfile"],
    couples_value_a: ".nvmrc#v?(\\d+)", couples_value_b: "Dockerfile#FROM node:(\\d+)",
    ...extra,
  });

test("runCheck value invariant: agreement suppresses the untouched heuristic", () => {
  const r = runCheck({ slug: "projx", changed: [".nvmrc"], norms: [VNORM()], readFile: readFrom(FILES) });
  assert.deepEqual(r.findings, []); // Dockerfile untouched but the values AGREE
});

test("runCheck value invariant: disagreement reports even when the target was touched", () => {
  const files = { ".nvmrc": "v24.2.0\n", Dockerfile: "FROM node:22\n" };
  const r = runCheck({
    slug: "projx", changed: [".nvmrc", "Dockerfile"], norms: [VNORM()], readFile: readFrom(files),
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "value-disagreement");
  assert.equal(r.findings[0].a.value, "24");
  assert.equal(r.findings[0].b.value, "22");
});

test("runCheck value invariant: arms on an invariant-file change without a trigger hit", () => {
  // only the Dockerfile (the B side, not a trigger) changed — to the wrong value
  const files = { ".nvmrc": "v24.2.0\n", Dockerfile: "FROM node:22\n" };
  const r = runCheck({ slug: "projx", changed: ["Dockerfile"], norms: [VNORM()], readFile: readFrom(files) });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "value-disagreement");
});

test("runCheck value invariant: unreadable side degrades to value-unverifiable with the untouched list", () => {
  const r = runCheck({ slug: "projx", changed: [".nvmrc"], norms: [VNORM()], readFile: readFrom({ ".nvmrc": "v24\n" }) });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "value-unverifiable");
  assert.equal(r.findings[0].reason, "unreadable");
  assert.deepEqual(r.findings[0].untouched, ["Dockerfile"]);
});

test("runCheck value invariant: a side pinned to another repo is unverifiable here", () => {
  const norm = VNORM({ couples_value_b: "other:Dockerfile#FROM node:(\\d+)" });
  const r = runCheck({ slug: "projx", changed: [".nvmrc"], norms: [norm], readFile: readFrom(FILES) });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "value-unverifiable");
  assert.equal(r.findings[0].reason, "cross-repo");
});

test("renderReport: summary line, finding blocks, reminders, advisory footer", () => {
  const text = renderReport(
    {
      slug: "projx", changed: ["src/a.js"], checked: 2,
      findings: [{ kind: "untouched", norm: "norm-x", title: "X couples", triggered: ["src/a.js"], untouched: ["API.md"], cross_repo: [] }],
      reminders: [{ norm: "norm-y", title: null, triggered: ["src/a.js"], cross_repo: ["other:d.md"] }],
    },
    { strict: false }
  );
  assert.match(text, /^spor check: 1 finding \(1 changed file, 2 coupling norms, project projx\)/);
  assert.match(text, /norm-x — X couples\n  triggered by: src\/a\.js\n  untouched: API\.md/);
  assert.match(text, /norm-y \(reminder\)/);
  assert.match(text, /advisory — exit 0/);
  const ok = renderReport({ slug: "projx", changed: [], checked: 0, findings: [], reminders: [] });
  assert.match(ok, /^spor check: ok/);
});

// ---------- CLI arm ----------

function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_DISTILLING = "1";
  return Object.assign(env, extra);
}
function runCli(args, cwd, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// scratch repo `projx` (slug projx) + scratch graph home carrying one coupling norm
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-check-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  const g = (...args) => execFileSync("git", ["-C", cwd, ...args], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  g("init", "-q");
  fs.writeFileSync(path.join(cwd, "src", "a.js"), "1\n");
  fs.writeFileSync(path.join(cwd, "API.md"), "api\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { root, home, cwd, g };
}
function writeNorm(home, id, body) {
  fs.writeFileSync(path.join(home, "nodes", `${id}.md`),
    `---\nid: ${id}\ntype: norm\ntitle: ${id} title\nsummary: s.\n${body}---\nbody\n`);
}

test("CLI local: default change set (uncommitted vs HEAD + untracked), finding, exit 0; --strict exits 1", async () => {
  const { home, cwd } = scratch();
  writeNorm(home, "norm-c", "couples_when: [src/**]\ncouples_also: [API.md]\n");
  fs.writeFileSync(path.join(cwd, "src", "a.js"), "2\n"); // unstaged edit
  fs.writeFileSync(path.join(cwd, "src", "new.js"), "n\n"); // untracked
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  const r = await runCli(["check"], cwd, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /spor check: 1 finding/);
  assert.match(r.stdout, /norm-c/);
  assert.match(r.stdout, /triggered by: src\/a\.js, src\/new\.js/);
  assert.match(r.stdout, /untouched: API\.md/);
  const strict = await runCli(["check", "--strict"], cwd, env);
  assert.equal(strict.status, 1);
  // touch the target too -> clean, exit 0 even under --strict
  fs.writeFileSync(path.join(cwd, "API.md"), "api2\n");
  const clean = await runCli(["check", "--strict"], cwd, env);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /spor check: ok/);
});

test("CLI local: --staged narrows to the index; --files takes an explicit set; --json shape", async () => {
  const { home, cwd, g } = scratch();
  writeNorm(home, "norm-c", "couples_when: [src/**]\ncouples_also: [API.md]\n");
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  fs.writeFileSync(path.join(cwd, "src", "a.js"), "2\n");
  // nothing staged -> --staged sees no changes
  const none = await runCli(["check", "--staged"], cwd, env);
  assert.match(none.stdout, /spor check: ok \(0 changed files/);
  g("add", "src/a.js");
  const staged = await runCli(["check", "--staged", "--json"], cwd, env);
  const j = JSON.parse(staged.stdout);
  assert.equal(j.project, "projx");
  assert.deepEqual(j.changed, ["src/a.js"]);
  assert.equal(j.findings.length, 1);
  assert.equal(j.findings[0].kind, "untouched");
  const files = await runCli(["check", "--files", "src/whatever.js", "--json"], cwd, env);
  assert.deepEqual(JSON.parse(files.stdout).changed, ["src/whatever.js"]);
  assert.equal(JSON.parse(files.stdout).findings.length, 1);
});

test("CLI local: --files derives repo-relative paths through an aliased cwd (issue-spor-windows-ci-short-path-mismatch)", async (t) => {
  // Portable stand-in for the windows-latest 8.3 short path: `git rev-parse
  // --show-toplevel` returns the real path while a symlinked cwd is the alias,
  // so the naive path.relative(top, resolve(cwd, f)) walks out of the repo and
  // the `src/**` trigger silently stops matching. toRepoRel's canonicalize-on-
  // walkout fallback keeps the derived path in-repo.
  const { home, root } = scratch();
  const linkRoot = `${root}-link`;
  try {
    fs.symlinkSync(root, linkRoot, "dir");
  } catch {
    t.skip("symlinks unavailable on this host");
    return;
  }
  writeNorm(home, "norm-c", "couples_when: [src/**]\ncouples_also: [API.md]\n");
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  const cwd = path.join(linkRoot, "projx"); // the alias spelling, vs git's real toplevel
  const files = await runCli(["check", "--files", "src/whatever.js", "--json"], cwd, env);
  const j = JSON.parse(files.stdout);
  assert.deepEqual(j.changed, ["src/whatever.js"]);
  assert.equal(j.findings.length, 1);
  assert.equal(j.findings[0].norm, "norm-c");
});

test("CLI local: --files through a tracked in-repo symlinked subtree matches a trigger authored against EITHER spelling (task-spor-coupling-matcher-symlink-alias)", async (t) => {
  const { home, cwd } = scratch();
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "web", "app.js"), "x\n");
  try {
    fs.symlinkSync(path.join(cwd, "packages", "web"), path.join(cwd, "frontend"), "dir");
  } catch {
    t.skip("symlinks unavailable on this host");
    return;
  }
  // the norm's trigger is authored against the git-RESOLVED subtree
  writeNorm(home, "norm-web", "couples_when: [packages/web/**]\ncouples_also: [API.md]\n");
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  // but --files is given the ALIAS spelling, as a caller reaching the file
  // through the symlinked directory would
  const r = await runCli(["check", "--files", "frontend/app.js", "--json"], cwd, env);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.changed.sort(), ["frontend/app.js", "packages/web/app.js"]);
  assert.equal(j.findings.length, 1);
  assert.equal(j.findings[0].norm, "norm-web");
  assert.deepEqual(j.findings[0].triggered, ["packages/web/app.js"]);
});

test("CLI local: default (git diff) change set reports ONLY the canonical spelling — a declared coupling.aliases map in .spor.json recovers a trigger authored against the alias (issue-spor-coupling-matcher-reverse-symlink-gap)", async () => {
  // Unlike --files (which re-derives candidate spellings from the literal fs
  // path), the default/--staged/--range change sets come straight from `git
  // diff --name-only`, which never reports an alias spelling — no symlink
  // needs to exist on disk at all to reproduce this gap. Without a declared
  // alias the norm's alias-authored glob can never match; declaring
  // `coupling.aliases` in .spor.json recovers it, with no runtime scanning.
  const { home, cwd, g } = scratch();
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "web", "app.js"), "1\n");
  g("add", "-A"); g("commit", "-q", "-m", "add web");
  writeNorm(home, "norm-web", "couples_when: [frontend/**]\ncouples_also: [API.md]\n");
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  fs.writeFileSync(path.join(cwd, "packages", "web", "app.js"), "2\n");
  const undeclared = await runCli(["check", "--json"], cwd, env);
  assert.deepEqual(JSON.parse(undeclared.stdout).findings, [], "no alias declared -> documented limitation");
  fs.writeFileSync(path.join(cwd, ".spor.json"), JSON.stringify({ coupling: { aliases: { frontend: "packages/web" } } }));
  const declared = await runCli(["check", "--json"], cwd, env);
  const j = JSON.parse(declared.stdout);
  assert.equal(j.findings.length, 1);
  assert.equal(j.findings[0].norm, "norm-web");
  assert.deepEqual(j.findings[0].triggered, ["packages/web/app.js"]);
});

test("CLI local: --range checks a commit range and reads invariant values from its right side", async () => {
  const { home, cwd, g } = scratch();
  writeNorm(home, "norm-v",
    "couples_when: [.nvmrc]\ncouples_also: [Dockerfile]\n" +
    "couples_value_a: .nvmrc#v?(\\d+)\ncouples_value_b: Dockerfile#FROM node:(\\d+)\n");
  fs.writeFileSync(path.join(cwd, ".nvmrc"), "v22\n");
  fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:22\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(cwd, ".nvmrc"), "v24\n"); // bump ONE side
  g("add", "-A"); g("commit", "-q", "-m", "bump nvmrc only");
  const env = baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  const r = await runCli(["check", "--range", "HEAD~1..HEAD", "--json"], cwd, env);
  const j = JSON.parse(r.stdout);
  assert.equal(j.findings.length, 1);
  assert.equal(j.findings[0].kind, "value-disagreement");
  assert.equal(j.findings[0].a.value, "24");
  assert.equal(j.findings[0].b.value, "22");
  // a bad range fails clean
  const bad = await runCli(["check", "--range", "zzz..HEAD"], cwd, env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /could not resolve --range/);
});

test("CLI: outside a git repo -> clean error, exit 1", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-check-nogit-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose);
  const r = await runCli(["check"], loose, baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a git repository/);
});

test("CLI remote: norms come from GET /v1/export; the git diff stays local", async () => {
  const { home, cwd } = scratch();
  const teamNodes = fs.mkdtempSync(path.join(os.tmpdir(), "spor-check-team-"));
  fs.mkdirSync(path.join(teamNodes, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(teamNodes, "nodes", "norm-team.md"),
    "---\nid: norm-team\ntype: norm\ntitle: team coupling\nsummary: s.\ncouples_when: [projx:src/**]\ncouples_also: [API.md]\n---\nbody\n");
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/export")) {
        const { buffer } = exportNodesDir(path.join(teamNodes, "nodes"));
        res.writeHead(200, { "content-type": "application/x-tar" });
        res.end(buffer);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const base = await new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    fs.writeFileSync(path.join(cwd, "src", "a.js"), "2\n");
    const env = baseEnv({
      SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1",
      SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test",
    });
    const r = await runCli(["check", "--json"], cwd, env);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.findings.length, 1);
    assert.equal(j.findings[0].norm, "norm-team");
  } finally {
    srv.close();
  }
});
