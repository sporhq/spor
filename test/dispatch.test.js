// spor dispatch + repos — kick off Claude Code background agents from the CLI
// (task-spor-cli-dispatch-background-agents). Covers the local slug->path map,
// briefing compilation, directory resolution (incl. cross-repo via the map),
// the --print dry run, and a real (stubbed) spawn. Everything runs against a
// throwaway graph home — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const u = require(path.join(__dirname, "..", "scripts", "engines", "util.js"));
const { pathWithOnlyGit, writeSpawnableNodeStub } = require("./helpers/portable");

// Env with no SPOR_*/SUBSTRATE_* leakage; force LOCAL mode (no server). Also
// isolate the config-cascade homes to an empty temp dir so the developer's real
// ~/.spor/config.json can't leak server+token in and flip a test to remote.
// `extra` is applied last, so SPOR_HOME / SPOR_CLAUDE_CMD passed by a test win.
// Default the in-flight agent list to empty (SPOR_FAKE_AGENTS_JSON="[]") so the
// same-machine dispatch guard (task-spor-dispatch-same-machine-guard) never
// shells out to a real `claude agents --json` — keeping these tests hermetic and
// deterministic; a guard test overrides it via `extra`.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-iso-"));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME;
  env.XDG_CONFIG_HOME = ISO_HOME;
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  return Object.assign(env, extra);
}
function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env), cwd });
}

function slashPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function noOpClaudeStub(home) {
  return writeSpawnableNodeStub(home, "claude-noop", "process.exit(0);");
}

// A scratch graph home with two linked nodes under repo `demo`.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "dec-x.md"),
    `---\nid: dec-x\ntype: decision\nrepo: demo\ntitle: A demo decision about auth token rotation\nsummary: A demo decision describing auth token rotation and credential handling for the pipeline.\ndate: 2026-06-01\n---\nBody about auth token rotation and credential handling.\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-rotate.md"),
    `---\nid: task-rotate\ntype: task\nrepo: demo\ntitle: Rotate pipeline auth tokens on a schedule\nsummary: Implement scheduled rotation of auth tokens and credentials in the pipeline.\ndate: 2026-06-02\nedges:\n  - {type: derived-from, to: dec-x}\n---\nImplement scheduled rotation of the auth tokens.\n`
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-repo-"));
  return { home, nodes, repo };
}

test("repos: empty, add, list, rm round-trip; stored in user config.json under dispatch.repos", () => {
  const { home, repo } = fixture();
  const env = { SPOR_HOME: home };
  const cfgFile = path.join(home, "config.json");
  assert.match(run(["repos"], env).stdout, /no repos mapped yet/);

  assert.strictEqual(run(["repos", "add", "demo", repo], env).status, 0);
  // the mapping lands in the user config, not a sidecar file
  assert.ok(!fs.existsSync(path.join(home, "repos.json")), "no sidecar repos.json");
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.repos.demo, repo);

  const list = run(["repos", "list"], env);
  assert.match(list.stdout, new RegExp(`^demo\\t${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  assert.strictEqual(run(["repos", "rm", "demo"], env).status, 0);
  assert.match(run(["repos"], env).stdout, /no repos mapped yet/);
});

test("repos: with a marker graph: home active, the map writes to the PERSONAL home and reads back (no desync)", () => {
  // issue-spor-config-desync-shared-graph-home: a `.spor` marker `graph:` key
  // redirects the GRAPH to a shared home, but the machine-local dispatch.repos
  // map must stay in the personal $SPOR_HOME/config.json. Before the fix it was
  // written to the shared home (cfg.graphHome()) but read from the personal one,
  // so it vanished from the next `spor repos list`.
  const { repo } = fixture();
  const personal = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-personal-"));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-shared-"));
  // A code repo whose .spor marker binds the shared graph home (absolute path).
  const code = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-code-"));
  fs.writeFileSync(path.join(code, ".spor"), `repo: demo\ngraph: ${shared}\n`);

  // Run from inside the marker-bound repo so the cascade resolves the shared
  // graph home, with SPOR_HOME = the personal home.
  const env = { SPOR_HOME: personal };
  assert.strictEqual(run(["repos", "add", "demo", repo], env, code).status, 0);

  // The map landed in the PERSONAL home, NOT the shared graph home.
  const personalCfg = path.join(personal, "config.json");
  assert.ok(fs.existsSync(personalCfg), "config.json written to the personal home");
  assert.strictEqual(JSON.parse(fs.readFileSync(personalCfg, "utf8")).dispatch.repos.demo, repo);
  assert.ok(!fs.existsSync(path.join(shared, "config.json")), "nothing written to the shared graph home");

  // And it reads back across a reload (the desync the issue describes is gone).
  const list = run(["repos", "list"], env, code);
  assert.match(list.stdout, new RegExp(`^demo\\t${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  // rm round-trips against the same personal home too.
  assert.strictEqual(run(["repos", "rm", "demo"], env, code).status, 0);
  assert.match(run(["repos"], env, code).stdout, /no repos mapped yet/);
});

test("repos add preserves other config.json keys (server/token)", () => {
  const { home, repo } = fixture();
  const cfgFile = path.join(home, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ server: "https://example", token: "t0" }) + "\n");
  assert.strictEqual(run(["repos", "add", "demo", repo], { SPOR_HOME: home }).status, 0);
  const data = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  assert.strictEqual(data.server, "https://example");
  assert.strictEqual(data.token, "t0");
  assert.strictEqual(data.dispatch.repos.demo, repo);
});

test("repos add rejects a non-canonical slug", () => {
  const { home, repo } = fixture();
  const r = run(["repos", "add", "Bad_Slug", repo], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid slug/);
});

test("dispatch free-text --print: resolves cwd dir, compiles a local briefing", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, new RegExp(`dir:    ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.stdout, /via --dir/);
  assert.match(r.stdout, /brief:  \d+ bytes/); // graph had relevant content
  assert.match(r.stdout, /# Task\n\nauth token rotation credentials/);
});

test("dispatch --no-brief: raw task prompt, no briefing block", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /brief:  \(none/);
  assert.doesNotMatch(r.stdout, /# Spor briefing/);
  // the session-project note rides even a no-brief prompt — it is identity
  // context, not part of the compiled briefing.
  assert.match(r.stdout, /Spor session project:/);
});

// --- session project on dispatch (issue-spor-dispatch-propagate-session-project-to-questions)
// `claude --bg` drops the launcher env and the agent token carries only
// {agent, session} (dec-spor-session-identity-active-record), so the session
// project reaches a dispatched, mention-less ask_question only if dispatch
// injects it into the prompt and the agent passes it as the `project` param.
test("dispatch --print: injects the session-project note so a mention-less question can be stamped", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "ship the widget", "--dir", repo, "--slug", "demo", "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Spor session project:.*`demo`/, "states the session project");
  assert.match(r.stdout, /pass `project: "demo"`/, "tells the agent to pass it to ask_question");
});

test("dispatch --print: the session-project note also rides a briefing prompt, above the briefing", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--slug", "demo", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  const prompt = r.stdout.slice(r.stdout.indexOf("--- prompt ---"));
  const noteAt = prompt.indexOf("Spor session project:");
  const briefAt = prompt.indexOf("# Spor briefing");
  assert.ok(noteAt >= 0, "note present");
  assert.ok(briefAt >= 0, "briefing present");
  assert.ok(noteAt < briefAt, "the note leads the standing context, above the compiled briefing");
});

// --- worktree-durable dispatch dir (issue-spor-dispatch-worktree-dir-stamping) --
// A dispatch run from INSIDE a linked git worktree must resolve (and register)
// the MAIN checkout, not the ephemeral worktree dir — otherwise removing the
// worktree leaves a dead dispatch.repos mapping that fails the next dispatch with
// "target dir does not exist". The cwd fallback uses dispatchRoot() (inferenceRoot,
// = dirname --git-common-dir), the same durable root session-start registers with,
// rather than repoRoot() (git --show-toplevel, the worktree dir).
function gitRepoWithWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-wt-"));
  const main = path.join(base, "wt-main-svc");
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
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(["init", "-q"]);
  fs.writeFileSync(path.join(main, "f.txt"), "x");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "root"]);
  const wt = path.join(base, "wt-ephemeral-checkout");
  g(["worktree", "add", "-q", wt, "HEAD"]);
  // git reports realpaths (macOS tmp is a /var -> /private/var symlink), so
  // compare against the resolved paths the CLI will emit.
  return { base, main: fs.realpathSync(main), wt: fs.realpathSync(wt) };
}

test("dispatch from inside a git worktree --print: resolves the MAIN checkout, not the worktree", () => {
  const { base, main, wt } = gitRepoWithWorktree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-wt-home-"));
  const r = run(["dispatch", "some free text task to dispatch", "--no-brief", "--print"], { SPOR_HOME: home }, wt);
  assert.strictEqual(r.status, 0, r.stderr);
  const dirLine = r.stdout.split("\n").find((line) => line.startsWith("dir:"));
  const resolvedDir = slashPath(dirLine && dirLine.replace(/^dir:\s+/, "").replace(/\s+\(.*$/, ""));
  assert.ok(resolvedDir.endsWith("/wt-main-svc"), "resolved the main checkout");
  assert.match(r.stdout, /via cwd/);
  assert.ok(!slashPath(r.stdout).includes("/wt-ephemeral-checkout"), "never the ephemeral worktree path");
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch from inside a git worktree (local, stubbed): registers the MAIN checkout in dispatch.repos", () => {
  const { base, main, wt } = gitRepoWithWorktree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-wt-reg-"));
  const stub = noOpClaudeStub(home);
  const r = run(["dispatch", "some free text task to dispatch", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub }, wt);
  assert.strictEqual(r.status, 0, r.stderr);
  const mapped = Object.values(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).dispatch.repos);
  assert.ok(mapped.some((p) => slashPath(p).endsWith("/wt-main-svc")), `main checkout registered (got ${JSON.stringify(mapped)})`);
  assert.ok(!mapped.some((p) => slashPath(p).endsWith("/wt-ephemeral-checkout")), "ephemeral worktree path NOT registered");
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch <node-id>: auto-detects node mode and resolves the dir cross-repo via the map", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home }); // demo -> repo
  // run from somewhere that is NOT the demo repo; the node's repo:demo drives the dir
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cwd-"));
  const r = run(["dispatch", "dec-x", "--print"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, new RegExp(`dir:    ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  assert.match(r.stdout, /name dec-x/);
  assert.match(r.stdout, /Work on dec-x — A demo decision about auth token rotation/);
});

test("dispatch --from-queue: dispatches the top-ranked queue item into its repo", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home }); // both fixture nodes are repo:demo
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cwd-"));
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 0);
  // The top item is one of the fixture nodes, dispatched in node mode and
  // resolved into demo's dir via the config map (not the unrelated cwd).
  assert.match(r.stdout, new RegExp(`dir:    ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  assert.match(r.stdout, /--name (task-rotate|dec-x)/);
  assert.match(r.stdout, /# Task\n\nWork on (task-rotate|dec-x)/);
});

test("dispatch --from-queue: empty queue exits 1", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-empty-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true }); // graph with no queueable work
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /queue empty/);
});

