"use strict";
// remote.test.js — the stale-pooled-socket retry
// (issue-spor-remote-stale-socket-after-blocking-spawn): `spor dispatch --bg`
// mints an agent token, blocks the event loop in a synchronous spawnSync
// launching `claude --bg` (several seconds under load), then POSTs
// /v1/agents/session on a pooled keep-alive socket the server may have already
// closed while the loop was blocked (Node's default 5s keepAliveTimeout, or a
// proxy's own idle cutoff). undici surfaces that as a `TypeError: fetch failed`
// whose `cause` carries `UND_ERR_SOCKET` / "other side closed" (or a bare
// ECONNRESET/EPIPE when something in front resets outright) — with NO response
// ever received. lib/remote.js now retries such a request exactly once, but
// ONLY when it's safe to repeat: an idempotent HTTP method, a POST explicitly
// marked `idempotent: true`, or a POST whose body carries an `idempotency_key`.
//
// The exact race (a real pooled socket dying mid-block) is timing-dependent
// and, on current Node/undici, is often already absorbed transparently before
// it ever reaches our code — so the deterministic unit tests below stub
// `global.fetch` to force the precise failure shape, pinning the retry rule
// itself regardless of what any given Node version's connection pool does
// under the hood. The end-to-end test at the bottom is the literal repro the
// issue's acceptance bar asks for: a real server with a 1s keepAliveTimeout,
// a client that blocks for 2s via a real spawnSync between two requests, and
// the second request succeeding either way.

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const { loadConfig } = require("../lib/config.js");
const remoteLib = require("../lib/remote.js");

function remoteCfg(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-remote-retry-"));
  return loadConfig({
    cwd: home,
    env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: "http://127.0.0.1:1", SPOR_TOKEN: "t", ...extraEnv },
  });
}

// A response object shaped like what `_attempt` expects from a real fetch()
// Response: `.text()` and a Headers-like `.headers.forEach((value, key) => …)`.
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach() {} },
    text: async () => JSON.stringify(body),
  };
}

function staleSocketError() {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return err;
}

// Stubs global.fetch for the life of `fn`, restoring it afterward even on throw.
async function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test("isStaleSocketError: matches UND_ERR_SOCKET / other side closed / ECONNRESET / EPIPE, never a normal response or a plain refusal", () => {
  const { isStaleSocketError } = remoteLib;
  assert.strictEqual(isStaleSocketError({ ok: false, transport: true, code: "UND_ERR_SOCKET", error: "fetch failed" }), true);
  assert.strictEqual(isStaleSocketError({ ok: false, transport: true, error: "other side closed" }), true);
  assert.strictEqual(isStaleSocketError({ ok: false, transport: true, cause: "read ECONNRESET" }), true);
  assert.strictEqual(isStaleSocketError({ ok: false, transport: true, error: "write EPIPE" }), true);
  // an ordinary connection refusal is a transport error too, but not THIS one
  assert.strictEqual(isStaleSocketError({ ok: false, transport: true, error: "connect ECONNREFUSED 127.0.0.1:1" }), false);
  // any actual HTTP response (even a 5xx) is not a transport error at all
  assert.strictEqual(isStaleSocketError({ ok: false, status: 500, transport: undefined }), false);
  assert.strictEqual(isStaleSocketError({ ok: true, status: 200 }), false);
  assert.strictEqual(isStaleSocketError(null), false);
});

test("safeToRepeat: idempotent methods always qualify; POST qualifies only when marked idempotent or carrying an idempotency_key", () => {
  const { safeToRepeat } = remoteLib;
  assert.strictEqual(safeToRepeat("GET", {}), true);
  assert.strictEqual(safeToRepeat("PUT", {}), true);
  assert.strictEqual(safeToRepeat("DELETE", {}), true);
  assert.strictEqual(safeToRepeat("HEAD", {}), true);
  assert.strictEqual(safeToRepeat("POST", {}), false);
  assert.strictEqual(safeToRepeat("POST", { idempotent: true }), true);
  assert.strictEqual(safeToRepeat("POST", { body: { session: "x" } }), false);
  assert.strictEqual(safeToRepeat("POST", { body: { idempotency_key: "abc" } }), true);
});

