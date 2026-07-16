// task-spor-coupling-nudge-posttool (dec-spor-coupling-norms-declared-first) —
// the post-tool edit-time coupling nudge: a deterministic glob match of the
// edited repo-relative path against coupling norms' `couples_when` triggers,
// injecting the `couples_also` targets. Driven through the real dispatcher
// (bin/spor-hook post-tool); local mode reads the scratch graph's nodes dir,
// remote mode reads a TTL-cached GET /v1/export snapshot served by an
// in-process stub. Everything writes to a throwaway SPOR_HOME.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnHook } = require("./helpers/portable");
const { exportNodesDir } = require("../lib/tar.js");

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("SUBSTRATE_")) delete env[k];
    if (k.startsWith("SPOR_") && k !== "SPOR_HOME") delete env[k];
  }
  env.SPOR_ENABLED = "1"; // opt the scratch repo in (task-spor-plugin-opt-in-default)
  return { ...env, ...extra };
}

// A git-repo cwd named `projx` (slug projx) + a separate scratch graph home.
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-couplingnudge-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  const g = (args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  g(["init", "-q"]);
  fs.writeFileSync(path.join(cwd, "f.txt"), "x");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "init"]);
  return { root, home, cwd };
}

function writeNorm(nodesDir, id, fm) {
  fs.writeFileSync(
    path.join(nodesDir, `${id}.md`),
    `---\nid: ${id}\ntype: norm\ntitle: ${fm.title ?? "coupling"}\nsummary: coupled artifacts change together.\n${fm.extra ?? ""}couples_when: [${fm.when.join(", ")}]\ncouples_also: [${fm.also.join(", ")}]\n---\n\nBody.\n`
  );
}

function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    let out = "";
    const c = spawnHook(args, input, env, { stdio: ["pipe", "pipe", "ignore"] });
    c.stdout.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

function editPayload(cwd, session = "s1", file = "src/code.js") {
  return JSON.stringify({
    cwd, session_id: session, hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_input: { file_path: path.join(cwd, file), new_string: "x" },
  });
}

