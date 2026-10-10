"use strict";
// busy-retry.test.js — the client honours the server's retryable 503 busy
// refusal (task-spor-client-honor-retry-after-on-503-busy): REST `503 {error:
// {code:"busy"}}` and OAuth `503 {error:"temporarily_unavailable"}`, each with
// Retry-After, are re-sent (bounded) by lib/remote.js and lib/auth.js — only
// for a request safe to re-send — and the hook engines' curl() honours a 503's
// Retry-After the way it already honoured a 429's.

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const busy = require("../lib/shell/busy.js");
const remoteLib = require("../lib/remote.js");
const auth = require("../lib/auth.js");
const u = require("../scripts/engines/util.js");
const { loadConfig } = require("../lib/config.js");

const BUSY_BODY = JSON.stringify({ error: { code: "busy", message: "retry shortly", details: [] } });

// A server answering `busy` (with `retryAfter`) to the first `busyTimes`
// requests, then 200 {ok:true}. Counts every request it sees.
async function busyServer({ busyTimes = 1, retryAfter = "0", body = BUSY_BODY, okBody = '{"ok":true}' } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: data });
      if (seen.length <= busyTimes) {
        const h = { "content-type": "application/json" };
        if (retryAfter != null) h["retry-after"] = retryAfter;
        res.writeHead(503, h);
        res.end(body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okBody);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, seen, close: () => new Promise((r) => srv.close(r)) };
}

function cfgFor(server) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-busy-retry-"));
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: server, SPOR_TOKEN: "t" } });
}

test("isBusy reads only the REST busy code and the OAuth temporarily_unavailable on a 503", () => {
  assert.ok(busy.isBusy({ status: 503, json: { error: { code: "busy" } } }));
  assert.ok(busy.isBusy({ status: 503, json: { error: "temporarily_unavailable" } }));
  assert.ok(!busy.isBusy({ status: 503, json: { error: { code: "ingestion_unavailable" } } }));
  assert.ok(!busy.isBusy({ status: 503, json: null }));
  assert.ok(!busy.isBusy({ status: 500, json: { error: { code: "busy" } } }));
  assert.ok(!busy.isBusy({ ok: false, transport: true }));
});

test("busyDelayMs honours Retry-After, falls back to 1s·2^n, and is capped", () => {
  assert.strictEqual(busy.busyDelayMs({ headers: { "retry-after": "1" } }, 0), 1000);
  assert.strictEqual(busy.busyDelayMs({ headers: {} }, 0), 1000);
  assert.strictEqual(busy.busyDelayMs({ headers: {} }, 1), 2000);
  assert.strictEqual(busy.busyDelayMs({ headers: { "retry-after": "3600" } }, 0), busy.BUSY_WAIT_CAP_MS);
});

test("withBusyRetry is bounded and hands back the last answer as-is", async () => {
  let calls = 0;
  const waits = [];
  const r = await busy.withBusyRetry(
    async () => {
      calls++;
      return { status: 503, json: { error: { code: "busy" } }, headers: { "retry-after": "2" } };
    },
    { sleep: async (ms) => waits.push(ms) },
  );
  assert.strictEqual(calls, 1 + busy.BUSY_MAX_RETRIES);
  assert.deepStrictEqual(waits, Array(busy.BUSY_MAX_RETRIES).fill(2000));
  assert.strictEqual(r.status, 503);
});

test("withBusyRetry stops waiting once the caller's signal aborts", async () => {
  const ctl = new AbortController();
  let calls = 0;
  await busy.withBusyRetry(
    async () => {
      calls++;
      ctl.abort();
      return { status: 503, json: { error: { code: "busy" } }, headers: {} };
    },
    { signal: ctl.signal, sleep: async () => {} },
  );
  assert.strictEqual(calls, 1);
});

test("remote GET re-sends a busy refusal and returns the eventual answer", async () => {
  const s = await busyServer({ busyTimes: 2 });
  try {
    const r = await remoteLib.get(cfgFor(s.url), "/v1/queue");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true });
    assert.strictEqual(s.seen.length, 3);
  } finally {
    await s.close();
  }
});

test("remote POST /v1/nodes (an id-keyed put) is re-sent on busy", async () => {
  const s = await busyServer();
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", { nodes: [{ node: "x", if_exists: "skip" }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(s.seen.length, 2);
    assert.strictEqual(s.seen[0].body, s.seen[1].body);
  } finally {
    await s.close();
  }
});

test("a POST that appends (capture without an idempotency_key) is NOT re-sent on busy", async () => {
  const s = await busyServer();
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/capture", { text: "a fact" });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error.code, "busy");
    assert.strictEqual(s.seen.length, 1);
  } finally {
    await s.close();
  }
});