// A node / --from-queue dispatch must run in the TARGET repo so its workspace
// hooks apply, never silently fall back to the launcher's cwd
// (issue-spor-dispatch-from-queue-wrong-repo-hooks). The happy path (a node whose
// repo: stamp is mapped in dispatch.repos) is covered above; these lock the
// residual hole: a node carrying NO repo/project stamp can't be resolved to a
// target repo, so the OLD behavior was a silent fallback to the launcher's cwd
// (applying its hooks to another repo's work). Now it REFUSES instead.
function stamplessFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-stampless-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  // No repo:/project: frontmatter — nothing identifies the owning repo.
  fs.writeFileSync(
    path.join(nodes, "task-orphan.md"),
    `---\nid: task-orphan\ntype: task\ntitle: An orphan task with no repo or project stamp\nsummary: A queueable task carrying neither a repo nor a project frontmatter field, so dispatch cannot resolve its target repo from the node.\ndate: 2026-06-02\n---\nDo the orphan work.\n`
  );
  return { home, nodes };
}

test("dispatch <node-id> with no repo/project stamp: refuses rather than silently using the launcher cwd", () => {
  const { home } = stamplessFixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-launcher-"));
  const r = run(["dispatch", "task-orphan", "--print", "--no-brief"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /can't tell which repo task-orphan belongs to/);
  assert.match(r.stderr, /workspace hooks/);
  // Crucially, it must NOT have silently resolved into the launcher's cwd.
  assert.doesNotMatch(r.stdout, /dir:.*via cwd/);
});

test("dispatch --from-queue lands on a stampless node: refuses rather than silently using the launcher cwd", () => {
  const { home } = stamplessFixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-launcher-"));
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /can't tell which repo task-orphan belongs to/);
  assert.doesNotMatch(r.stdout, /dir:.*via cwd/);
});

test("dispatch <node-id> with no stamp + explicit --dir: the escape hatch lets it through (cwd guard is off)", () => {
  const { home } = stamplessFixture();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-target-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-launcher-"));
  const r = run(["dispatch", "task-orphan", "--dir", target, "--print", "--no-brief"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via --dir`));
  assert.doesNotMatch(r.stderr, /can't tell which repo/);
});

// A FREE-TEXT dispatch (no node) legitimately targets the launcher's cwd — that
// work IS for the current repo. The guard must not catch it (only node-mode).
test("dispatch free-text from cwd: still resolves the launcher cwd (guard is node-mode only)", () => {
  const { home } = stamplessFixture();
  const launcher = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-launcher-"));
  const r = run(["dispatch", "some free text work to do here", "--print", "--no-brief"], { SPOR_HOME: home }, launcher);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via cwd`));
  assert.doesNotMatch(r.stderr, /can't tell which repo/);
});

// --- Corrupt dispatch.repos mapping guard --------------------------------
// issue-spor-dispatch-repos-corruption-worktree-session-start: a session-start
// re-probe from a confused worktree cwd can point a slug at the WRONG checkout
// (e.g. spor-server -> the client repo). A node dispatched there runs against a
// tree lacking its files and "completes" with zero commits. Dispatch now refuses
// when a MAP-resolved (source "config") git checkout reports a different slug
// than the one looked up.

// A real git repo at <base>/<name> with one commit, so projectSlug() derives its
// slug from the dir basename (the slug convention). Returns the realpath (git and
// macOS tmp both symlink-resolve, so compare against the resolved path).
function gitRepoNamed(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-gr-"));
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  const g = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  g(["init", "-q"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "root"]);
  return { base, dir: fs.realpathSync(dir) };
}

// A scratch home with one task stamped `repo: <slug>` (so node dispatch resolves
// the target via the dispatch.repos map for that slug).
function repoStampedTaskHome(slug) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-corrupt-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-srv.md"),
    `---\nid: task-srv\ntype: task\nrepo: ${slug}\ntitle: A server-side task that must run in the ${slug} checkout\nsummary: A task stamped repo:${slug} so dispatch resolves its target dir through the dispatch.repos map.\ndate: 2026-06-02\n---\nDo the ${slug} work.\n`
  );
  return { home, nodes };
}

test("dispatch <node>: refuses a corrupt dispatch.repos mapping (slug points at the wrong checkout)", () => {
  const { home } = repoStampedTaskHome("spor-server");
  const { base, dir: clientRepo } = gitRepoNamed("spor-client"); // a real but WRONG repo
  // Corrupt the map exactly as a worktree re-probe would: spor-server -> the client repo.
  assert.strictEqual(run(["repos", "add", "spor-server", clientRepo], { SPOR_HOME: home }).status, 0);
  const r = run(["dispatch", "task-srv", "--print", "--no-brief"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /dispatch\.repos\['spor-server'\] points at .* but that checkout is 'spor-client', not 'spor-server'/);
  assert.match(r.stderr, /the slug→path map is corrupt/);
  assert.match(r.stderr, /spor repos add spor-server/);
  // It must NOT have proceeded to print the dispatch into the wrong checkout.
  assert.doesNotMatch(r.stdout, /dir:    /);
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch <node>: --force overrides the corrupt-mapping guard (loud, but proceeds)", () => {
  const { home } = repoStampedTaskHome("spor-server");
  const { base, dir: clientRepo } = gitRepoNamed("spor-client");
  run(["repos", "add", "spor-server", clientRepo], { SPOR_HOME: home });
  const r = run(["dispatch", "task-srv", "--print", "--no-brief", "--force"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /--force set — dispatching into the mismatched checkout anyway/);
  assert.match(r.stdout, new RegExp(`dir:    ${clientRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch <node>: a CORRECT git mapping passes the guard (no false positive)", () => {
  const { home } = repoStampedTaskHome("spor-server");
  const { base, dir: serverRepo } = gitRepoNamed("spor-server"); // the RIGHT repo
  run(["repos", "add", "spor-server", serverRepo], { SPOR_HOME: home });
  const r = run(["dispatch", "task-srv", "--print", "--no-brief"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${serverRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  assert.doesNotMatch(r.stderr, /map is corrupt/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch <node>: a NON-git mapped target is trusted (guard is git-checkout only)", () => {
  // The map legitimately points slugs at arbitrarily-named dirs; only a real git
  // checkout has an authoritative slug to validate against, so a non-git target
  // (here a plain tmp dir whose basename != the slug) must NOT trip the guard.
  const { home } = repoStampedTaskHome("spor-server");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-plain-")); // not git, basename != slug
  run(["repos", "add", "spor-server", plain], { SPOR_HOME: home });
  const r = run(["dispatch", "task-srv", "--print", "--no-brief"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  assert.doesNotMatch(r.stderr, /map is corrupt/);
});

test("dispatch <node>: a monorepo SUBTREE slug mapped to the shared root passes the guard", () => {
  // issue-cc-project-identity-monorepo-worktree: a subtree marker
  // (services/api/.spor -> `repo: my-api`) splits one repo into distinct slugs,
  // and session-start registers the subtree slug -> the shared git ROOT. So
  // projectSlug(root) != 'my-api' even though the mapping is CORRECT — the guard
  // must accept it via the subtree-marker scan, not refuse it.
  const { home } = repoStampedTaskHome("my-api");
  const { base, dir: root } = gitRepoNamed("platform"); // root slug != the subtree slug
  const sub = path.join(root, "services", "api");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, ".spor"), "repo: my-api\n");
  run(["repos", "add", "my-api", root], { SPOR_HOME: home });
  const r = run(["dispatch", "task-srv", "--print", "--no-brief"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*via config`));
  assert.doesNotMatch(r.stderr, /map is corrupt/);
  fs.rmSync(base, { recursive: true, force: true });
});

// --- registerRepo verify mode (the passive session-start re-probe) --------
// The auto-probe must not CLOBBER a correct mapping with the wrong checkout when
// run from a cross-repo worktree cwd, but must still fill new slugs and self-heal
// in the genuine repo (issue-spor-dispatch-repos-corruption-worktree-session-start).
function readRepos(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).dispatch.repos || {};
  } catch {
    return {};
  }
}

test("registerRepo verify: fills an unmapped slug (first contact)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-rr-"));
  const { base, dir } = gitRepoNamed("spor-server");
  assert.strictEqual(u.registerRepo(home, "spor-server", dir, { verify: true }), true);
  assert.strictEqual(readRepos(home)["spor-server"], dir);
  fs.rmSync(base, { recursive: true, force: true });
});

test("registerRepo verify: does NOT clobber a correct mapping with a foreign checkout", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-rr-"));
  const right = gitRepoNamed("spor-server");
  const wrong = gitRepoNamed("spor-client"); // a foreign repo (projectSlug != spor-server)
  assert.strictEqual(u.registerRepo(home, "spor-server", right.dir), true); // explicit: establish correct
  // The passive re-probe tries to point spor-server at the client checkout — refused.
  assert.strictEqual(u.registerRepo(home, "spor-server", wrong.dir, { verify: true }), false);
  assert.strictEqual(readRepos(home)["spor-server"], right.dir, "correct mapping preserved");
  fs.rmSync(right.base, { recursive: true, force: true });
  fs.rmSync(wrong.base, { recursive: true, force: true });
});

test("registerRepo verify: self-heals a corrupted mapping from the genuine repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-rr-"));
  const wrong = gitRepoNamed("spor-client");
  const right = gitRepoNamed("spor-server");
  // Map is already corrupt: spor-server -> the client checkout.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { repos: { "spor-server": wrong.dir } } }) + "\n");
  // A session opening in the genuine spor-server repo heals it (projectSlug(dir) === slug).
  assert.strictEqual(u.registerRepo(home, "spor-server", right.dir, { verify: true }), true);
  assert.strictEqual(readRepos(home)["spor-server"], right.dir, "healed to the genuine checkout");
  fs.rmSync(right.base, { recursive: true, force: true });
  fs.rmSync(wrong.base, { recursive: true, force: true });
});

