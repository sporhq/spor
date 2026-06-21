// drain.test.js — `spor drain` (alias `spor sync`), the manual outbox flush for
// pure-CLI users who never open a Claude Code session (task-spor-cli-outbox-drain-
// verb), plus the opportunistic drain a successful remote `spor add` fires so
// standalone usage self-heals.
//
// Oracle = the on-disk outbox state (what shipped / what stayed) + the CLI's
// reported tally + the request the fake server saw. Never the server's framing —
// we script the responses. Everything runs against a throwaway home.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage, isolated config homes so the dev box's
// real ~/.spor/config.json can't flip a local-mode test to remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-drain-iso-"));
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
// Sync runner for the local-mode / empty-outbox paths (no server to talk to).
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

// A scratch home with an outbox/. Returns { home, outbox }.
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-drain-"));
  const outbox = path.join(home, "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  return { home, outbox };
}
function spool(outbox, name, body = { text: "a stranded capture", context: { project: "demo" } }) {
  fs.writeFileSync(path.join(outbox, name), JSON.stringify(body));
}
const listSpool = (outbox) => (fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((f) => f.endsWith(".json")) : []);
const listDead = (outbox) => listSpool(path.join(outbox, "dead"));

// Fake server: records every request; responds per a handler (default: 200 with
// an ids payload, the success the drain/add both want).
function stubServer(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      if (handler) return handler(req, res, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "captured", ids: ["task-x"] }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
// A bound-then-closed port: connecting yields ECONNREFUSED (genuine unreachable).
function deadBase() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      srv.close(() => resolve(base));
    });
  });
}

test("drain (local mode) is a no-op that explains itself, exits 0", () => {
  const { home } = freshHome();
  const r = run(["drain"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to drain.*local mode/i);
});

test("drain (remote, empty outbox) reports clear and exits 0 without contacting the server", async () => {
  const { home } = freshHome();
  const base = await deadBase(); // dead — proves we never hit it when the outbox is empty
  const r = await runAsync(["drain"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /outbox empty/);
});

test("drain (remote) ships every spooled file and removes it, reporting the tally", async () => {
  const { home, outbox } = freshHome();
  spool(outbox, `cli-1-${"a".repeat(8)}.capture.json`); // -> /v1/capture
  spool(outbox, `node-1-${"b".repeat(8)}.json`, { id: "n-x", type: "note" }); // -> /v1/nodes
  const { srv, hits, base } = await stubServer();
  try {
    const r = await runAsync(["drain"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /drained 2\/2/);
    assert.strictEqual(listSpool(outbox).length, 0, "both spooled files shipped and were removed");
    // routed to the right endpoint by filename suffix
    assert.ok(hits.some((h) => h.url === "/v1/capture"), "the .capture.json went to /v1/capture");
    assert.ok(hits.some((h) => h.url === "/v1/nodes"), "the .json went to /v1/nodes");
  } finally {
    srv.close();
  }
});

test("drain (remote) honors --limit, deferring the rest", async () => {
  const { home, outbox } = freshHome();
  spool(outbox, "cli-1.capture.json");
  spool(outbox, "cli-2.capture.json");
  spool(outbox, "cli-3.capture.json");
  const { srv, base } = await stubServer();
  try {
    const r = await runAsync(["drain", "--limit", "2"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /drained 2\/2/);
    assert.strictEqual(listSpool(outbox).length, 1, "one file deferred by the cap");
  } finally {
    srv.close();
  }
});

test("drain (remote) dead-letters a permanent reject and reports it (exit 0 — progress)", async () => {
  const { home, outbox } = freshHome();
  spool(outbox, "cli-bad.capture.json");
  const { srv, base } = await stubServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "unauthorized" } }));
  });
  try {
    const r = await runAsync(["drain"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, "dead-lettering is progress, not a transient failure");
    assert.match(r.stdout, /dead-lettered/);
    assert.strictEqual(listSpool(outbox).length, 0, "the reject left the live outbox");
    assert.strictEqual(listDead(outbox).length, 1, "and moved to outbox/dead/");
  } finally {
    srv.close();
  }
});