test("a capture carrying an idempotency_key IS re-sent on busy", async () => {
  const s = await busyServer();
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/capture", { text: "a fact", idempotency_key: "k1" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(s.seen.length, 2);
  } finally {
    await s.close();
  }
});

test("a 503 that is not busy (no busy code) is not re-sent", async () => {
  const s = await busyServer({ body: JSON.stringify({ error: { code: "ingestion_unavailable" } }) });
  try {
    const r = await remoteLib.get(cfgFor(s.url), "/v1/queue");
    assert.strictEqual(r.status, 503);
    assert.strictEqual(s.seen.length, 1);
  } finally {
    await s.close();
  }
});

test("busyRetryable: the per-verb safety table", () => {
  const ok = (m, p, o) => assert.ok(remoteLib.busyRetryable(m, p, o), `${m} ${p}`);
  const no = (m, p, o) => assert.ok(!remoteLib.busyRetryable(m, p, o), `${m} ${p}`);
  ok("GET", "/v1/queue");
  ok("DELETE", "/v1/nodes/x/edges");
  ok("POST", "/v1/nodes");
  ok("POST", "/v1/nodes/batch");
  ok("POST", "/v1/digest");
  ok("POST", "/v1/nodes/task-x/edges");
  ok("POST", "/v1/nodes/task-x/edges/live");
  ok("POST", "/v1/nodes/task-x/status");
  ok("POST", "/v1/nodes/task-x/priority");
  ok("POST", "/v1/nodes/task-x/readiness");
  ok("POST", "/v1/nodes/task-x/release");
  ok("POST", "/v1/queue/release");
  ok("POST", "/v1/agents/agent-x/capabilities");
  ok("PATCH", "/v1/nodes/task-x");
  ok("POST", "/v1/anything", { idempotent: true });
  no("POST", "/v1/capture");
  no("POST", "/v1/questions");
  no("POST", "/v1/corrections");
  no("POST", "/v1/nodes/task-x/claim");
  no("POST", "/v1/nodes/task-x/extend");
  no("POST", "/v1/me/tokens");
  no("POST", "/v1/agents/agent-x/token");
  no("POST", "/v1/merge");
  no("POST", "/v1/gardener");
  no("PATCH", "/v1/other");
});

test("remote download re-sends a busy refusal", async () => {
  const s = await busyServer({ okBody: "tarball-bytes" });
  try {
    const r = await remoteLib.download(cfgFor(s.url), "/v1/export");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buffer.toString(), "tarball-bytes");
    assert.strictEqual(s.seen.length, 2);
  } finally {
    await s.close();
  }
});

test("remote exchange re-sends a busy upload only when it carries an Idempotency-Key", async () => {
  const s = await busyServer({ busyTimes: 1 });
  try {
    const cfg = cfgFor(s.url);
    const r = await remoteLib.exchange(cfg, "POST", "/v1/assets", { body: () => "bytes", headers: { "idempotency-key": "k" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(s.seen.length, 2);
    assert.strictEqual(s.seen[1].body, "bytes");
  } finally {
    await s.close();
  }
  const s2 = await busyServer({ busyTimes: 1 });
  try {
    const r = await remoteLib.exchange(cfgFor(s2.url), "POST", "/v1/assets", { body: () => "bytes" });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(s2.seen.length, 1);
  } finally {
    await s2.close();
  }
});

test("OAuth token calls re-send a 503 temporarily_unavailable", async () => {
  const s = await busyServer({
    body: JSON.stringify({ error: "temporarily_unavailable", error_description: "busy" }),
    okBody: JSON.stringify({ access_token: "a", refresh_token: "r" }),
  });
  try {
    const r = await auth.devicePoll(s.url, "dc");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.access_token, "a");
    assert.strictEqual(s.seen.length, 2);
  } finally {
    await s.close();
  }
});

test("hook curl() honours a 503's Retry-After between retries", async () => {
  // Retry-After 0.6s is longer than curl's first exponential step (250ms), so
  // the elapsed time shows which one it waited.
  const s = await busyServer({ retryAfter: "0.6" });
  try {
    const t0 = Date.now();
    const r = await u.curl(`${s.url}/v1/queue`, { retry: 1, backoffCapMs: 8000 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.http, "200");
    assert.strictEqual(s.seen.length, 2);
    assert.ok(elapsed >= 550, `waited ${elapsed}ms, expected the 600ms Retry-After`);
  } finally {
    await s.close();
  }
});

test("oauthPost busyRetries: 0 (the hook engines' refresh) does not re-send", async () => {
  const s = await busyServer({ body: JSON.stringify({ error: "temporarily_unavailable" }) });
  try {
    const r = await auth.oauthPost(s.url, "/oauth/token", { grant_type: "refresh_token", refresh_token: "r" }, 8000, { busyRetries: 0 });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(s.seen.length, 1);
  } finally {
    await s.close();
  }
});
