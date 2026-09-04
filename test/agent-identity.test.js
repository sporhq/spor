// Agent identity — the client half of dec-spor-agent-identity-nodes /
// dec-spor-session-identity-active-record / task-spor-agent-identity-nodes:
//   1. `spor agent create/list` (local writes the node + owned-by edge; remote
//      POSTs /v1/admin/agents and fails soft on a server without it).
//   2. dispatch wiring: a forced session uuid (--session-id), a per-session
//      agent-scoped token minted into a 0600 --mcp-config + --strict-mcp-config,
//      and a SESSION-BOUND claim.
//   3. the agent-on-behalf-of authorship read-out (kernel authorshipLine +
//      renderNorm), additive and byte-identical for person-direct nodes.
// Everything runs against a throwaway graph home and stub servers — never the
// live graph, never a real `claude --bg`.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeSpawnableNodeStub } = require("./helpers/portable");
const { waitForFile } = require("./helpers/launch.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const kernel = require("../lib/kernel/graph.js");

// --- env helpers (mirror dispatch.test.js) --------------------------------
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-iso-"));
function localEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO;
  env.XDG_CONFIG_HOME = ISO;
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  env.SPOR_DISTILLING = "1";
  // The launcher tests here run against the SUPERVISED default (`claude -p
  // --output-format stream-json` under the shared supervisor,
  // task-spor-claude-adapter-headless-supervised); the few whose subject is the
  // native `claude --bg` opt-in (its `claude agents --json` session capture)
  // merge NATIVE_BG into their env (see below).
  return Object.assign(env, extra);
}
function remoteEnv(home, server, extra = {}) {
  const env = localEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: server, SPOR_TOKEN: "test-token" });
  return Object.assign(env, extra);
}
function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: localEnv(env), cwd });
}

// The launch-mode pin for the handful of tests whose SUBJECT is the native
// `claude --bg` launch (its argv, its $PWD pin, its exit-code/lease coupling,
// its `claude agents --json` session capture): merge into a test's env. Every
// other launcher test here runs against the SUPERVISED default
// (`claude -p --output-format stream-json` under the shared supervisor,
// task-spor-claude-adapter-headless-supervised), whose harness child is a
// DETACHED grandchild — so a launch is observed by waiting for the stub's
// marker file rather than reading it the instant the CLI returns.
const NATIVE_BG = { SPOR_DISPATCH_CLAUDE_LAUNCH_MODE: "native-background" };
function runAsync(args, env, cwd) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// A scratch local graph home holding a single person node.
function homeWithPerson() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "person-anthony.md"),
    `---\nid: person-anthony\ntype: person\ntitle: Anthony Allen\nsummary: Team member Anthony Allen.\nemail: a@x.io\ndate: 2026-06-16\n---\nTeam member Anthony Allen <a@x.io>.\n`
  );
  return { home, nodes };
}

// ===========================================================================
// 1. spor agent create / list (local)
// ===========================================================================

