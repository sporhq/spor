// spor dispatch + repos — kick off Claude Code background agents from the CLI
// (task-spor-cli-dispatch-background-agents). Covers the local slug->path map,
// briefing compilation, directory resolution (incl. cross-repo via the map),
// the --print dry run, and a real (stubbed) spawn. Everything runs against a
// throwaway graph home — never the live graph.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

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
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = run(["dispatch", "some free text task to dispatch", "--no-brief", "--print"], { SPOR_HOME: home }, wt);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`dir:    ${esc(main)} `), "resolved the main checkout");
  assert.match(r.stdout, /via cwd/);
  assert.doesNotMatch(r.stdout, new RegExp(esc(wt)), "never the ephemeral worktree path");
  fs.rmSync(base, { recursive: true, force: true });
});

test("dispatch from inside a git worktree (local, stubbed): registers the MAIN checkout in dispatch.repos", { skip: process.platform === "win32" }, () => {
  const { base, main, wt } = gitRepoWithWorktree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-wt-reg-"));
  const stub = path.join(home, "claude-stub.sh");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(stub, 0o755);
  const r = run(["dispatch", "some free text task to dispatch", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub }, wt);
  assert.strictEqual(r.status, 0, r.stderr);
  const mapped = Object.values(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).dispatch.repos);
  assert.ok(mapped.includes(main), `main checkout registered (got ${JSON.stringify(mapped)})`);
  assert.ok(!mapped.includes(wt), "ephemeral worktree path NOT registered");
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
  const stub = path.join(home, "claude-stub.sh");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(stub, 0o755);
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
  const stub = path.join(home, "claude-stub.sh");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(stub, 0o755);
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

// Real spawn through SPOR_CLAUDE_CMD: the launcher must pass --bg + flags and run
// in the resolved cwd. Posix-only (the stub is a shell script).
test("dispatch spawns the claude binary with --bg in the target dir", { skip: process.platform === "win32" }, () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = path.join(home, "claude-stub.sh");
  const outFile = path.join(home, "spawn.out");
  // cwd on line 1, then each argv element on its own line (the prompt is last
  // and may add extra lines — fine, we only assert on the leading flags).
  fs.writeFileSync(stub, `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > "$OUTFILE"\n`);
  fs.chmodSync(stub, 0o755);
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
  assert.match(prompt, /PRE\n# Spor briefing \(compiled/); // default prompt embedded verbatim
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
const isWin = process.platform === "win32";

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
function claimStub({ claimStatus = 200, claimBody = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      if (req.method === "GET" && /^\/v1\/nodes\/[^/]+$/.test(req.url)) {
        const id = decodeURIComponent(req.url.split("/").pop());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw: `---\nid: ${id}\ntype: task\nrepo: demo\ntitle: Demo task ${id}\nsummary: A demo task.\ndate: 2026-06-01\n---\nbody\n` }));
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
  const stub = path.join(dir, "claude-stub.sh");
  fs.writeFileSync(stub, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}
const claimHit = (hits) => hits.find((h) => h.method === "POST" && /\/claim$/.test(h.url));

test("dispatch <node-id> (remote): auto-claims the node, then launches the agent", { skip: isWin }, async () => {
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

test("dispatch (remote): a node already claimed by another aborts WITHOUT launching", { skip: isWin }, async () => {
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

test("dispatch --no-claim (remote): skips the claim entirely and launches", { skip: isWin }, async () => {
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

test("dispatch free-text (remote): no node to claim, so no claim is attempted", { skip: isWin }, async () => {
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

test("dispatch (remote): a claim server error warns but still dispatches (fail-open)", { skip: isWin }, async () => {
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

test("dispatch --print (remote node): previews the auto-claim and writes nothing", { skip: isWin }, async () => {
  const { home, repo } = fixture();
  const { srv, hits, base } = await claimStub({ claimStatus: 200 });
  try {
    const r1 = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--print"], remoteEnv(home, base));
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /claim:  would establish a session-bound lease on task-rotate/);
    assert.ok(!claimHit(hits), "--print is side-effect-free — no claim POSTed");

    const r2 = await runAsync(["dispatch", "task-rotate", "--dir", repo, "--no-brief", "--no-claim", "--print"], remoteEnv(home, base));
    assert.match(r2.stdout, /claim:  \(--no-claim/);
  } finally {
    srv.close();
  }
});

test("dispatch <node-id> (local): no lease, no claim line — byte-identical", { skip: isWin }, async () => {
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

test("dispatch <node-id> (local): a same-named agent already in flight refuses, no launch", { skip: isWin }, () => {
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

test("dispatch <node-id> --force (local): launches despite an agent in flight", { skip: isWin }, () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const r = run(["dispatch", "dec-x", "--no-brief", "--force"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("dec-x") });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "the agent launched with --force");
});

test("dispatch <node-id> (local): a DONE same-named agent is not in flight — dispatch proceeds", { skip: isWin }, () => {
  const { home, repo } = fixture();
  run(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  const agents = inFlightAgent("dec-x", { status: "idle", state: "done" });
  const r = run(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "a finished agent does not block dispatch");
});

test("dispatch free-text (local): NOT guarded even if an agent shares the derived name (node mode only)", { skip: isWin }, () => {
  const { home, repo } = fixture();
  const sentinel = path.join(home, "g-launched");
  const stub = claudeStub(home, sentinel);
  // free-text name derives from the first words: "alpha beta gamma"
  const r = run(["dispatch", "alpha beta gamma", "--dir", repo, "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: inFlightAgent("alpha beta gamma") });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(sentinel), "free-text dispatch is not guarded — only node dispatch is");
});

test("dispatch <node-id> (local): fails soft on unparseable agents output (no guard, dispatches)", { skip: isWin }, () => {
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

test("dispatch <node-id> (remote): an in-flight agent refuses BEFORE the claim — no claim POST, no launch", { skip: isWin }, async () => {
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

test("dispatch <node-id> --force (remote): still auto-claims and launches", { skip: isWin }, async () => {
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
