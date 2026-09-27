// spor next --readiness (remote mode) — task-spor-queue-remote-readiness-ignored.
// Local mode already forwards --readiness into rankQueue (lib/queue.js) and
// prints the counts_by_readiness lead line; remote mode silently dropped the
// flag and never rendered the counts. This file is the remote-only contract:
// the query param actually reaches GET /v1/queue, the lead line renders from
// the server's counts_by_readiness, and an invalid value's 422 surfaces
// rather than being swallowed. Runs against an in-process fake server only —
// never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const { hermeticEnv } = require("./helpers/env.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// No SPOR_*/SUBSTRATE_* leakage; isolate the config homes so the dev's real
// ~/.spor/config.json can't leak a server+token in and flip a local test remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-readiness-remote-iso-"));
function bare(extra = {}) {
  return hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, ...extra });
}
// Async spawn: the stub server runs IN-PROCESS, so a blocking spawnSync would
// freeze the test event loop (mirrors next-limit.test.js / in-flight.test.js).
function runAsync(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

const READINESS_VALUES = new Set(["agent", "human", "untriaged"]);
const mkItems = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `task-${i + 1}`, score: n - i, suggest: "do", why: "queueable" }));

// A stub GET /v1/queue that records every request's parsed ?readiness= value,
// rejects an unknown class with the server's own 422 shape (server/rest-
// fastify.js's `queue` handler), and — when a readiness filter was requested —
// answers with a fixed counts_by_readiness envelope, matching the server
// contract (API.md's GET /v1/queue row): the aggregate rides even on a request
// that itself asked for a class.
function fakeServer(items) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const m = /^\/v1\/queue\?(.*)$/.exec(req.url);
    if (req.method === "GET" && m) {
      const p = new URLSearchParams(m[1]);
      const readinessRaw = p.getAll("readiness").flatMap((v) => v.split(","));
      const readiness = [];
      for (const v of readinessRaw) {
        const s = v.trim();
        if (!s) continue;
        if (!READINESS_VALUES.has(s)) {
          requests.push({ readiness: p.get("readiness") });
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({
            error: { code: "invalid_node", message: `bad readiness value '${s}' (must be one of agent, human, untriaged)` },
          }));
          return;
        }
        readiness.push(s);
      }
      requests.push({ readiness: p.get("readiness") });
      const filtered = readiness.length ? items.filter((it) => readiness.includes(it.readiness)) : items;
      res.writeHead(200, { "content-type": "application/json" });
      const body = {
        items: filtered,
        count: filtered.length,
        total_count: filtered.length,
        offset: 0,
        returned_count: filtered.length,
        next_offset: null,
        truncated: false,
        counts_by_type: { task: filtered.length },
      };
      if (readiness.length || items.some((it) => it.readiness)) {
        body.counts_by_readiness = {
          agent: items.filter((it) => it.readiness === "agent").length,
          human: items.filter((it) => it.readiness === "human").length,
          untriaged: items.filter((it) => !it.readiness || it.readiness === "untriaged").length,
        };
      }
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, requests }))
  );
}

test("remote next --readiness agent forwards ?readiness=agent to GET /v1/queue", async () => {
  const items = mkItems(3).map((it, i) => ({ ...it, readiness: i === 0 ? "agent" : "human" }));
  const { srv, base, requests } = await fakeServer(items);
  try {
    const r = await runAsync(["next", "--readiness", "agent", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(requests, [{ readiness: "agent" }], "the query param was sent exactly once");
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 1, "server-filtered to the one agent-ready item");
  } finally {
    srv.close();
  }
});

test("remote next --readiness agent,untriaged forwards a comma-joined value", async () => {
  const items = mkItems(3).map((it, i) => ({ ...it, readiness: ["agent", "human", "untriaged"][i] }));
  const { srv, base, requests } = await fakeServer(items);
  try {
    const r = await runAsync(["next", "--readiness", "agent,untriaged", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(requests, [{ readiness: "agent,untriaged" }]);
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 2, "server-filtered to the agent + untriaged items");
  } finally {
    srv.close();
  }
});

test("remote next repeated --readiness flags are joined the same as local's comma form", async () => {
  const items = mkItems(2).map((it, i) => ({ ...it, readiness: ["agent", "human"][i] }));
  const { srv, base, requests } = await fakeServer(items);
  try {
    const r = await runAsync(["next", "--readiness", "agent", "--readiness", "human", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(requests, [{ readiness: "agent,human" }]);
  } finally {
    srv.close();
  }
});

test("remote next human render prints the counts_by_readiness lead line like local mode", async () => {
  const items = mkItems(3).map((it, i) => ({ ...it, readiness: ["agent", "human", "untriaged"][i] }));
  const { srv, base } = await fakeServer(items);
  try {
    const r = await runAsync(["next", "--readiness", "agent,human,untriaged"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^readiness: 1 agent-ready, 1 need human, 1 untriaged$/m);
  } finally {
    srv.close();
  }
});

test("remote next --readiness with no filter still shows counts when the graph has readiness signal", async () => {
  const items = mkItems(2).map((it, i) => ({ ...it, readiness: ["agent", "human"][i] }));
  const { srv, base } = await fakeServer(items);
  try {
    const r = await runAsync(["next"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^readiness: 1 agent-ready, 1 need human, 0 untriaged$/m);
  } finally {
    srv.close();
  }
});

test("remote next --readiness <invalid> surfaces the server's 422, never a silent unfiltered queue", async () => {
  const { srv, base, requests } = await fakeServer(mkItems(3));
  try {
    const r = await runAsync(["next", "--readiness", "bogus", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.notStrictEqual(r.status, 0, "a 422 must not exit 0");
    assert.deepStrictEqual(requests, [{ readiness: "bogus" }], "the bad value still reached the server, not filtered client-side");
    assert.match(r.stderr, /422/);
    assert.match(r.stderr, /bad readiness value 'bogus'/);
    assert.strictEqual(r.stdout, "", "no queue is printed when the request was rejected");
  } finally {
    srv.close();
  }
});

test("--readiness is documented in spor next --help", () => {
  const r = spawnSync(process.execPath, [CLI, "next", "--help"], { encoding: "utf8", env: bare() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--readiness/);
});