test("agent create (local): writes a valid agent node + owned-by edge to the sole person", () => {
  const { home, nodes } = homeWithPerson();
  const r = run(["agent", "create", "anthony-laptop"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /created agent agent-anthony-laptop owned by Anthony Allen \(person-anthony\)/);
  const md = fs.readFileSync(path.join(nodes, "agent-anthony-laptop.md"), "utf8");
  assert.match(md, /^type: agent$/m);
  assert.match(md, /^spiffe: spiffe:\/\/spor\.local\/person\/anthony\/agent\/anthony-laptop$/m);
  assert.match(md, /^status: active$/m);
  assert.match(md, /- \{type: owned-by, to: person-anthony\}/);
  // it validates against the registry (the foundation seed schema)
  const v = run(["validate", "--nodes", nodes], { SPOR_HOME: home });
  assert.strictEqual(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /0 errors/);
});

test("agent create (local): --pubkey is recorded; default empty pubkey is allowed", () => {
  const { home, nodes } = homeWithPerson();
  const r = run(["agent", "create", "ci", "--owner", "person-anthony", "--pubkey", "SHA256:abc123"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(nodes, "agent-ci.md"), "utf8");
  assert.match(md, /^pubkey: SHA256:abc123$/m);
});

test("agent create (local): duplicate id is refused", () => {
  const { home } = homeWithPerson();
  run(["agent", "create", "dup"], { SPOR_HOME: home });
  const r = run(["agent", "create", "dup"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /agent already exists: agent-dup/);
});

test("agent create (local): an unknown explicit --owner is refused (identity never guessed)", () => {
  const { home } = homeWithPerson();
  const r = run(["agent", "create", "x", "--owner", "person-nobody"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such person node: person-nobody/);
});

test("agent create (local): no person node => requires --owner, writes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-nop-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const r = run(["agent", "create", "x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no person node in the graph to own this agent/);
  assert.ok(!fs.existsSync(path.join(home, "nodes", "agent-x.md")), "nothing written");
});

test("agent create (local): ambiguous owner (>1 person) => requires --owner", () => {
  const { home, nodes } = homeWithPerson();
  fs.writeFileSync(
    path.join(nodes, "person-jo.md"),
    `---\nid: person-jo\ntype: person\ntitle: Jo\nsummary: Team member Jo.\nemail: jo@x.io\ndate: 2026-06-16\n---\nJo.\n`
  );
  const r = run(["agent", "create", "x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /several person nodes — name the owner with --owner/);
});

test("agent list (local): lists agents with owner + status; empty graph says so", () => {
  const { home } = homeWithPerson();
  const empty = run(["agent", "list"], { SPOR_HOME: home });
  assert.match(empty.stdout, /no agents yet/);
  run(["agent", "create", "anthony-laptop"], { SPOR_HOME: home });
  const r = run(["agent", "list"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /agent-anthony-laptop\towned-by Anthony Allen \(person-anthony\)\tactive/);
});

test("agent: usage on a bad subcommand / missing label", () => {
  const { home } = homeWithPerson();
  const a = run(["agent", "bogus"], { SPOR_HOME: home });
  assert.strictEqual(a.status, 1);
  assert.match(a.stderr, /usage: spor agent create/);
  const b = run(["agent", "create"], { SPOR_HOME: home });
  assert.strictEqual(b.status, 1);
  assert.match(b.stderr, /usage: spor agent create <label>/);
});

// ---------------------------------------------------------------------------
// spor agent use — the real setter for dispatch.agent (the per-machine default
// dispatch identity). A LOCAL config write, mode-independent; this is what the
// create/list hints point to (task-spor-dispatch-agent-flag-disambiguation).
// ---------------------------------------------------------------------------

test("agent use: writes dispatch.agent to the user config; idempotent re-run is a no-op", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-use-"));
  const r = run(["agent", "use", "agent-anthony-laptop"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /dispatch\.agent = agent-anthony-laptop/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.strictEqual(cfg.dispatch.agent, "agent-anthony-laptop");
  const again = run(["agent", "use", "agent-anthony-laptop"], { SPOR_HOME: home });
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /already = agent-anthony-laptop/);
});

test("agent use: preserves other config keys (server/token/repos map)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-usep-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ server: "http://x", token: "t", dispatch: { repos: { api: "/code/api" } } }) + "\n");
  run(["agent", "use", "agent-x"], { SPOR_HOME: home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.strictEqual(cfg.server, "http://x");
  assert.strictEqual(cfg.token, "t");
  assert.strictEqual(cfg.dispatch.repos.api, "/code/api");
  assert.strictEqual(cfg.dispatch.agent, "agent-x");
});

test("agent use --clear: drops dispatch.agent back to person-scoped", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-usec-"));
  run(["agent", "use", "agent-x"], { SPOR_HOME: home });
  const r = run(["agent", "use", "--clear"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleared dispatch\.agent/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(!("agent" in (cfg.dispatch || {})), "dispatch.agent removed");
});

test("agent use: an invalid agent id is refused, writing nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-usei-"));
  const r = run(["agent", "use", "Bad Id!"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid agent id/);
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "nothing written");
});

// The label-vs-id slip (issue-spor-dispatch-agent-id-prefix-validation-gap):
// `spor agent list` prints both the agent's id (agent-x) and its bare LABEL (x);
// pasting the label drops the `agent-` prefix the server's token-mint requires.
// The client must REFUSE the prefix-less slug (not write a dispatch.agent that
// 422s on every dispatch) and suggest the prefixed form, writing nothing.
test("agent use: a prefix-less id (the label slip) is refused with a 'did you mean agent-…' hint, writing nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-usepfx-"));
  const r = run(["agent", "use", "anthony-shark-november"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid agent id 'anthony-shark-november'/);
  assert.match(r.stderr, /did you mean 'agent-anthony-shark-november'/);
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "nothing written");
});

// task-spor-agent-use-label-resolution: the deferred convenience layered on
// top of the prefix-hint above — a bare label that DOES match one of the
// caller's own agents resolves to its full id instead of erroring.
test("agent use (local): a label matching an existing agent resolves to its full id", () => {
  const { home } = homeWithPerson();
  run(["agent", "create", "anthony-shark-november"], { SPOR_HOME: home });
  const r = run(["agent", "use", "anthony-shark-november"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /dispatch\.agent = agent-anthony-shark-november \(resolved from label 'anthony-shark-november'\)/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.strictEqual(cfg.dispatch.agent, "agent-anthony-shark-november");
});

test("agent use (local): a label matching NO agent still falls back to the prefix-hint error", () => {
  const { home } = homeWithPerson();
  run(["agent", "create", "someone-else"], { SPOR_HOME: home });
  const r = run(["agent", "use", "anthony-shark-november"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid agent id 'anthony-shark-november'/);
  assert.match(r.stderr, /did you mean 'agent-anthony-shark-november'/);
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "nothing written");
});

test("agent use (local): a label matching more than one agent is refused as ambiguous, writing nothing", () => {
  const { home, nodes } = homeWithPerson();
  fs.writeFileSync(
    path.join(nodes, "agent-x.md"),
    `---\nid: agent-x\ntype: agent\ntitle: something-else\nsummary: s.\nstatus: active\ndate: 2026-06-16\nedges:\n  - {type: owned-by, to: person-anthony}\n---\nAgent.\n`
  );
  fs.writeFileSync(
    path.join(nodes, "agent-y.md"),
    `---\nid: agent-y\ntype: agent\ntitle: x\nsummary: s.\nstatus: active\ndate: 2026-06-16\nedges:\n  - {type: owned-by, to: person-anthony}\n---\nAgent.\n`
  );
  const r = run(["agent", "use", "x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /'x' matches more than one of your agents: agent-x, agent-y/);
  assert.ok(!fs.existsSync(path.join(home, "config.json")), "nothing written");
});

test("agent use: missing id prints usage", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-useu-"));
  const r = run(["agent", "use"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor agent use/);
});

// ===========================================================================
// 2. spor agent create (remote) — fail-soft when the endpoint is absent
// ===========================================================================

// Stub server answering /v1/me, the configurable admin + SELF-SERVE create
// doors, and the agent list surface. `agentsStatus`/`agentsBody` shape POST
// /v1/admin/agents (the --owner admin path); `selfStatus`/`selfBody` shape the
// self-serve POST /v1/agents (the default, owner = caller). `agentsList` (when
// set) serves GET /v1/agents; otherwise that GET 404s and the client falls back
// to the /v1/changes audit projection (served when `changes` is set), exercising
// both list paths.
function agentStub({ agentsStatus = 201, agentsBody = null, selfStatus = 201, selfBody = null, agentsList = null, changes = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/me") return j(200, { person: "person-anthony", email: "a@x.io", bound: true, is_admin: true });
      if (req.url === "/v1/admin/agents" && req.method === "POST") {
        return j(agentsStatus, agentsBody || { id: "agent-anthony-laptop", owner: "person-anthony", spiffe: "spiffe://spor.acme/person/anthony/agent/anthony-laptop", status: "active", revision: "r1" });
      }
      if (req.url === "/v1/agents" && req.method === "POST") {
        // self-serve create: owner is ALWAYS the caller, never asserted in the body
        return j(selfStatus, selfBody || { id: "agent-anthony-cc-web", owner: "person-anthony", spiffe: "spiffe://spor.acme/person/anthony/agent/anthony-cc-web", status: "active", revision: "r1" });
      }
      if (req.url === "/v1/agents" && req.method === "GET") {
        if (agentsList) return j(200, { agents: agentsList });
        return j(404, { error: { code: "not_found" } }); // surface not deployed
      }
      if (req.url.startsWith("/v1/changes")) {
        // `change` is the raw git --name-status LETTER (A/M/D), as GET /v1/changes
        // emits — not a word — so the deletion filter is "D", not "deleted".
        return j(200, { changes: changes || [
          { id: "agent-anthony-laptop", change: "A", type: "agent", title: "anthony-laptop" },
          { id: "agent-anthony-old", change: "D", type: "agent", title: "anthony-old" },
          { id: "task-x", change: "M", type: "task", title: "Some task" },
        ], count: 3 });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("agent create (remote): --owner uses the ADMIN POST /v1/admin/agents, not the self-serve door", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-rem-"));
  const { srv, hits, base } = await agentStub({ agentsStatus: 201 });
  try {
    const r = await runAsync(["agent", "create", "anthony-laptop", "--owner", "person-anthony"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /created agent agent-anthony-laptop owned by person-anthony/);
    assert.match(r.stdout, /spiffe: spiffe:\/\/spor\.acme/);
    const post = hits.find((h) => h.url === "/v1/admin/agents" && h.method === "POST");
    assert.ok(post, "POSTed to /v1/admin/agents");
    assert.deepStrictEqual(JSON.parse(post.body), { label: "anthony-laptop", owner: "person-anthony" });
    assert.ok(!hits.some((h) => h.url === "/v1/agents" && h.method === "POST"), "did NOT hit the self-serve door");
  } finally {
    srv.close();
  }
});

test("agent create (remote): a server without the endpoint (404) fails soft, not a crash", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-rem2-"));
  const { srv, base } = await agentStub({ agentsStatus: 404 });
  try {
    const r = await runAsync(["agent", "create", "x", "--owner", "person-anthony"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no agent-creation endpoint yet/);
  } finally {
    srv.close();
  }
});

test("agent list (remote): reads GET /v1/agents (the caller's owned agents)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-rem3-"));
  const { srv, hits, base } = await agentStub({ agentsList: [{ id: "agent-anthony-laptop", owner: "person-anthony", status: "active" }] });
  try {
    const r = await runAsync(["agent", "list"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent-anthony-laptop\towned-by person-anthony\tactive/);
    assert.ok(hits.some((h) => h.url === "/v1/agents" && h.method === "GET"), "GET /v1/agents");
  } finally {
    srv.close();
  }
});

test("agent list (remote): falls back to the /v1/changes projection when /v1/agents 404s", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-rem3b-"));
  const { srv, base } = await agentStub({}); // agentsList unset => /v1/agents 404 => /v1/changes
  try {
    const r = await runAsync(["agent", "list"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent-anthony-laptop\tanthony-laptop/);
    assert.doesNotMatch(r.stdout, /task-x/); // non-agent rows dropped
    assert.doesNotMatch(r.stdout, /agent-anthony-old/); // deleted agent (change "D") dropped, not leaked as live
  } finally {
    srv.close();
  }
});

// task-spor-agent-use-label-resolution: remote-mode label resolution goes
// through GET /v1/agents (the caller's owned agents), the same route `agent
// list` reads.
test("agent use (remote): a label matching one of the caller's agents resolves via GET /v1/agents", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user-"));
  const { srv, hits, base } = await agentStub({ agentsList: [{ id: "agent-anthony-shark-november", owner: "person-anthony", title: "anthony-shark-november", status: "active" }] });
  try {
    const r = await runAsync(["agent", "use", "anthony-shark-november"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /dispatch\.agent = agent-anthony-shark-november \(resolved from label 'anthony-shark-november'\)/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.strictEqual(cfg.dispatch.agent, "agent-anthony-shark-november");
    assert.ok(hits.some((h) => h.url === "/v1/agents" && h.method === "GET"), "GET /v1/agents");
  } finally {
    srv.close();
  }
});

// GET /v1/agents' documented shape (API.md) carries `label`, not `title` — the
// stub above uses `title` too (matching the /v1/changes fallback and local
// graph nodes' frontmatter field), so this test locks in the REAL field name.
test("agent use (remote): matches on the documented `label` field, not just `title`", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user5-"));
  const { srv, base } = await agentStub({ agentsList: [{ id: "agent-x", owner: "person-anthony", label: "myx", status: "active" }] });
  try {
    const r = await runAsync(["agent", "use", "myx"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /dispatch\.agent = agent-x \(resolved from label 'myx'\)/);
  } finally {
    srv.close();
  }
});

test("agent use (remote): a GET /v1/agents 404 (old server) falls back to the /v1/changes projection, same as `agent list`", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user6-"));
  const { srv, base } = await agentStub({}); // agentsList unset => /v1/agents 404 => /v1/changes
  try {
    const r = await runAsync(["agent", "use", "anthony-laptop"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /dispatch\.agent = agent-anthony-laptop \(resolved from label 'anthony-laptop'\)/);
  } finally {
    srv.close();
  }
});

test("agent use (remote): a label matching none of the caller's agents falls back to the prefix-hint error", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user2-"));
  const { srv, base } = await agentStub({ agentsList: [{ id: "agent-someone-else", owner: "person-anthony", title: "someone-else", status: "active" }] });
  try {
    const r = await runAsync(["agent", "use", "anthony-shark-november"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /invalid agent id 'anthony-shark-november'/);
    assert.match(r.stderr, /did you mean 'agent-anthony-shark-november'/);
  } finally {
    srv.close();
  }
});

test("agent use (remote): a label matching more than one of the caller's agents is refused as ambiguous", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user4-"));
  const { srv, base } = await agentStub({
    agentsList: [
      { id: "agent-x", owner: "person-anthony", title: "something-else", status: "active" },
      { id: "agent-y", owner: "person-anthony", title: "x", status: "active" },
    ],
  });
  try {
    const r = await runAsync(["agent", "use", "x"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /'x' matches more than one of your agents: agent-x, agent-y/);
  } finally {
    srv.close();
  }
});

test("agent use (remote): an unreachable server falls back to the prefix-hint error rather than hanging or crashing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-user3-"));
  const r = await runAsync(["agent", "use", "anthony-shark-november"], remoteEnv(home, "http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid agent id 'anthony-shark-november'/);
});

// ---------------------------------------------------------------------------
// 2b. spor agent create (remote, self-serve) + standing agent PATs
// (task-spor-cli-agent-self-serve-verbs)
// ---------------------------------------------------------------------------

test("agent create (remote, self-serve): no --owner POSTs /v1/agents owned by the caller", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-self-"));
  const { srv, hits, base } = await agentStub({});
  try {
    const r = await runAsync(["agent", "create", "anthony-cc-web"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /created agent agent-anthony-cc-web owned by person-anthony/);
    assert.match(r.stdout, /spiffe: spiffe:\/\/spor\.acme/);
    assert.match(r.stdout, /spor agent token agent-anthony-cc-web/); // points at the standing-PAT mint
    const self = hits.find((h) => h.url === "/v1/agents" && h.method === "POST");
    assert.ok(self, "POSTed to the self-serve /v1/agents");
    assert.deepStrictEqual(JSON.parse(self.body), { label: "anthony-cc-web" }); // no owner asserted
    assert.ok(!hits.some((h) => h.url === "/v1/admin/agents"), "did NOT hit the admin door");
  } finally {
    srv.close();
  }
});

test("agent create (remote, self-serve): an unbound caller (403) is nudged to whoami", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-self2-"));
  const { srv, base } = await agentStub({ selfStatus: 403, selfBody: { error: { code: "forbidden", message: "needs a bound person identity" } } });
  try {
    const r = await runAsync(["agent", "create", "x"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bound person identity/);
    assert.match(r.stderr, /whoami/);
  } finally {
    srv.close();
  }
});

// A stub for the standing agent-PAT surface: mint (POST .../token), list (GET
// .../tokens) and revoke (DELETE .../tokens/{prefix}). `standing:false` models an
// OLD server that ignores the {standing} flag and mints a short per-session token.
function agentTokenStub({ standing = true } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      let m = req.url.match(/^\/v1\/agents\/([^/?]+)\/token$/);
      if (m && req.method === "POST") {
        const id = decodeURIComponent(m[1]);
        if (id === "agent-nope") return j(404, { error: { code: "not_found", message: `no such agent '${id}'` } });
        if (id === "agent-nottheirs") return j(403, { error: { code: "forbidden", message: "only the owner may mint its tokens" } });
        const b = body ? JSON.parse(body) : {};
        if (b.expires === "400d") return j(422, { error: { code: "invalid_node", message: "expires may be at most 1 year out" } });
        if (!standing) return j(201, { token: "spor_pat_session999", expires_at: "2026-06-29T00:00:00.000Z", agent: id, session: null });
        return j(201, { token: "spor_pat_standing123", hash_prefix: "1111aaaa2222", agent: id, owner: "person-anthony", label: b.label || null, expires: b.expires ? "2026-09-20" : "2027-06-22", standing: true });
      }
      m = req.url.match(/^\/v1\/agents\/([^/?]+)\/tokens$/);
      if (m && req.method === "GET") {
        return j(200, { tokens: [{ hash_prefix: "1111aaaa2222", label: "cc-web", standing: true, expires: "2027-06-22", expired: false }], count: 1 });
      }
      m = req.url.match(/^\/v1\/agents\/([^/?]+)\/tokens\/([^/?]+)$/);
      if (m && req.method === "DELETE") {
        if (decodeURIComponent(m[2]) === "1111aaaa2222") return j(200, { revoked: 1, hash_prefix: "1111aaaa2222", oauth_grants_revoked: 0 });
        return j(404, { error: { code: "not_found", message: "no such token" } });
      }
      j(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("agent token (remote): mints a standing PAT over POST /v1/agents/{id}/token {standing:true}", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok-"));
  const { srv, hits, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "--expires", "90d", "--label", "cc-web"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /spor_pat_standing123/); // the plaintext token, shown once
    assert.match(r.stdout, /1111aaaa2222/);          // hash prefix
    assert.match(r.stdout, /SPOR_TOKEN/);            // the headless-agent affordance
    assert.match(r.stdout, /spor agent token agent-anthony-cc-web revoke 1111aaaa2222/);
    const hit = hits.find((h) => h.method === "POST" && h.url === "/v1/agents/agent-anthony-cc-web/token");
    assert.ok(hit, "POSTed the mint");
    assert.strictEqual(hit.auth, "Bearer test-token");
    const sent = JSON.parse(hit.body);
    assert.strictEqual(sent.standing, true); // standing mode requested
    assert.strictEqual(sent.expires, "90d"); // --expires forwarded verbatim
    assert.strictEqual(sent.label, "cc-web"); // --label forwarded
  } finally {
    srv.close();
  }
});

test("agent token (remote): --expires past the 1-year cap surfaces the server 422", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok2-"));
  const { srv, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "--expires", "400d"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /1 year/);
  } finally {
    srv.close();
  }
});

test("agent token (remote): a non-owner is a friendly 403", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok3-"));
  const { srv, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-nottheirs"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /only the owner of agent-nottheirs/);
  } finally {
    srv.close();
  }
});

test("agent token (remote): an unknown agent is a friendly 404", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok4-"));
  const { srv, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-nope"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such agent 'agent-nope'/);
  } finally {
    srv.close();
  }
});

test("agent token (remote): an old server (no standing echo) warns, never presents a durable PAT", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok5-"));
  const { srv, base } = await agentTokenStub({ standing: false });
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1); // not a success — the caller asked for a standing PAT
    assert.match(r.stderr, /no standing-PAT support/);
    assert.doesNotMatch(r.stdout, /minted standing PAT/); // not framed as the durable credential
    assert.doesNotMatch(r.stdout, /revoke/); // no durable-PAT revoke hint (there is no hash_prefix)
  } finally {
    srv.close();
  }
});

