// spor dispatch + repos — kick off Claude Code background agents from the CLI
// (task-spor-cli-dispatch-background-agents). Covers the local slug->path map,
// briefing compilation, directory resolution (incl. cross-repo via the map),
// the --print dry run, and a real (stubbed) spawn. Everything runs against a
// throwaway graph home — never the live graph.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage; force LOCAL mode (no server). Also
// isolate the config-cascade homes to an empty temp dir so the developer's real
// ~/.spor/config.json can't leak server+token in and flip a test to remote.
// `extra` is applied last, so SPOR_HOME / SPOR_CLAUDE_CMD passed by a test win.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-disp-iso-"));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME;
  env.XDG_CONFIG_HOME = ISO_HOME;
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