test("registerRepo without verify: keeps last-writer-wins (explicit callers unchanged)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-rr-"));
  const right = gitRepoNamed("spor-server");
  const wrong = gitRepoNamed("spor-client");
  assert.strictEqual(u.registerRepo(home, "spor-server", right.dir), true);
  // An EXPLICIT registration (no opts) still overwrites, even to a mismatched dir.
  assert.strictEqual(u.registerRepo(home, "spor-server", wrong.dir), true);
  assert.strictEqual(readRepos(home)["spor-server"], wrong.dir, "explicit clobber preserved");
  fs.rmSync(right.base, { recursive: true, force: true });
  fs.rmSync(wrong.base, { recursive: true, force: true });
});

// --from-queue must SKIP items already in flight on this machine and advance to
// the next genuinely-free one (task-spor-dispatch-from-queue-skip-in-flight). The
// queue's lease filter is viewer-relative, so the dispatcher's own in-progress
// claim floats to the top via its `front` signal; without the skip, --from-queue
// re-picks that in-flight item and the same-machine guard refuses it. A scratch
// home with two ranked tasks (task-aaa p1 outranks task-bbb) under repo `demo`.
function twoTaskFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-fq-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-aaa.md"),
    `---\nid: task-aaa\ntype: task\nrepo: demo\npriority: p1\ntitle: First ranked task aaa\nsummary: The top-ranked task in this scratch queue, given priority p1 so it outranks task-bbb.\ndate: 2026-06-02\n---\nDo aaa.\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-bbb.md"),
    `---\nid: task-bbb\ntype: task\nrepo: demo\ntitle: Second ranked task bbb\nsummary: The runner-up task in this scratch queue, with no priority so it sits below task-aaa.\ndate: 2026-06-02\n---\nDo bbb.\n`
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-fq-repo-"));
  return { home, nodes, repo };
}

test("dispatch --from-queue: skips an item already in flight here, advances to the next", () => {
  const { home, repo } = twoTaskFixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  // task-aaa (the top item) already has a background agent in flight on this box.
  const agents = JSON.stringify([{ id: "g1", name: "task-aaa", kind: "background", status: "busy", state: "working", cwd: "/x" }]);
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: agents });
  assert.strictEqual(r.status, 0, r.stderr);
  // It must land on task-bbb, NOT the in-flight task-aaa.
  assert.match(r.stdout, /--name task-bbb/);
  assert.match(r.stdout, /Work on task-bbb/);
  assert.doesNotMatch(r.stdout, /--name task-aaa/);
  // …and say so on stderr (never-silent: report what was skipped).
  assert.match(r.stderr, /skipped 1 item\(s\) already in flight on this machine; picking task-bbb/);
});

test("dispatch --from-queue: nothing in flight picks the top item (unchanged behavior)", () => {
  const { home, repo } = twoTaskFixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: "[]" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--name task-aaa/); // p1 top item
  assert.doesNotMatch(r.stderr, /skipped/); // no skip note when nothing is in flight
});

// --from-queue must never auto-dispatch a QUESTION: questions are human
// decisions, not agent work (the standing model — agent-actionable work is a
// task). A p1 question outranks a plain task in the ranked queue, so without the
// exclusion --from-queue would pick it; it must skip it and pick the task.
test("dispatch --from-queue: excludes questions (human decisions), picks the task", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-fq-q-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "question-decide.md"),
    `---\nid: question-decide\ntype: question\nrepo: demo\npriority: p1\ntitle: A human decision that must never be auto-dispatched\nsummary: A p1 question that outranks the task in the ranked queue; --from-queue must skip it because questions are human decisions, not agent work.\nstatus: open\ndate: 2026-06-02\n---\nWhich vendor should we pick?\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-work.md"),
    `---\nid: task-work\ntype: task\nrepo: demo\ntitle: The agent-dispatchable task\nsummary: A plain task --from-queue should land on once the higher-ranked question is excluded from auto-dispatch.\ndate: 2026-06-02\n---\nDo the work.\n`
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-fq-q-repo-"));
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const r = run(["dispatch", "--from-queue", "--print"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: "[]" }, fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cwd-")));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--name task-work/);
  assert.doesNotMatch(r.stdout, /question-decide/);
});

test("dispatch --from-queue: when EVERY candidate is in flight, falls back to top so the guard refuses", () => {
  const { home, repo } = twoTaskFixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "fq-launched");
  const stub = claudeStub(home, sentinel);
  const agents = JSON.stringify([
    { id: "g1", name: "task-aaa", kind: "background", status: "busy", state: "working", cwd: "/x" },
    { id: "g2", name: "task-bbb", kind: "background", status: "busy", state: "working", cwd: "/x" },
  ]);
  const r = run(["dispatch", "--from-queue", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /task-aaa already has a background agent in flight on this machine/);
  assert.ok(!fs.existsSync(sentinel), "no agent launched when all candidates are in flight");
});

test("dispatch --backfill --print: dispatches the /spor:backfill skill, no briefing", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "--backfill", "--dir", repo, "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /name spor-backfill/);
  assert.match(r.stdout, /\/spor:backfill/);
  assert.match(r.stdout, /onboard: /); // shows the onboarding plan
});

test("dispatch --backfill --print: previews the init step and writes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb-")); // fresh: no nodes dir
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb-repo-"));
  const r = run(["dispatch", "--backfill", "--dir", repo, "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /onboard: init graph home; register /);
  assert.ok(!fs.existsSync(path.join(home, "nodes")), "print is a dry run — nothing created");
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "print wrote no config");
});

test("dispatch --backfill (local): inits the graph home and registers the repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb2-")); // fresh, uninitialized
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb2-repo-"));
  const stub = noOpClaudeStub(home);
  const r = run(["dispatch", "--backfill", "--dir", repo], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /initialized graph home/);
  assert.ok(fs.existsSync(path.join(home, "nodes")), "graph home nodes/ created");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(Object.values(cfg.dispatch.repos).includes(repo), "repo dir registered");
});

test("dispatch --backfill re-enables a previously-disabled repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb3-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-onb3-repo-"));
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: false }) + "\n");
  const stub = noOpClaudeStub(home);
  const r = run(["dispatch", "--backfill"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub }, repo); // cwd = the disabled repo
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /re-enabled Spor/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, ".spor.json"), "utf8")).enabled, true);
});

test("dispatch: unknown slug exits 1 with actionable guidance", () => {
  const { home } = fixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cwd-"));
  const r = run(["dispatch", "--node", "dec-x", "--slug", "nosuchrepo", "--print"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /don't know where 'nosuchrepo' lives/);
  assert.match(r.stderr, /spor repos add nosuchrepo/);
});

// issue-spor-dispatch-unmapped-slug-cwd-mismatch: a node's target slug that is
// NOT in dispatch.repos but EQUALS the cwd's own inferred slug must resolve to
// the cwd — you're already standing in the target repo — instead of erroring
// "run from inside that repo once" at someone who already is. A git-inited dir
// named `demo` pins its inferred slug to `demo` (= dec-x's `repo:`), with demo
// left out of dispatch.repos.
function namedRepo(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-named-")), name);
  fs.mkdirSync(dir);
  const r = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  return { dir, real: fs.realpathSync(dir) };
}

test("dispatch <node>: an unmapped slug matching the cwd's own slug resolves to the cwd (--print)", () => {
  const { home } = fixture(); // dec-x carries `repo: demo`, and demo is NOT mapped
  const { dir } = namedRepo("demo"); // cwd's inferred slug == 'demo' == dec-x's repo
  const r = run(["dispatch", "dec-x", "--no-brief", "--print"], { SPOR_HOME: home }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(slug: demo, via cwd-self\)/); // resolved to the cwd, not errored
  assert.doesNotMatch(r.stderr, /don't know where 'demo' lives/);
  assert.doesNotMatch(r.stderr, /carries no repo\/project stamp/); // nor the stampless-node guard
});

test("dispatch <node> (real): an unmapped cwd-matching slug self-registers the repo", () => {
  const { home } = fixture();
  const { real } = namedRepo("demo");
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub }, real);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "the agent launched in the cwd-resolved repo");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(slashPath(cfg.dispatch.repos.demo).endsWith("/demo"), "demo self-registered to the cwd's durable root");
});

// Real spawn through SPOR_CLAUDE_CMD: the launcher must pass --bg + flags and run
// in the resolved cwd.
test("dispatch spawns the claude binary with --bg in the target dir", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const outFile = path.join(home, "spawn.out");
  // cwd on line 1, then each argv element on its own line (the prompt is last
  // and may add extra lines — fine, we only assert on the leading flags).
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--model", "haiku"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile });
  assert.strictEqual(r.status, 0);
  const lines = fs.readFileSync(outFile, "utf8").split("\n");
  const cwd = lines[0];
  const argv = lines.slice(1);
  assert.strictEqual(cwd, fs.realpathSync(repo)); // launched in the cross-repo dir
  assert.strictEqual(argv[0], "--bg");
  assert.ok(argv.includes("--model") && argv.includes("haiku"));
  assert.ok(argv.includes("--name") && argv.includes("dec-x"));
});

// --- worktree isolation (dispatch.worktree) ------------------------------
// Run the dispatched agent in its own git worktree off the target repo so
// parallel dispatches never race the shared tree/index. Opt-in; dispatch owns
// create + setup hook + launch cwd.

