// join.test.js — `spor join` onboarding, with the hosted-server default
// (task-spor-api-cli-default-server-base). The server URL defaults to the hosted
// Spor REST base (lib/config.js DEFAULT_SERVER = https://api.sporhq.io) when
// omitted, so onboarding is `spor join <token>` rather than requiring the URL.
//
// Oracle = what `spor join` WRITES to the user config.json (server + token), not
// the confirm step's framing. The confirm's /v1/status + /v1/me probe is
// redirected to a local stub via env SPOR_SERVER (which sits ABOVE config.json in
// the cascade) so the test never reaches the real hosted host.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { DEFAULT_SERVER } = require(path.join(__dirname, "..", "lib", "config.js"));
const isWin = process.platform === "win32";

// Strip ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip the test
// to remote or leak a token (mirrors capabilities-publish.test.js).
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
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

// A scratch HOME whose config.json `spor join` reads AND writes (userConfigHome
// resolves to SPOR_HOME). XDG too so the global config layer can't leak in.
function scratchHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-join-"));
  return home;
}

function readCfg(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

// Minimal status stub so the join confirm (cmdStatus → /v1/status, /v1/me) is
// fast and deterministic instead of hitting the real hosted host.
function statusStub() {
  const srv = http.createServer((req, res) => {
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/v1/status") return j(200, { node_count: 7 });
    if (req.url === "/v1/me") return j(200, { bound: true, person: "person-test", email: "t@test.dev", is_admin: false });
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("join: no URL defaults SPOR_SERVER to the hosted base, with a token", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await statusStub();
  try {
    // env SPOR_SERVER redirects the confirm probe to the stub; the WRITE still
    // uses the omitted-URL default (env never feeds writeServerToken).
    const r = await runAsync(["join", "spor_pat_abc123"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = readCfg(home);
    assert.strictEqual(cfg.server, DEFAULT_SERVER, "wrote the hosted default server");
    assert.strictEqual(cfg.server, "https://api.sporhq.io", "the hosted default is api.sporhq.io");
    assert.strictEqual(cfg.token, "spor_pat_abc123", "token-shaped positional taken as the token");
    assert.match(r.stdout, /using the hosted Spor default https:\/\/api\.sporhq\.io/);
  } finally {
    srv.close();
  }
});

test("join: explicit URL + token still wins (no default applied)", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await statusStub();
  try {
    const r = await runAsync(["join", base, "spor_pat_xyz"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = readCfg(home);
    assert.strictEqual(cfg.server, base, "explicit URL written verbatim");
    assert.strictEqual(cfg.token, "spor_pat_xyz");
    assert.doesNotMatch(r.stdout, /using the hosted Spor default/, "no default banner when a URL is given");
  } finally {
    srv.close();
  }
});

test("join: --token flag only defaults the server to the hosted base", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await statusStub();
  try {
    const r = await runAsync(["join", "--token", "spor_pat_flag"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = readCfg(home);
    assert.strictEqual(cfg.server, DEFAULT_SERVER);
    assert.strictEqual(cfg.token, "spor_pat_flag");
  } finally {
    srv.close();
  }
});

test("join: no args writes the hosted default and notes the missing token", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await statusStub();
  try {
    const r = await runAsync(["join"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = readCfg(home);
    assert.strictEqual(cfg.server, DEFAULT_SERVER, "bare join still onboards to the hosted base");
    assert.ok(!cfg.token, "no token written");
    assert.match(r.stdout, /no token given/);
  } finally {
    srv.close();
  }
});

test("join: --server flag overrides the default", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await statusStub();
  try {
    const r = await runAsync(["join", "--server", base, "--token", "spor_pat_s"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = readCfg(home);
    assert.strictEqual(cfg.server, base);
    assert.strictEqual(cfg.token, "spor_pat_s");
    assert.doesNotMatch(r.stdout, /using the hosted Spor default/);
  } finally {
    srv.close();
  }
});
