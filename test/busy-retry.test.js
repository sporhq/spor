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

// ---- issue-spor-client-busy-retry-gaps ----

// A server scripted per request: `answers[i]` is `[status, bodyObject]` (the
// last one repeats). Records every request body parsed.
async function scriptedServer(answers, { retryAfter = "0" } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: data ? JSON.parse(data) : null });
      const [status, obj] = answers[Math.min(seen.length, answers.length) - 1];
      const h = { "content-type": "application/json" };
      if (retryAfter != null) h["retry-after"] = retryAfter;
      res.writeHead(status, h);
      res.end(JSON.stringify(obj));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

const OK = (id) => ({ ok: true, id, status: "created" });
const ENTRY_BUSY = { ok: false, code: "busy", message: "the state store is busy; retry shortly" };

test("busyEntryIndexes reads only per-entry busy results of a 207", () => {
  assert.deepStrictEqual(busy.busyEntryIndexes({ status: 207, json: { results: [OK("a"), ENTRY_BUSY, { ok: false, code: "conflict" }, ENTRY_BUSY] } }), [1, 3]);
  assert.deepStrictEqual(busy.busyEntryIndexes({ status: 200, json: { results: [ENTRY_BUSY] } }), []);
  assert.deepStrictEqual(busy.busyEntryIndexes({ status: 207, json: {} }), []);
});

test("POST /v1/nodes: per-entry busy in a 207 re-sends ONLY those entries and merges the answers", async () => {
  const s = await scriptedServer([
    [207, { results: [OK("a"), ENTRY_BUSY, OK("c"), ENTRY_BUSY] }],
    [207, { results: [OK("b"), ENTRY_BUSY] }],
    [200, { results: [OK("d")] }],
  ]);
  try {
    const body = { nodes: [{ node: "A" }, { node: "B", if_exists: "error" }, "C", { node: "D", revision: "r1" }], if_exists: "skip" };
    const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", body);
    assert.strictEqual(s.seen.length, 3);
    assert.deepStrictEqual(s.seen[1].body, { nodes: [{ node: "B", if_exists: "error" }, { node: "D", revision: "r1" }], if_exists: "skip" });
    assert.deepStrictEqual(s.seen[2].body, { nodes: [{ node: "D", revision: "r1" }], if_exists: "skip" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.json.results.map((e) => e.id), ["a", "b", "c", "d"]);
    assert.deepStrictEqual(JSON.parse(r.text), r.json);
  } finally {
    await s.close();
  }
});

test("POST /v1/nodes: a still-busy entry is bounded and reported in its original position", async () => {
  const s = await scriptedServer([[207, { results: [OK("a"), ENTRY_BUSY, { ok: false, code: "invalid_node" }] }], [207, { results: [ENTRY_BUSY] }]]);
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", { nodes: ["A", "B", "C"] });
    assert.strictEqual(s.seen.length, 1 + busy.BUSY_MAX_RETRIES);
    for (const req of s.seen.slice(1)) assert.deepStrictEqual(req.body.nodes, ["B"]);
    assert.strictEqual(r.status, 207);
    assert.strictEqual(r.ok, true, "a 207 reads ok at the HTTP layer, merged or not");
    assert.deepStrictEqual(r.json.results, [OK("a"), ENTRY_BUSY, { ok: false, code: "invalid_node" }]);
  } finally {
    await s.close();
  }
});

test("POST /v1/nodes: a 207 with no busy entry is returned as-is, not re-sent", async () => {
  const s = await scriptedServer([[207, { results: [OK("a"), { ok: false, code: "conflict" }] }]]);
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", { nodes: ["A", "B"] });
    assert.strictEqual(s.seen.length, 1);
    assert.strictEqual(r.status, 207);
  } finally {
    await s.close();
  }
});