test("drain (remote, server unreachable) leaves files spooled and exits 1", async () => {
  const { home, outbox } = freshHome();
  spool(outbox, "cli-1.capture.json");
  const base = await deadBase();
  const r = await runAsync(["drain"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
  assert.strictEqual(r.status, 1, "no progress against a dead server -> exit 1 so a script can detect it");
  assert.match(r.stdout, /drained 0\/1/);
  assert.strictEqual(listSpool(outbox).length, 1, "the capture stays spooled for the next drain");
});

test("sync is an alias for drain", () => {
  const { home } = freshHome();
  const r = run(["sync"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to drain/);
});

// --- opportunistic drain on a successful remote `spor add` -------------------

test("add (remote) opportunistically flushes a pre-existing spool on success", async () => {
  const { home, outbox } = freshHome();
  spool(outbox, "cli-old.capture.json"); // a capture stranded by an earlier outage
  const { srv, hits, base } = await stubServer();
  try {
    const r = await runAsync(["add", "a fresh capture that ships cleanly now"],
      { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /captured:/);
    assert.match(r.stdout, /also flushed 1 spooled capture/);
    assert.strictEqual(listSpool(outbox).length, 0, "the stranded capture drained on the back of the add");
    // two POSTs: the add itself, then the drained backlog file
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 2);
  } finally {
    srv.close();
  }
});

test("add (remote) success with an empty outbox flushes nothing and stays quiet", async () => {
  const { home, outbox } = freshHome();
  const { srv, hits, base } = await stubServer();
  try {
    const r = await runAsync(["add", "a capture with no backlog behind it"],
      { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /also flushed/);
    assert.strictEqual(listSpool(outbox).length, 0);
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 1, "only the add itself posted");
  } finally {
    srv.close();
  }
});

// --- idempotency key survives the timeout → spool → drain race ----------------
// (issue-spor-add-cli-duplicate-on-timeout-drain). The server dedupes a capture
// it has already seen by its key, so the ONLY thing the client must guarantee is
// that the key on the first POST is the SAME key the drain replay re-sends.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("add (remote) stamps a client idempotency key onto the capture POST body", async () => {
  const { home } = freshHome();
  const { srv, hits, base } = await stubServer();
  try {
    const r = await runAsync(["add", "a capture that carries an idempotency key"],
      { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    const cap = hits.find((h) => h.url === "/v1/capture");
    assert.match(JSON.parse(cap.body).idempotency_key, UUID_RE, "the POST body carries a uuid key");
  } finally {
    srv.close();
  }
});

test("add timeout spools the key; drain replays the SAME key so the server dedupes", async () => {
  const { home, outbox } = freshHome();
  // 1) add against an unreachable server → transport failure → spool. This is the
  //    "client aborted but the server may have landed it" case the fix targets.
  const deadServer = await deadBase();
  const add = await runAsync(["add", "a capture that times out client-side but lands on the server"],
    { SPOR_SERVER: deadServer, SPOR_TOKEN: "tok", SPOR_HOME: home });
  assert.strictEqual(add.status, 1, "transport failure exits 1");
  const spooled = listSpool(outbox);
  assert.strictEqual(spooled.length, 1, "the failed capture spooled");
  const spoolKey = JSON.parse(fs.readFileSync(path.join(outbox, spooled[0]), "utf8")).idempotency_key;
  assert.match(spoolKey, UUID_RE, "the spool file preserves the idempotency key");
  // 2) drain to a live server → the replay POST must carry the IDENTICAL key, so
  //    the server recognizes the already-landed capture instead of re-ingesting.
  const { srv, hits, base } = await stubServer();
  try {
    const drain = await runAsync(["drain"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home });
    assert.strictEqual(drain.status, 0, drain.stderr);
    const replay = hits.find((h) => h.url === "/v1/capture");
    assert.strictEqual(JSON.parse(replay.body).idempotency_key, spoolKey,
      "drain re-POSTs the identical key — the server dedupes rather than double-writes");
    assert.strictEqual(listSpool(outbox).length, 0, "the drained capture left the outbox");
  } finally {
    srv.close();
  }
});
