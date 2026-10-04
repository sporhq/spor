// task-spor-client-config-tenant-unification-and-refresh:
//   1. ONE same-server pick rule in lib/config.js (the old tokenForServer is
//      folded into flat(); a bearer-less pick prefers the store default).
//   2. An OPAQUE foreign bearer on a multi-org server is never stamped with the
//      first same-server tenant's org: it takes the server's cached /v1/me echo
//      (remote.echoBearerOrg asks, auth.echoedBearerOrg reads), else "" unknown.
//   3. session-start, the post-tool heartbeat/claim calls, prompt-context's
//      digest and infer-commits' capture go through u.curlWithRefresh, so an
//      expired store-tenant token is refreshed once and the call retried —
//      concurrent 401s in one run sharing the one refresh.
// Every home is a mkdtemp scratch dir; every server a port-0 stub.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const auth = require("../lib/auth");
const remote = require("../lib/remote");
const { loadConfig } = require("../lib/config");
const u = require("../scripts/engines/util");
const { hermeticEnv } = require("./helpers/env");
const { spawnHook } = require("./helpers/portable");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spor-tenant-unify-"));
const loadAt = (home, env = {}) =>
  loadConfig({ cwd: home, env: hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: home, ...env }) });
const fakeJwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function listen(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
      hits.push({ method: req.method, url: req.url, bearer, body });
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      handler(req, { bearer, body, send });
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// ---------------------------------------------------------------------------
// 1. one same-server pick rule
// ---------------------------------------------------------------------------

test("selector: a bearer-less same-server pick prefers the store default, else the first entry", () => {
  const home = tmp();
  auth.upsertTenant(home, { server: "https://s", org: "acme", access_token: "ACME", refresh_token: "RT-a" });
  auth.upsertTenant(home, { server: "https://s", org: "beta", access_token: "BETA", refresh_token: "RT-b" }, { makeDefault: true });
  const t = loadAt(home, { SPOR_SERVER: "https://s" }).tenant();
  assert.strictEqual(t.key, "https://s/beta");
  assert.strictEqual(t.token, "BETA");
  assert.strictEqual(t.refresh_token, "RT-b");
  // --server takes the same rule (it used to walk tokenForServer's own list)
  const cli = loadConfig({ cwd: home, cli: { server: "https://s" }, env: hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: home }) }).tenant();
  assert.strictEqual(cli.key, "https://s/beta");
  // the default on ANOTHER server: the first entry on this one
  auth.upsertTenant(home, { server: "https://other", org: "gamma", access_token: "G" }, { makeDefault: true });
  const first = loadAt(home, { SPOR_SERVER: "https://s" }).tenant();
  assert.strictEqual(first.key, "https://s/acme");
  assert.strictEqual(first.token, "ACME");
});

// ---------------------------------------------------------------------------
// 2. opaque foreign bearer org
// ---------------------------------------------------------------------------

test("selector: an opaque foreign bearer on a multi-org server is unknown, never the first tenant's org", () => {
  const home = tmp();
  auth.upsertTenant(home, { server: "https://s", org: "acme", access_token: "ACME", refresh_token: "RT-a" });
  auth.upsertTenant(home, { server: "https://s", org: "beta", access_token: "BETA", refresh_token: "RT-b" });
  const t = loadAt(home, { SPOR_SERVER: "https://s", SPOR_TOKEN: "spor_oat_agent" }).tenant();
  assert.strictEqual(t.org, "", "no guess onto acme");
  assert.strictEqual(t.key, null);
  assert.strictEqual(t.refresh_token, null);
  // the server's echo, once recorded, is the org
  auth.recordBearerOrg(home, "https://s", "spor_oat_agent", "beta");
  assert.strictEqual(loadAt(home, { SPOR_SERVER: "https://s", SPOR_TOKEN: "spor_oat_agent" }).tenant().org, "beta");
  const file = fs.readFileSync(auth.bearerOrgsPath(home), "utf8");
  assert.ok(!file.includes("spor_oat_agent"), "the cache never holds the bearer itself");
  // a JWT claim still wins over everything
  assert.strictEqual(loadAt(home, { SPOR_SERVER: "https://s", SPOR_TOKEN: fakeJwt({ org: "acme" }) }).tenant().org, "acme");
});

