// agents-md-cli.test.js — `spor agents-md` / `spor enable` directive rider
// (task-spor-agents-md-capture-discipline-directive). The committed
// capture-discipline directive: a managed AGENTS.md block in user voice that
// tells agents to keep the graph current (capture at discovery, issue before
// fix, graph over private auto-memory, resolve with artifacts). Contract under
// test:
//   - `spor agents-md` writes the directive block WITHOUT a briefing embed by
//     default (hooked hosts get briefings at session start; a committed
//     snapshot stales) and is idempotent;
//   - `--briefing` restores the hook-less floor (directive + briefing embed);
//   - an existing CLAUDE.md that never mentions AGENTS.md gains one
//     @AGENTS.md import (once; --no-claude-md skips; a mentioning CLAUDE.md
//     is untouched; a missing CLAUDE.md is never created);
//   - `spor enable` writes .spor.json AND rides the directive along
//     (--no-agents opts out);
//   - the `spor upgrade` rider refreshes only a repo that already carries the
//     managed block, preserving its directive-only vs briefing mode.
// Never the live graph: every run gets a scratch SPOR_HOME + scratch cwd.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { DIRECTIVE } = require("../scripts/engines/agents-md.js");

// Bare env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not
// flip a local-mode test to remote or leak a token); config homes isolated.
function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agents-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agents-cwd-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  return { home, cwd };
}
function bare(home, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = home;
  env.XDG_CONFIG_HOME = home;
  return Object.assign(env, extra);
}
function run(cwd, home, args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd, env: bare(home) });
}
const BRIEF = [
  "---",
  "id: brief-projx",
  "type: briefing",
  "title: projx briefing",
  "version: 3",
  "---",
  "projx standing briefing body.",
  "",
].join("\n");
// The scratch cwd is not a git repo, so projectSlug falls back to the dir
// basename (mkdtemp suffix) — write the brief under that slug when a test
// needs the local-mode briefing embed to resolve.
function writeBrief(home, cwd) {
  const slug = path
    .basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  fs.writeFileSync(path.join(home, "nodes", `brief-${slug}.md`), BRIEF.replace(/projx/g, slug));
  return slug;
}