test("agent token list (remote): lists the agent's standing PATs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok6-"));
  const { srv, hits, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "list"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /1111aaaa2222/);
    assert.match(r.stdout, /cc-web/);
    assert.ok(hits.some((h) => h.method === "GET" && h.url === "/v1/agents/agent-anthony-cc-web/tokens"), "hit the list GET");
  } finally {
    srv.close();
  }
});

test("agent token revoke (remote): deletes one by hash prefix", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok7-"));
  const { srv, hits, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "revoke", "1111aaaa2222"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /revoked 1111aaaa2222/);
    assert.ok(hits.some((h) => h.method === "DELETE" && h.url === "/v1/agents/agent-anthony-cc-web/tokens/1111aaaa2222"), "hit the revoke DELETE");
  } finally {
    srv.close();
  }
});

test("agent token revoke (remote): a prefix that isn't one is a friendly 404", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok8-"));
  const { srv, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "revoke", "nottheirs99"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no standing PAT of agent-anthony-cc-web/);
  } finally {
    srv.close();
  }
});

test("agent token revoke without a prefix exits 1 with usage", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-tok9-"));
  const { srv, base } = await agentTokenStub();
  try {
    const r = await runAsync(["agent", "token", "agent-anthony-cc-web", "revoke"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: spor agent token agent-anthony-cc-web revoke/);
  } finally {
    srv.close();
  }
});