test("remote.echoBearerOrg: asks /v1/me only for an ambiguous opaque foreign bearer, caches it, and re-resolves the tenant", async () => {
  let me = { status: 200, body: { org: "beta" } };
  const { srv, hits, base } = await listen((req, { send }) => {
    if (req.url === "/v1/me") return send(me.status, me.body);
    return send(404, {});
  });
  try {
    const home = tmp();
    auth.upsertTenant(home, { server: base, org: "acme", access_token: "ACME", refresh_token: "RT-a" });
    // a single-org server: the org is not ambiguous, so no request
    const single = loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_x" });
    assert.strictEqual(single.tenant().org, "acme");
    assert.strictEqual(await remote.echoBearerOrg(single), null);
    assert.strictEqual(hits.length, 0);

    auth.upsertTenant(home, { server: base, org: "beta", access_token: "BETA", refresh_token: "RT-b" });
    const cfg = loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_x" });
    assert.strictEqual(cfg.tenant().org, "");
    assert.strictEqual(await remote.echoBearerOrg(cfg), "beta");
    assert.deepStrictEqual(hits.map((h) => [h.url, h.bearer]), [["/v1/me", "spor_oat_x"]], "asked as the bearer itself");
    assert.strictEqual(cfg.tenant().org, "beta", "the memoized tenant re-resolved");
    assert.strictEqual(cfg.tenant().refresh_token, null, "still no refresh credential");
    // cached: never asked again
    assert.strictEqual(await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_x" })), null);
    assert.strictEqual(hits.length, 1);

    // the store's own bearer, a JWT bearer, and an agent run never ask
    await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "BETA" }));
    await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: fakeJwt({ org: "beta" }) }));
    await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_y", SPOR_AGENT_RUN: "1" }));
    assert.strictEqual(hits.length, 1);

    // an older server (404) records the miss and is not re-asked inside the window
    me = { status: 404, body: {} };
    const old = loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_z" });
    assert.strictEqual(await remote.echoBearerOrg(old), null);
    assert.strictEqual(old.tenant().org, "");
    assert.strictEqual(await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_z" })), null);
    assert.strictEqual(hits.length, 2);
    // ...but is past it
    me = { status: 200, body: { org: "acme" } };
    const later = Date.now() + auth.BEARER_ORG_RETRY_MS + 1;
    assert.strictEqual(await remote.echoBearerOrg(loadAt(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_oat_z" }), { now: later }), "acme");
  } finally {
    srv.close();
  }
});

test("remote.echoBearerOrg: a transport failure caches nothing", async () => {
  const home = tmp();
  auth.upsertTenant(home, { server: "http://127.0.0.1:9", org: "acme", access_token: "A" });
  auth.upsertTenant(home, { server: "http://127.0.0.1:9", org: "beta", access_token: "B" });
  const cfg = loadAt(home, { SPOR_SERVER: "http://127.0.0.1:9", SPOR_TOKEN: "spor_oat_q" });
  assert.strictEqual(await remote.echoBearerOrg(cfg, { timeoutMs: 1000 }), null);
  assert.strictEqual(auth.bearerOrgEntry(home, "http://127.0.0.1:9", "spor_oat_q"), null);
});

// ---------------------------------------------------------------------------
// 3. refresh coverage
// ---------------------------------------------------------------------------

// Every authenticated route answers 200 only for FRESH; /oauth/token swaps RT
// for FRESH. `ok(req)` is the 200 body per route.
function authServer(ok = () => ({ ok: true })) {
  return listen((req, { bearer, send }) => {
    if (req.url === "/oauth/token") return send(200, { access_token: "FRESH", refresh_token: "RT2", expires_in: 3600 });
    return bearer === "FRESH" ? send(200, ok(req)) : send(401, { error: "expired" });
  });
}

test("curlWithRefresh: concurrent 401s in one run share ONE refresh and all retry with its token", async () => {
  const { srv, hits, base } = await authServer();
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: "acme", access_token: "STALE", refresh_token: "RT" } }, default: key });
    u.setConfig(loadAt(home));
    const rs = await Promise.all([1, 2, 3].map((i) => u.curlWithRefresh(`${base}/v1/thing/${i}`, { timeoutMs: 3000 })));
    assert.deepStrictEqual(rs.map((r) => r.http), ["200", "200", "200"]);
    assert.strictEqual(hits.filter((h) => h.url === "/oauth/token").length, 1);
  } finally {
    u.clearConfig();
    srv.close();
  }
});

