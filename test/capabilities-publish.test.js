// capabilities-publish.test.js — `spor capabilities publish` pushes this box's
// EFFECTIVE capabilities to the team server's fleet scheduler
// (task-spor-remote-fleet-scheduler). The remote twin of the LOCAL satisfiability
// match `spor dispatch` runs: the server host-matches an assigned profile against
// every box's published capabilities to enable substitution-free re-routing.
//
// Oracle = the REQUEST BODY the CLI POSTs (the same effectiveCapabilities()
// collapse the local path uses) + the fail-soft exits, never the server's framing.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const isWin = process.platform === "win32";

// Strip the ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip a test
// to remote or leak a token (mirrors dispatch.test.js / agent-identity.test.js).
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

// A scratch home whose user config carries a probed+declared capability map.
function homeWithCaps() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-pub-"));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      dispatch: {
        capabilities: {
          probed: { harnesses: ["claude-code"], plugins: ["spor"] },
          declared: { skills: ["writing"] },
        },
      },
    }) + "\n"
  );
  return home;
}

// A scratch HOME (no ~/.claude manifest) and a harness-free PATH (only git, for
// config load), so the publish's re-probe (issue-spor-capabilities-publish-
// manual-no-spor-seed) yields a DETERMINISTIC set on any box: empty
// harnesses/plugins/skills, with reachable_mcp seeded to [spor] from remote-mode
// CONFIGURED-ness. Without pinning HOME/PATH the probe would read this box's real
// harnesses + ~/.claude (a dev box with `claude` installed flips the assertion).
function cleanProbeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-cleanhome-"));
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-path-"));
  const git = (spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout || "").trim();
  if (git) { try { fs.symlinkSync(git, path.join(pathDir, "git")); } catch { /* ignore */ } }
  return { HOME: home, PATH: pathDir };
}

// Records every request; POST /v1/agents/{id}/capabilities echoes the collapsed caps.
function capStub({ status = 200 } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/agents\/([^/]+)\/capabilities$/);
      if (m && req.method === "POST") {
        if (status !== 200) return j(status, { error: { code: status === 404 ? "not_found" : "forbidden", message: "x" } });
        const caps = JSON.parse(body || "{}");
        return j(200, { agent: decodeURIComponent(m[1]), capabilities: caps, published_at: "2026-06-19T00:00:00.000Z", published_by: "person-anthony", changed: true });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

const remoteEnv = (home, base, extra = {}) =>
  baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("publish (local mode): refuses remote-only with a clear line", { skip: isWin }, async () => {
  const home = homeWithCaps();
  const r = await runAsync(["capabilities", "publish"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote-only/);
});

test("publish (remote, no dispatch.agent): refuses with a `spor agent use` hint", { skip: isWin }, async () => {
  const home = homeWithCaps();
  const { srv, base } = await capStub();
  try {
    const r = await runAsync(["capabilities", "publish"], remoteEnv(home, base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no dispatch agent configured/);
    assert.match(r.stderr, /spor agent use/);
  } finally {
    srv.close();
  }
});

test("publish (remote): re-probes THIS box then POSTs the effective capabilities to /v1/agents/{id}/capabilities", { skip: isWin }, async () => {
  const home = homeWithCaps();
  const { srv, hits, base } = await capStub();
  try {
    const r = await runAsync(["capabilities", "publish"], remoteEnv(home, base, { SPOR_DISPATCH_AGENT: "agent-anthony-laptop", ...cleanProbeEnv() }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /published agent-anthony-laptop to the fleet scheduler/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/agents/agent-anthony-laptop/capabilities");
    assert.ok(post, "POSTed to the agent's capabilities endpoint");
    // The body is the EFFECTIVE collapse over a FRESH probe (not the stale fixture
    // .probed): the harness-free PATH + clean HOME probe to empty harnesses/plugins/
    // skills, the sticky `declared.skills` survives, and reachable_mcp is the
    // deterministic [spor] seed remote mode always carries
    // (issue-spor-capabilities-publish-manual-no-spor-seed).
    assert.deepStrictEqual(JSON.parse(post.body), {
      harnesses: [], reachable_mcp: ["spor"], skills: ["writing"], plugins: [], deny: [],
    });
  } finally {
    srv.close();
  }
});

test("publish (remote): seeds reachable_mcp:[spor] even when config carried no .probed (the manual/auto parity fix)", { skip: isWin }, async () => {
  // The regression: a box whose ~/.spor/config.json has NO dispatch.capabilities
  // (never ran session-start) used to publish a caps set MISSING the spor seed, so
  // an `mcp:[spor]` profile failed to host-match it. The manual verb now re-probes
  // with sporReachable, exactly like the session-start auto-publish.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-noprobe-"));
  const { srv, hits, base } = await capStub();
  try {
    const r = await runAsync(["capabilities", "publish"], remoteEnv(home, base, { SPOR_DISPATCH_AGENT: "agent-fresh-box", ...cleanProbeEnv() }));
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/agents/agent-fresh-box/capabilities");
    assert.ok(post, "POSTed to the agent's capabilities endpoint");
    const body = JSON.parse(post.body);
    assert.deepStrictEqual(body.reachable_mcp, ["spor"], "spor MCP seeded by the fresh re-probe");
  } finally {
    srv.close();
  }
});

test("publish (remote): an undeployed surface (404) fails soft, not a crash", { skip: isWin }, async () => {
  const home = homeWithCaps();
  const { srv, base } = await capStub({ status: 404 });
  try {
    const r = await runAsync(["capabilities", "publish"], remoteEnv(home, base, { SPOR_DISPATCH_AGENT: "agent-x" }));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /404/);
  } finally {
    srv.close();
  }
});

test("publish (remote): a dead server fails soft with a transport line", { skip: isWin }, async () => {
  const home = homeWithCaps();
  // a port nothing is listening on
  const r = await runAsync(["capabilities", "publish"], remoteEnv(home, "http://127.0.0.1:1", { SPOR_DISPATCH_AGENT: "agent-x" }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not reach the server/);
});