function journal(home, session = "s1") {
  const p = path.join(home, "journal", `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("local mode: a matching edit fires the coupling nudge naming the targets", async () => {
  const { home, cwd } = scratch();
  writeNorm(path.join(home, "nodes"), "norm-projx-api-docs", {
    title: "src changes update the API docs",
    extra: "project: projx\n",
    when: ["src/**"],
    also: ["API.md", "skills/spor/"],
  });
  const out = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), freshEnv(home));
  const json = JSON.parse(out);
  const ctx = json.hookSpecificOutput.additionalContext;
  assert.strictEqual(json.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(ctx, /coupling nudge/);
  assert.match(ctx, /You edited src\/code\.js/);
  assert.match(ctx, /norm-projx-api-docs — src changes update the API docs: also update API\.md, skills\/spor\//);
  assert.match(ctx, /SPOR_COUPLING_NUDGE=0/);
  // cooldown + journal
  const state = path.join(home, "journal", "s1.coupling-nudged");
  assert.strictEqual(fs.readFileSync(state, "utf8").trim(), "norm-projx-api-docs");
  const j = journal(home).filter((e) => e.tool === "coupling-nudge");
  assert.strictEqual(j.length, 1);
  assert.deepStrictEqual(j[0].norms, ["norm-projx-api-docs"]);
});

test("short-path / symlink parity: a git long-path top vs an aliased cwd still fires (issue-spor-windows-ci-short-path-mismatch)", async (t) => {
  // Reproduce the windows-latest failure class portably: on CI os.tmpdir() is an
  // 8.3 short path (…\RUNNER~1\…) while `git rev-parse --show-toplevel` returns
  // the long form, so path.relative walks clean out of the repo and the nudge
  // emits nothing. A symlinked cwd creates the same real-vs-alias split (git
  // resolves to the physical path; the hook payload carries the alias) — the fix
  // canonicalizes both sides before deriving the repo-relative path.
  const { root, home } = scratch();
  const linkRoot = `${root}-link`;
  try {
    fs.symlinkSync(root, linkRoot, "dir");
  } catch {
    t.skip("symlinks unavailable on this host");
    return;
  }
  const cwd = path.join(linkRoot, "projx"); // basename stays `projx` -> slug projx
  writeNorm(path.join(home, "nodes"), "norm-projx-api-docs", {
    title: "src changes update the API docs",
    extra: "project: projx\n",
    when: ["src/**"],
    also: ["API.md"],
  });
  const out = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), freshEnv(home));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /You edited src\/code\.js/);
  assert.match(ctx, /norm-projx-api-docs/);
});

test("symlink-alias parity: a trigger glob authored against the RESOLVED path still fires when edited via the alias (task-spor-coupling-matcher-symlink-alias)", async (t) => {
  // A tracked in-repo symlinked subtree (`frontend -> packages/web`) gives one
  // edit two valid repo-relative spellings. The edit itself is reached via the
  // alias (`frontend/app.js`, no walk-out — literal-first keeps that spelling),
  // but the norm's couples_when glob is authored against the git-resolved
  // subtree (`packages/web/**`). Before this fix, only the alias spelling was
  // ever tested and the nudge stayed silent; now both spellings are tested.
  const { home, cwd } = scratch();
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "web", "app.js"), "x");
  try {
    fs.symlinkSync(path.join(cwd, "packages", "web"), path.join(cwd, "frontend"), "dir");
  } catch {
    t.skip("symlinks unavailable on this host");
    return;
  }
  writeNorm(path.join(home, "nodes"), "norm-projx-web-docs", {
    title: "web changes update the docs",
    extra: "project: projx\n",
    when: ["packages/web/**"],
    also: ["API.md"],
  });
  const out = await runAsync(
    ["post-tool", "--host", "claude-code"],
    editPayload(cwd, "s1", "frontend/app.js"),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /You edited frontend\/app\.js/); // literal-first spelling for the human-facing line
  assert.match(ctx, /norm-projx-web-docs/);
});

test("declared coupling.aliases recovers the REVERSE symlink-alias gap: an edit reported only under its canonical path still fires a trigger authored against the alias (issue-spor-coupling-matcher-reverse-symlink-gap)", async () => {
  // No symlink is materialized on disk at all here — repoRelativeCandidates
  // has nothing to derive an alias spelling FROM, reproducing the case an
  // environment hands the hook an already-resolved path. Without a declared
  // alias the norm (authored against the alias) can never fire; a
  // `coupling.aliases` map in .spor.json recovers it, no filesystem scan.
  const { home, cwd } = scratch();
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  writeNorm(path.join(home, "nodes"), "norm-projx-web-docs", {
    title: "web changes update the docs",
    extra: "project: projx\n",
    when: ["frontend/**"],
    also: ["API.md"],
  });
  const env = freshEnv(home);
  const undeclared = await runAsync(
    ["post-tool", "--host", "claude-code"],
    editPayload(cwd, "s1", "packages/web/app.js"),
    env
  );
  assert.strictEqual(undeclared.trim(), "", "no alias declared -> the documented limitation stands");
  fs.writeFileSync(
    path.join(cwd, ".spor.json"),
    JSON.stringify({ coupling: { aliases: { frontend: "packages/web" } } })
  );
  const declared = await runAsync(
    ["post-tool", "--host", "claude-code"],
    editPayload(cwd, "s2", "packages/web/app.js"),
    env
  );
  const ctx2 = JSON.parse(declared).hookSpecificOutput.additionalContext;
  assert.match(ctx2, /You edited packages\/web\/app\.js/);
  assert.match(ctx2, /norm-projx-web-docs/);
});

test("once per (session, norm): a second matching edit is silent, a NEW norm still fires", async () => {
  const { home, cwd } = scratch();
  const nodes = path.join(home, "nodes");
  writeNorm(nodes, "norm-a", { when: ["src/**"], also: ["API.md"] });
  const env = freshEnv(home);
  const first = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd, "s1", "src/a.js"), env);
  assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /norm-a/);
  const second = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd, "s1", "src/b.js"), env);
  assert.strictEqual(second.trim(), "", "same norm must not fire twice in one session");
  // a norm authored mid-session is picked up (fingerprint cache) and fires
  writeNorm(nodes, "norm-b", { when: ["src/**"], also: ["GRAPH.md"] });
  const third = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd, "s1", "src/c.js"), env);
  const ctx = JSON.parse(third).hookSpecificOutput.additionalContext;
  assert.match(ctx, /norm-b/);
  assert.doesNotMatch(ctx, /norm-a/);
});

test("non-matching path, and a graph with no coupling norms, stay silent", async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home);
  // no norms at all
  assert.strictEqual((await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), env)).trim(), "");
  // a norm whose trigger doesn't cover the edited path
  writeNorm(path.join(home, "nodes"), "norm-docs", { when: ["docs/**"], also: ["README.md"] });
  assert.strictEqual(
    (await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd, "s2", "src/a.js"), env)).trim(),
    ""
  );
  assert.ok(!fs.existsSync(path.join(home, "journal", "s2.coupling-nudged")));
});

test("cross-repo: a trigger qualified to this repo fires even when the norm is stamped elsewhere", async () => {
  const { home, cwd } = scratch();
  const nodes = path.join(home, "nodes");
  // stamped to another repo; qualified trigger pins projx (the cross-repo case)
  writeNorm(nodes, "norm-xrepo", {
    title: "engine docs live in otherrepo",
    extra: "project: otherrepo\n",
    when: ["projx:src/**"],
    also: ["otherrepo:docs/engines.md"],
  });
  // stamped to another repo with an UNQUALIFIED trigger: scope-bound, silent here
  writeNorm(nodes, "norm-foreign", { extra: "project: otherrepo\n", when: ["src/**"], also: ["X.md"] });
  const out = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), freshEnv(home));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /norm-xrepo/);
  assert.match(ctx, /otherrepo:docs\/engines\.md/);
  assert.doesNotMatch(ctx, /norm-foreign/);
});

test("SPOR_COUPLING_NUDGE=0 disables the branch", async () => {
  const { home, cwd } = scratch();
  writeNorm(path.join(home, "nodes"), "norm-a", { when: ["src/**"], also: ["API.md"] });
  const out = await runAsync(
    ["post-tool", "--host", "claude-code"],
    editPayload(cwd),
    freshEnv(home, { SPOR_COUPLING_NUDGE: "0" })
  );
  assert.strictEqual(out.trim(), "");
});

test("a graph-home write and an out-of-repo write never match", async () => {
  const { home, cwd, root } = scratch();
  writeNorm(path.join(home, "nodes"), "norm-a", { when: ["**/*.md"], also: ["API.md"] });
  const env = freshEnv(home);
  // inside the graph home (a node write)
  const inGraph = JSON.stringify({
    cwd, session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Write", tool_input: { file_path: path.join(home, "nodes", "x.md"), content: "y" },
  });
  assert.strictEqual((await runAsync(["post-tool", "--host", "claude-code"], inGraph, env)).trim(), "");
  // outside any git repo
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose);
  const outside = JSON.stringify({
    cwd: loose, session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Write", tool_input: { file_path: path.join(loose, "note.md"), content: "y" },
  });
  assert.strictEqual((await runAsync(["post-tool", "--host", "claude-code"], outside, env)).trim(), "");
});

