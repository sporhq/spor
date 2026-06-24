// share.test.js — `spor share <lens-id> [--expires <Nd>]` is the shell front-door
// for minting a shareable read-only render ticket (task-spor-share-lens-cli-verb),
// wrapping POST /v1/lens/{id}/ticket. The server mints a signed, expiring,
// read-only ticket recording the caller as the sharer
// (dec-cc-lens-share-render-tickets) and returns { ticket, url, lens_id,
// sharer_person_id, exp }. The verb is REMOTE-only — tickets are signed
// server-side — so local mode degrades with one clear line and no crash.
//
// Oracle = the request the verb makes (method/path/bearer/body) + the bytes it
// renders from a scripted response + the fail-soft exits — never a live server.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip the
// mode or leak a token), config homes isolated to a temp dir. Mirrors
// admin-gardener.test.js / history.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-share-iso-"));
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
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// Records every request; serves a scriptable POST /v1/lens/{id}/ticket so the
// method, path, bearer, and body are all observable.
function ticketStub({ body = null, status = 200, errBody = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const m = req.method === "POST" && /^\/v1\/lens\/[^/]+\/ticket$/.test(req.url);
      if (m) {
        if (status === 200) return j(200, body);
        if (errBody) return j(status, errBody);
        if (status === 404) return j(404, { error: { code: "not_found", message: "no such lens" } });
        if (status === 422) return j(422, { error: { code: "no_person", message: "token is not bound to a person node" } });
        return j(status, { error: { code: "server_error", message: "boom" } });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) =>
  bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

const TICKET_BODY = {
  ticket: "eyJhbGciOiJFZERTQSJ9.eyJsZW5zIjoibGVucy1yb2FkbWFwIn0.sig",
  url: "https://api.sporhq.io/v1/lens/lens-roadmap/render?ticket=eyJhbGciOiJFZERTQSJ9.eyJsZW5zIjoibGVucy1yb2FkbWFwIn0.sig",
  lens_id: "lens-roadmap",
  sharer_person_id: "person-anthony",
  exp: "2026-06-28T00:00:00+00:00",
};

// --- remote mode ------------------------------------------------------------

test("share (remote) POSTs /v1/lens/{id}/ticket and renders the link", async () => {
  const { srv, hits, base } = await ticketStub({ body: TICKET_BODY });
  try {
    const r = await runAsync(["share", "lens-roadmap"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Shareable read-only link \(expires 2026-06-28T00:00:00\+00:00\):/);
    assert.match(r.stdout, /render\?ticket=eyJhbGciOiJFZERTQSJ9/);
    assert.match(r.stdout, /Recipients view lens-roadmap as person-anthony — read-only, no sign-in, no write access\./);
    const hit = hits.find((h) => h.method === "POST");
    assert.ok(hit, "POST issued");
    assert.strictEqual(hit.url, "/v1/lens/lens-roadmap/ticket", "lens id in the path");
    assert.strictEqual(hit.auth, "Bearer test-token", "bearer forwarded");
    assert.strictEqual(hit.body, "{}", "no --expires => empty body (server default window)");
  } finally {
    srv.close();
  }
});

test("share (remote) --expires rides the body verbatim (server validates)", async () => {
  const { srv, hits, base } = await ticketStub({ body: TICKET_BODY });
  try {
    const r = await runAsync(["share", "lens-roadmap", "--expires", "14d"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.method === "POST");
    assert.deepStrictEqual(JSON.parse(hit.body), { expires: "14d" });
  } finally {
    srv.close();
  }
});

test("share (remote) --json passes the envelope through verbatim", async () => {
  const { srv, base } = await ticketStub({ body: TICKET_BODY });
  try {
    const r = await runAsync(["share", "lens-roadmap", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), TICKET_BODY);
  } finally {
    srv.close();
  }
});

test("share (remote) url-encodes the lens id in the path", async () => {
  const { srv, hits, base } = await ticketStub({ body: TICKET_BODY });
  try {
    const r = await runAsync(["share", "workspace q3"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.method === "POST");
    assert.strictEqual(hit.url, "/v1/lens/workspace%20q3/ticket");
  } finally {
    srv.close();
  }
});

test("share (remote) a 404 names the missing lens, exit 1", async () => {
  const { srv, base } = await ticketStub({ status: 404 });
  try {
    const r = await runAsync(["share", "lens-bogus"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no lens or workspace 'lens-bogus'/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

test("share (remote) a 422 no_person surfaces the why plus a person-binding hint, exit 1", async () => {
  const { srv, base } = await ticketStub({ status: 422 });
  try {
    const r = await runAsync(["share", "lens-roadmap"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /share error 422 \(no_person\): token is not bound to a person node/);
    assert.match(r.stderr, /your token must be bound to a person node/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

test("share (remote) a non-no_person 422 (bad expires) surfaces the why WITHOUT the person hint", async () => {
  const errBody = { error: { code: "invalid_expires", message: "expires exceeds the 30d maximum" } };
  const { srv, base } = await ticketStub({ status: 422, errBody });
  try {
    const r = await runAsync(["share", "lens-roadmap", "--expires", "90d"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /share error 422 \(invalid_expires\): expires exceeds the 30d maximum/);
    assert.doesNotMatch(r.stderr, /must be bound to a person node/);
  } finally {
    srv.close();
  }
});

test("share (remote) a non-200 surfaces the server's message, exit 1", async () => {
  const { srv, base } = await ticketStub({ status: 500 });
  try {
    const r = await runAsync(["share", "lens-roadmap"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /share error 500.*boom/);
  } finally {
    srv.close();
  }
});

test("share (remote) a dead server fails soft with an offline line, no stack", async () => {
  const r = await runAsync(["share", "lens-roadmap"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- local mode + usage -----------------------------------------------------

test("share (local) redirects to remote mode, no request, exit 0", async () => {
  const r = await runAsync(["share", "lens-roadmap"], bare({ SPOR_HOME: ISO_HOME }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /sharing needs a team graph/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("share with no lens id prints usage, exit 1", async () => {
  const r = await runAsync(["share"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor share <lens-id> \[--expires <Nd>\]/);
});

test("share --help prints the command page without dispatching", async () => {
  const r = await runAsync(["share", "--help"], bare({ SPOR_HOME: ISO_HOME }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /spor share/);
  assert.match(r.stdout, /read-only render ticket/);
});