// A git repo cwd + a scratch graph home holding a STALE store tenant for `base`
// (its default — remote mode with no SPOR_SERVER at all).
function hookScratch(base) {
  const root = tmp();
  const home = path.join(root, "graph");
  fs.mkdirSync(home, { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" };
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  const key = `${base}/acme`;
  auth.writeStore(home, { tenants: { [key]: { server: base, org: "acme", access_token: "STALE", refresh_token: "RT" } }, default: key });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_")) delete env[k];
  Object.assign(env, { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ENABLED: "1" });
  return { home, cwd, key, env };
}

function runHook(args, input, env) {
  return new Promise((resolve, reject) => {
    let out = "";
    const c = spawnHook(args, input, env, { stdio: ["pipe", "pipe", "ignore"] });
    c.stdout.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

const retriedFresh = (hits, re) => {
  const mine = hits.filter((h) => re.test(h.url));
  return mine.some((h) => h.bearer === "STALE") && mine.some((h) => h.bearer === "FRESH");
};

test("session-start: an expired store token is refreshed once and the briefing + queue reads retried", async () => {
  const { srv, hits, base } = await authServer((req) =>
    req.url.startsWith("/v1/briefing/") ? { found: true, body: "BRIEFING-BODY", version: 3, graph_status: { node_count: 7 } } : { items: [] }
  );
  try {
    const s = hookScratch(base);
    const out = await runHook(["session-start", "--host", "claude-code"], JSON.stringify({ cwd: s.cwd, session_id: "t1" }), s.env);
    assert.match(out, /BRIEFING-BODY/, out);
    assert.ok(retriedFresh(hits, /^\/v1\/briefing\//), JSON.stringify(hits));
    assert.ok(retriedFresh(hits, /^\/v1\/queue/), JSON.stringify(hits));
    assert.strictEqual(hits.filter((h) => h.url === "/oauth/token").length, 1, "one refresh across the concurrent reads");
    assert.strictEqual(auth.readStore(s.home).tenants[s.key].access_token, "FRESH");
  } finally {
    srv.close();
  }
});

test("post-tool: the fleet heartbeat refreshes an expired store token and retries", async () => {
  const { srv, hits, base } = await authServer();
  try {
    const s = hookScratch(base);
    const env = { ...s.env, SPOR_CLAIM_NUDGE: "0", SPOR_DISPATCH_AGENT: "agent-x" };
    const payload = JSON.stringify({
      cwd: s.cwd, session_id: "s1", hook_event_name: "PostToolUse",
      tool_name: "Edit", tool_input: { file_path: path.join(s.cwd, "code.js"), new_string: "x" },
    });
    await runHook(["post-tool", "--host", "claude-code"], payload, env);
    assert.ok(retriedFresh(hits, /\/v1\/agents\/agent-x\/heartbeat$/), JSON.stringify(hits));
  } finally {
    srv.close();
  }
});

test("prompt-context: the remote digest refreshes an expired store token and retries", async () => {
  const { srv, hits, base } = await authServer(() => ({ found: true, text: "DIGEST-BODY" }));
  try {
    const s = hookScratch(base);
    const out = await runHook(
      ["prompt-context", "--host", "claude-code"],
      JSON.stringify({ cwd: s.cwd, session_id: "p1", prompt: "six words minimum to pass the gate" }),
      s.env
    );
    assert.ok(retriedFresh(hits, /^\/v1\/digest$/), JSON.stringify(hits));
    assert.match(out, /DIGEST-BODY/, out);
  } finally {
    srv.close();
  }
});

test("infer-commits: a proposal capture refreshes an expired store token and retries", async () => {
  const { srv, hits, base } = await authServer();
  const root = tmp();
  try {
    const home = path.join(root, "graph");
    fs.mkdirSync(home, { recursive: true });
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" };
    // A branch named after the candidate id is a confident link on its own
    // (the same seam test/infer-commits.test.js uses).
    for (const args of [["init", "-q", "-b", "task-test-node"], ["commit", "-q", "--allow-empty", "-m", "wip"]]) {
      const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv });
      assert.strictEqual(r.status, 0, r.stderr);
    }
    const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const journal = path.join(root, "journal.jsonl");
    fs.writeFileSync(journal, JSON.stringify({ tool: "git-commit", sha, nodes: [] }) + "\n");
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: "acme", access_token: "STALE", refresh_token: "RT" } }, default: key });
    u.setConfig(loadAt(home, { SPOR_INFER_COMMITS: "1" }));
    const { inferCommits } = require("../scripts/engines/infer-commits");
    await inferCommits({ repo, journal, index: "task-test-node — Some candidate title\n", slug: "repo", session: "s-infer" });
    assert.ok(retriedFresh(hits, /^\/v1\/capture$/), JSON.stringify(hits));
  } finally {
    u.clearConfig();
    srv.close();
  }
});

test("curlWithRefresh: a caller's deadline bounds the refresh — no retry past an aborted signal", async () => {
  // The deadline fires the moment the token grant is asked for; the grant
  // then hangs well past it.
  const ctl = new AbortController();
  let grantAnswered;
  let granted = false;
  const answered = new Promise((r) => (grantAnswered = r));
  const { srv, hits, base } = await listen((req, { bearer, send }) => {
    if (req.url === "/oauth/token") {
      ctl.abort();
      return setTimeout(() => {
        granted = true;
        send(200, { access_token: "FRESH", refresh_token: "RT2", expires_in: 3600 });
        grantAnswered();
      }, 3000);
    }
    return bearer === "FRESH" ? send(200, {}) : send(401, {});
  });
  try {
    const home = tmp();
    const key = `${base}/acme`;
    auth.writeStore(home, { tenants: { [key]: { server: base, org: "acme", access_token: "STALE", refresh_token: "RT" } }, default: key });
    u.setConfig(loadAt(home));
    const r = await u.curlWithRefresh(`${base}/v1/thing`, { timeoutMs: 10000, signal: ctl.signal });
    assert.strictEqual(r.http, "401");
    assert.ok(!hits.some((h) => h.url === "/v1/thing" && h.bearer === "FRESH"), "no retry after the deadline");
    assert.strictEqual(granted, false, "returned at the deadline, before the grant answered");
  } finally {
    u.clearConfig();
    await answered; // let the hanging grant answer before closing
    srv.close();
  }
});

// task-spor-refresh-coverage-distill-and-remaining-engines: the distill,
// link-commits, agents-md and doctor-candidate calls refresh once too.
test("link-commits and agents-md: an expired store token is refreshed and the call retried", async () => {
  const { srv, hits, base } = await authServer((req) => (req.url.startsWith("/v1/briefing/") ? { found: true, body: "AGENTS-BRIEF", version: 1 } : { ok: true }));
  try {
    const s = hookScratch(base);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" };
    const c = spawnSync("git", ["-C", s.cwd, "commit", "-q", "--allow-empty", "-m", "work\n\nSpor: task-some-node"], { encoding: "utf8", env: gitEnv });
    assert.strictEqual(c.status, 0, c.stderr);
    u.setConfig(loadAt(s.home));
    try {
      await require("../scripts/engines/link-commits").linkCommits(s.cwd);
    } finally {
      u.clearConfig();
    }
    assert.ok(retriedFresh(hits, /\/v1\/nodes\/task-some-node\/commits$/), JSON.stringify(hits));
    hits.length = 0;
    // a fresh run: the store now holds FRESH, so re-stale it for the agents-md call
    const key = Object.keys(auth.readStore(s.home).tenants)[0];
    auth.writeStore(s.home, { tenants: { [key]: { server: base, org: "acme", access_token: "STALE", refresh_token: "RT" } }, default: key });
    await runHook(["agents-md", "--cwd", s.cwd], "", s.env);
    assert.ok(retriedFresh(hits, /^\/v1\/briefing\//), JSON.stringify(hits));
  } finally {
    srv.close();
  }
});
