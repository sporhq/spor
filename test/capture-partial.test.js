// capture-partial.test.js — the client's handling of a PARTIAL capture
// (task-spor-client-capture-partial-unsaved-handling): a `503 partial_unsaved`
// is FINAL — never spooled, busy-retried or re-sent; its deferred drafts are
// re-submitted as `POST /v1/nodes` `if_exists: skip` writes — and a `200`
// marked `partial` is surfaced. Also the drain's handling of a non-replayable
// busy and of a `/v1/nodes` 207's per-entry verdicts.
//
// Oracle = the requests the fake server saw + the on-disk outbox state + the
// CLI's output. Everything runs against a throwaway home and a fake server.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { hermeticEnv } = require("./helpers/env.js");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const cp = require("../lib/shell/capture-partial.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const DRAIN = path.join(__dirname, "..", "scripts", "engines", "drain-outbox.js");

const draft = (id) => `---\nid: ${id}\ntype: task\ntitle: ${id}\nsummary: deferred draft ${id}\n---\n\nbody of ${id}\n`;
const UNSAVED = {
  error: {
    code: "partial_unsaved",
    message: "partial capture: task-a landed; task-b, task-c not written",
    retryable: false,
    landed: ["task-a"],
    ids: ["task-a"],
    nodes: [{ id: "task-a", status: "created" }],
    deferred: ["task-b", "task-c"],
    deferred_drafts: [
      { id: "task-b", type: "task", title: "task-b", summary: "s", body: "", edges: [], raw: draft("task-b") },
      { id: "task-c", type: "task", title: "task-c", summary: "s", body: "", edges: [], raw: draft("task-c") },
    ],
  },
};
const PARTIAL_200 = {
  status: "captured",
  ids: ["task-a", "cap-2026-10-10-1"],
  partial: true,
  landed: ["task-a"],
  deferred: ["task-b"],
  pending_id: "cap-2026-10-10-1",
};

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-partial-"));
  const outbox = path.join(home, "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  return { home, outbox };
}
const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Fake server: records every request; `routes[url]` is a list of [status, body]
// answers taken in order (the last one repeats).
function stubServer(routes) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const list = routes[req.url] || [[200, { status: "captured", ids: ["task-x"] }]];
      const n = hits.filter((h) => h.url === req.url).length - 1;
      const [status, json] = list[Math.min(n, list.length - 1)];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