test("agents-md: writes the directive block, no briefing embed by default", () => {
  const { home, cwd } = scratch();
  writeBrief(home, cwd); // present but must NOT be embedded
  const r = run(cwd, home, ["agents-md"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(md, /<!-- spor:begin -->/);
  assert.match(md, /## Spor team graph/);
  assert.ok(md.includes(DIRECTIVE), "directive text is the packaged wording");
  assert.doesNotMatch(md, /Standing project briefing/);
  assert.doesNotMatch(md, /standing briefing body/);
  assert.match(r.stdout, /capture-discipline directive/);
});

// The cohort bullet is the creation-time half of the fix for
// issue-spor-agent-missing-dependency-edges: the gardener's unedged-gate
// detector only catches an unwired cohort on the next sweep, so this wording is
// the guarantee. Pin it — a silent drop is invisible everywhere else.
test("directive: instructs blocks edges for a multi-node cohort", () => {
  assert.match(DIRECTIVE, /more than one piece of work/);
  assert.match(DIRECTIVE, /`blocks` edges/);
});

// This repo dogfoods its own managed block, so the committed AGENTS.md must
// carry the packaged directive verbatim — otherwise the wording ships to every
// other repo while our own copy silently rots. Only the directive is compared:
// the tools line above it varies with whether a server is configured.
test("directive: this repo's committed AGENTS.md carries the packaged wording", () => {
  const md = fs.readFileSync(path.join(__dirname, "..", "AGENTS.md"), "utf8");
  assert.ok(md.includes(DIRECTIVE), "run `spor agents-md` and commit the result");
});

test("agents-md: idempotent — a second run replaces, never appends", () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# hand content\n");
  run(cwd, home, ["agents-md"]);
  run(cwd, home, ["agents-md"]);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(md, /# hand content/);
  assert.strictEqual(md.match(/<!-- spor:begin -->/g).length, 1);
});

test("agents-md --briefing: embeds the standing briefing (hook-less floor)", () => {
  const { home, cwd } = scratch();
  const slug = writeBrief(home, cwd);
  const r = run(cwd, home, ["agents-md", "--briefing"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.ok(md.includes(DIRECTIVE), "directive rides along with the briefing");
  assert.match(md, /Standing project briefing/);
  assert.ok(md.includes(`${slug} standing briefing body`));
});

// Stub server answering GET /v1/briefing/<slug> with a found:true body, so
// the REMOTE briefing-embed path (writeAgentsBlock's curl branch) runs.
function stubBriefingServer(version = 1) {
  const http = require("node:http");
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ found: true, body: "remote standing briefing body.", version }));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

// issue-spor-agents-md-local-mcp-leak (review follow-up on this branch's own
// gate: the toolsLine() fix left a second leak vector untouched): the
// "Standing project briefing (...)" heading also lands in the COMMITTED
// block, and its `meta` used to bake in `u.serverHost()` unconditionally —
// so `--briefing` against a loopback SPOR_SERVER still leaked the dev
// server's host/port even after the tools-line sentence was fixed.
//
// Async `spawn` (not `spawnSync`): the stub server lives in THIS test
// process, and spawnSync blocks this process's event loop until the child
// exits, which would deadlock the child's connection back to the stub (same
// class of gotcha as the claude-binary spawnSync note in CLAUDE.md).
test("agents-md --briefing: a loopback SPOR_SERVER is also omitted from the briefing heading", async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await stubBriefingServer(2);
  try {
    const env = bare(home, { SPOR_SERVER: base });
    const { spawn } = require("node:child_process");
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, "agents-md", "--briefing"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    assert.match(md, /Standing project briefing/);
    assert.ok(md.includes("remote standing briefing body."));
    assert.doesNotMatch(md, /127\.0\.0\.1/);
    assert.doesNotMatch(md, /reachable over MCP/);
  } finally {
    srv.close();
  }
});

// issue-spor-agents-md-local-mcp-leak: a machine-local SPOR_SERVER must never
// be baked into the committed block; a public/hosted server keeps the
// sentence; --no-server-line suppresses it unconditionally either way.
test("agents-md: a loopback SPOR_SERVER is omitted from the tools line", () => {
  const { home, cwd } = scratch();
  const env = bare(home, { SPOR_SERVER: "http://127.0.0.1:8787" });
  const r = spawnSync(process.execPath, [CLI, "agents-md"], { encoding: "utf8", cwd, env });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(md, /127\.0\.0\.1/);
  assert.doesNotMatch(md, /reachable over MCP/);
});

test("agents-md: a bracketed IPv6 loopback SPOR_SERVER is omitted from the tools line", () => {
  const { home, cwd } = scratch();
  const env = bare(home, { SPOR_SERVER: "http://[::1]:8787" });
  const r = spawnSync(process.execPath, [CLI, "agents-md"], { encoding: "utf8", cwd, env });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(md, /::1/);
  assert.doesNotMatch(md, /reachable over MCP/);
});

// The server can be resolved from config.json rather than raw SPOR_SERVER env
// (test/spor-cli.test.js "uses an already-configured server" pins that
// resolution path) — the loopback check must catch it there too, not just
// when SPOR_SERVER is set directly.
test("agents-md: a loopback server resolved from config.json is also omitted", () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ server: "http://127.0.0.1:8787", token: "tok" }));
  const r = run(cwd, home, ["agents-md"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(md, /127\.0\.0\.1/);
  assert.doesNotMatch(md, /reachable over MCP/);
});

test("agents-md: a public server URL keeps the tools line", () => {
  const { home, cwd } = scratch();
  const env = bare(home, { SPOR_SERVER: "https://spor.example.com" });
  const r = spawnSync(process.execPath, [CLI, "agents-md"], { encoding: "utf8", cwd, env });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(md, /reachable over MCP at https:\/\/spor\.example\.com\/mcp/);
});

test("agents-md --no-server-line: suppresses the tools line for any URL", () => {
  const { home, cwd } = scratch();
  const env = bare(home, { SPOR_SERVER: "https://spor.example.com" });
  const r = spawnSync(process.execPath, [CLI, "agents-md", "--no-server-line"], { encoding: "utf8", cwd, env });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(md, /reachable over MCP/);
  assert.doesNotMatch(md, /spor\.example\.com/);
});

// Re-running over an AGENTS.md whose committed block already carries a
// leaked local endpoint must replace it leak-free (append-or-replace marker
// semantics unchanged; this is the regeneration-heals-a-prior-leak case).
test("agents-md: regenerating over a previously-leaked block replaces it leak-free", () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# theirs\n\n<!-- spor:begin -->\n## Spor team graph\n\n" +
      "A team knowledge graph (Spor) holds prior decisions. It is reachable over MCP at http://127.0.0.1:8787/mcp (bearer token).\n" +
      "<!-- spor:end -->\n"
  );
  const env = bare(home, { SPOR_SERVER: "http://127.0.0.1:8787" });
  const r = spawnSync(process.execPath, [CLI, "agents-md"], { encoding: "utf8", cwd, env });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(md, /# theirs/);
  assert.doesNotMatch(md, /127\.0\.0\.1/);
  assert.strictEqual(md.match(/<!-- spor:begin -->/g).length, 1);
});