// A git-inited target repo with one commit, so `git worktree add ... HEAD` works.
// The checkout dir is named `demo` so projectSlug() derives the same slug it gets
// mapped under (the slug convention) — i.e. it passes the corrupt-mapping guard
// (issue-spor-dispatch-repos-corruption-worktree-session-start).
function gitTargetRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-wtrepo-"));
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  const g = (args) => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(["init", "-q"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "x");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "root"]);
  return { repo, real: fs.realpathSync(repo), g };
}
// Merge a patch into config.json's `dispatch` block (e.g. { worktree: true }).
function setDispatch(home, patch) {
  const file = path.join(home, "config.json");
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
  data.dispatch = Object.assign(data.dispatch || {}, patch);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
// The pwd+argv-capturing claude stub (cwd on line 1, then each argv element).
function pwdStub(home) {
  return writeSpawnableNodeStub(home, "claude-pwd", `
const fs = require("node:fs");
fs.writeFileSync(process.env.OUTFILE, [process.cwd(), ...process.argv.slice(2)].join("\\n") + "\\n");
`);
}

test("dispatch --worktree --print: previews the worktree path + branch and creates nothing", () => {
  const { home } = fixture();
  const { repo } = gitTargetRepo();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const r = run(["dispatch", "dec-x", "--no-brief", "--worktree", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(r.stdout, new RegExp(`worktree: ${esc(path.join(repo, ".claude", "worktrees", "dec-x"))}\\s+\\(branch dec-x, off HEAD\\)`));
  assert.match(r.stdout, /no setup hook \(dispatch\.worktreeSetup unset\)/);
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees")), "--print created no worktree");
});

test("dispatch --worktree (stubbed): creates the worktree + branch and launches IN it, not the main checkout", () => {
  const { home } = fixture();
  const { repo, real, g } = gitTargetRepo();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const outFile = path.join(home, "spawn.out");
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief", "--worktree"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile });
  assert.strictEqual(r.status, 0, r.stderr);
  const wtDir = path.join(repo, ".claude", "worktrees", "dec-x");
  const cwd = fs.readFileSync(outFile, "utf8").split("\n")[0];
  assert.strictEqual(cwd, fs.realpathSync(wtDir), "launched inside the worktree");
  assert.notStrictEqual(cwd, real, "did NOT launch in the main checkout");
  assert.ok(fs.existsSync(wtDir), "worktree dir exists on disk");
  assert.ok(
    slashPath(g(["worktree", "list"])).includes("/.claude/worktrees/dec-x "),
    "worktree list includes the dispatch worktree"
  );
  assert.strictEqual(g(["rev-parse", "--verify", "--quiet", "refs/heads/dec-x"]).trim().length, 40, "branch dec-x created");
});

test("dispatch worktree setup hook: runs with cwd=worktree + dispatch context env, before launch", () => {
  const { home } = fixture();
  const { repo } = gitTargetRepo();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  // Hook drops a sentinel (proves cwd=worktree) recording SPOR_MAIN_CHECKOUT +
  // SPOR_DISPATCH_NODE (proves the context env reached it).
  const hook = path.join(home, "wt-setup.js");
  fs.writeFileSync(hook, `
const fs = require("node:fs");
fs.writeFileSync(".wt-setup-ran", process.env.SPOR_MAIN_CHECKOUT + "\\n" + process.env.SPOR_DISPATCH_NODE + "\\n");
`);
  setDispatch(home, { worktree: true, worktreeSetup: `node ${JSON.stringify(hook)}` });
  const outFile = path.join(home, "spawn.out");
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile });
  assert.strictEqual(r.status, 0, r.stderr);
  const sentinel = path.join(repo, ".claude", "worktrees", "dec-x", ".wt-setup-ran");
  assert.ok(fs.existsSync(sentinel), "setup hook ran in the worktree (cwd=worktree)");
  const [mainCheckout, node] = fs.readFileSync(sentinel, "utf8").split("\n");
  assert.strictEqual(mainCheckout, repo, "SPOR_MAIN_CHECKOUT reached the hook");
  assert.strictEqual(node, "dec-x", "SPOR_DISPATCH_NODE reached the hook");
  assert.match(r.stdout, /setup ran/);
});

test("dispatch --no-worktree overrides dispatch.worktree=true: launches in the main checkout, no worktree", () => {
  const { home } = fixture();
  const { repo, real } = gitTargetRepo();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  setDispatch(home, { worktree: true });
  const outFile = path.join(home, "spawn.out");
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief", "--no-worktree"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile });
  assert.strictEqual(r.status, 0, r.stderr);
  const cwd = fs.readFileSync(outFile, "utf8").split("\n")[0];
  assert.strictEqual(cwd, real, "launched in the main checkout");
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees")), "no worktree created");
});

test("dispatch worktree setup hook failure: aborts, removes the worktree + branch, launches nothing", () => {
  const { home } = fixture();
  const { repo, g } = gitTargetRepo();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const failHook = writeSpawnableNodeStub(home, "fail", "process.exit(3);");
  setDispatch(home, { worktree: true, worktreeSetup: failHook });
  const mark = path.join(home, "launched.mark");
  const stub = recordingStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark });
  assert.notStrictEqual(r.status, 0, "non-zero exit on setup failure");
  assert.match(r.stderr, /setup hook failed/);
  assert.ok(!fs.existsSync(mark), "agent never launched");
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", "dec-x")), "half-prepped worktree removed");
  // rev-parse --verify --quiet exits non-zero (no output) once the branch is gone
  // — a raw call, since the asserting g() would throw on that expected miss.
  const branchCheck = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/dec-x"], { encoding: "utf8" });
  assert.notStrictEqual(branchCheck.status, 0, "branch removed (rev-parse misses)");
});

test("dispatch --backfill --print: worktree forced off even with dispatch.worktree=true", () => {
  const { home, repo } = fixture();
  setDispatch(home, { worktree: true });
  const r = run(["dispatch", "--backfill", "--print", "--dir", repo], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /worktree:/, "backfill onboards the main checkout, never a worktree");
});

// --- per-target-repo scoping: the TARGET repo's committable .spor.json --------
// A cross-repo dispatch (standing somewhere else) honors the TARGET repo's own
// dispatch.worktree[/Setup], since the cfg cascade only sees the dispatcher cwd.

test("dispatch (cross-repo): honors the TARGET repo's .spor.json dispatch.worktree, not the standing config", () => {
  const { home } = fixture();
  const { repo } = gitTargetRepo();
  // The target repo declares it wants isolation; the standing config does NOT.
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktree: true } }) + "\n");
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-elsewhere-"));
  const outFile = path.join(home, "spawn.out");
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile }, elsewhere);
  assert.strictEqual(r.status, 0, r.stderr);
  const cwd = fs.readFileSync(outFile, "utf8").split("\n")[0];
  assert.strictEqual(cwd, fs.realpathSync(path.join(repo, ".claude", "worktrees", "dec-x")), "launched in the worktree per target .spor.json");
});

test("dispatch (cross-repo): a relative dispatch.worktreeSetup in the target .spor.json resolves against the repo", () => {
  const { home } = fixture();
  const { repo } = gitTargetRepo();
  fs.mkdirSync(path.join(repo, "scripts"));
  const setup = writeSpawnableNodeStub(path.join(repo, "scripts"), "wt-setup", "require('node:fs').writeFileSync('./.ran', 'ran\\n');");
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktree: true, worktreeSetup: path.relative(repo, setup) } }) + "\n");
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-elsewhere-"));
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: path.join(home, "o.out") }, elsewhere);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(repo, ".claude", "worktrees", "dec-x", ".ran")), "relative setup hook ran (resolved against the repo dir)");
});

test("dispatch --no-worktree overrides the target repo's .spor.json dispatch.worktree", () => {
  const { home } = fixture();
  const { repo, real } = gitTargetRepo();
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktree: true } }) + "\n");
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-elsewhere-"));
  const outFile = path.join(home, "spawn.out");
  const stub = pwdStub(home);
  const r = run(["dispatch", "dec-x", "--no-brief", "--no-worktree"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, OUTFILE: outFile }, elsewhere);
  assert.strictEqual(r.status, 0, r.stderr);
  const cwd = fs.readFileSync(outFile, "utf8").split("\n")[0];
  assert.strictEqual(cwd, real, "launched in the main checkout despite the target asking for a worktree");
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees")), "no worktree created");
});