test("POST /v1/nodes: a top-level busy re-sends a multi-entry batch only when a landed entry would re-read as success", async () => {
  const busyTop = [503, { error: { code: "busy", message: "busy", details: [] } }];
  const done = [200, { results: [OK("a"), OK("b")] }];
  for (const [body, expectResend] of [
    [{ nodes: ["A", "B"] }, true], // default skip
    [{ nodes: [{ node: "A", if_exists: "update" }, "B"], if_exists: "skip" }, true],
    [{ nodes: ["A", "B"], if_exists: "error" }, false],
    [{ nodes: [{ node: "A", if_exists: "update", revision: "r" }, "B"] }, false],
    [{ nodes: ["A", "B"], if_exists: "update", spill: true }, false],
    [{ nodes: [{ node: "A", if_exists: "error" }] }, true], // one entry is one atomic write
  ]) {
    const s = await scriptedServer([busyTop, done]);
    try {
      const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", body);
      assert.strictEqual(s.seen.length, expectResend ? 2 : 1, JSON.stringify(body));
      assert.strictEqual(r.status, expectResend ? 200 : 503, JSON.stringify(body));
    } finally {
      await s.close();
    }
  }
});

test("POST /v1/nodes: a top-level busy on a re-sent subset re-sends that subset (one entry is atomic)", async () => {
  const s = await scriptedServer([
    [207, { results: [OK("a"), ENTRY_BUSY] }],
    [503, { error: { code: "busy" } }],
    [200, { results: [OK("b")] }],
  ]);
  try {
    const r = await remoteLib.post(cfgFor(s.url), "/v1/nodes", { nodes: ["A", "B"], if_exists: "error" });
    assert.strictEqual(s.seen.length, 3);
    assert.deepStrictEqual(s.seen[2].body.nodes, ["B"]);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((e) => e.id), ["a", "b"]);
  } finally {
    await s.close();
  }
});

test("oauthPost stops re-sending a busy refusal once the caller's signal aborts", async () => {
  const s = await busyServer({ busyTimes: 99, retryAfter: "1", body: JSON.stringify({ error: "temporarily_unavailable" }) });
  try {
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 150);
    const r = await auth.oauthPost(s.url, "/oauth/token", { grant_type: "refresh_token", refresh_token: "r" }, 8000, { signal: ctl.signal });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(s.seen.length, 1);
    assert.ok(Date.now() - t0 < 900, "returned at the abort, not after the Retry-After");
  } finally {
    await s.close();
  }
});

test("a 401's nested token refresh stops re-sending once the request's signal aborts", async () => {
  // /v1/queue answers 401; /oauth/token answers busy (Retry-After 1s) forever.
  const seen = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.url);
      if (req.url === "/oauth/token") {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: "temporarily_unavailable" }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized" } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-busy-refresh-"));
    auth.upsertTenant(home, { server: url, org: "acme", access_token: "tok", refresh_token: "rt", expires_in: 3600 }, { makeDefault: true });
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: "acme" } });
    assert.ok(cfg.tenant() && cfg.tenant().refresh_token, "store tenant resolved");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const r = await remoteLib.get(cfg, "/v1/queue", { signal: ctl.signal });
    assert.strictEqual(r.status, 401);
    // Give an un-aborted refresh time to have re-sent after its 1s Retry-After.
    await new Promise((r2) => setTimeout(r2, 1300));
    assert.strictEqual(seen.filter((u2) => u2 === "/oauth/token").length, 1, seen.join(","));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("batchResendSafe: one entry always; several only under skip or an unrevisioned, unspilled update", () => {
  const safe = (body) => remoteLib.batchResendSafe(body, body.nodes);
  assert.ok(safe({ nodes: [{ node: "A", if_exists: "error" }] }));
  assert.ok(safe({ nodes: ["A", "B"] }));
  assert.ok(safe({ nodes: ["A", { node: "B", if_exists: "update" }] }));
  assert.ok(!safe({ nodes: ["A", "B"], if_exists: "error" }));
  assert.ok(!safe({ nodes: ["A", { node: "B", if_exists: "update", revision: "r" }] }));
  assert.ok(!safe({ nodes: ["A", { node: "B", if_exists: "update", spill: true }] }));
  assert.ok(safe({ nodes: ["A", { node: "B", spill: true }] }));
});