// ---------- remote mode ----------

// Stub server: /v1/export streams a tarball of `nodesDir`; /v1/queue answers
// empty (so the claim nudge stays silent and the write falls through to the
// coupling branch); counts export hits for the TTL assertion.
function stubServer(nodesDir) {
  const hits = { export: 0 };
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/export")) {
        hits.export++;
        const { buffer } = exportNodesDir(nodesDir);
        res.writeHead(200, { "content-type": "application/x-tar" });
        res.end(buffer);
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/queue")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("remote mode: norms come from the cached /v1/export snapshot; one fetch serves many writes", async () => {
  const { home, cwd, root } = scratch();
  // the TEAM graph lives server-side in a separate dir, not in SPOR_HOME
  const teamNodes = path.join(root, "team-nodes");
  fs.mkdirSync(teamNodes, { recursive: true });
  writeNorm(teamNodes, "norm-team-coupling", {
    title: "src couples with API.md",
    when: ["projx:src/**"],
    also: ["API.md"],
  });
  const { srv, hits, base } = await stubServer(teamNodes);
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" });
    const out = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), env);
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /coupling nudge/);
    assert.match(ctx, /norm-team-coupling/);
    assert.strictEqual(hits.export, 1);
    // the snapshot cache was written and a second session reuses it (TTL)
    const cache = JSON.parse(fs.readFileSync(path.join(home, "cache", "coupling.json"), "utf8"));
    assert.strictEqual(cache.norms.length, 1);
    const again = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd, "s2"), env);
    assert.match(JSON.parse(again).hookSpecificOutput.additionalContext, /norm-team-coupling/);
    assert.strictEqual(hits.export, 1, "the TTL-fresh cache must not refetch");
  } finally {
    srv.close();
  }
});

test("remote fail-open: a dead server is silent, costs one bounded attempt, and stays quiet for the TTL", async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home, {
    SPOR_SERVER: "http://127.0.0.1:1",
    SPOR_TOKEN: "spor_pat_test",
    SPOR_COUPLING_NUDGE_TIMEOUT: "400",
    SPOR_CLAIM_NUDGE_TIMEOUT: "400",
  });
  const out = await runAsync(["post-tool", "--host", "claude-code"], editPayload(cwd), env);
  assert.strictEqual(out.trim(), "");
  // the pre-stamped cache means the NEXT write does not attempt the download
  const cache = JSON.parse(fs.readFileSync(path.join(home, "cache", "coupling.json"), "utf8"));
  assert.ok(typeof cache.fetched === "number");
  assert.deepStrictEqual(cache.norms, []);
});