test("agents-md: 'agents' alias resolves to the same verb", () => {
  const { home, cwd } = scratch();
  const r = run(cwd, home, ["agents"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, "AGENTS.md")));
});

test("agents-md: appends @AGENTS.md import to a CLAUDE.md exactly once", () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# repo instructions\n");
  const r = run(cwd, home, ["agents-md"]);
  assert.match(r.stdout, /@AGENTS\.md import appended/);
  let cm = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8");
  assert.match(cm, /^@AGENTS\.md$/m);
  run(cwd, home, ["agents-md"]); // second run: already mentions AGENTS.md
  cm = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8");
  assert.strictEqual(cm.match(/@AGENTS\.md/g).length, 1);
});

test("agents-md: CLAUDE.md already mentioning AGENTS.md is untouched; --no-claude-md skips; absent CLAUDE.md is not created", () => {
  const { home, cwd } = scratch();
  const mentioning = "# repo\n\nSee AGENTS.md for agent instructions.\n";
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), mentioning);
  run(cwd, home, ["agents-md"]);
  assert.strictEqual(fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8"), mentioning);

  const { home: h2, cwd: c2 } = scratch();
  fs.writeFileSync(path.join(c2, "CLAUDE.md"), "# repo\n");
  run(c2, h2, ["agents-md", "--no-claude-md"]);
  assert.doesNotMatch(fs.readFileSync(path.join(c2, "CLAUDE.md"), "utf8"), /@AGENTS\.md/);

  const { home: h3, cwd: c3 } = scratch();
  run(c3, h3, ["agents-md"]);
  assert.ok(!fs.existsSync(path.join(c3, "CLAUDE.md")), "CLAUDE.md is never created");
});

test("enable: writes .spor.json AND the directive block by default", () => {
  const { home, cwd } = scratch();
  const r = run(cwd, home, ["enable"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".spor.json"), "utf8"));
  assert.strictEqual(cfg.enabled, true);
  const md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  assert.ok(md.includes(DIRECTIVE));
  assert.doesNotMatch(md, /Standing project briefing/, "enable writes directive-only");
});

test("enable --no-agents: opts out of the directive block", () => {
  const { home, cwd } = scratch();
  const r = run(cwd, home, ["enable", "--no-agents"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, ".spor.json")));
  assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));
});

// The upgrade rider is unit-tested directly (in a scratch env `spor upgrade`
// early-returns before the rider — no wired hosts to refresh).
test("upgrade rider: refreshes only a managed block, preserving its mode", async () => {
  const { refreshAgentsBlockIfManaged } = require("../bin/spor.js");
  const { home, cwd } = scratch();
  // In-process run: scrub every SPOR_*/SUBSTRATE_* var (a configured dev box
  // carries SPOR_SERVER, which would flip the engine's briefing fetch to the
  // LIVE server) and point the graph home at the scratch dir.
  const prevEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_")) {
      prevEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.SPOR_HOME = home;
  try {
    // no AGENTS.md -> no-op, nothing created
    await refreshAgentsBlockIfManaged(cwd);
    assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));

    // unmanaged AGENTS.md -> untouched
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# theirs, no markers\n");
    await refreshAgentsBlockIfManaged(cwd);
    assert.strictEqual(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), "# theirs, no markers\n");

    // managed directive-only block with STALE wording -> refreshed to the
    // packaged directive, still no briefing embed
    fs.writeFileSync(
      path.join(cwd, "AGENTS.md"),
      "# theirs\n\n<!-- spor:begin -->\n## Spor team graph\n\nold wording\n<!-- spor:end -->\n"
    );
    await refreshAgentsBlockIfManaged(cwd);
    let md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    assert.match(md, /# theirs/);
    assert.doesNotMatch(md, /old wording/);
    assert.ok(md.includes(DIRECTIVE));
    assert.doesNotMatch(md, /Standing project briefing/);

    // managed block WITH a briefing header -> refresh keeps briefing mode
    const slug = writeBrief(home, cwd);
    fs.writeFileSync(
      path.join(cwd, "AGENTS.md"),
      "<!-- spor:begin -->\n### Standing project briefing (old)\nold body\n<!-- spor:end -->\n"
    );
    await refreshAgentsBlockIfManaged(cwd);
    md = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    assert.ok(md.includes(DIRECTIVE));
    assert.match(md, /Standing project briefing/);
    assert.ok(md.includes(`${slug} standing briefing body`));
  } finally {
    delete process.env.SPOR_HOME;
    Object.assign(process.env, prevEnv);
  }
});