// --- profile satisfiability gate (dec-spor-machine-profile-satisfiability) ---
// Dispatch resolves the profile it would run under (--profile > assigned->agent
// edge attr > agent default) and refuses soft-and-loud when THIS machine can't
// satisfy it, leaving the assignment intact and launching nothing.
function writeProfile(nodes, id, fields) {
  fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\ntype: profile\ntitle: ${id}\nsummary: A test profile.\n${fields}\ndate: 2026-06-18\n---\nA test profile.\n`);
}
function setCaps(home, capabilities) {
  const file = path.join(home, "config.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* fresh */
  }
  data.dispatch = data.dispatch || {};
  data.dispatch.capabilities = capabilities;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
// A claude stub that records its launch into LAUNCH_MARK, so a test can assert a
// refused dispatch NEVER launched.
function recordingStub(home) {
  return writeSpawnableNodeStub(home, "claude-rec", `
require("node:fs").writeFileSync(process.env.LAUNCH_MARK, "launched\\n");
`);
}
// A clean HOME (no ~/.claude manifest) + a harness-free PATH (only git, for the
// config load's git shell-outs), so the satisfiability re-probe `spor dispatch`
// now runs (task-spor-dispatch-fresh-probe-before-satisfiability) yields a
// DETERMINISTIC set on ANY box: empty harnesses/plugins/skills, with reachable_mcp
// seeded to [spor] only in remote mode. Mirrors cleanProbeEnv() in
// capabilities-publish.test.js — without pinning HOME/PATH the probe reads this
// box's REAL harnesses (a dev box with `codex` on PATH flips a "harness not
// available here" assertion) + ~/.claude plugins/skills. Merge into a test's env.
function cleanProbeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cleanhome-"));
  return { HOME: home, PATH: pathWithOnlyGit() };
}

test("dispatch --profile: refuses when this machine can't satisfy it; nothing launches, assignment untouched", () => {
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  setCaps(home, { declared: { harnesses: ["claude-code"] } }); // codex NOT available here
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const r = run(["dispatch", "dec-x", "--dir", repo, "--profile", "profile-codex", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /can't satisfy profile profile-codex/);
  assert.match(r.stderr, /harness 'codex' not available here \(codex not on PATH\)/);
  assert.match(r.stderr, /assignment is unchanged/);
  assert.ok(!fs.existsSync(mark), "claude was never launched");
});

test("dispatch --profile: a satisfiable profile dispatches normally", () => {
  const { home, nodes, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  writeProfile(nodes, "profile-cc", "harness: claude-code\nplugins: [spor]");
  setCaps(home, { declared: { harnesses: ["claude-code"], plugins: ["spor"] } });
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const r = run(["dispatch", "dec-x", "--profile", "profile-cc", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark });
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(mark), "claude launched for a satisfiable profile");
});

test("dispatch --profile: an unknown profile id is a hard error before any launch", () => {
  const { home, repo } = fixture();
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const r = run(["dispatch", "dec-x", "--dir", repo, "--profile", "profile-nope", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not load profile profile-nope/);
  assert.ok(!fs.existsSync(mark));
});

test("dispatch <node>: the assigned->agent edge profile attr is honored (no --profile)", () => {
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  // task-rotate is assigned to an agent UNDER profile-codex — unsatisfiable here.
  fs.writeFileSync(
    path.join(nodes, "task-rotate.md"),
    `---\nid: task-rotate\ntype: task\nrepo: demo\ntitle: Rotate tokens\nsummary: Rotate pipeline auth tokens.\ndate: 2026-06-02\nedges:\n  - {type: assigned, to: agent-test, profile: profile-codex}\n---\nBody.\n`
  );
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const r = run(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /can't satisfy profile profile-codex \(via assigned → agent-test\)/);
  assert.ok(!fs.existsSync(mark));
});

test("dispatch <node>: falls back to the assigned agent's default uses-profile", () => {
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  // An agent whose DEFAULT profile (uses-profile) is unsatisfiable here.
  fs.writeFileSync(
    path.join(nodes, "agent-test.md"),
    `---\nid: agent-test\ntype: agent\ntitle: Test agent\nsummary: A test agent.\ndate: 2026-06-18\nedges:\n  - {type: uses-profile, to: profile-codex}\n---\nAgent.\n`
  );
  // task-rotate assigned to agent-test with NO per-assignment profile override.
  fs.writeFileSync(
    path.join(nodes, "task-rotate.md"),
    `---\nid: task-rotate\ntype: task\nrepo: demo\ntitle: Rotate tokens\nsummary: Rotate pipeline auth tokens.\ndate: 2026-06-02\nedges:\n  - {type: assigned, to: agent-test}\n---\nBody.\n`
  );
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const r = run(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /can't satisfy profile profile-codex \(via agent-test default\)/);
  assert.ok(!fs.existsSync(mark));
});

test("dispatch --print --profile: previews the verdict and writes nothing", () => {
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const r = run(["dispatch", "dec-x", "--dir", repo, "--profile", "profile-codex", "--no-brief", "--print"], { SPOR_HOME: home, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 0); // --print never fails
  assert.match(r.stdout, /profile: profile-codex \(via --profile\) — UNSATISFIABLE here/);
  assert.match(r.stdout, /harness 'codex' not available here/);
});

test("dispatch: no profile resolved => byte-identical (no profile line)", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(!/profile:/.test(r.stdout), "no profile preview line when none resolves");
});

// --- substitution-free re-routing CONSUMER (task-spor-fleet-scheduler-autoroute-
// dispatch) --- When THIS box can't satisfy the resolved profile, the remote-mode
// refusal CONSUMES the fleet scheduler (GET /v1/profiles/{id}/hosts): it NAMES the
// boxes that can run THIS exact profile (re-route there) or, when none can,
// escalates to the owner — FORK B, never a substitute. Fail-soft: an unreachable
// scheduler falls back to the generic hint and local mode stays byte-identical.
const PROFILE_MD = (id, fields) =>
  `---\nid: ${id}\ntype: profile\ntitle: ${id}\nsummary: A test profile.\n${fields}\ndate: 2026-06-18\n---\nBody.\n`;

// A fake server that serves the profile node and a scriptable /hosts host-match.
function fleetStub({ hosts, hostsStatus = 200 } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const pm = req.url.match(/^\/v1\/nodes\/([^/?]+)/);
    if (pm && req.method === "GET") {
      const id = decodeURIComponent(pm[1]);
      if (id === "profile-codex") return j(200, { id, raw: PROFILE_MD("profile-codex", "harness: codex") });
      // An mcp:[spor] profile — satisfiable on ANY remote box by construction,
      // since the fresh re-probe seeds reachable_mcp:[spor] in remote mode
      // (task-spor-dispatch-fresh-probe-before-satisfiability).
      if (id === "profile-spor") return j(200, { id, raw: PROFILE_MD("profile-spor", "mcp: [spor]") });
      return j(404, { error: { code: "not_found" } });
    }
    const hm = req.url.match(/^\/v1\/profiles\/([^/?]+)\/hosts/);
    if (hm && req.method === "GET") {
      if (hostsStatus !== 200) return j(hostsStatus, { error: { code: "not_found", message: "x" } });
      return j(200, hosts || { profile: decodeURIComponent(hm[1]), satisfiable: [], unsatisfiable: [], counts: {} });
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteCapEnv = (home, base, extra = {}) => ({
  SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra,
});
// Async runner — the in-process fake server can't answer the child's HTTP
// request while spawnSync blocks the event loop, so the remote tests spawn
// async (the same reason capabilities-publish.test.js does).
function runAsyncDisp(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

test("dispatch (remote, unsatisfiable): names the fleet hosts that satisfy the profile", async () => {
  const { home, repo } = fixture();
  setCaps(home, { declared: { harnesses: ["claude-code"] } }); // codex NOT here
  const stub = recordingStub(home);
  const mark = path.join(home, "launched.mark");
  const { srv, hits, base } = await fleetStub({
    hosts: {
      profile: "profile-codex",
      satisfiable: [
        { agent: "agent-bob-laptop", owner: "person-bob", age_seconds: 120 },
        { agent: "agent-carol-ci", owner: "person-carol", age_seconds: 4000 },
      ],
      unsatisfiable: [{ agent: "agent-mine", owner: "person-me", age_seconds: 5, reasons: ["harness 'codex' not available here"] }],
      counts: { satisfiable: 2, unsatisfiable: 1 },
    },
  });
  try {
    const r = await runAsyncDisp(["dispatch", "do a thing here", "--dir", repo, "--profile", "profile-codex", "--no-brief"],
      remoteCapEnv(home, base, { SPOR_CLAUDE_CMD: stub, LAUNCH_MARK: mark, ...cleanProbeEnv() }));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /can't satisfy profile profile-codex/);
    // CONSUMES the scheduler: names the satisfiable hosts as re-route targets…
    assert.match(r.stderr, /Re-route to a fleet host that satisfies profile-codex/);
    assert.match(r.stderr, /agent-bob-laptop \(person-bob, 2m ago\)/);
    assert.match(r.stderr, /agent-carol-ci \(person-carol, 1h ago\)/);
    assert.match(r.stderr, /it runs THIS profile, never a substitute/);
    // …and it actually hit the host-match endpoint, launched nothing.
    assert.ok(hits.some((h) => h.method === "GET" && /^\/v1\/profiles\/profile-codex\/hosts/.test(h.url)), "called /hosts");
    assert.ok(!fs.existsSync(mark), "claude was never launched");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, unsatisfiable, no host satisfies): escalates to the owner (FORK B)", async () => {
  const { home, repo } = fixture();
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const { srv, base } = await fleetStub({
    hosts: { profile: "profile-codex", satisfiable: [], unsatisfiable: [
      { agent: "agent-a", owner: "person-x", age_seconds: 10, reasons: ["harness 'codex' not available here"] },
      { agent: "agent-b", owner: "person-y", age_seconds: 20, reasons: ["harness 'codex' not available here"] },
    ], counts: { satisfiable: 0, unsatisfiable: 2 } },
  });
  try {
    const r = await runAsyncDisp(["dispatch", "do a thing here", "--dir", repo, "--profile", "profile-codex", "--no-brief"], remoteCapEnv(home, base, cleanProbeEnv()));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /NO fleet host currently satisfies profile-codex — escalate to the owner/);
    assert.match(r.stderr, /2 box\(es\) checked; none satisfy it/);
    assert.match(r.stderr, /never substituted/);
  } finally {
    srv.close();
  }
});

test("dispatch (remote, unsatisfiable): a scheduler outage falls back to the generic hint (fail-soft)", async () => {
  const { home, repo } = fixture();
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  // The profile node resolves, but the /hosts route 404s (undeployed surface).
  const { srv, base } = await fleetStub({ hostsStatus: 404 });
  try {
    const r = await runAsyncDisp(["dispatch", "do a thing here", "--dir", repo, "--profile", "profile-codex", "--no-brief"], remoteCapEnv(home, base, cleanProbeEnv()));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /can't satisfy profile profile-codex/);
    // falls back to the original generic re-route hint
    assert.match(r.stderr, /assignment is unchanged. Re-route to a machine that satisfies it/);
    assert.doesNotMatch(r.stderr, /Re-route to a fleet host/);
  } finally {
    srv.close();
  }
});

test("dispatch (remote, unsatisfiable): a 403 (steward-scoped) is reported as an authorization denial, then degrades to the generic hint", async () => {
  const { home, repo } = fixture();
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  // The /hosts route 403s (host visibility is steward-scoped, API.md §3). It must
  // NOT be reported as a scheduler outage (issue-spor-capabilities-hosts-403-misreported).
  const { srv, base } = await fleetStub({ hostsStatus: 403 });
  try {
    const r = await runAsyncDisp(["dispatch", "do a thing here", "--dir", repo, "--profile", "profile-codex", "--no-brief"], remoteCapEnv(home, base, cleanProbeEnv()));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /can't satisfy profile profile-codex/);
    assert.match(r.stderr, /not authorized to list fleet hosts for profile-codex/);
    assert.match(r.stderr, /steward-scoped/);
    assert.doesNotMatch(r.stderr, /fleet scheduler unavailable/);
    // still degrades to the original generic re-route hint
    assert.match(r.stderr, /assignment is unchanged. Re-route to a machine that satisfies it/);
  } finally {
    srv.close();
  }
});

test("dispatch (local, unsatisfiable): byte-identical — no scheduler consult", () => {
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const r = run(["dispatch", "dec-x", "--dir", repo, "--profile", "profile-codex", "--no-brief"], { SPOR_HOME: home, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /assignment is unchanged. Re-route to a machine that satisfies it/);
  assert.doesNotMatch(r.stderr, /fleet host/); // local mode never consults the scheduler
});

// --- fresh re-probe before the satisfiability check
// (task-spor-dispatch-fresh-probe-before-satisfiability) --- The satisfiability
// gate re-probes THIS box (like the session-start auto-publish + manual
// `spor capabilities publish`) before collapsing capabilities, so a box whose
// .probed is empty/stale still satisfies an `mcp:[spor]` profile it can run.
test("dispatch (remote): an mcp:[spor] profile satisfies on a box with EMPTY .probed — the fresh re-probe seeds reachable_mcp:[spor]", async () => {
  const { home, repo } = fixture();
  // No prior session-start: .probed is absent and reachable_mcp is UNDECLARED.
  // Before the fix this collapsed to an empty reachable_mcp and the mcp:[spor]
  // profile was wrongly UNSATISFIABLE here; the re-probe now seeds it (remote).
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const { srv, base } = await fleetStub();
  try {
    const r = await runAsyncDisp(
      ["dispatch", "do a thing here", "--dir", repo, "--profile", "profile-spor", "--no-brief", "--print"],
      remoteCapEnv(home, base, cleanProbeEnv())
    );
    assert.strictEqual(r.status, 0, r.stderr); // --print never fails
    assert.match(r.stdout, /profile: profile-spor \(via --profile\) — satisfiable here/);
    assert.doesNotMatch(r.stdout, /UNSATISFIABLE/);
  } finally {
    srv.close();
  }
});

test("dispatch (local): the same mcp:[spor] profile is UNSATISFIABLE on an empty box — the spor seed is REMOTE-gated (no server bound)", () => {
  // The gate: the re-probe seeds reachable_mcp:[spor] only when a server is bound
  // (cfg.mode() === "remote"). In local mode there is no spor MCP by construction,
  // so an mcp:[spor] profile with no declared reachable_mcp stays unsatisfiable —
  // the user must declare it (spor capabilities allow-mcp spor).
  const { home, nodes, repo } = fixture();
  writeProfile(nodes, "profile-spor", "mcp: [spor]");
  setCaps(home, { declared: { harnesses: ["claude-code"] } });
  const r = run(["dispatch", "dec-x", "--dir", repo, "--profile", "profile-spor", "--no-brief", "--print"], { SPOR_HOME: home, ...cleanProbeEnv() });
  assert.strictEqual(r.status, 0); // --print never fails
  assert.match(r.stdout, /profile: profile-spor \(via --profile\) — UNSATISFIABLE here/);
  assert.match(r.stdout, /MCP server\(s\) not available here: spor/);
});

// --- user-supplied prompt templates (task-spor-dispatch-user-prompt-templates)
// `--template F` replaces the default prompt assembly with the file's contents,
// substituting Handlebars-style {{placeholder}} tokens from the dispatch context.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const promptOf = (stdout) => stdout.slice(stdout.indexOf("--- prompt ---"));

test("dispatch --template (free text): substitutes {{slug}}/{{dir}}/{{task}}/{{brief}}, takes over the default", () => {
  const { home, repo } = fixture();
  const tpl = path.join(home, "t.tpl");
  fs.writeFileSync(tpl, "SLUG={{slug}} DIR={{dir}}\nTASK: {{task}}\nBRIEF>>>{{brief}}<<<\n");
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--slug", "demo", "--template", tpl, "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  const prompt = promptOf(r.stdout);
  assert.match(prompt, new RegExp(`SLUG=demo DIR=${esc(repo)}`));
  assert.match(prompt, /TASK: auth token rotation credentials/);
  // the compiled digest (which mentions the fixture nodes) landed inside the markers
  assert.match(prompt, /BRIEF>>>[\s\S]*dec-x[\s\S]*<<</);
  // the built-in wrapper is gone — the template fully controls the prompt
  assert.doesNotMatch(prompt, /# Spor briefing \(compiled/);
  // --print announces which template was used
  assert.match(r.stdout, new RegExp(`template: ${esc(tpl)}`));
});

test("dispatch --template (node mode): fills {{node}} and {{title}}", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const tpl = path.join(home, "n.tpl");
  fs.writeFileSync(tpl, "NODE={{node}}\nTITLE={{title}}\n");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-cwd-"));
  const r = run(["dispatch", "dec-x", "--template", tpl, "--print"], { SPOR_HOME: home }, elsewhere);
  assert.strictEqual(r.status, 0);
  const prompt = promptOf(r.stdout);
  assert.match(prompt, /NODE=dec-x/);
  assert.match(prompt, /TITLE=A demo decision about auth token rotation/);
});

test("dispatch --template: {{default}} embeds the built-in prompt; unknown placeholders warn and blank out", () => {
  const { home, repo } = fixture();
  const tpl = path.join(home, "w.tpl");
  fs.writeFileSync(tpl, "PRE\n{{default}}\nPOST {{bogus}}END\n");
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--template", tpl, "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  const prompt = promptOf(r.stdout);
  // default prompt embedded verbatim — now led by the session-project note
  // (issue-spor-dispatch-propagate-session-project-to-questions), then the briefing.
  assert.match(prompt, /PRE\n> \*\*Spor session project:\*\*/);
  assert.match(prompt, /# Spor briefing \(compiled/);
  assert.match(prompt, /POST END/); // {{bogus}} stripped to ""
  assert.match(r.stderr, /unknown template placeholder\(s\): bogus/);
});

test("dispatch: a {{default}}-only template reproduces the default prompt byte-for-byte", () => {
  const { home, repo } = fixture();
  const base = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--print"], { SPOR_HOME: home });
  const tpl = path.join(home, "id.tpl");
  fs.writeFileSync(tpl, "{{default}}");
  const withTpl = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--template", tpl, "--print"], { SPOR_HOME: home });
  assert.strictEqual(promptOf(withTpl.stdout), promptOf(base.stdout));
});

test("dispatch: dispatch.template config supplies a default template when --template is absent", () => {
  const { home, repo } = fixture();
  const tpl = path.join(home, "cfg.tpl");
  fs.writeFileSync(tpl, "CFGTPL task={{task}}\n");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { template: tpl } }) + "\n");
  // cwd = the (markerless) repo so the cascade can't pick up a stray ancestor .spor.json
  const r = run(["dispatch", "auth token rotation credentials", "--dir", repo, "--print"], { SPOR_HOME: home }, repo);
  assert.strictEqual(r.status, 0);
  assert.match(promptOf(r.stdout), /CFGTPL task=auth token rotation credentials/);
});

test("dispatch --template with an unreadable path exits 1 before compiling", () => {
  const { home, repo } = fixture();
  const r = run(["dispatch", "some task text here please", "--dir", repo, "--template", path.join(home, "nope.tpl"), "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not read --template/);
});

// --- remote auto-claim (task-spor-dispatch-auto-claim) ---------------------
// A node dispatch in REMOTE mode establishes the claim/lease at dispatch time
// via POST /v1/nodes/{id}/claim, so concurrent dispatch of the same node is
// refused before a duplicate agent launches. Driven through the real CLI against
// an in-process stub server; the bg launch is a stub that drops a sentinel file
// so we can assert whether it ran. Posix-only (the claude stub is a shell
// script). spawnSync would block the loop and starve the stub, so these spawn
// async (mirrors test/claim-nudge.test.js).

// Env that forces REMOTE mode (SPOR_SERVER + token), isolating the config homes
// so the dev's real ~/.spor can't leak in. `extra` (e.g. SPOR_CLAUDE_CMD) wins.
function remoteEnv(home, server, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = home;
  env.XDG_CONFIG_HOME = home;
  env.SPOR_SERVER = server;
  env.SPOR_TOKEN = "test-token";
  // Empty agent list by default (see bare()), so the same-machine guard never
  // shells out to a real `claude agents --json`; a guard test overrides via extra.
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  return Object.assign(env, extra);
}

function runAsync(args, env, cwd) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// Stub server: answers GET /v1/nodes/{id} (so node resolution succeeds, any id),
// and POST /v1/nodes/{id}/claim with a caller-chosen status/body. Records hits.
// `nodeStatus`/`nodeResolution` shape the GET node to exercise the resolved-task
// guard: a terminal `status:` line and/or the server's `resolution` enrichment
// (the inbound resolves/answers edge it surfaces, API.md §3). `nodeRequires`/
// `nodeHeld` exercise the readiness guard (task-spor-dispatch-readiness-guard):
// a `requires:` frontmatter line and/or the server's `held` get()-hook
// enrichment (schema-task.md).
function claimStub({ claimStatus = 200, claimBody = null, nodeStatus = null, nodeResolution = null, nodeRequires = null, nodeHeld = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      if (req.method === "GET" && /^\/v1\/nodes\/[^/]+$/.test(req.url)) {
        const id = decodeURIComponent(req.url.split("/").pop());
        const statusLine = nodeStatus ? `\nstatus: ${nodeStatus}` : "";
        const requiresLine = nodeRequires ? `\nrequires: [${nodeRequires}]` : "";
        const node = { raw: `---\nid: ${id}\ntype: task\nrepo: demo${statusLine}${requiresLine}\ntitle: Demo task ${id}\nsummary: A demo task.\ndate: 2026-06-01\n---\nbody\n` };
        if (nodeResolution) node.resolution = nodeResolution;
        if (nodeHeld) node.held = nodeHeld;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(node));
        return;
      }
      if (req.method === "POST" && /^\/v1\/nodes\/[^/]+\/claim$/.test(req.url)) {
        res.writeHead(claimStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(claimBody || { ok: true, status: "claimed", lease: { by: "person-anthony" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

// A claude stub that records its launch by touching `sentinel`, then exits 0.
function claudeStub(dir, sentinel) {
  return writeSpawnableNodeStub(dir, "claude-claim", `
require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "launched\\n");
`);
}
const claimHit = (hits) => hits.find((h) => h.method === "POST" && /\/claim$/.test(h.url));

test("dispatch <node-id> (remote): auto-claims the node, then launches the agent", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    const claim = claimHit(hits);
    assert.ok(claim, "POST .../claim was sent");
    assert.match(claim.url, /^\/v1\/nodes\/task-rotate\/claim$/);
    assert.match(r.stdout, /claimed task-rotate/);
    assert.ok(fs.existsSync(sentinel), "the bg agent launched after the claim");
  } finally {
    srv.close();
  }
});

// inc-spor-dispatch-duplicate-task-2026-06-18: the claim carries a per-invocation
// `dispatch` nonce so the server refuses a SECOND concurrent dispatch of the same
// node — even by the same person, on any machine — instead of treating it as the
// person-scoped idempotent renew that let two agents launch on one task.
test("dispatch <node-id> (remote): the claim carries a per-invocation dispatch nonce", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    const claim = claimHit(hits);
    assert.ok(claim, "POST .../claim was sent");
    const body = JSON.parse(claim.body || "{}");
    assert.ok(body.dispatch && typeof body.dispatch === "string", "the claim body carries a dispatch nonce");
  } finally {
    srv.close();
  }
});

test("dispatch --force (remote): omits the dispatch nonce so a deliberate re-dispatch renews", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--force"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    const claim = claimHit(hits);
    assert.ok(claim, "the claim was still attempted");
    const body = JSON.parse(claim.body || "{}");
    assert.ok(!("dispatch" in body), "--force omits the nonce so the claim renews instead of conflicting");
  } finally {
    srv.close();
  }
});

test("dispatch (remote): a node already claimed by another aborts WITHOUT launching", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({
    claimStatus: 409,
    claimBody: { error: { code: "conflict", message: "claimed by person-bob until 2026-06-16T16:00:00Z" } },
  });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1);
    assert.ok(claimHit(hits), "the claim was attempted");
    assert.match(r.stderr, /already claimed/);
    assert.match(r.stderr, /person-bob/); // the holder is surfaced
    assert.match(r.stderr, /--no-claim/); // and the override is suggested
    assert.ok(!fs.existsSync(sentinel), "no duplicate agent was launched");
  } finally {
    srv.close();
  }
});

test("dispatch --no-claim (remote): skips the claim entirely and launches", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--no-claim"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!claimHit(hits), "no claim attempted with --no-claim");
    assert.doesNotMatch(r.stdout, /claimed task-rotate/);
    assert.ok(fs.existsSync(sentinel), "the agent still launched");
  } finally {
    srv.close();
  }
});

test("dispatch free-text (remote): no node to claim, so no claim is attempted", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "some free text task here", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!claimHit(hits), "free-text dispatch claims nothing");
    assert.ok(fs.existsSync(sentinel), "the agent launched");
  } finally {
    srv.close();
  }
});

test("dispatch (remote): a claim server error warns but still dispatches (fail-open)", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 500, claimBody: { error: { code: "internal", message: "boom" } } });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(claimHit(hits), "the claim was attempted");
    assert.match(r.stderr, /could not establish a lease/);
    assert.match(r.stderr, /internal/); // the failure code is surfaced
    assert.ok(fs.existsSync(sentinel), "dispatch proceeds despite the outage");
  } finally {
    srv.close();
  }
});

test("dispatch --print (remote node): previews the auto-claim and writes nothing", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  try {
    const r1 = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--print"], remoteEnv(home, base));
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /claim:  would establish a lease on task-rotate at launch \(session bound from the run after launch\)/);
    assert.ok(!claimHit(hits), "--print is side-effect-free — no claim POSTed");

    const r2 = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--no-claim", "--print"], remoteEnv(home, base));
    assert.match(r2.stdout, /claim:  \(--no-claim/);
  } finally {
    srv.close();
  }
});

// REMOTE --from-queue pushes the question exclusion DOWN to the ranker: the
// /v1/queue fetch carries exclude_type=question, so the candidate page is a full
// LIMIT of actionable work rather than LIMIT-minus-questions (a page crowded by
// top-ranked questions could otherwise starve the in-flight skip). Asserts the
// request the client actually sends, and that it lands on the returned task.
// (issue-spor-dispatch-from-queue-dispatches-questions — the preferred fix;
// the local-mode counterpart is exercised by the excludes-questions test above.)
test("dispatch --from-queue (remote): queue fetch excludes questions at the ranker (exclude_type=question)", async () => {
  const { home, repo } = fixture();
  const queueHits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/queue")) {
        queueHits.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ id: "task-foo", type: "task", project: "demo", repo: "demo", title: "The actionable task" }] }));
        return;
      }
      if (req.method === "GET" && /^\/v1\/nodes\/[^/]+$/.test(req.url)) {
        const id = decodeURIComponent(req.url.split("/").pop());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: `---\nid: ${id}\ntype: task\nrepo: demo\ntitle: The actionable task\nsummary: A demo task.\ndate: 2026-06-01\n---\nbody\n` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    run(["repos", "add", "demo", repo], { SPOR_HOME: home }); // map the slug so resolveDir lands the dispatch
    const r = await runAsync(["dispatch", "--from-queue", "--no-brief", "--print"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(queueHits.length, "GET /v1/queue was sent");
    assert.match(queueHits[0], /exclude_type=question/);
    assert.match(r.stdout, /--name task-foo/);
  } finally {
    srv.close();
  }
});

// --from-queue must HARD-SKIP a held task (dec-spor-dispatch-from-queue-skip-held):
// the held-task self-limit damps its front and flags it suggest:triage (an open
// task with a recorded non-resolving outcome, no resolver, no blocker — held on an
// external gate). It stays demoted-but-dispatchable so a held p1/blocking item can
// still top the page, but --from-queue dispatches an AGENT to DO work and a held
// task awaits a triage decision, not re-work — auto-dispatching it re-enters the
// churn the self-limit broke. The client filter drops it (reading the suggest the
// ranker set) and advances to the next actionable item, exactly like the blocked
// defense above. A server returns the held item top-ranked, a plain task below it.
test("dispatch --from-queue (remote): hard-skips a held task (suggest:triage), advances to the next", async () => {
  const { home, repo } = fixture();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/queue")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [
          { id: "task-held", type: "task", project: "demo", repo: "demo", title: "A held task nothing resolves", suggest: "triage" },
          { id: "task-do", type: "task", project: "demo", repo: "demo", title: "The actionable task", suggest: "do" },
        ] }));
        return;
      }
      if (req.method === "GET" && /^\/v1\/nodes\/[^/]+$/.test(req.url)) {
        const id = decodeURIComponent(req.url.split("/").pop());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: `---\nid: ${id}\ntype: task\nrepo: demo\ntitle: The actionable task\nsummary: A demo task.\ndate: 2026-06-01\n---\nbody\n` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    run(["repos", "add", "demo", repo], { SPOR_HOME: home });
    const r = await runAsync(["dispatch", "--from-queue", "--no-brief", "--print"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /--name task-do/);
    assert.doesNotMatch(r.stdout, /task-held/);
  } finally {
    srv.close();
  }
});

// When every candidate is held, --from-queue picks nothing and exits 1 ("queue
// empty") — the held task stays visible in `spor next` for a human to triage, but
// AUTOMATIC dispatch never re-picks it (same shape as the blocked/question drops).
test("dispatch --from-queue (remote): a held-only queue dispatches nothing (exits 1)", async () => {
  const { home, repo } = fixture();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/queue")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [
          { id: "task-held", type: "task", project: "demo", repo: "demo", title: "The only item, and it is held", suggest: "triage" },
        ] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    run(["repos", "add", "demo", repo], { SPOR_HOME: home });
    const r = await runAsync(["dispatch", "--from-queue", "--no-brief", "--print"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /queue empty/);
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> (local): no lease, no claim line — byte-identical", async () => {
  // Local mode has no pool/contention; the auto-claim is a no-op and emits no
  // claim line, keeping local node dispatch output unchanged.
  const { home, repo } = fixture();
  const r = run(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /^claim:/m);
});

// --- same-machine duplicate-dispatch guard (task-spor-dispatch-same-machine-guard)
// `spor dispatch` names each background agent after its node id, so a node whose
// agent is already in flight on THIS machine is a duplicate the auto-claim can't
// catch (a same-person re-claim is an idempotent renew). dispatchedAgents() —
// the same NO-LLM, fail-soft cross-reference `spor next --hide-dispatched` uses,
// fed here via SPOR_FAKE_AGENTS_JSON — gates the launch; --force overrides. The
// guard is node mode only and runs in BOTH local and remote (it's a local read).
const inFlightAgent = (name, extra = {}) =>
  JSON.stringify([{ id: "g1", name, kind: "background", status: "busy", state: "working", cwd: "/x", ...extra }]);

test("dispatch <node-id> (local): a same-named agent already in flight refuses, no launch", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("dec-x") });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /dec-x already has a background agent in flight on this machine/);
  assert.match(r.stderr, /g1 \(working\)/); // the live agent is named
  assert.match(r.stderr, /--force/); // the override is suggested
  assert.ok(!fs.existsSync(sentinel), "no duplicate agent was launched");
});

test("dispatch <node-id> --force (local): launches despite an agent in flight", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "dec-x", "--no-brief", "--force"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("dec-x") });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "the agent launched with --force");
});

test("dispatch <node-id> (local): a DONE same-named agent is not in flight — dispatch proceeds", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const agents = inFlightAgent("dec-x", { status: "idle", state: "done" });
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "a finished agent does not block dispatch");
});

test("dispatch free-text (local): NOT guarded even if an agent shares the derived name (node mode only)", () => {
  const { home, repo } = fixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  // free-text name derives from the first words: "alpha beta gamma"
  const r = run(["dispatch", "alpha beta gamma", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("alpha beta gamma") });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "free-text dispatch is not guarded — only node dispatch is");
});

test("dispatch <node-id> (local): fails soft on unparseable agents output (no guard, dispatches)", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: "not json at all" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "unparseable => empty => no guard => dispatch proceeds");
});

test("dispatch <node-id> --print: previews the in-flight warning; clean when nothing is in flight", () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const r = run(["dispatch", "dec-x", "--no-brief", "--print"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: inFlightAgent("dec-x") });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /in-flight: dec-x already has 1 agent\(s\) in flight here/);
  assert.match(r.stdout, /real dispatch would refuse/);
  // --force flips the preview note
  const forced = run(["dispatch", "dec-x", "--no-brief", "--print", "--force"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: inFlightAgent("dec-x") });
  assert.match(forced.stdout, /--force set, dispatching anyway/);
  // and a clean run (no agents) prints no in-flight line at all
  const clean = run(["dispatch", "dec-x", "--no-brief", "--print"], { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: "[]" });
  assert.doesNotMatch(clean.stdout, /in-flight:/);
});

test("dispatch <node-id> (remote): an in-flight agent refuses BEFORE the claim — no claim POST, no launch", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(
      ["dispatch", "task-rotate", "--dir", repo, "--no-brief"],
      remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("task-rotate") })
    );
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /already has a background agent in flight/);
    assert.ok(!claimHit(hits), "the local guard refuses before any claim is POSTed");
    assert.ok(!fs.existsSync(sentinel), "no duplicate agent was launched");
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> --force (remote): still auto-claims and launches", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(
      ["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--force"],
      remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("task-rotate") })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(claimHit(hits), "--force still auto-claims the lease");
    assert.ok(fs.existsSync(sentinel), "and launches");
  } finally {
    srv.close();
  }
});

// --- already-resolved dispatch guard (issue-spor-dispatch-resolved-task-no-guard)
// Dispatching an agent at a node that is already done — a terminal status, or
// retired by a live inbound resolves/answers edge — would just redo finished work.
// Mirrors the in-flight guard: node mode only, both modes, --force overrides. The
// ranker drops resolved items from --from-queue, so for an auto-pick this is
// defense-in-depth; for an explicit `--node <id>` it is the primary guard.

// A scratch home with a DONE task (terminal status), an OPEN task retired by a
// live inbound `resolves` edge from a decision (its status lags the structural
// truth), and a genuinely-open control. Plus a repo to launch into.
function resolvedFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-res-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-done.md"),
    `---\nid: task-done\ntype: task\nrepo: demo\nstatus: done\ntitle: An already-finished task\nsummary: A task that has already been completed and resolved long ago.\ndate: 2026-06-01\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-lagging.md"),
    `---\nid: task-lagging\ntype: task\nrepo: demo\nstatus: open\ntitle: Looks open but a decision resolved it\nsummary: A task whose status still reads open though a live decision resolves it.\ndate: 2026-06-02\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "dec-resolver.md"),
    `---\nid: dec-resolver\ntype: decision\nrepo: demo\nstatus: active\ntitle: The decision that resolves the lagging task\nsummary: Decided how to handle it; this resolves the lagging task above so it is done.\ndate: 2026-06-03\nedges:\n  - {type: resolves, to: task-lagging}\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-live.md"),
    `---\nid: task-live\ntype: task\nrepo: demo\nstatus: open\ntitle: A genuinely open task\nsummary: A task with no resolver and a non-terminal status, fully dispatchable.\ndate: 2026-06-04\n---\nbody\n`
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-repo-"));
  return { home, nodes, repo };
}