test("request(): a stale-socket failure on an idempotent GET is retried once and the retry's success is returned", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) throw staleSocketError();
      return fakeResponse(200, { hello: "world" });
    },
    async () => {
      const r = await remoteLib.request(cfg, "GET", "/v1/whatever", {});
      assert.strictEqual(calls, 2, "exactly one retry");
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.json, { hello: "world" });
    }
  );
});

test("request(): a stale-socket failure on a plain POST (no idempotency signal) is surfaced immediately, never retried", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      throw staleSocketError();
    },
    async () => {
      const r = await remoteLib.request(cfg, "POST", "/v1/whatever", { body: { foo: "bar" } });
      assert.strictEqual(calls, 1, "no retry — unsafe to repeat a bare POST");
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.transport, true);
    }
  );
});

test("request(): a POST explicitly marked idempotent is retried once on a stale socket", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) throw staleSocketError();
      return fakeResponse(200, { ok: true });
    },
    async () => {
      const r = await remoteLib.request(cfg, "POST", "/v1/agents/session", { body: { session: "abc" }, idempotent: true });
      assert.strictEqual(calls, 2);
      assert.strictEqual(r.ok, true);
    }
  );
});

test("request(): a POST whose body carries an idempotency_key is retried once on a stale socket, with no explicit flag needed", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) throw staleSocketError();
      return fakeResponse(200, { ok: true });
    },
    async () => {
      const r = await remoteLib.request(cfg, "POST", "/v1/capture", { body: { text: "x", idempotency_key: "key-1" } });
      assert.strictEqual(calls, 2);
      assert.strictEqual(r.ok, true);
    }
  );
});

test("request(): the retry is exactly ONE attempt — two consecutive stale-socket failures still fail (no unbounded loop)", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      throw staleSocketError();
    },
    async () => {
      const r = await remoteLib.request(cfg, "GET", "/v1/whatever", {});
      assert.strictEqual(calls, 2, "attempted twice total, then gave up");
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.transport, true);
    }
  );
});

test("request(): a non-stale-socket transport error (e.g. connection refused) is never retried, even for a GET", async () => {
  const cfg = remoteCfg();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
      throw err;
    },
    async () => {
      const r = await remoteLib.request(cfg, "GET", "/v1/whatever", {});
      assert.strictEqual(calls, 1, "a plain refusal is not the stale-socket case — no retry");
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.transport, true);
    }
  );
});

// ---------------------------------------------------------------------------
// End-to-end: the literal acceptance-bar repro. A real HTTP server with a 1s
// keepAliveTimeout, and a client that blocks the event loop for 2s via a real
// spawnSync (mirroring `spor dispatch --bg`'s blocking claude launch) between
// two requests over the SAME pooled connection. The second request must
// succeed — whether that's because Node's own connection pool already evicted
// the dead socket, or because our one-shot retry caught it having not.
test("end-to-end: a request after a spawnSync block past the server's keepAliveTimeout still succeeds", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  srv.keepAliveTimeout = 1000;
  srv.headersTimeout = 1100;
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = remoteCfg({ SPOR_SERVER: base });
  try {
    const r1 = await remoteLib.get(cfg, "/v1/x");
    assert.strictEqual(r1.ok, true);

    // Block the event loop synchronously past the server's keepAliveTimeout —
    // the same shape as a blocking `claude --bg` launch inside cmdDispatch.
    spawnSync(process.execPath, ["-e", "1"], { timeout: 5000 });
    spawnSync("sleep", ["2"]);

    const r2 = await remoteLib.get(cfg, "/v1/y");
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.deepStrictEqual(r2.json, { ok: true, path: "/v1/y" });
  } finally {
    srv.close();
  }
});
