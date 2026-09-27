// admin-gardener.test.js — `spor admin gardener` is the shell front-door for an
// on-demand gardener sweep (task-spor-admin-gardener-cli-verb), wrapping
// POST /v1/gardener. The server-side sweep files its findings as queue items
// (dec-cc-gardener-files-findings) and resolves its own cleared findings; the
// response is { checked, filed: [...ids], resolved: [...ids], skipped: [...ids],
// generated_at }. The verb lives under the `spor admin` parent (the ops-facing,
// admin-gated surface) and is REMOTE-only — the gardener runs on the server.
//
// Oracle = the request the verb makes + the bytes it renders from a scripted
// response + the fail-soft exits — never a live server (responses are scripted).
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { hermeticEnv } = require("./helpers/env.js");
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
// history.test.js / export.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-admingardener-iso-"));
function bare(extra = {}) {
  return hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, ...extra });
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

// Records every request; serves a scriptable POST /v1/gardener so the method,
// path, and bearer passthrough are all observable. `retryAfter`/`errorBody`
// let the 429 (cooldown, task-spor-server-gardener-on-demand-cooldown) and 409
// (in-flight) refusals be scripted with the server's real shape: a
// Retry-After header (seconds) plus a `{error:{code,message}}` body.
function gardenerStub({ body = null, status = 200, retryAfter = null, errorBody = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      const j = (code, b, extraHeaders) => {
        res.writeHead(code, { "content-type": "application/json", ...(extraHeaders || {}) });
        res.end(JSON.stringify(b));
      };
      if (req.method === "POST" && req.url === "/v1/gardener") {
        if (status === 403) return j(403, { error: { code: "forbidden", message: "admin privilege required: a stewards edge to the graph root" } });
        if (status === 429) {
          return j(
            429,
            errorBody || { error: { code: "rate_limited", message: `on-demand gardener sweep cooldown in effect; retry after ${retryAfter}s` } },
            retryAfter != null ? { "retry-after": String(retryAfter) } : {}
          );
        }
        if (status === 409) {
          return j(409, errorBody || { error: { code: "conflict", message: "a gardener sweep is already in flight" } });
        }
        if (status !== 200) return j(status, { error: { code: "server_error", message: "boom" } });
        return j(200, body);
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) =>
  bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

const SWEEP_BODY = {
  checked: 145,
  filed: ["find-stale-anchors-task-x", "find-cold-work-task-y"],
  resolved: ["find-cold-work-task-z"],
  skipped: ["find-stale-anchors-task-w"],
  generated_at: "2026-06-21T12:00:00+00:00",
};

// --- remote mode ------------------------------------------------------------

test("admin gardener (remote) POSTs /v1/gardener and renders the sweep summary", async () => {
  const { srv, hits, base } = await gardenerStub({ body: SWEEP_BODY });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /gardener swept 145 nodes: 2 filed, 1 resolved, 1 unchanged/);
    assert.match(r.stdout, /filed     find-stale-anchors-task-x/);
    assert.match(r.stdout, /filed     find-cold-work-task-y/);
    assert.match(r.stdout, /resolved  find-cold-work-task-z/);
    const hit = hits.find((h) => h.method === "POST" && h.url === "/v1/gardener");
    assert.ok(hit, "POST /v1/gardener");
    assert.strictEqual(hit.auth, "Bearer test-token", "bearer forwarded");
    assert.strictEqual(hit.body, "{}", "empty-object body (no args ride the request)");
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) --json passes the envelope through verbatim", async () => {
  const { srv, base } = await gardenerStub({ body: SWEEP_BODY });
  try {
    const r = await runAsync(["admin", "gardener", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), SWEEP_BODY);
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a quiet sweep says so, no id lines", async () => {
  const quiet = { checked: 1, filed: [], resolved: [], skipped: [] };
  const { srv, base } = await gardenerStub({ body: quiet });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /gardener swept 1 node: 0 filed, 0 resolved, 0 unchanged/);
    assert.match(r.stdout, /no new findings filed or resolved this sweep/);
    assert.doesNotMatch(r.stdout, /^\s+filed /m);
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) surfaces a REJECTED finding on stderr but still exits 0", async () => {
  const body = { checked: 3, filed: [], resolved: [], skipped: ["find-cold-work-task-q (REJECTED: bad edge)"] };
  const { srv, base } = await gardenerStub({ body });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /REJECTED \(gardener bug\): find-cold-work-task-q \(REJECTED: bad edge\)/);
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a 403 explains the admin gate, exit 1", async () => {
  const { srv, base } = await gardenerStub({ status: 403 });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /forbidden — admin privilege required/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a non-200 surfaces the server's message, exit 1", async () => {
  const { srv, base } = await gardenerStub({ status: 500 });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gardener sweep failed \(500\): boom/);
  } finally {
    srv.close();
  }
});

