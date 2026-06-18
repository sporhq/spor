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

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const kernel = require("../lib/kernel/graph.js");
const isWin = process.platform === "win32";

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
  return Object.assign(env, extra);
}
function remoteEnv(home, server, extra = {}) {
  const env = localEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: server, SPOR_TOKEN: "test-token" });
  return Object.assign(env, extra);
}
function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: localEnv(env), cwd });
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
  assert.match(r.stdout, /created agent agent-anthony-laptop owned by person-anthony/);
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
  assert.match(r.stdout, /agent-anthony-laptop\towned-by person-anthony\tactive/);
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

test("agent use: missing id prints usage", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-useu-"));
  const r = run(["agent", "use"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor agent use/);
});

// ===========================================================================
// 2. spor agent create (remote) — fail-soft when the endpoint is absent
// ===========================================================================

// Stub server answering /v1/me, a configurable /v1/admin/agents, and the agent
// list surface. `agentsList` (when set) serves GET /v1/agents; otherwise that
// route 404s and the client falls back to the /v1/changes audit projection
// (served when `changes` is set), exercising both list paths.
function agentStub({ agentsStatus = 201, agentsBody = null, agentsList = null, changes = null } = {}) {
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
      if (req.url === "/v1/agents" && req.method === "GET") {
        if (agentsList) return j(200, { agents: agentsList });
        return j(404, { error: { code: "not_found" } }); // surface not deployed
      }
      if (req.url.startsWith("/v1/changes")) {
        return j(200, { changes: changes || [
          { id: "agent-anthony-laptop", change: "added", type: "agent", title: "anthony-laptop" },
          { id: "task-x", change: "modified", type: "task", title: "Some task" },
        ], count: 2 });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("agent create (remote): POSTs /v1/admin/agents and prints the created id + spiffe", { skip: isWin }, async () => {
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
  } finally {
    srv.close();
  }
});

test("agent create (remote): a server without the endpoint (404) fails soft, not a crash", { skip: isWin }, async () => {
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

test("agent list (remote): reads GET /v1/agents (the caller's owned agents)", { skip: isWin }, async () => {
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

test("agent list (remote): falls back to the /v1/changes projection when /v1/agents 404s", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-rem3b-"));
  const { srv, base } = await agentStub({}); // agentsList unset => /v1/agents 404 => /v1/changes
  try {
    const r = await runAsync(["agent", "list"], remoteEnv(home, base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent-anthony-laptop\tanthony-laptop/);
    assert.doesNotMatch(r.stdout, /task-x/); // non-agent rows dropped
  } finally {
    srv.close();
  }
});

// ===========================================================================
// 3. dispatch identity wiring
// ===========================================================================

// A claude stub that dumps cwd + argv to a file, then exits 0.
function argvStub(dir, outFile) {
  const stub = path.join(dir, "claude-argv.sh");
  fs.writeFileSync(stub, `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > "${outFile}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}

// Stub server: /v1/me, GET /v1/nodes/{id}, POST /v1/nodes/{id}/claim (records
// the session it received), and the SELF-SERVE owner-gated per-session mint
// POST /v1/agents/{id}/token (configurable status; records the agent {id} in the
// path + the session in the body).
function dispatchStub({ mintStatus = 201, mintBody = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/me") return j(200, { person: "person-anthony", bound: true, is_admin: true });
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

test("dispatch (remote) --print: no agent configured => person-scoped notice, lease bound after launch", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d1r-"));
  const { srv, base } = await dispatchStub();
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief", "--print"], remoteEnv(home, base, { SPOR_SESSION_ID: SID }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent:  \(none configured/);
    assert.doesNotMatch(r.stdout, /--session-id/); // never forced
    assert.match(r.stdout, new RegExp(`session: ${SID}`)); // pinned shows; else "(allocated by claude --bg…)"
    assert.match(r.stdout, /would establish a lease on dec-x/);
  } finally {
    srv.close();
  }
});

test("dispatch (remote) --as: overrides dispatch.agent for one dispatch, marked (via --as)", { skip: isWin }, async () => {
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

test("dispatch (remote, real): mints a session-DEFERRED token + 0600 mcp-config, NO --session-id, binds the run session after launch", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d2-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d2r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    // SPOR_SESSION_ID pins the captured session, short-circuiting `claude agents --json`.
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
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
    assert.strictEqual(st.mode & 0o777, 0o600, "mcp-config is 0600");
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

test("dispatch (remote, real): mint endpoint absent (404) => fails soft, person-scoped, no mcp-config flags", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d3r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 404 });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /can't mint agent-scoped session tokens yet/);
    const argv = fs.readFileSync(outFile, "utf8").split("\n").slice(1);
    assert.ok(!argv.includes("--session-id"), "--session-id is never passed (claude --bg ignores it)");
    assert.ok(!argv.includes("--mcp-config"), "no mcp-config when mint is absent");
    assert.ok(!argv.includes("--strict-mcp-config"), "no strict flag when mint is absent");
    assert.ok(!fs.existsSync(path.join(home, "outbox", "dispatch")), "no mcp-config file written");
  } finally {
    srv.close();
  }
});

test("dispatch (remote, real): mint 403 (caller doesn't own the agent) => fails soft, person-scoped", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-d4r-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-not-mine" } }) + "\n");
  const stub = argvStub(home, outFile);
  const { srv, base } = await dispatchStub({ mintStatus: 403, mintBody: { error: { code: "forbidden", message: "not the owner" } } });
  try {
    const r = await runAsync(["dispatch", "dec-x", "--dir", repo, "--no-brief"], remoteEnv(home, base, { SPOR_SESSION_ID: SID, SPOR_CLAUDE_CMD: stub }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not mint an agent token .* dispatching person-scoped/);
    const argv = fs.readFileSync(outFile, "utf8").split("\n").slice(1);
    assert.ok(!argv.includes("--session-id"), "--session-id is never passed (claude --bg ignores it)");
    assert.ok(!argv.includes("--mcp-config"), "no agent-scoping on an owner-mismatch");
  } finally {
    srv.close();
  }
});

// The root case (issue-spor-dispatch-agent-id-prefix-validation-gap): a configured
// dispatch.agent that DROPPED the `agent-` prefix (the label stored instead of the
// id). Before the fix this 422'd at token-mint on EVERY dispatch and fell back to
// person-scoped with a non-actionable warning. Now it's caught CLIENT-SIDE before
// any network: no /v1/agents/{id}/token round-trip, an actionable warning naming
// the bad value + the fix, and a clean person-scoped launch.
test("dispatch (remote, real): a prefix-less dispatch.agent fails soft client-side — no mint round-trip, actionable warning, person-scoped", { skip: isWin }, async () => {
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
    assert.strictEqual(r.status, 0, r.stderr);
    // actionable warning: names the bad value AND the exact fix
    assert.match(r.stderr, /configured dispatch\.agent 'anthony-shark-november' is not a valid agent id/);
    assert.match(r.stderr, /spor agent use agent-anthony-shark-november/);
    // caught client-side: NO token mint round-trip at all (the whole point)
    assert.ok(!hits.some((h) => /\/token$/.test(h.url)), "no /v1/agents/{id}/token round-trip — caught before the network");
    // still launched, person-scoped (no agent-scoping flags)
    const argv = fs.readFileSync(outFile, "utf8").split("\n").slice(1);
    assert.strictEqual(argv[0], "--bg", "dispatch still launches");
    assert.ok(!argv.includes("--mcp-config"), "no agent-scoping on an invalid dispatch.agent");
    assert.ok(!argv.includes("--strict-mcp-config"), "no strict flag either");
  } finally {
    srv.close();
  }
});

// The same misconfiguration under --print: the preview must report person-scoped
// (not "would mint a token", which the old preview did — a lie, since the mint
// 422s), with the actionable warning on stderr.
test("dispatch (remote, --print): a prefix-less dispatch.agent previews person-scoped + warns", { skip: isWin }, async () => {
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
test("dispatch (remote, real): captures the run session from `claude agents --json` and binds it (no SPOR_SESSION_ID)", { skip: isWin }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-cap-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-agent-capr-"));
  const outFile = path.join(home, "argv.out");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent: "agent-anthony-laptop" } }) + "\n");
  const stub = argvStub(home, outFile);
  const REAL = "aaaaaaaa-1111-2222-3333-444444444444";
  // The candidates the capture must pick among. Only the newest, this-repo,
  // not-done agent should win — the others probe each filter.
  const agents = JSON.stringify([
    { id: "other", kind: "background", state: "working", name: "dec-x", cwd: "/some/other/repo", sessionId: "WRONG-other-repo", startedAt: 9999 },
    { id: "old",   kind: "background", state: "working", name: "dec-x", cwd: repo,                sessionId: "WRONG-older-run",  startedAt: 1000 },
    { id: "new",   kind: "background", state: "working", name: "dec-x", cwd: repo,                sessionId: REAL,               startedAt: 2000 },
    { id: "done",  kind: "background", state: "done",    name: "dec-x", cwd: repo,                sessionId: "WRONG-finished",   startedAt: 5000 },
  ]);
  const { srv, hits, base } = await dispatchStub({ mintStatus: 201 });
  try {
    const r = await runAsync(
      ["dispatch", "dec-x", "--dir", repo, "--no-brief", "--force"],
      remoteEnv(home, base, { SPOR_CLAUDE_CMD: stub, SPOR_FAKE_AGENTS_JSON: agents })
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