test("agent token: local mode explains it needs a team graph", () => {
  const { home } = homeWithPerson();
  const r = run(["agent", "token", "agent-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote mode/);
});

test("agent token: an invalid agent id is rejected with the prefix nudge", () => {
  const r = run(["agent", "token", "mylabel"], { SPOR_SERVER: "http://127.0.0.1:9", SPOR_TOKEN: "t" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid agent id 'mylabel'/);
  assert.match(r.stderr, /did you mean 'agent-mylabel'/);
});

// ===========================================================================
// 3. dispatch identity wiring
// ===========================================================================

// A claude stub that dumps cwd + argv to a file, then exits 0.
function argvStub(dir, outFile) {
  return writeSpawnableNodeStub(dir, "claude-argv", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(outFile)}, [process.cwd(), ...process.argv.slice(2)].join("\\n") + "\\n");
`);
}

// Stub server: /v1/me, GET /v1/nodes/{id}, POST /v1/nodes/{id}/claim (records
// the session it received), and the SELF-SERVE owner-gated per-session mint
// POST /v1/agents/{id}/token (configurable status; records the agent {id} in the
// path + the session in the body).
function dispatchStub({ mintStatus = 201, mintBody = null, queueItem = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/me") return j(200, { person: "person-anthony", bound: true, is_admin: true });
      if (queueItem && req.method === "GET" && req.url.startsWith("/v1/queue")) return j(200, { items: [queueItem] });
      if (req.method === "GET" && /^\/v1\/nodes\/[^/]+$/.test(req.url)) {
        const id = decodeURIComponent(req.url.split("/").pop());
        return j(200, { raw: `---\nid: ${id}\ntype: task\nrepo: demo\ntitle: Demo ${id}\nsummary: A demo task.\ndate: 2026-06-01\n---\nbody\n` });
      }
      if (req.method === "POST" && /^\/v1\/nodes\/[^/]+\/claim$/.test(req.url)) {
        return j(200, { ok: true, status: "claimed", lease: { by: "person-anthony", session: JSON.parse(body || "{}").session || null } });
      }
      if (req.method === "POST" && /^\/v1\/nodes\/[^/]+\/renew$/.test(req.url)) {
        return j(200, { ok: true, lease: { by: "person-anthony", session: JSON.parse(body || "{}").session || null } });
      }
      // late session bind (dec-spor-dispatch-bg-session-late-bind): the dispatcher
      // authenticates with the AGENT token; record + echo the session it bound.
      if (req.method === "POST" && req.url === "/v1/agents/session") {
        const p = JSON.parse(body || "{}");
        return j(200, { ok: true, agent: "agent-anthony-laptop", session: p.session });
      }
      const mintMatch = req.method === "POST" && req.url.match(/^\/v1\/agents\/([^/]+)\/token$/);
      if (mintMatch) {
        const agent = decodeURIComponent(mintMatch[1]);
        const p = JSON.parse(body || "{}");
        // session is now OPTIONAL (deferred) — the token id stays stable regardless.
        return j(mintStatus, mintBody || { token: `agtok_${agent.slice(6, 14)}`, agent, session: p.session || null, expires_at: "2026-06-16T23:59:59Z" });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

const SID = "11111111-2222-3333-4444-555555555555";

test("dispatch (local) --print: shows the pinned session, NO --session-id (claude --bg ignores it)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-repo-"));
  const r = run(["dispatch", "some free text task here", "--dir", repo, "--no-brief", "--print"], { SPOR_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`session: ${SID}`)); // SPOR_SESSION_ID pins it
  assert.doesNotMatch(r.stdout, /--session-id/); // never forced — --bg self-allocates
  assert.doesNotMatch(r.stdout, /^agent:/m); // local mode => no agent-scoping line
});

test("dispatch (remote) --print: no agent configured => person-scoped notice flagging the real-run refusal, lease bound after launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1r-"));
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print"], remoteEnv(home, base, { SPOR_SESSION_ID: SID }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent:  \(none configured/);
    assert.match(r.stdout, /real dispatch would REFUSE/);
    assert.doesNotMatch(r.stdout, /--session-id/); // never forced
    assert.match(r.stdout, new RegExp(`session: ${SID}`)); // pinned shows; else "(allocated by claude --bg…)"
    assert.match(r.stdout, /would establish a lease on dec-x/);
  } finally {
    srv.close();
  }
});

// dec-spor-worker-strictness-split-interactive-lenient, the core of this item: a
// REAL remote dispatch with no agent identity at all (no --as, no dispatch.agent)
// must HARD-FAIL rather than silently attribute the dispatched agent's writes to
// the person — naming `spor agent use` as the fix and --allow-person-token as the
// escape hatch. Nothing is claimed or launched.
test("dispatch (remote, real): no agent configured => hard-fails, names 'spor agent use' and --allow-person-token, nothing launched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1c-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1cr-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  const stub = argvStub(home, outFile);
  const { srv, hits, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot dispatch dec-x: no dispatch agent configured for this machine/);
    assert.match(r.stderr, /spor agent use/);
    assert.match(r.stderr, /--allow-person-token/);
    assert.ok(!fs.existsSync(outFile), "nothing launched");
    assert.ok(!hits.some((h) => /\/claim$/.test(h.url)), "no claim established — nothing left to clean up");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real) --allow-person-token: no agent configured => fails soft as before, person-scoped launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1d-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1dr-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--allow-person-token"],
      remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const argv = (await waitForFile(outFile)).split("\n").slice(1);
    assert.strictEqual(argv[0], "-p", "dispatch still launches (supervised print mode)");
    assert.ok(!argv.includes("--mcp-config"), "no agent-scoping — person-scoped");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real) dispatch.allowPersonToken config: no agent configured => fails soft without the CLI flag", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1e-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1er-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { allowPersonToken: true } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(await waitForFile(outFile), "launched person-scoped, via dispatch.allowPersonToken");
  } finally {
    srv.close();
  }
});

// Local mode has no CA to mint against in the first place — the hard-fail is
// remote-only, and a local dispatch with no agent configured stays exactly as
// it always has (byte-identical).
test("dispatch (local, real): no agent identity concept at all — never hard-fails", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-dlocal-"));
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-dlocalh-")), "argv.out");
  const stub = argvStub(path.dirname(outFile), outFile);
  const r = run(["dispatch", "some free text task here", "--dir", repo, "--no-brief"], { SPOR_CLAUDE_CMD: stub, SPOR_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(await waitForFile(outFile), "local dispatch still launches with no agent configured");
});

test("dispatch (remote) --as: overrides dispatch.agent for one dispatch, marked (via --as)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-das-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-dasr-"));
  // dispatch.agent default is one agent; --as picks a different one for this run.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-default" } }) + "\n");
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print", "--as", "agent-other-machine"], remoteEnv(home, base, { SPOR_SESSION_ID: SID }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent:  agent-other-machine \(via --as\)/);
    assert.doesNotMatch(r.stdout, /agent-default/);
  } finally {
    srv.close();
  }
});

test("dispatch (local) --as: can't take effect (no CA) => note + person-scoped", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-dasl-"));
  const r = run(["dispatch", "some free text task here", "--dir", repo, "--no-brief", "--print", "--as", "agent-x"], { SPOR_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /--as agent-x ignored in local mode/);
  assert.doesNotMatch(r.stdout, /^agent:/m);
});

test("dispatch --as: an invalid agent id is refused before launch", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-dasi-"));
  const r = run(["dispatch", "some free text task here", "--dir", repo, "--no-brief", "--print", "--as", "Bad!"], { SPOR_SESSION_ID: SID });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --as agent id/);
});

// --as must enforce the SAME 'agent-<slug>' contract as the server's token-mint
// (issue-spor-dispatch-agent-id-prefix-validation-gap): a prefix-less slug is a
// valid kebab id but the server 422s it, so catch it before launch with a hint.
test("dispatch --as: a prefix-less id is refused before launch with a 'did you mean' hint", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-daspfx-"));
  const r = run(["dispatch", "some free text task here", "--dir", repo, "--no-brief", "--print", "--as", "anthony-shark-november"], { SPOR_SESSION_ID: SID });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --as agent id 'anthony-shark-november'/);
  assert.match(r.stderr, /did you mean '--as agent-anthony-shark-november'/);
});

test("dispatch (remote, real): mints a session-DEFERRED token + 0600 mcp-config, NO --session-id, binds the run session after launch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d2-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d2r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    // SPOR_SESSION_ID pins the captured session, short-circuiting `claude agents --json`.
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { ...NATIVE_BG, SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent:  agent-anthony-laptop \(writes attributed/);
    assert.match(r.stdout, new RegExp(`session: ${SID} \\(bound`)); // late-bound to the real run

    // argv: --bg … --mcp-config <file> --strict-mcp-config <prompt> — NO --session-id
    const lines = fs.readFileSync(outFile, "utf8").split("\n");
    const argv = lines.slice(1);
    assert.strictEqual(argv[0], "--bg");
    assert.ok(!argv.includes("--session-id"), "--session-id is never passed (claude --bg ignores it)");
    const mi = argv.indexOf("--mcp-config");
    assert.ok(mi >= 0, "--mcp-config present");
    assert.ok(argv.includes("--strict-mcp-config"), "--strict-mcp-config present");

    // the mcp-config file is 0600 and carries the agent-scoped bearer
    const mcpFile = argv[mi + 1];
    const st = fs.statSync(mcpFile);
    if (process.platform !== "win32") assert.strictEqual(st.mode & 0o777, 0o600, "mcp-config is 0600");
    const conf = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    assert.strictEqual(conf.mcpServers.spor.type, "http");
    assert.match(conf.mcpServers.spor.url, /\/mcp$/);
    assert.match(conf.mcpServers.spor.headers.Authorization, /^Bearer agtok_/);

    // the mint hit the self-serve owner-gated route, SESSION-DEFERRED (empty body)
    const mint = hits.find((h) => h.url === "/v1/agents/agent-anthony-laptop/token" && h.method === "POST");
    assert.ok(mint, "POSTed to /v1/agents/{id}/token (self-serve, not the admin route)");
    assert.deepStrictEqual(JSON.parse(mint.body), {}, "token minted session-deferred (no session up front)");
    assert.ok(!hits.some((h) => h.url === "/v1/admin/tokens"), "did NOT use the admin token route");

    // the claim is PERSON-SCOPED (no session up front); the real session is bound LATE.
    // It carries the per-invocation dispatch nonce (inc-spor-dispatch-duplicate-task-2026-06-18).
    const claim = hits.find((h) => /\/claim$/.test(h.url) && h.method === "POST");
    const claimBody = JSON.parse(claim.body);
    assert.ok(!("session" in claimBody), "claim is person-scoped (session bound later)");
    assert.ok(claimBody.dispatch && typeof claimBody.dispatch === "string", "claim carries a per-invocation dispatch nonce");
    // late bind: the token's session rebound via POST /v1/agents/session, and the lease renewed to it
    const bind = hits.find((h) => h.url === "/v1/agents/session" && h.method === "POST");
    assert.ok(bind, "POSTed to /v1/agents/session to bind the captured run session");
    assert.deepStrictEqual(JSON.parse(bind.body), { session: SID }, "the real session is bound to the token");
    const renew = hits.find((h) => /\/renew$/.test(h.url) && h.method === "POST");
    assert.ok(renew, "renewed the lease to the captured run session");
    assert.strictEqual(JSON.parse(renew.body).session, SID, "lease renewed with the real session");
  } finally {
    srv.close();
  }
});

// dec-spor-worker-strictness-split-interactive-lenient: a mint failure on a
// REAL run now HARD-FAILS by default — no launch, no lease, no side effect
// left to clean up. --allow-person-token (below) is the escape hatch that
// restores the old fail-soft.
test("dispatch (remote, real): mint endpoint absent (404) => hard-fails, names 'spor agent use' and --allow-person-token, nothing launched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 404 });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot dispatch dec-x: could not mint an agent-scoped token for agent-anthony-laptop \(this server can't mint agent-scoped session tokens yet\)/);
    assert.match(r.stderr, /spor agent use/);
    assert.match(r.stderr, /--allow-person-token/);
    assert.ok(!fs.existsSync(outFile), "nothing launched");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real) --allow-person-token: mint endpoint absent (404) => fails soft as before, person-scoped, no mcp-config flags", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3b-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3br-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 404 });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--allow-person-token"],
      remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /can't mint agent-scoped session tokens yet.*--allow-person-token/);
    const argv = (await waitForFile(outFile)).split("\n").slice(1);
    assert.ok(!argv.includes("--session-id"), "--session-id is never passed — the session is read off the run's own stream");
    assert.ok(!argv.includes("--mcp-config"), "no mcp-config when mint is absent");
    assert.ok(!argv.includes("--strict-mcp-config"), "no strict flag when mint is absent");
    assert.ok(!fs.existsSync(path.join(home, "outbox", "dispatch")), "no mcp-config file written");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real): mint 403 (caller doesn't own the agent) => hard-fails, nothing launched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-not-mine" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 403, mintBody: { error: { code: "forbidden", message: "not the owner" } } });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot dispatch dec-x: could not mint an agent-scoped token for agent-not-mine/);
    assert.match(r.stderr, /--allow-person-token/);
    assert.ok(!fs.existsSync(outFile), "nothing launched");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real) --allow-person-token: mint 403 (caller doesn't own the agent) => fails soft as before, person-scoped", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4b-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4br-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-not-mine" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 403, mintBody: { error: { code: "forbidden", message: "not the owner" } } });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--allow-person-token"],
      remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not mint an agent token .* dispatching person-scoped \(--allow-person-token\)/);
    const argv = (await waitForFile(outFile)).split("\n").slice(1);
    assert.ok(!argv.includes("--session-id"), "--session-id is never passed — the session is read off the run's own stream");
    assert.ok(!argv.includes("--mcp-config"), "no agent-scoping on an owner-mismatch");
  } finally {
    srv.close();
  }
});

// The standing config twin of --allow-person-token (dispatch.allowPersonToken):
// a machine that wants the old fail-soft on every dispatch, not just this one.
test("dispatch (remote, real) dispatch.allowPersonToken config: mint failure fails soft without the CLI flag", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4c-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4cr-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ dispatch: { agent: "agent-not-mine", allowPersonToken: true } }) + "\n"
  );
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 403, mintBody: { error: { code: "forbidden", message: "not the owner" } } });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(await waitForFile(outFile), "launched person-scoped, via dispatch.allowPersonToken");
  } finally {
    srv.close();
  }
});

// The root case (issue-spor-dispatch-agent-id-prefix-validation-gap): a configured
// dispatch.agent that DROPPED the `agent-` prefix (the label stored instead of the
// id) is caught CLIENT-SIDE before any network — no /v1/agents/{id}/token
// round-trip. Per dec-spor-worker-strictness-split-interactive-lenient a real run
// now HARD-FAILS on this (the config is simply broken and no agent identity is
// available), rather than silently launching person-scoped.
test("dispatch (remote, real): a prefix-less dispatch.agent hard-fails client-side — no mint round-trip, nothing launched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d5-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d5r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  // The bug-for-bug value from the issue: the LABEL, missing the agent- prefix.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "anthony-shark-november" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 1);
    // actionable error: names the bad value AND the exact fix, and the escape hatch
    assert.match(r.stderr, /cannot dispatch dec-x: configured dispatch\.agent 'anthony-shark-november' is not a valid agent id/);
    assert.match(r.stderr, /spor agent use agent-anthony-shark-november/);
    assert.match(r.stderr, /--allow-person-token/);
    // caught client-side: NO token mint round-trip at all (the whole point)
    assert.ok(!hits.some((h) => /\/token$/.test(h.url)), "no /v1/agents/{id}/token round-trip — caught before the network");
    assert.ok(!fs.existsSync(outFile), "nothing launched");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real) --allow-person-token: a prefix-less dispatch.agent fails soft as before, person-scoped", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d5b-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d5br-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "anthony-shark-november" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--allow-person-token"],
      remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /configured dispatch\.agent 'anthony-shark-november' is not a valid agent id/);
    assert.match(r.stderr, /dispatching person-scoped \(--allow-person-token\)/);
    assert.ok(!hits.some((h) => /\/token$/.test(h.url)), "no /v1/agents/{id}/token round-trip — caught before the network");
    const argv = (await waitForFile(outFile)).split("\n").slice(1);
    assert.strictEqual(argv[0], "-p", "dispatch still launches (supervised print mode)");
    assert.ok(!argv.includes("--mcp-config"), "no agent-scoping on an invalid dispatch.agent");
    assert.ok(!argv.includes("--strict-mcp-config"), "no strict flag either");
  } finally {
    srv.close();
  }
});

// The same misconfiguration under --print: a preview never fails (side-effect-free
// by design), so it still reports person-scoped — but now also flags that a real
// dispatch would refuse unless --allow-person-token is passed.
test("dispatch (remote, --print): a prefix-less dispatch.agent previews person-scoped, warns, and flags the real-run refusal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d6-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d6r-"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "anthony-shark-november" } }) + "\n");
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print"], remoteEnv(home, base, { SPOR_SESSION_ID: SID }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /configured dispatch\.agent 'anthony-shark-november' is not a valid agent id/);
    assert.match(r.stdout, /agent:  \(none configured/);
    assert.match(r.stdout, /real dispatch would REFUSE/);
    assert.doesNotMatch(r.stdout, /would mint/);
  } finally {
    srv.close();
  }
});

// Capture path: with NO SPOR_SESSION_ID, dispatch reads the REAL run session from
// `claude agents --json` post-launch and binds it (dec-spor-dispatch-bg-session-
// late-bind). This exercises the actual capture/match logic (newestDispatchedSession:
// cwd filter, state!=="done" filter, newest-by-startedAt) that the SPOR_SESSION_ID
// pin short-circuits in every other test. The fake agents list (SPOR_FAKE_AGENTS_JSON)
// is the same seam the dup-guard uses; --force is needed because that static list
// represents the POST-launch agent set, which the PRE-launch dup-guard also sees.
test("dispatch (remote, real): captures the run session from `claude agents --json` and binds it (no SPOR_SESSION_ID)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-cap-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-capr-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const REAL = "aaaaaaaa-1111-2222-3333-444444444444";
  // The candidates the capture must pick among. Only the newest, this-repo,
  // not-done agent should win — the others probe each filter. "old" predates
  // this dispatch's own launch (an EARLIER run of the same name+cwd — the
  // reusable-name scenario, issue-spor-dispatch-unbound-run-identity-not-
  // unique) so it must lose even though it shares name+cwd with "new"; "new"
  // is stamped well into the future so it reliably clears the "since this
  // launch" floor regardless of how long test setup takes.
  const past = Date.now() - 3600000;
  const future = Date.now() + 3600000;
  const agents = JSON.stringify([
    { id: "other", kind: "background", state: "working", name: "dec-x", cwd: "/some/other/repo", sessionId: "WRONG-other-repo", startedAt: future },
    { id: "old",   kind: "background", state: "working", name: "dec-x", cwd: repo,                sessionId: "WRONG-older-run",  startedAt: past },
    { id: "new",   kind: "background", state: "working", name: "dec-x", cwd: repo,                sessionId: REAL,               startedAt: future },
    { id: "done",  kind: "background", state: "done",    name: "dec-x", cwd: repo,                sessionId: "WRONG-finished",   startedAt: future },
  ]);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--force"],
      remoteEnv(home, base, { ...NATIVE_BG, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    // it reported binding the captured session
    assert.match(r.stdout, new RegExp(`session: ${REAL} \\(bound`));

    // the token was rebound to the REAL captured session (not a decoy)
    const bind = hits.find((h) => h.url === "/v1/agents/session" && h.method === "POST");
    assert.ok(bind, "POSTed /v1/agents/session to bind the captured session");
    assert.strictEqual(JSON.parse(bind.body).session, REAL, "bound the NEWEST this-repo non-done session");

    // and the lease was renewed to the same captured session
    const renew = hits.find((h) => /\/renew$/.test(h.url) && h.method === "POST");
    assert.ok(renew, "renewed the lease");
    assert.strictEqual(JSON.parse(renew.body).session, REAL, "lease renewed with the captured session");

    // none of the decoys (other-repo / older / done) leaked through
    assert.ok(!hits.some((h) => h.method === "POST" && /"session":"WRONG/.test(h.body || "")), "no decoy session was bound");
  } finally {
    srv.close();
  }
});

// issue-spor-dispatch-unbound-run-identity-not-unique: a launch NAME is
// derived from the node id, so re-dispatching the SAME node into the SAME
// checkout produces a candidate that matches on name+cwd exactly like the
// run just launched would — the only thing telling them apart is that the
// stale one started BEFORE this launch even began. Session capture must
// reject it rather than adopting it the instant it sees ANY same-name
// candidate, which is what an unbounded "newest so far" pick would do.
test("dispatch (remote, real): a STALE same-name agent from an EARLIER dispatch is never captured as this run's session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-stale-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-staler-"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, path.join(home, "argv.out"));
  // Only a STALE candidate exists — same name, same cwd, but its startedAt
  // predates this dispatch's own launch, exactly as an earlier, still-
  // registered (or zombie) agent from a prior dispatch of the same node
  // would look. No "real" candidate for THIS launch ever appears.
  const agents = JSON.stringify([
    { id: "stale", kind: "background", state: "working", name: "dec-x", cwd: repo, sessionId: "WRONG-earlier-run", startedAt: Date.now() - 3600000 },
  ]);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--force"],
      remoteEnv(home, base, { ...NATIVE_BG, SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    // no session was captured — the honest miss, never the stale decoy
    assert.doesNotMatch(r.stdout, /session: WRONG-earlier-run/);
    assert.match(r.stderr, /could not read the run session/);
    assert.ok(!hits.some((h) => h.method === "POST" && (h.body || "").includes("WRONG-earlier-run")), "the stale earlier-run session never reached the server");
  } finally {
    srv.close();
  }
});

// A `claude` stub whose "agents --json" answer changes over calls: it reports
// NOTHING for the first `emptyCalls` invocations (simulating the real launched
// agent not having registered with the daemon yet — the exact race the poll
// loop exists to ride out), then reports `agentsJson` from then on. Any other
// invocation (the `--bg` launch itself) just exits 0. Distinguishing "agents
// --json" from other subcommands mirrors dispatchHarnesses' activeDiscovery
// args, so this drives the SAME code path enumerateHarnessAgents does against
// a real claude binary — SPOR_FAKE_AGENTS_JSON would instead answer identically
// on every call, which can't reproduce a registration-lag race.
function delayedAgentsStub(dir, counterFile, emptyCalls, agentsJson) {
  return writeSpawnableNodeStub(dir, "claude-delayed-agents", `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("agents") && argv.includes("--json")) {
  let n = 0;
  try { n = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8"), 10) || 0; } catch {}
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(n + 1));
  process.stdout.write(n < ${JSON.stringify(emptyCalls)} ? "[]" : ${JSON.stringify(agentsJson)});
}
process.exit(0);
`);
}

// issue-spor-dispatch-ambient-session-id-borrows-caller-transcript: an ambient
// SPOR_SESSION_ID (e.g. a caller's own session, leaked into the env a real
// dispatch runs under) must never be trusted once discovery PROVES it isn't the
// launched agent's session — even when the real agent only shows up in `claude
// agents --json` a couple of poll iterations after launch, not instantly. A
// one-shot check taken before the poll starts would see nothing yet and
// rubber-stamp the pin; verification has to live INSIDE the poll to catch this.
test("dispatch (remote, real): a SPOR_SESSION_ID that doesn't match the launched agent is ignored, even if the real agent registers a couple of poll ticks late", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-pinmismatch-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-pinmismatchr-"));
  const counterFile = path.join(home, "agents-calls.count");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const REAL = "aaaaaaaa-1111-2222-3333-444444444444";
  const CALLER_PIN = "ffffffff-0000-0000-0000-ffffffffffff"; // an unrelated live session, e.g. the caller's own
  const agents = JSON.stringify([
    { id: "new", kind: "background", state: "working", name: "dec-x", cwd: repo, sessionId: REAL, startedAt: Date.now() + 3600000 },
  ]);
  // The pre-launch dup-guard also calls "agents --json" once before the launch
  // even happens, so the empty answer must outlast that call too — 2 empty
  // calls (dup-guard + the poll's first tick) before the real agent "appears".
  const stub = delayedAgentsStub(home, counterFile, 2, agents);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    // remoteEnv/localEnv default SPOR_FAKE_AGENTS_JSON to "[]" so ordinary tests
    // never spawn a real "agents --json" process — but that same seam would
    // short-circuit THIS test's delayed stub, so drop it and let discovery
    // actually invoke delayedAgentsStub.
    const env = remoteEnv(home, base, { ...NATIVE_BG, SPOR_CLAUDE_CMD: stub, SPOR_SESSION_ID: CALLER_PIN });
    delete env.SPOR_FAKE_AGENTS_JSON;
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], env);
    assert.strictEqual(r.status, 0, r.stderr);
    // it really did take more than one poll tick to appear
    const calls = parseInt(fs.readFileSync(counterFile, "utf8"), 10);
    assert.ok(calls >= 3, `expected the real agent to register after the first poll tick (saw ${calls} "agents --json" calls)`);
    // the pin's mismatch is called out, and the REAL discovered session wins —
    // never the caller's pinned session/transcript
    assert.match(r.stderr, /SPOR_SESSION_ID.*does not match the launched agent's session/);
    assert.match(r.stdout, new RegExp(`session: ${REAL} \\(bound`));
    assert.doesNotMatch(r.stdout, new RegExp(CALLER_PIN));

    const bind = hits.find((h) => h.url === "/v1/agents/session" && h.method === "POST");
    assert.ok(bind, "POSTed /v1/agents/session to bind the captured session");
    assert.strictEqual(JSON.parse(bind.body).session, REAL, "bound the discovered session, not the mismatched pin");
    assert.ok(!hits.some((h) => h.method === "POST" && (h.body || "").includes(CALLER_PIN)), "the caller's pinned session never reached the server");
  } finally {
    srv.close();
  }
});

// ===========================================================================
// 3b. spor work inherits the identity hard-fail (dec-spor-worker-strictness-
//     split-interactive-lenient) — every launch it makes goes through the same
//     cmdDispatch code path, so this is the end-to-end wiring check, not a
//     re-test of every mint scenario already covered above.
// ===========================================================================

test("spor work --once (remote): no agent configured => the dispatch hard-fails, the loop records the refusal and dispatches nothing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-w1-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-w1r-"));
  fs.mkdirSync(home, { recursive: true });
  const { srv, base } = await dispatchStub({ queueItem: { id: "task-foo", type: "task", project: "demo", repo: "demo", title: "The actionable task", readiness: "agent" } });
  try {
    run(["repos", "add", "demo", repo], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    const r = await runAsync(
      ["work", "--once", "--max", "1", "--interval", "1", "--no-brief"],
      remoteEnv(home, base, { SPOR_SESSION_ID: SID })
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /work: skipping task-foo —/);
    assert.match(r.stdout, /dispatched 0;/);
    const status = JSON.parse(run(["work", "--status", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home }).stdout);
    const skipped = status.workers[0].skipped;
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].id, "task-foo");
    assert.match(skipped[0].reason, /no dispatch agent configured for this machine/, "the loop's skip reason IS the hard-fail's own message");
  } finally {
    srv.close();
  }
});