test("dispatch <node-id> (local): a DONE (terminal status) node refuses, no launch", () => {
  const { home, repo } = resolvedFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-done", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /task-done is already resolved \(status: done\) — not dispatching/);
  assert.match(r.stderr, /--force/); // the override is suggested
  assert.ok(!fs.existsSync(sentinel), "no agent was launched at finished work");
});

test("dispatch <node-id> (local): a node retired by an inbound resolves edge refuses even with an open status", () => {
  const { home, repo } = resolvedFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-lagging", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /task-lagging is already resolved \(resolves edge from dec-resolver/);
  assert.ok(!fs.existsSync(sentinel), "the status lags but the resolver retires it — no launch");
});

test("dispatch <node-id> --force (local): launches despite a resolved target", () => {
  const { home, repo } = resolvedFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-done", "--dir", repo, "--no-brief", "--force"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "the agent launched with --force");
});

test("dispatch <node-id> (local): a genuinely-open node is NOT guarded — dispatch proceeds", () => {
  const { home, repo } = resolvedFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-live", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "an open task with no resolver dispatches normally");
});

test("dispatch <node-id> --print (local): previews the resolved warning; --force flips it; clean run prints none", () => {
  const { home, repo } = resolvedFixture();
  const r = run(["dispatch", "task-done", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /resolved: task-done is already resolved \(status: done\)/);
  assert.match(r.stdout, /real dispatch would refuse/);
  const forced = run(["dispatch", "task-done", "--dir", repo, "--no-brief", "--print", "--force"], { SPOR_HOME: home });
  assert.match(forced.stdout, /--force set, dispatching anyway/);
  const clean = run(["dispatch", "task-live", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.doesNotMatch(clean.stdout, /resolved:/);
});

test("dispatch <node-id> (remote): a node the server reports resolved refuses BEFORE the claim — no claim POST, no launch", async () => {
  const { home, repo } = fixture();
  // The server's get(node) surfaces the inbound resolver as `resolution` (API.md §3).
  const { srv, hits, base } = await claimStub({ nodeResolution: { by: "dec-fix", edge: "resolves", title: "The fix that resolved it" } });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /task-rotate is already resolved \(resolves edge from dec-fix/);
    assert.ok(!claimHit(hits), "the resolved guard refuses before any claim is POSTed");
    assert.ok(!fs.existsSync(sentinel), "no agent was launched at finished work");
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> (remote): a terminal-status node from the server refuses", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ nodeStatus: "done" });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /task-rotate is already resolved \(status: done\)/);
    assert.ok(!claimHit(hits), "no claim POST for a resolved node");
    assert.ok(!fs.existsSync(sentinel), "no launch");
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> --force (remote): launches despite the server reporting it resolved", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ nodeStatus: "done" });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--force"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(claimHit(hits), "--force still auto-claims the lease");
    assert.ok(fs.existsSync(sentinel), "and launches");
  } finally {
    srv.close();
  }
});

// --- agent-readiness dispatch guard (task-spor-dispatch-readiness-guard,
// dec-spor-agent-readiness-derived-classification) --- `requires: human` is a
// hard REFUSE (no --force, the risk-class register itself), a broader derived
// `readiness: human` (assigned to a person, a held task) only WARNS and the
// dispatch proceeds. Local mode gets the exact rankQueue derivation (full
// graph); remote mode approximates it off the node's own frontmatter plus the
// server's already-shipped get() hook `held` enrichment (see resolveNode).

function readinessFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-rdy-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-needs-human.md"),
    `---\nid: task-needs-human\ntype: task\nrepo: demo\nstatus: open\nrequires: [human]\ntitle: Work only a human can do\nsummary: A task marked requires human — no agent can complete it regardless of capability.\ndate: 2026-06-01\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-assigned-person.md"),
    `---\nid: task-assigned-person\ntype: task\nrepo: demo\nstatus: open\ntitle: Work assigned to a person\nsummary: A task carrying an assigned edge to a person node, not an agent.\ndate: 2026-06-02\nedges:\n  - {type: assigned, to: person-x}\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "person-x.md"),
    `---\nid: person-x\ntype: person\nrepo: demo\ntitle: Person X\nsummary: A team member who does work in the demo project.\ndate: 2026-06-01\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-agent-ready.md"),
    `---\nid: task-agent-ready\ntype: task\nrepo: demo\nstatus: open\nreadiness: agent\nreadiness_by: Dana via cli\ntitle: Stamped agent-ready\nsummary: A task explicitly stamped agent-ready, so the guard has nothing to warn about.\ndate: 2026-06-03\n---\nbody\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-plain.md"),
    `---\nid: task-plain\ntype: task\nrepo: demo\nstatus: open\ntitle: A plain, untriaged task\nsummary: A task with no readiness signal at all — untriaged, no guard output.\ndate: 2026-06-04\n---\nbody\n`
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-repo-"));
  return { home, nodes, repo };
}