// 429: the on-demand sweep cooldown (task-spor-server-gardener-on-demand-cooldown,
// this task's server-side sibling). The CLI must print the retry time it reads
// off Retry-After, plus the server's reason, instead of a bare "failed (429)".
test("admin gardener (remote) a 429 prints the cooldown retry time from Retry-After, exit 1, no bare HTTP error", async () => {
  const { srv, base } = await gardenerStub({ status: 429, retryAfter: 120 });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gardener sweep refused: cooldown — retry in 120s \(at .+\)/);
    assert.match(r.stderr, /on-demand gardener sweep cooldown in effect; retry after 120s/);
    assert.doesNotMatch(r.stderr, /gardener sweep failed \(429\)/, "not the bare HTTP-error fallback");
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a 429 with no Retry-After header still refuses clearly, exit 1", async () => {
  const { srv, base } = await gardenerStub({
    status: 429,
    errorBody: { error: { code: "rate_limited", message: "cooldown in effect, try later" } },
  });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gardener sweep refused: cooldown in effect/);
    assert.match(r.stderr, /cooldown in effect, try later/);
  } finally {
    srv.close();
  }
});

// 409: the pre-existing in-flight guard (a caller that only JOINS an in-flight
// sweep still gets the unchanged 200 join — this is the genuinely-conflicting case).
test("admin gardener (remote) a 409 says a sweep is already in flight, exit 1, no bare HTTP error", async () => {
  const { srv, base } = await gardenerStub({ status: 409 });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gardener sweep refused: a gardener sweep is already in flight/);
    assert.doesNotMatch(r.stderr, /gardener sweep failed \(409\)/, "not the bare HTTP-error fallback");
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a 409 with a server message surfaces it verbatim, exit 1", async () => {
  const { srv, base } = await gardenerStub({
    status: 409,
    errorBody: { error: { code: "conflict", message: "sweep xyz already running" } },
  });
  try {
    const r = await runAsync(["admin", "gardener"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gardener sweep refused: sweep xyz already running/);
  } finally {
    srv.close();
  }
});

test("admin gardener (remote) a dead server fails soft with an offline line, no stack", async () => {
  const r = await runAsync(["admin", "gardener"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- local mode + usage -----------------------------------------------------

test("admin gardener (local) redirects to remote mode, no request, exit 1", async () => {
  const r = await runAsync(["admin", "gardener"], bare({ SPOR_HOME: ISO_HOME }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /admin gardener needs a team graph \(remote mode\)/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("admin with no sub-command prints usage, exit 1", async () => {
  const r = await runAsync(["admin"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor admin gardener \[--json\]/);
});

test("admin with an unknown sub-command names it and prints usage, exit 1", async () => {
  const r = await runAsync(["admin", "bogus"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown sub-command 'bogus'/);
  assert.match(r.stderr, /usage: spor admin gardener/);
});

test("admin --help prints the command page without dispatching", async () => {
  const r = await runAsync(["admin", "--help"], bare({ SPOR_HOME: ISO_HOME }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /spor admin gardener/);
  assert.match(r.stdout, /run a gardener sweep now/);
  assert.match(r.stdout, /spor admin token/); // the team-token admin surface
});
