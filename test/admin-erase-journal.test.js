// admin-erase-journal.test.js — `spor admin erase-journal` is the shell front-door
// for POST /v1/admin/journal/erase (task-split-spor-3771554c884d). Remote only.
"use strict";
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-erasej-iso-"));
function run(args, env) {
  return new Promise((resolve) => {
    let o = "", e = "";
    const c = spawn(process.execPath, [CLI, ...args], {
      env: hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, ...env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => resolve({ status: code, stdout: o, stderr: e }));
  });
}
function stub(status, body) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remote = (base) => ({ SPOR_SERVER: base, SPOR_TOKEN: "test-token" });
const OK = { ok: true, name: "server.log", segments: 2, scanned: 100, matched: 3, erased: 3, rechained: 40, dryRun: false, verify: { ok: true, lines: 97, last_seq: 97, error: null } };

test("erase-journal posts the mapped body and prints the receipt", async () => {
  const { srv, hits, base } = await stub(200, OK);
  try {
    const r = await run(["admin", "erase-journal", "--journal", "server.log", "--id", "person-x", "--also", "a@b.com", "--also", "c@d.com", "--ticket", "T-1", "--reason", "gdpr", "--allow-broken-chain"], remote(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /server\.log: scanned 100 lines in 2 segment\(s\), matched 3, erased 3, rechained 40/);
    assert.match(r.stdout, /verify: ok/);
    assert.strictEqual(hits[0].method, "POST");
    assert.strictEqual(hits[0].url, "/v1/admin/journal/erase");
    assert.strictEqual(hits[0].auth, "Bearer test-token");
    assert.deepStrictEqual(JSON.parse(hits[0].body), { journal: "server.log", id: "person-x", also: ["a@b.com", "c@d.com"], ticket: "T-1", reason: "gdpr", allow_broken_chain: true });
  } finally { srv.close(); }
});

test("erase-journal --dry-run sends dry_run and a null verify is fine", async () => {
  const { srv, hits, base } = await stub(200, { ...OK, dryRun: true, erased: 0, verify: null });
  try {
    const r = await run(["admin", "erase-journal", "--journal", "mcp-wire.log", "--text", "needle", "--dry-run"], remote(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^dry run: /);
    assert.deepStrictEqual(JSON.parse(hits[0].body), { journal: "mcp-wire.log", text: "needle", dry_run: true });
  } finally { srv.close(); }
});

test("erase-journal exits 1 on a failed verify", async () => {
  const { srv, base } = await stub(200, { ...OK, verify: { ok: false, lines: 5, last_seq: 4, error: "chain break" } });
  try {
    const r = await run(["admin", "erase-journal", "--journal", "server.log", "--id", "x"], remote(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /verify: FAILED — chain break/);
  } finally { srv.close(); }
});

test("erase-journal surfaces 409 and 500 and 403", async () => {
  for (const [status, code, re] of [[409, "conflict", /409 conflict.*pending/], [500, "internal", /pending 'erase-journal --recover'/]]) {
    const { srv, base } = await stub(status, { error: { code, message: "staged erasure pending" } });
    try {
      const r = await run(["admin", "erase-journal", "--journal", "server.log", "--id", "x"], remote(base));
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, re);
    } finally { srv.close(); }
  }
  const { srv, base } = await stub(403, { error: { code: "forbidden", message: "no" } });
  try {
    const r = await run(["admin", "erase-journal", "--journal", "server.log", "--id", "x"], remote(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /admin privilege required/);
  } finally { srv.close(); }
});

test("erase-journal validates args and refuses local mode before any request", async () => {
  const { srv, hits, base } = await stub(200, OK);
  try {
    for (const a of [["--journal", "server.log"], ["--journal", "server.log", "--id", "x", "--text", "y"], ["--id", "x"], ["--journal", "server.log", "--text", "y", "--also", "zzzz"]]) {
      const r = await run(["admin", "erase-journal", ...a], remote(base));
      assert.strictEqual(r.status, 1, a.join(" "));
    }
    assert.strictEqual(hits.length, 0);
  } finally { srv.close(); }
  const r = await run(["admin", "erase-journal", "--journal", "server.log", "--id", "x"], { SPOR_MODE: "local" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote mode/);
});