function runAsync(file, args, env) {
  return new Promise((resolve) => {
    let out = "";
    let errOut = "";
    const c = spawn(process.execPath, [file, ...args], { env: hermeticEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
// The drain engine's own CLI entry (tag, perFileSec, maxFiles, maxWallSec, retry).
const drain = (home, base) => runAsync(DRAIN, ["test", "5", "0", "0", "0"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "tok" });
const remoteLog = (home) => {
  try {
    return fs.readFileSync(path.join(home, "journal", "remote.log"), "utf8");
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// the pure reading

test("partialUnsaved reads the refusal; anything else is null", () => {
  const p = cp.partialUnsaved(UNSAVED);
  assert.deepStrictEqual(p.landed, ["task-a"]);
  assert.deepStrictEqual(p.deferred, ["task-b", "task-c"]);
  assert.deepStrictEqual(p.drafts.map((d) => d.id), ["task-b", "task-c"]);
  assert.deepStrictEqual(cp.deferredNodesBody(p.drafts), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
  assert.strictEqual(cp.partialUnsaved({ error: { code: "busy", retryable: false } }), null);
  assert.strictEqual(cp.partialUnsaved(null), null);
  // a draft with no raw markdown is not re-submittable
  const thin = cp.partialUnsaved({ error: { code: "partial_unsaved", deferred: ["x"], deferred_drafts: [{ id: "x", raw: "" }] } });
  assert.deepStrictEqual(thin.drafts, []);
});

test("partialCapture reads a 200 marked partial", () => {
  assert.deepStrictEqual(cp.partialCapture(PARTIAL_200), { landed: ["task-a"], deferred: ["task-b"], pending_id: "cap-2026-10-10-1" });
  assert.strictEqual(cp.partialCapture({ status: "captured", ids: ["x"] }), null);
  assert.match(cp.describePartialCapture(cp.partialCapture(PARTIAL_200)), /task-a landed; task-b not written — the text is preserved as cap-2026-10-10-1/);
});

test("splitNodesResults: landed, busy (re-sendable) and refused entries, original order kept", () => {
  const body = { nodes: ["a", "b", "c", "d", "e"], if_exists: "skip" };
  const split = cp.splitNodesResults(
    {
      results: [
        { ok: true, status: "created" },
        { ok: false, code: "busy", retryable: true },
        { ok: false, code: "invalid_node" },
        { ok: false, code: "busy", retryable: false },
        { ok: false, code: "internal", landed: true },
      ],
    },
    body
  );
  assert.strictEqual(split.landed, 2);
  assert.deepStrictEqual(split.retry, { nodes: ["b"], if_exists: "skip" });
  assert.deepStrictEqual(split.dead, { nodes: ["c", "d"], if_exists: "skip" });
  assert.strictEqual(cp.splitNodesResults({ results: [] }, body), null, "a mismatched result list is no reading");
  // a gated entry the server marks retryable follows its busy resolver
  const gated = cp.splitNodesResults(
    { results: [{ ok: false, code: "busy", retryable: true }, { ok: false, code: "transition_denied", retryable: true, retry_with: [0] }] },
    { nodes: ["dec", "task"], if_exists: "skip" }
  );
  assert.deepStrictEqual(gated.retry, { nodes: ["dec", "task"], if_exists: "skip" });
  assert.strictEqual(gated.dead, null);
  assert.strictEqual(cp.splitNodesResults({}, { id: "x" }), null);
});

// ---------------------------------------------------------------------------
// spor add

test("add (remote): a 503 partial_unsaved is never spooled — its deferred drafts are re-submitted as skip node writes", async () => {
  const { home, outbox } = freshHome();
  const { srv, hits, base } = await stubServer({
    "/v1/capture": [[503, UNSAVED]],
    "/v1/nodes": [[200, { results: [{ ok: true, id: "task-b", status: "created" }, { ok: true, id: "task-c", status: "skipped" }] }]],
  });
  try {
    const r = await runAsync(CLI, ["add", "a capture whose second half could not be saved"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 1, "the capture is final — never re-sent");
    const puts = hits.filter((h) => h.url === "/v1/nodes");
    assert.strictEqual(puts.length, 1);
    assert.deepStrictEqual(JSON.parse(puts[0].body), { nodes: [{ node: draft("task-b"), if_exists: "skip" }, { node: draft("task-c"), if_exists: "skip" }] });
    assert.match(r.stdout, /captured: task-a \(partial\)/);
    assert.match(r.stdout, /created: task-b/);
    assert.match(r.stdout, /skipped: task-c/);
    assert.match(r.stderr, /partial capture: task-a landed; task-b, task-c not written/);
    assert.deepStrictEqual(listJson(outbox), [], "nothing spooled");
  } finally {
    srv.close();
  }
});

test("add (remote): a deferred draft that does not land is spooled as a /v1/nodes skip batch, exit 1", async () => {
  const { home, outbox } = freshHome();
  const { srv, hits, base } = await stubServer({
    "/v1/capture": [[503, UNSAVED]],
    "/v1/nodes": [[207, { results: [{ ok: true, id: "task-b", status: "created" }, { ok: false, id: "task-c", code: "invalid_node", message: "bad edge" }] }]],
  });
  try {
    const r = await runAsync(CLI, ["add", "a capture whose second half could not be saved"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 1);
    const files = listJson(outbox);
    assert.strictEqual(files.length, 1, r.stderr);
    assert.match(files[0], /\.deferred\.json$/);
    assert.ok(!files[0].endsWith(".capture.json"), "never a capture spool");
    assert.deepStrictEqual(readJson(path.join(outbox, files[0])), { nodes: [draft("task-c")], if_exists: "skip" });
    assert.match(r.stderr, /task-c: .*bad edge/);
    assert.match(r.stderr, /spor drain/);
  } finally {
    srv.close();
  }
});

test("add (remote): a 200 marked partial names what landed, what did not, and the pending id", async () => {
  const { home } = freshHome();
  const { srv, base } = await stubServer({ "/v1/capture": [[200, PARTIAL_200]] });
  try {
    const r = await runAsync(CLI, ["add", "a capture that landed only in part today"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /captured: task-a, cap-2026-10-10-1/);
    assert.match(r.stderr, /warning: partial capture: task-a landed; task-b not written — the text is preserved as cap-2026-10-10-1/);
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// the outbox drain

const CAPTURE = { text: "a spooled capture", context: { project: "demo" }, idempotency_key: "k-1" };

test("drain: a partial_unsaved capture is settled — drafts re-submitted, the capture file gone, never re-POSTed", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "s1-abc.capture.json"), JSON.stringify(CAPTURE));
  const { srv, hits, base } = await stubServer({
    "/v1/capture": [[503, UNSAVED]],
    "/v1/nodes": [[200, { results: [{ ok: true, status: "created" }, { ok: true, status: "created" }] }]],
  });
  try {
    await drain(home, base);
    await drain(home, base); // a second pass finds nothing to send
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 1);
    const puts = hits.filter((h) => h.url === "/v1/nodes");
    assert.strictEqual(puts.length, 1);
    assert.deepStrictEqual(JSON.parse(puts[0].body), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
    assert.deepStrictEqual(listJson(outbox), []);
    assert.deepStrictEqual(listJson(path.join(outbox, "dead")), []);
    assert.match(remoteLog(home), /settled s1-abc\.capture\.json \(http=503, partial_unsaved\)/);
  } finally {
    srv.close();
  }
});

test("drain: drafts whose re-submit fails transiently are spooled as a nodes batch that the next drain ships", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "s1-abc.capture.json"), JSON.stringify(CAPTURE));
  const { srv, hits, base } = await stubServer({
    "/v1/capture": [[503, UNSAVED]],
    "/v1/nodes": [[500, { error: { code: "internal" } }], [200, { results: [{ ok: true }, { ok: true }] }]],
  });
  try {
    await drain(home, base);
    assert.deepStrictEqual(listJson(outbox), ["s1-abc.deferred.json"]);
    assert.deepStrictEqual(readJson(path.join(outbox, "s1-abc.deferred.json")), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
    await drain(home, base);
    assert.deepStrictEqual(listJson(outbox), []);
    assert.strictEqual(hits.filter((h) => h.url === "/v1/capture").length, 1, "the capture itself is never re-sent");
    assert.strictEqual(hits.filter((h) => h.url === "/v1/nodes").length, 2);
  } finally {
    srv.close();
  }
});

test("drain: a /v1/nodes 207 keeps only its busy entries spooled and dead-letters the refused ones", async () => {
  const { home, outbox } = freshHome();
  const body = { nodes: ["n1", "n2", "n3"], if_exists: "skip" };
  fs.writeFileSync(path.join(outbox, "batch.json"), JSON.stringify(body));
  const { srv, base } = await stubServer({
    "/v1/nodes": [[207, { results: [{ ok: true }, { ok: false, code: "busy", retryable: true }, { ok: false, code: "invalid_node" }] }]],
  });
  try {
    await drain(home, base);
    assert.deepStrictEqual(readJson(path.join(outbox, "batch.json")), { nodes: ["n2"], if_exists: "skip" });
    assert.deepStrictEqual(readJson(path.join(outbox, "dead", "batch.json")), { nodes: ["n3"], if_exists: "skip" });
  } finally {
    srv.close();
  }
});

test("drain: a busy marked retryable:false is dead-lettered — unless it is a keyed capture", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "nodes.json"), JSON.stringify({ nodes: ["n1"] }));
  fs.writeFileSync(path.join(outbox, "keyed.capture.json"), JSON.stringify(CAPTURE));
  fs.writeFileSync(path.join(outbox, "bare.capture.json"), JSON.stringify({ text: "no key", context: { project: "demo" } }));
  const BUSY = { error: { code: "busy", message: "busy", retryable: false, retry_after: 1 } };
  const { srv, hits, base } = await stubServer({ "/v1/nodes": [[503, BUSY]], "/v1/capture": [[503, BUSY]] });
  try {
    await drain(home, base);
    assert.deepStrictEqual(listJson(path.join(outbox, "dead")), ["bare.capture.json", "nodes.json"]);
    assert.deepStrictEqual(listJson(outbox), ["keyed.capture.json"]);
    assert.strictEqual(hits.length, 3, "each file POSTed once, never busy-retried");
  } finally {
    srv.close();
  }
});

test("drain: a 207 whose refused entries cannot be dead-lettered leaves the file whole", async () => {
  const { home, outbox } = freshHome();
  const body = { nodes: ["n1", "n2", "n3"], if_exists: "skip" };
  fs.writeFileSync(path.join(outbox, "batch.json"), JSON.stringify(body));
  fs.writeFileSync(path.join(outbox, "dead"), "not a directory"); // dead-letter writes fail
  const { srv, base } = await stubServer({
    "/v1/nodes": [[207, { results: [{ ok: true }, { ok: false, code: "busy", retryable: true }, { ok: false, code: "invalid_node" }] }]],
  });
  try {
    await drain(home, base);
    assert.deepStrictEqual(readJson(path.join(outbox, "batch.json")), body, "no refused entry is dropped");
  } finally {
    srv.close();
  }
});

test("drain: a later refusal of a re-spooled remainder never overwrites the earlier dead-letter", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "batch.json"), JSON.stringify({ nodes: ["n1", "n2"], if_exists: "skip" }));
  const { srv, base } = await stubServer({
    "/v1/nodes": [
      [207, { results: [{ ok: false, code: "busy", retryable: true }, { ok: false, code: "invalid_node" }] }],
      [207, { results: [{ ok: false, code: "invalid_node" }] }],
    ],
  });
  try {
    await drain(home, base);
    await drain(home, base);
    const dead = listJson(path.join(outbox, "dead"));
    assert.strictEqual(dead.length, 2, JSON.stringify(dead));
    const all = dead.flatMap((f) => readJson(path.join(outbox, "dead", f)).nodes).sort();
    assert.deepStrictEqual(all, ["n1", "n2"]);
    assert.deepStrictEqual(listJson(outbox), []);
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// issue-spor-drain-outbox-deadletter-and-split

const BUSY_FINAL = { error: { code: "busy", message: "busy", retryable: false, retry_after: 1 } };

test("drain: a permanent reject never overwrites an earlier same-named dead-letter, and keeps its spool suffix", async () => {
  const { home, outbox } = freshHome();
  fs.mkdirSync(path.join(outbox, "dead"));
  fs.writeFileSync(path.join(outbox, "dead", "s1.capture.json"), JSON.stringify({ text: "the first" }));
  fs.writeFileSync(path.join(outbox, "s1.capture.json"), JSON.stringify({ text: "the second" }));
  const { srv, base } = await stubServer({ "/v1/capture": [[422, { error: { code: "invalid" } }]] });
  try {
    await drain(home, base);
    const dead = listJson(path.join(outbox, "dead"));
    assert.strictEqual(dead.length, 2, JSON.stringify(dead));
    assert.ok(dead.every((f) => f.endsWith(".capture.json")), "a replay moved back still routes to /v1/capture");
    assert.deepStrictEqual(dead.map((f) => readJson(path.join(outbox, "dead", f)).text).sort(), ["the first", "the second"]);
    assert.deepStrictEqual(listJson(outbox), []);
  } finally {
    srv.close();
  }
});

test("drain: a permanent reject whose dead-letter cannot be written stays spooled, never discarded", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "dead"), "not a directory");
  fs.writeFileSync(path.join(outbox, "s1.capture.json"), JSON.stringify(CAPTURE));
  const { srv, base } = await stubServer({ "/v1/capture": [[422, { error: { code: "invalid" } }]] });
  try {
    await drain(home, base);
    assert.deepStrictEqual(listJson(outbox), ["s1.capture.json"]);
    assert.match(remoteLog(home), /dead-letter write failed; left spooled/);
  } finally {
    srv.close();
  }
});

for (const [label, answer] of [
  ["no results", { ok: true }],
  ["a results list that is not one per entry", { results: [{ ok: true }] }],
]) {
  test(`drain: a /v1/nodes 2xx with ${label} keeps the whole batch spooled — never read as landed`, async () => {
    const { home, outbox } = freshHome();
    const body = { nodes: ["n1", "n2"], if_exists: "skip" };
    fs.writeFileSync(path.join(outbox, "batch.json"), JSON.stringify(body));
    const { srv, base } = await stubServer({ "/v1/nodes": [[200, answer]] });
    try {
      await drain(home, base);
      assert.deepStrictEqual(readJson(path.join(outbox, "batch.json")), body);
      assert.deepStrictEqual(listJson(path.join(outbox, "dead")), []);
      assert.match(remoteLog(home), /kept batch\.json spooled: http=200 carried no per-entry results/);
    } finally {
      srv.close();
    }
  });
}

test("drain: a deferred-draft re-submit answered busy retryable:false dead-letters the drafts and settles the capture", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "s1-abc.capture.json"), JSON.stringify(CAPTURE));
  const { srv, hits, base } = await stubServer({ "/v1/capture": [[503, UNSAVED]], "/v1/nodes": [[503, BUSY_FINAL]] });
  try {
    await drain(home, base);
    await drain(home, base);
    assert.deepStrictEqual(listJson(outbox), [], "nothing left for a drain to re-send");
    assert.deepStrictEqual(listJson(path.join(outbox, "dead")), ["s1-abc.deferred.json"]);
    assert.deepStrictEqual(readJson(path.join(outbox, "dead", "s1-abc.deferred.json")), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
    assert.strictEqual(hits.filter((h) => h.url === "/v1/nodes").length, 1, "the non-replayable re-submit is never re-sent");
  } finally {
    srv.close();
  }
});

test("drain: a deferred-draft re-submit answered 2xx without per-entry results is spooled, not counted landed", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "s1-abc.capture.json"), JSON.stringify(CAPTURE));
  const { srv, base } = await stubServer({ "/v1/capture": [[503, UNSAVED]], "/v1/nodes": [[200, { ok: true }]] });
  try {
    await drain(home, base);
    assert.deepStrictEqual(listJson(outbox), ["s1-abc.deferred.json"]);
    assert.deepStrictEqual(readJson(path.join(outbox, "s1-abc.deferred.json")), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
    assert.match(remoteLog(home), /without per-entry results; spooled to outbox\/s1-abc\.deferred\.json/);
  } finally {
    srv.close();
  }
});

