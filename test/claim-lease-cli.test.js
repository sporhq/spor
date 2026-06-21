// claim-lease-cli.test.js — `spor claim|renew|extend|release <node-id>`
// (task-spor-claim-lease-cli-verbs): the shell front-door for the heartbeat-
// renewed task lease (dec-cc-task-claim-lease). The CLI twins of the claim /
// renew / extend / release MCP tools and the POST /v1/nodes/{id}/{action} REST
// routes the server already exposes (art-res-task-cc-claim-lease-server).
//
// REMOTE-ONLY: a claim is a server-held lease and local mode has no claim pool,
// so local mode degrades with one clear line and makes no request. Oracle = the
// REQUEST the CLI POSTs (path + body) in remote mode — never the server's
// framing, which we script — plus the remote-only degradation in local mode.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage + isolated config homes so the dev box's
// real ~/.spor/config.json can't flip a local-mode test to remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-lease-iso-"));
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
// Sync runner for the local-mode + usage paths (no server, so no event-loop deadlock).
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}
// Async runner for remote mode — a blocking spawnSync would deadlock against the
// in-process fake server (the event loop can't accept the connection).
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// A fake server over the four lease routes. `handler(action, id, body)` returns
// { code, json } so each test scripts the exact response it wants.
function leaseStub(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.url.match(/^\/v1\/nodes\/([^/]+)\/(claim|renew|extend|release)$/);
      if (m && req.method === "POST") {
        const out = handler(m[2], decodeURIComponent(m[1]), body ? JSON.parse(body) : {});
        return j(out.code, out.json);
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const leaseView = (over = {}) => ({
  node_id: "task-x", by: "person-anthony", expires: 1, session: null, claimed_at: null,
  expires_at: "2026-06-21T12:00:00.000Z", ...over,
});

// ---------------- local mode: remote-only degradation ----------------

for (const verb of ["claim", "renew", "release"]) {
  test(`${verb} (local) degrades with a remote-only note, exit 0, no graph touched`, () => {
    const r = run([verb, "task-x"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /task claims are a team-graph feature/);
    assert.match(r.stdout, /set SPOR_SERVER\/SPOR_TOKEN/);
  });
}

test("extend (local) degrades before parsing the duration", () => {
  const r = run(["extend", "task-x", "2h"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /task claims are a team-graph feature/);
});

// ---------------- usage / argument validation ----------------

test("claim with no id exits 1 with usage", () => {
  const r = run(["claim"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor claim <node-id>/);
});

test("extend with no id shows the duration hint", () => {
  const r = run(["extend"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor extend <node-id> <duration>/);
  assert.match(r.stderr, /2h \/ 45m \/ 30s \/ 1d/);
});

test("extend (remote) with no duration exits 1 client-side, no request made", async () => {
  const { srv, hits, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "extended", lease: leaseView() } }));
  try {
    const r = await runAsync(["extend", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: spor extend <node-id> <duration>/);
    assert.strictEqual(hits.length, 0, "no request for a missing duration");
  } finally {
    srv.close();
  }
});

test("extend (remote) with a malformed duration exits 1 client-side, no request made", async () => {
  const { srv, hits, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "extended", lease: leaseView() } }));
  try {
    const r = await runAsync(["extend", "task-x", "soon"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bad duration 'soon'/);
    assert.strictEqual(hits.length, 0, "no request for a bad duration");
  } finally {
    srv.close();
  }
});

// ---------------- claim ----------------

test("claim (remote) POSTs {} and reports the lease expiry", async () => {
  const { srv, hits, base } = await leaseStub((action) => {
    assert.strictEqual(action, "claim");
    return { code: 200, json: { ok: true, status: "claimed", lease: leaseView(), edge: "added" } };
  });
  try {
    const r = await runAsync(["claim", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^claimed task-x$/m);
    assert.match(r.stdout, /lease expires 2026-06-21T12:00:00\.000Z, held by person-anthony/);
    const post = hits.find((h) => h.url === "/v1/nodes/task-x/claim");
    assert.ok(post, "POSTed to the claim route");
    assert.deepStrictEqual(JSON.parse(post.body), {}, "body carries no caller-supplied holder");
  } finally {
    srv.close();
  }
});

test("claim (remote) surfaces a 409 already_claimed conflict naming the holder", async () => {
  const { srv, base } = await leaseStub(() => ({
    code: 409,
    json: { error: { code: "already_claimed", message: "'task-x' is held by person-bob until 2026-06-21T13:00:00.000Z" }, holder: leaseView({ by: "person-bob" }) },
  }));
  try {
    const r = await runAsync(["claim", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot claim task-x: 'task-x' is held by person-bob until 2026-06-21T13:00:00\.000Z/);
  } finally {
    srv.close();
  }
});

// ---------------- renew ----------------

test("renew (remote) POSTs {} to the renew route and reports the bumped expiry", async () => {
  const { srv, hits, base } = await leaseStub((action) => {
    assert.strictEqual(action, "renew");
    return { code: 200, json: { ok: true, status: "renewed", lease: leaseView({ expires_at: "2026-06-21T12:45:00.000Z" }) } };
  });
  try {
    const r = await runAsync(["renew", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^renewed task-x$/m);
    assert.match(r.stdout, /lease expires 2026-06-21T12:45:00\.000Z/);
    const post = hits.find((h) => h.url === "/v1/nodes/task-x/renew");
    assert.deepStrictEqual(JSON.parse(post.body), {});
  } finally {
    srv.close();
  }
});

test("renew (remote) surfaces a 409 lease_lost", async () => {
  const { srv, base } = await leaseStub(() => ({
    code: 409,
    json: { error: { code: "lease_lost", message: "cannot renew 'task-x'; your claim has lapsed" } },
  }));
  try {
    const r = await runAsync(["renew", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot renew task-x: cannot renew 'task-x'; your claim has lapsed/);
  } finally {
    srv.close();
  }
});

// ---------------- extend ----------------

test("extend (remote) parses 2h to ms and POSTs {ms}", async () => {
  const { srv, hits, base } = await leaseStub((action, id, body) => {
    assert.strictEqual(action, "extend");
    assert.strictEqual(body.ms, 2 * 60 * 60 * 1000);
    return { code: 200, json: { ok: true, status: "extended", lease: leaseView({ expires_at: "2026-06-21T14:00:00.000Z" }) } };
  });
  try {
    const r = await runAsync(["extend", "task-x", "2h"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^extended task-x$/m);
    assert.match(r.stdout, /lease expires 2026-06-21T14:00:00\.000Z/);
    const post = hits.find((h) => h.url === "/v1/nodes/task-x/extend");
    assert.deepStrictEqual(JSON.parse(post.body), { ms: 7200000 });
  } finally {
    srv.close();
  }
});

test("extend (remote) parses a fractional + week duration (server-dialect parity)", async () => {
  const { srv, hits, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "extended", lease: leaseView() } }));
  try {
    let r = await runAsync(["extend", "task-x", "1.5h"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(hits.at(-1).body), { ms: 5400000 }); // 1.5 * 3_600_000
    r = await runAsync(["extend", "task-x", "1w"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(hits.at(-1).body), { ms: 604800000 });
  } finally {
    srv.close();
  }
});

test("extend (remote) rejects a sub-millisecond duration client-side (rounds to 0)", async () => {
  const { srv, hits, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "extended", lease: leaseView() } }));
  try {
    const r = await runAsync(["extend", "task-x", "0.4ms"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bad duration '0\.4ms'/);
    assert.strictEqual(hits.length, 0, "a non-positive duration never reaches the server");
  } finally {
    srv.close();
  }
});

test("extend (remote) accepts bare milliseconds", async () => {
  const { srv, hits, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "extended", lease: leaseView() } }));
  try {
    const r = await runAsync(["extend", "task-x", "90000"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.url === "/v1/nodes/task-x/extend");
    assert.deepStrictEqual(JSON.parse(post.body), { ms: 90000 });
  } finally {
    srv.close();
  }
});

test("extend (remote) notes when the request is capped to the org maximum", async () => {
  const { srv, base } = await leaseStub(() => ({
    code: 200,
    json: { ok: true, status: "extended", lease: leaseView({ expires_at: "2026-06-21T20:00:00.000Z" }), capped_to_max: true, claim_ttl_max_ms: 28800000 },
  }));
  try {
    const r = await runAsync(["extend", "task-x", "30d"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /capped to the org maximum/);
  } finally {
    srv.close();
  }
});

test("extend (remote) surfaces a 422 invalid_node from the server", async () => {
  // a positive duration passes the client gate; the server can still reject (e.g.
  // a non-task node id) — the generic !ok branch surfaces it with details.
  const { srv, base } = await leaseStub(() => ({
    code: 422,
    json: { error: { code: "invalid_node", message: "task-x is not a claimable node type", details: ["only work nodes carry a lease"] } },
  }));
  try {
    const r = await runAsync(["extend", "task-x", "1h"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /extend error 422: task-x is not a claimable node type/);
    assert.match(r.stderr, /only work nodes carry a lease/);
  } finally {
    srv.close();
  }
});

// ---------------- release ----------------

test("release (remote) POSTs to the release route and notes the retired edge", async () => {
  const { srv, hits, base } = await leaseStub((action) => {
    assert.strictEqual(action, "release");
    return { code: 200, json: { ok: true, status: "released", node_id: "task-x", edge: "removed" } };
  });
  try {
    const r = await runAsync(["release", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^released task-x$/m);
    assert.match(r.stdout, /assigned edge retired/);
    const post = hits.find((h) => h.url === "/v1/nodes/task-x/release");
    assert.deepStrictEqual(JSON.parse(post.body), {});
  } finally {
    srv.close();
  }
});

test("release (remote) is quiet about the edge on an idempotent skip", async () => {
  const { srv, base } = await leaseStub(() => ({ code: 200, json: { ok: true, status: "released", node_id: "task-x", edge: "skipped" } }));
  try {
    const r = await runAsync(["release", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^released task-x$/m);
    assert.doesNotMatch(r.stdout, /assigned edge retired/);
  } finally {
    srv.close();
  }
});

test("release (remote) refuses another's claim with a 409", async () => {
  const { srv, base } = await leaseStub(() => ({
    code: 409,
    json: { error: { code: "already_claimed", message: "'task-x' is held by person-bob; you cannot release another's claim" }, holder: leaseView({ by: "person-bob" }) },
  }));
  try {
    const r = await runAsync(["release", "task-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cannot release task-x: 'task-x' is held by person-bob; you cannot release another's claim/);
  } finally {
    srv.close();
  }
});

// ---------------- shared error paths ----------------

test("claim (remote) maps a 404 to a clean 'no such node'", async () => {
  const { srv, base } = await leaseStub(() => ({ code: 404, json: { error: { code: "not_found", message: "node does not exist" } } }));
  try {
    const r = await runAsync(["claim", "task-gone"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such node: task-gone/);
  } finally {
    srv.close();
  }
});

for (const verb of ["claim", "renew", "release"]) {
  test(`${verb} (remote) fails open against an unreachable server (no stack trace)`, async () => {
    const r = await runAsync([verb, "task-x"], remoteEnv("http://127.0.0.1:1"));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /offline/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  });
}

test("extend (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["extend", "task-x", "1h"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// ---------------- help pages ----------------

for (const [verb, head] of [["claim", "spor claim <node-id>"], ["renew", "spor renew <node-id>"], ["extend", "spor extend <node-id> <duration>"], ["release", "spor release <node-id>"]]) {
  test(`${verb} --help prints its command page`, () => {
    const r = run([verb, "--help"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith(head), `header should be '${head}'`);
  });
}
