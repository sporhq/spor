// join.test.js — `spor join` onboarding, with the hosted-server default
// (task-spor-api-cli-default-server-base) AND the multi-tenant credential store
// (dec-spor-client-cli-mode-tenant-resolution). The server URL defaults to the
// hosted Spor REST base (lib/config.js DEFAULT_SERVER = https://api.sporhq.io)
// when omitted, so onboarding is `spor join <token>`; the credential is APPENDED
// to ~/.spor/auth/credentials.json keyed by (server, org), never overwriting a
// sibling tenant.
//
// Oracle = what `spor join` WRITES to the credential store, not the confirm
// step's framing. The confirm's /v1/me probe is redirected to a local stub via
// env SPOR_SERVER (which the confirm honors) so the test never reaches the real
// hosted host.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { DEFAULT_SERVER } = require(path.join(__dirname, "..", "lib", "config.js"));
const auth = require(path.join(__dirname, "..", "lib", "auth.js"));
const isWin = process.platform === "win32";
const HOSTED_KEY = `${DEFAULT_SERVER}/`; // <server>/<org>, org empty for an opaque PAT

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

// A scratch HOME whose auth/credentials.json `spor join` reads AND writes
// (userConfigHome resolves to SPOR_HOME). XDG too so the global config layer
// can't leak in.
function scratchHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-join-"));
}

// Minimal /v1/me stub so the join confirm is fast and deterministic instead of
// hitting the real hosted host. `extra` merges into the echo body (e.g. {org}
// for the opaque-token keying tests, task-spor-client-me-org-consume).
function meStub(extra = {}) {
  const srv = http.createServer((req, res) => {
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/v1/me") return j(200, { bound: true, person: "person-test", email: "t@test.dev", is_admin: false, ...extra });
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("join: no URL defaults the stored server to the hosted base, with a token", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub();
  try {
    // env SPOR_SERVER redirects the confirm probe to the stub; the WRITE still
    // keys the tenant by the omitted-URL default.
    const r = await runAsync(["join", "spor_pat_abc123"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const store = auth.readStore(home);
    const t = store.tenants[HOSTED_KEY];
    assert.ok(t, "tenant keyed by the hosted default server");
    assert.strictEqual(t.server, DEFAULT_SERVER, "stored the hosted default server");
    assert.strictEqual(t.server, "https://api.sporhq.io", "the hosted default is api.sporhq.io");
    assert.strictEqual(t.access_token, "spor_pat_abc123", "token-shaped positional taken as the token");
    assert.strictEqual(t.person, "person-test", "identity confirmed via /v1/me and stored");
    assert.strictEqual(store.default, HOSTED_KEY, "first tenant becomes the active default");
    assert.match(r.stdout, /using the hosted Spor default https:\/\/api\.sporhq\.io/);
  } finally {
    srv.close();
  }
});

test("join: explicit URL + token still wins (no default applied)", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub();
  try {
    const r = await runAsync(["join", base, "spor_pat_xyz"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const store = auth.readStore(home);
    const t = store.tenants[`${base}/`];
    assert.ok(t, "tenant keyed by the explicit URL");
    assert.strictEqual(t.server, base, "explicit URL stored verbatim");
    assert.strictEqual(t.access_token, "spor_pat_xyz");
    assert.doesNotMatch(r.stdout, /using the hosted Spor default/, "no default banner when a URL is given");
  } finally {
    srv.close();
  }
});

test("join: --token flag only defaults the server to the hosted base", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub();
  try {
    const r = await runAsync(["join", "--token", "spor_pat_flag"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const t = auth.readStore(home).tenants[HOSTED_KEY];
    assert.strictEqual(t.server, DEFAULT_SERVER);
    assert.strictEqual(t.access_token, "spor_pat_flag");
  } finally {
    srv.close();
  }
});

test("join: no args writes the hosted default tenant and notes the missing token", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub();
  try {
    const r = await runAsync(["join"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base }));
    assert.strictEqual(r.status, 0, r.stderr);
    const t = auth.readStore(home).tenants[HOSTED_KEY];
    assert.strictEqual(t.server, DEFAULT_SERVER, "bare join still onboards to the hosted base");
    assert.ok(!t.access_token, "no token written");
    assert.match(r.stdout, /no token given/);
  } finally {
    srv.close();
  }
});

// task-spor-client-me-org-consume: an opaque spor_pat_/spor_oat_ token carries no
// readable `org` claim, so without the /v1/me echo every such tenant on one
// server collides on key "<server>/". The confirm now falls back to me.org for
// the (server, org) key, AFTER --org and the JWT claim.
test("join: opaque token keys by the org echoed from /v1/me (no --org, no JWT claim)", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub({ org: "acme" });
  try {
    const r = await runAsync(["join", base, "spor_pat_opaque"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const store = auth.readStore(home);
    const t = store.tenants[`${base}/acme`];
    assert.ok(t, "tenant keyed by (server, org) from the /v1/me echo");
    assert.strictEqual(t.org, "acme", "echoed org stored on the credential");
    assert.ok(!store.tenants[`${base}/`], "did not collide on the org-less key");
  } finally {
    srv.close();
  }
});

test("join: explicit --org wins over the /v1/me org echo", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub({ org: "echoed" });
  try {
    const r = await runAsync(["join", base, "spor_pat_x", "--org", "chosen"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const store = auth.readStore(home);
    assert.ok(store.tenants[`${base}/chosen`], "keyed by the explicit --org");
    assert.strictEqual(store.tenants[`${base}/chosen`].org, "chosen");
    assert.ok(!store.tenants[`${base}/echoed`], "the echo did not override --org");
  } finally {
    srv.close();
  }
});

test("join: --server flag overrides the default", { skip: isWin }, async () => {
  const home = scratchHome();
  const { srv, base } = await meStub();
  try {
    const r = await runAsync(["join", "--server", base, "--token", "spor_pat_s"], baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }));
    assert.strictEqual(r.status, 0, r.stderr);
    const t = auth.readStore(home).tenants[`${base}/`];
    assert.strictEqual(t.server, base);
    assert.strictEqual(t.access_token, "spor_pat_s");
    assert.doesNotMatch(r.stdout, /using the hosted Spor default/);
  } finally {
    srv.close();
  }
});
