// issue-spor-tenant-resolution-gaps:
//   1. `spor auth login` reconciles a FLAT bearer the cascade pairs with the
//      server ahead of the store (Config.flatTokenShadow): a config-file token
//      the server rejects is removed, an env one / a still-accepted one is
//      reported — never a silent 401 right after a successful sign-in.
//   2. (the same-server pick rule was unified by task-spor-client-config-
//      tenant-unification-and-refresh; see tenant-unification-refresh.test.js)
//   3. lib/remote.js refreshes only through the resolved tenant's exact store
//      `key` — no tenantKey(server, org) fallback that could name a sibling.
// Every home is a mkdtemp scratch dir; every server a port-0 stub.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const auth = require("../lib/auth");
const remote = require("../lib/remote");
const { loadConfig } = require("../lib/config");
const { hermeticEnv } = require("./helpers/env");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spor-tenant-gaps-"));
const envAt = (home, extra = {}) => hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: home, ...extra });
const loadAt = (home, env = {}) => loadConfig({ cwd: home, env: envAt(home, env) });
const writeUserConfig = (home, data) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(data));
const readUserConfig = (home) => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));

function run(args, env) {
  return new Promise((resolve) => {
    let out = "";
    let er = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (er += d));
    c.on("close", (code) => resolve({ code, stdout: out, stderr: er }));
  });
}

// /v1/me accepts exactly the bearers in `valid`.
function meServer(valid) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    hits.push({ url: req.url, bearer });
    const ok = req.url === "/v1/me" && valid.includes(bearer);
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { person: "person-x", org: "acme" } : { error: "unauthorized" }));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// ---------------------------------------------------------------------------
// Config.flatTokenShadow
// ---------------------------------------------------------------------------

test("flatTokenShadow: SPOR_TOKEN for SPOR_SERVER shadows the stored credential", () => {
  const home = tmp();
  const c = loadAt(home, { SPOR_SERVER: "https://s/", SPOR_TOKEN: "OLD" });
  assert.deepStrictEqual(c.flatTokenShadow("https://s", "NEW"), { source: "env", origin: "SPOR_TOKEN", token: "OLD", reached: true, recordedFor: null });
  assert.strictEqual(c.flatTokenShadow("https://s", "OLD"), null, "the same bearer is no shadow");
  assert.strictEqual(c.flatTokenShadow("https://other", "NEW"), null, "env pairs with its own server only");
});

test("flatTokenShadow: SPOR_SERVER with no SPOR_TOKEN pairs the config-file token", () => {
  const home = tmp();
  writeUserConfig(home, { token: "OLD" });
  const s = loadAt(home, { SPOR_SERVER: "https://s" }).flatTokenShadow("https://s", "NEW");
  assert.deepStrictEqual(s, { source: "user", origin: path.join(home, "config.json"), token: "OLD", reached: true, recordedFor: "" });
});

test("flatTokenShadow: a config.json server+token for the same server is reported; another server is not", () => {
  const home = tmp();
  writeUserConfig(home, { server: "https://s/", token: "OLD" });
  const sh = loadAt(home).flatTokenShadow("https://s", "NEW");
  assert.strictEqual(sh.token, "OLD");
  assert.strictEqual(sh.recordedFor, "https://s");
  assert.strictEqual(sh.reached, true, "no store default: step 6 sends it");
  auth.upsertTenant(home, { server: "https://s", org: "acme", access_token: "NEW" });
  assert.strictEqual(loadAt(home).flatTokenShadow("https://s", "NEW").reached, false, "a store default masks step 6");
  assert.strictEqual(loadAt(home).flatTokenShadow("https://t", "NEW"), null);
  // an env SPOR_SERVER naming another server makes the file pairing unreachable
  assert.strictEqual(loadAt(home, { SPOR_SERVER: "https://t" }).flatTokenShadow("https://s", "NEW"), null);
});

test("flatTokenShadow: an agent run never reports (it never logs in)", () => {
  const home = tmp();
  const c = loadAt(home, { SPOR_SERVER: "https://s", SPOR_TOKEN: "OLD", SPOR_AGENT_RUN: "1" });
  assert.strictEqual(c.flatTokenShadow("https://s", "NEW"), null);
});

// ---------------------------------------------------------------------------
// spor auth login (paste path) reconciles the shadow
// ---------------------------------------------------------------------------

test("auth login removes a REJECTED flat config token for the same server, and the store's credential is then sent", async () => {
  const { srv, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    writeUserConfig(home, { server: base, token: "STALE", mode: "auto" });
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /removed a stale flat token/);
    const cfg = readUserConfig(home);
    assert.strictEqual(cfg.token, undefined);
    assert.strictEqual(cfg.server, base, "only the token key is removed");
    assert.strictEqual(cfg.mode, "auto");
    // the SPOR_SERVER pairing that used to send STALE now reaches the store
    assert.strictEqual(loadAt(home, { SPOR_SERVER: base }).token(), "NEW");
  } finally {
    srv.close();
  }
});