test("add (remote): a deferred-draft re-submit answered busy retryable:false is dead-lettered, not spooled for the drain", async () => {
  const { home, outbox } = freshHome();
  const { srv, hits, base } = await stubServer({ "/v1/capture": [[503, UNSAVED]], "/v1/nodes": [[503, BUSY_FINAL]] });
  try {
    const r = await runAsync(CLI, ["add", "a capture whose second half could not be saved"], { SPOR_SERVER: base, SPOR_TOKEN: "tok", SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.deepStrictEqual(listJson(outbox), []);
    const dead = listJson(path.join(outbox, "dead"));
    assert.strictEqual(dead.length, 1, r.stderr);
    assert.match(dead[0], /\.deferred\.json$/);
    assert.deepStrictEqual(readJson(path.join(outbox, "dead", dead[0])), { nodes: [draft("task-b"), draft("task-c")], if_exists: "skip" });
    assert.match(r.stderr, /non-replayable/);
    assert.strictEqual(hits.filter((h) => h.url === "/v1/nodes").length, 1);
  } finally {
    srv.close();
  }
});

// The drain's tally is the `spor drain` verb's report: one file per settle
// outcome, counted in-process over the engine's return value.
test("drain: the returned tally counts each settled outcome once", async () => {
  const { home, outbox } = freshHome();
  fs.writeFileSync(path.join(outbox, "a-ok.capture.json"), JSON.stringify({ text: "ok", context: {} }));
  fs.writeFileSync(path.join(outbox, "b-rejected.capture.json"), JSON.stringify({ text: "rejected", context: {} }));
  fs.writeFileSync(path.join(outbox, "c-split.json"), JSON.stringify({ nodes: ["n1", "n2", "n3"], if_exists: "skip" }));
  fs.writeFileSync(path.join(outbox, "d-refused.json"), JSON.stringify({ nodes: ["r1"], if_exists: "skip" }));
  fs.writeFileSync(path.join(outbox, "e-down.json"), JSON.stringify({ nodes: ["x1"], if_exists: "skip" }));
  const routes = {
    "a-ok": [200, { status: "captured", ids: ["task-x"] }],
    "b-rejected": [422, { error: { code: "invalid" } }],
    "c-split": [207, { results: [{ ok: true }, { ok: false, code: "busy", retryable: true }, { ok: false, code: "invalid_node" }] }],
    "d-refused": [207, { results: [{ ok: false, code: "invalid_node" }] }],
    "e-down": [500, { error: { code: "internal" } }],
  };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body);
      const key = sent.text ? (sent.text === "ok" ? "a-ok" : "b-rejected") : { n1: "c-split", r1: "d-refused", x1: "e-down" }[sent.nodes[0]];
      const [status, json] = routes[key];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  Object.assign(process.env, { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: `http://127.0.0.1:${srv.address().port}`, SPOR_TOKEN: "tok", SPOR_MODE: "remote" });
  try {
    const { drainOutbox } = require(DRAIN);
    const s = await drainOutbox(home, { tag: "test", maxTimeSec: 5, retryOverride: 0 });
    assert.deepStrictEqual(s, { attempted: 5, drained: 1, deadLettered: 2, failed: 2 });
    assert.deepStrictEqual(listJson(outbox), ["c-split.json", "e-down.json"]);
    assert.deepStrictEqual(listJson(path.join(outbox, "dead")).sort(), ["b-rejected.capture.json", "c-split.json", "d-refused.json"]);
  } finally {
    srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