// The --allow-person-token PASSTHROUGH itself (cmdWork's `passthrough` object,
// bin/spor.js) is exercised directly at the dispatch level above (identical CLI
// flag, identical cmdDispatch call) — a full native-background spor-work run
// here would need to wait out the harness's live-agent reconciliation cadence
// for very little extra signal, so this stays a dispatch-level check.

// ===========================================================================
// 4. authorship read-out (authorshipLine + renderNorm)
// ===========================================================================

test("authorshipLine: agent stamp => 'agent <label> on behalf of <person>'", () => {
  const nodes = { "agent-anthony-laptop": { id: "agent-anthony-laptop", type: "agent", title: "anthony-laptop" } };
  assert.strictEqual(
    kernel.authorshipLine({ author: "Anthony <a@x.io>", authored_by_agent: "agent-anthony-laptop" }, nodes),
    "agent anthony-laptop on behalf of Anthony <a@x.io>"
  );
});

test("authorshipLine: no stamp => the plain person author, byte-identical", () => {
  assert.strictEqual(kernel.authorshipLine({ author: "Anthony <a@x.io>" }, {}), "Anthony <a@x.io>");
  assert.strictEqual(kernel.authorshipLine({}, {}), "");
});

test("authorshipLine: unresolvable agent node still reads as on-behalf-of (bare id)", () => {
  assert.strictEqual(
    kernel.authorshipLine({ author: "Anthony <a@x.io>", authored_by_agent: "agent-ghost" }, {}),
    "agent agent-ghost on behalf of Anthony <a@x.io>"
  );
});