test("auth login keeps a flat config token the server still ACCEPTS, and warns", async () => {
  const { srv, base } = await meServer(["NEW", "OTHER"]);
  try {
    const home = tmp();
    writeUserConfig(home, { server: base, token: "OTHER" });
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠ the flat 'token' in .* is still accepted by the server and would be sent to .* whenever no stored tenant is the default/);
    assert.strictEqual(readUserConfig(home).token, "OTHER");
  } finally {
    srv.close();
  }
});

test("auth login never probes or removes a flat token recorded for ANOTHER server that SPOR_SERVER borrows", async () => {
  const { srv, hits, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    writeUserConfig(home, { server: "https://other.example", token: "OTHER-SERVER-TOKEN" });
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home, { SPOR_SERVER: base }));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /recorded for https:\/\/other\.example\) is sent to .* while SPOR_SERVER names it/);
    assert.strictEqual(readUserConfig(home).token, "OTHER-SERVER-TOKEN");
    assert.ok(!hits.some((h) => h.bearer === "OTHER-SERVER-TOKEN"), "the other server's token was never sent here");
  } finally {
    srv.close();
  }
});

test("auth login never removes a token whose server sits in the OTHER config file", async () => {
  const { srv, hits, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    fs.mkdirSync(path.join(home, "spor"), { recursive: true });
    fs.writeFileSync(path.join(home, "spor", "config.json"), JSON.stringify({ server: "https://other.example" }));
    writeUserConfig(home, { token: "OTHER-SERVER-TOKEN" });
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home, { SPOR_SERVER: base }));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(readUserConfig(home).token, "OTHER-SERVER-TOKEN");
    assert.ok(!hits.some((h) => h.bearer === "OTHER-SERVER-TOKEN"));
  } finally {
    srv.close();
  }
});

test("auth login keeps a 0600 config.json at 0600 when it removes the stale token", { skip: process.platform === "win32" }, async () => {
  const { srv, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    writeUserConfig(home, { server: base, token: "STALE" });
    fs.chmodSync(path.join(home, "config.json"), 0o600);
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(readUserConfig(home).token, undefined);
    assert.strictEqual(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
  } finally {
    srv.close();
  }
});

test("auth login warns (never edits anything) about a rejected SPOR_TOKEN in the environment", async () => {
  const { srv, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "STALE" }));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠ SPOR_TOKEN in your environment is rejected by the server \(401\).*unset it/);
  } finally {
    srv.close();
  }
});

test("auth login with no flat token makes no extra /v1/me call", async () => {
  const { srv, hits, base } = await meServer(["NEW"]);
  try {
    const home = tmp();
    const r = await run(["auth", "login", base, "NEW", "--org", "acme"], envAt(home));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /⚠|stale flat token/);
    assert.deepStrictEqual(hits.map((h) => h.bearer), ["NEW"]);
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// lib/remote.js refresh is keyed on the tenant's own store key only
// ---------------------------------------------------------------------------

test("remote: a key-less tenant carrying a refresh_token never refreshes (no synthesized tenantKey)", async () => {
  const home = tmp();
  // A sibling the synthesized key "<server>/acme" would have named.
  auth.upsertTenant(home, { server: "https://s", org: "acme", access_token: "SIB", refresh_token: "RT-sib" });
  const cfg = {
    userConfigHome: () => home,
    server: () => "https://s",
    token: () => "FOREIGN",
    tenant: () => ({ key: null, server: "https://s", org: "acme", token: "FOREIGN", refresh_token: "RT-x", exp: 1 }),
  };
  const origRefresh = auth.refreshTenant;
  const origFetch = global.fetch;
  const refreshed = [];
  const sent = [];
  auth.refreshTenant = async (h, sel) => {
    refreshed.push(sel);
    return "PERSON";
  };
  global.fetch = async (url, opts) => {
    sent.push(opts.headers.Authorization);
    return new Response("{}", { status: 401 });
  };
  try {
    assert.strictEqual(await remote.refreshAfterAuthFailure(cfg), null);
    const r = await remote.get(cfg, "/v1/me");
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(refreshed, []);
    assert.deepStrictEqual(sent, ["Bearer FOREIGN"]);
  } finally {
    auth.refreshTenant = origRefresh;
    global.fetch = origFetch;
  }
});

test("remote: a keyed store tenant refreshes through exactly its own key", async () => {
  const home = tmp();
  const cfg = {
    userConfigHome: () => home,
    tenant: () => ({ key: "https://s/beta", server: "https://s", org: "beta", token: "T", refresh_token: "RT" }),
  };
  const origRefresh = auth.refreshTenant;
  const refreshed = [];
  auth.refreshTenant = async (h, sel) => {
    refreshed.push(sel);
    return "FRESH";
  };
  try {
    assert.strictEqual(await remote.refreshAfterAuthFailure(cfg), "FRESH");
    assert.deepStrictEqual(refreshed, ["https://s/beta"]);
  } finally {
    auth.refreshTenant = origRefresh;
  }
});