test("dispatch <node-id> (local): requires:human REFUSES, no launch, no claim", () => {
  const { home, repo } = readinessFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-needs-human", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /cannot dispatch task-needs-human: this item requires a human — requires human\./);
  assert.match(r.stderr, /the assignment is unchanged/);
  assert.doesNotMatch(r.stderr, /--force/, "no --force bypass is offered for the requires:human refusal");
  assert.ok(!fs.existsSync(sentinel), "no agent was launched at human-only work");
});

test("dispatch <node-id> --force (local): --force does NOT override the requires:human refusal", () => {
  const { home, repo } = readinessFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-needs-human", "--dir", repo, "--no-brief", "--force"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /requires a human/);
  assert.ok(!fs.existsSync(sentinel), "--force has no effect on the requires:human refusal");
});

// issue-spor-dispatch-probe-side-effect-before-refusal: the requires:human
// refusal must fire BEFORE resolveDispatchProfile/probeCapabilities run, so a
// refused dispatch persists nothing to local config. Assign the node to an
// agent under a profile too, so — were the ordering still wrong — profile
// resolution would run and write a probed capability cache.
test("dispatch <node-id> (local): requires:human refuses BEFORE profile resolution — no .probed side effect", () => {
  const { home, nodes, repo } = readinessFixture();
  writeProfile(nodes, "profile-codex", "harness: codex");
  fs.writeFileSync(
    path.join(nodes, "agent-test.md"),
    `---\nid: agent-test\ntype: agent\ntitle: Test agent\nsummary: A test agent.\ndate: 2026-06-18\nedges:\n  - {type: uses-profile, to: profile-codex}\n---\nAgent.\n`
  );
  fs.writeFileSync(
    path.join(nodes, "task-needs-human-profiled.md"),
    `---\nid: task-needs-human-profiled\ntype: task\nrepo: demo\nstatus: open\nrequires: [human]\ntitle: Human work also assigned to a profiled agent\nsummary: A requires:human task that ALSO carries an assigned->agent edge with a profile, so profile resolution would run and probe capabilities if the guard didn't refuse first.\ndate: 2026-06-05\nedges:\n  - {type: assigned, to: agent-test}\n---\nbody\n`
  );
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const cfgFile = path.join(home, "config.json");
  const r = run(
    ["dispatch", "task-needs-human-profiled", "--dir", repo, "--no-brief"],
    { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, ...cleanProbeEnv() }
  );
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /cannot dispatch task-needs-human-profiled: this item requires a human/);
  assert.ok(!fs.existsSync(sentinel), "no agent was launched");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    /* no config.json at all is also proof of no side effect */
  }
  assert.ok(
    !(cfg.dispatch && cfg.dispatch.capabilities && cfg.dispatch.capabilities.probed),
    "the refusal must not persist a probed capability cache to local config"
  );
});

