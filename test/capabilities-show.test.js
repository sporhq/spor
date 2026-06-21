// capabilities-show.test.js — `spor capabilities show <agent-id>` is the explicit
// READER of one agent's published fleet capabilities
// (GET /v1/agents/{id}/capabilities, task-spor-capabilities-read-agent-cli-verb).
// The read twin of `spor capabilities publish` (which POSTs the same endpoint)
// and the per-agent companion to `hosts` (profile→boxes): it surfaces what a
// SPECIFIC box advertised (caps + published_at/last_seen/published_by) without
// falling back to raw REST. Readable by the owner, the agent itself, or an admin.
//
// Oracle = the request the CLI makes (the GET path) + its rendered output + the
// fail-soft exits, never the server's framing (we script the responses).

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const isWin = process.platform === "win32";

// Strip ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip a test to
// remote or leak a token (mirrors capabilities-hosts.test.js / dispatch.test.js).
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  env.SPOR_DISTILLING = "1";
  return Object.assign(env, extra);
}
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-show-"));
}
// A scratch home whose user config pins this box's dispatch.agent (for `me`).
function homeWithAgent(agent) {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dispatch: { agent } }) + "\n");
  return home;
}

// Records every request; GET /v1/agents/{id}/capabilities returns a scriptable record.
function showStub({ status = 200, body } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const m = req.url.match(/^\/v1\/agents\/([^/?]+)\/capabilities$/);
    if (m && req.method === "GET") {
      if (status !== 200) {
        const codeFor = { 403: "forbidden", 404: "not_found" };
        const msgFor = { 403: "readable by the owner, the agent itself, or an admin" };
        return j(status, { error: { code: codeFor[status] || "bad_request", message: msgFor[status] || "x" } });
      }
      return j(200, body || { agent: decodeURIComponent(m[1]), capabilities: {}, published_at: null, last_seen: null, published_by: null });
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (home, base, extra = {}) =>
  baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("show (local mode): refuses remote-only with a clear line", { skip: isWin }, async () => {
  const home = freshHome();
  const r = await runAsync(["capabilities", "show", "agent-bob"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote-only/);
});

test("show (no agent id): falls through to THIS box's local effective caps", { skip: isWin }, async () => {
  // `show`/`list` with no agent id stay the local-box read (byte-identical),
  // working even in local mode — the agent read is the only remote branch.
  const home = freshHome();
  for (const args of [["capabilities", "show"], ["capabilities"], ["capabilities", "list"]]) {
    const r = await runAsync(args, baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /harnesses:/);
    assert.match(r.stdout, /reachable_mcp:/);
  }
});

test("show (remote): renders an agent's published caps + timestamps and GETs the right path", { skip: isWin }, async () => {
  const { srv, hits, base } = await showStub({
    body: {
      agent: "agent-bob-laptop",
      capabilities: { harnesses: ["claude-code", "codex"], reachable_mcp: ["spor"], skills: ["writing", "impeccable"], plugins: ["spor"], deny: ["profile-x"] },
      published_at: "2026-06-20T10:00:00.000Z",
      last_seen: "2026-06-21T09:00:00.000Z",
      published_by: "person-bob",
      session: "sess-1",
    },
  });
  try {
    const r = await runAsync(["capabilities", "show", "agent-bob-laptop"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent-bob-laptop — published capabilities/);
    assert.match(r.stdout, /harnesses:\s+claude-code, codex/);
    assert.match(r.stdout, /reachable_mcp:\s+spor/);
    assert.match(r.stdout, /skills:\s+2/);
    assert.match(r.stdout, /plugins:\s+spor/);
    assert.match(r.stdout, /deny:\s+profile-x/);
    assert.match(r.stdout, /published_at:\s+2026-06-20T10:00:00\.000Z/);
    assert.match(r.stdout, /last_seen:\s+2026-06-21T09:00:00\.000Z/);
    assert.match(r.stdout, /published_by:\s+person-bob/);
    const hit = hits.find((h) => h.method === "GET" && h.url === "/v1/agents/agent-bob-laptop/capabilities");
    assert.ok(hit, "GET /v1/agents/agent-bob-laptop/capabilities");
  } finally {
    srv.close();
  }
});

test("show (remote): --json emits the parsed record", { skip: isWin }, async () => {
  const body = { agent: "agent-bob", capabilities: { harnesses: ["codex"] }, published_at: "2026-06-20T00:00:00.000Z", last_seen: "2026-06-20T00:00:00.000Z", published_by: "person-bob" };
  const { srv, base } = await showStub({ body });
  try {
    const r = await runAsync(["capabilities", "show", "agent-bob", "--json"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.agent, "agent-bob");
    assert.deepStrictEqual(j.capabilities.harnesses, ["codex"]);
    assert.strictEqual(j.published_by, "person-bob");
  } finally {
    srv.close();
  }
});

test("show (remote): `me` resolves to this box's dispatch.agent", { skip: isWin }, async () => {
  const { srv, hits, base } = await showStub({ body: { agent: "agent-mine", capabilities: {}, published_at: "2026-06-20T00:00:00.000Z" } });
  try {
    const r = await runAsync(["capabilities", "show", "me"], remoteEnv(homeWithAgent("agent-mine"), base));
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.method === "GET" && h.url === "/v1/agents/agent-mine/capabilities");
    assert.ok(hit, "resolved `me` → dispatch.agent in the GET path");
  } finally {
    srv.close();
  }
});

test("show (remote): `me` with no dispatch.agent configured errors with a pointer", { skip: isWin }, async () => {
  const { srv, base } = await showStub();
  try {
    const r = await runAsync(["capabilities", "show", "me"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no dispatch agent configured/);
    assert.match(r.stderr, /spor agent use/);
  } finally {
    srv.close();
  }
});

test("show (remote): a 404 (no caps published / unknown agent) fails soft", { skip: isWin }, async () => {
  const { srv, base } = await showStub({ status: 404 });
  try {
    const r = await runAsync(["capabilities", "show", "agent-nope"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no capabilities published for 'agent-nope'/);
  } finally {
    srv.close();
  }
});

test("show (remote): a 403 reports an authorization denial, not a transport outage", { skip: isWin }, async () => {
  // Readable only by the owner / the agent / an admin (API.md §3); a denial must
  // NOT be misreported as an outage (mirrors issue-spor-capabilities-hosts-403-misreported).
  const { srv, base } = await showStub({ status: 403 });
  try {
    const r = await runAsync(["capabilities", "show", "agent-someone-elses"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not authorized to read agent-someone-elses's published capabilities/);
    assert.match(r.stderr, /owner, the agent itself, or an admin/);
    assert.doesNotMatch(r.stderr, /could not reach the fleet scheduler/);
  } finally {
    srv.close();
  }
});

test("show (remote): a dead server fails soft with a transport line", { skip: isWin }, async () => {
  const r = await runAsync(["capabilities", "show", "agent-bob"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not reach the fleet scheduler/);
});