test("renderNorm (via compile): an agent-authored norm reads on-behalf-of; a person-direct norm is unchanged", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-norm-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "person-anthony.md"), `---\nid: person-anthony\ntype: person\ntitle: Anthony\nsummary: Member.\nemail: a@x.io\ndate: 2026-06-16\n---\nMember.\n`);
  fs.writeFileSync(path.join(nodes, "agent-anthony-laptop.md"), `---\nid: agent-anthony-laptop\ntype: agent\ntitle: anthony-laptop\nsummary: Principal owned by person-anthony.\nspiffe: spiffe://spor.local/person/anthony/agent/anthony-laptop\npubkey: \nstatus: active\ndate: 2026-06-16\nedges:\n  - {type: owned-by, to: person-anthony}\n---\nPrincipal.\n`);
  fs.writeFileSync(path.join(nodes, "norm-agent.md"), `---\nid: norm-agent\ntype: norm\ntitle: Lint before commit\nsummary: Run the linter before every commit.\nalways_on: true\nproject: demo\nauthor: Anthony <a@x.io>\nauthored_by_agent: agent-anthony-laptop\ndate: 2026-06-16\n---\nRun the linter before every commit.\n`);
  fs.writeFileSync(path.join(nodes, "norm-person.md"), `---\nid: norm-person\ntype: norm\ntitle: Absolute paths\nsummary: Reference files by absolute path.\nalways_on: true\nproject: demo\nauthor: Anthony <a@x.io>\ndate: 2026-06-16\n---\nUse absolute paths.\n`);

  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "compile.js"), "--root", "norm-agent", "--project", "demo"], { encoding: "utf8", env: localEnv({ SPOR_HOME: home }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\*authored by: agent anthony-laptop on behalf of Anthony <a@x\.io>\*/);
  assert.match(r.stdout, /\*authored by: Anthony <a@x\.io>\*/); // the person-direct norm, unchanged
});