test("dispatch <node-id> (local): assigned-to-person WARNS but still launches", () => {
  const { home, repo } = readinessFixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "task-assigned-person", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: task-assigned-person's derived readiness is human, not agent — assigned to person-x\./);
  assert.ok(fs.existsSync(sentinel), "the warn does not block the dispatch");
});

test("dispatch <node-id> (local): a readiness:agent-stamped task and a plain untriaged task carry no readiness guard output", () => {
  const { home, repo } = readinessFixture();
  for (const id of ["task-agent-ready", "task-plain"]) {
    const sentinel = path.join(home, `g-launched-${id}`);
    const stub = claudeStub(home, sentinel);
    const r = run(["dispatch", id, "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /readiness is human|requires a human/, `${id} must not warn`);
    assert.ok(fs.existsSync(sentinel));
  }
});

test("dispatch <node-id> --print (local): previews the readiness guard; a clean node prints none", () => {
  const { home, repo } = readinessFixture();
  const refuse = run(["dispatch", "task-needs-human", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.strictEqual(refuse.status, 0, refuse.stderr);
  assert.match(refuse.stdout, /readiness: human — requires human — real dispatch would REFUSE \(no --force override\)/);
  const warn = run(["dispatch", "task-assigned-person", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.match(warn.stdout, /readiness: human — assigned to person-x — real dispatch would warn and proceed/);
  const clean = run(["dispatch", "task-plain", "--dir", repo, "--no-brief", "--print"], { SPOR_HOME: home });
  assert.doesNotMatch(clean.stdout, /readiness:/);
});

test("dispatch <node-id> (remote): requires:human REFUSES before the claim — no claim POST, no launch", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ nodeRequires: "human" });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /cannot dispatch task-rotate: this item requires a human — requires human\./);
    assert.ok(!claimHit(hits), "the readiness guard refuses before any claim is POSTed");
    assert.ok(!fs.existsSync(sentinel), "no agent was launched at human-only work");
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> (remote): the server's already-shipped held enrichment WARNS but still launches", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ nodeHeld: { outcomes: ["dec-x"], note: "held" } });
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: task-rotate's derived readiness is human, not agent — held task awaiting triage\./);
    assert.ok(claimHit(hits), "a warn (not a refuse) still proceeds to claim + launch");
    assert.ok(fs.existsSync(sentinel));
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> (remote): no readiness signal at all is byte-identical — no guard output, normal launch", async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({});
  const sentinel = path.join(home, "launched");
  const stub = claudeStub(home, sentinel);
  try {
    const r = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /readiness is human|requires a human/);
    assert.ok(claimHit(hits));
    assert.ok(fs.existsSync(sentinel));
  } finally {
    srv.close();
  }
});
