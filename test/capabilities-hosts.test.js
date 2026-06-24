// capabilities-hosts.test.js — `spor capabilities hosts <profile-id>` is the
// explicit CONSUMER of the remote fleet scheduler's host-match
// (GET /v1/profiles/{id}/hosts, task-spor-fleet-scheduler-autoroute-dispatch).
// It lists the boxes that satisfy a profile (re-route targets) and those that
// can't WITH the matcher's reasons, enabling substitution-free re-routing
// (dec-spor-machine-profile-satisfiability FORK B — never a substitute).
//
// Oracle = the request the CLI makes (path + query string) + its rendered
// verdict + fail-soft exits, never the server's framing (we script the responses).

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Strip ambient SPOR_*/SUBSTRATE_* so a configured dev box can't flip a test to
// remote or leak a token (mirrors capabilities-publish.test.js / dispatch.test.js).
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  env.SPOR_DISTILLING = "1";
  return Object.assign(env, extra);
}
function runAsync(args, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-caps-hosts-"));
}

// Records every request; GET /v1/profiles/{id}/hosts returns a scriptable match.
function hostsStub({ status = 200, body } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const m = req.url.match(/^\/v1\/profiles\/([^/?]+)\/hosts/);
    if (m && req.method === "GET") {
      if (status !== 200) {
        const codeFor = { 403: "forbidden", 404: "not_found" };
        const msgFor = { 403: "host visibility is steward-scoped" };
        return j(status, { error: { code: codeFor[status] || "bad_request", message: msgFor[status] || "x" } });
      }
      return j(200, body || { profile: decodeURIComponent(m[1]), satisfiable: [], unsatisfiable: [], counts: {} });
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (home, base, extra = {}) =>
  baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("hosts (local mode): refuses remote-only with a clear line", async () => {
  const r = await runAsync(["capabilities", "hosts", "profile-x"], baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote-only/);
});

test("hosts (remote, no profile id): usage error", async () => {
  const { srv, base } = await hostsStub();
  try {
    const r = await runAsync(["capabilities", "hosts"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: spor capabilities hosts/);
  } finally {
    srv.close();
  }
});

test("hosts (remote): lists satisfiable re-route targets + unsatisfiable with reasons", async () => {
  const { srv, hits, base } = await hostsStub({
    body: {
      profile: "profile-codex",
      satisfiable: [
        { agent: "agent-bob-laptop", owner: "person-bob", age_seconds: 90 },
        { agent: "agent-carol-ci", owner: "person-carol", age_seconds: 7200 },
      ],
      unsatisfiable: [{ agent: "agent-mine", owner: "person-me", age_seconds: 3, reasons: ["harness 'codex' not available here (codex not on PATH)"] }],
      counts: { satisfiable: 2, unsatisfiable: 1 },
    },
  });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-codex"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /profile profile-codex — 2 satisfiable \/ 1 not/);
    assert.match(r.stdout, /✓ agent-bob-laptop \(person-bob, 2m ago\)/);
    assert.match(r.stdout, /✓ agent-carol-ci \(person-carol, 2h ago\)/);
    assert.match(r.stdout, /✗ agent-mine/);
    assert.match(r.stdout, /harness 'codex' not available here/);
    const hit = hits.find((h) => h.method === "GET" && /^\/v1\/profiles\/profile-codex\/hosts/.test(h.url));
    assert.ok(hit, "GET /v1/profiles/profile-codex/hosts");
  } finally {
    srv.close();
  }
});

test("hosts (remote, none satisfiable): says escalate to the owner", async () => {
  const { srv, base } = await hostsStub({
    body: { profile: "profile-codex", satisfiable: [], unsatisfiable: [{ agent: "agent-a", owner: "person-x", age_seconds: 5, reasons: ["x"] }], counts: { satisfiable: 0, unsatisfiable: 1 } },
  });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-codex"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /satisfiable: \(none — escalate to the owner/);
  } finally {
    srv.close();
  }
});

test("hosts (remote): --owner and --max-age ride the query string", async () => {
  const { srv, hits, base } = await hostsStub({ body: { profile: "profile-x", satisfiable: [], unsatisfiable: [], counts: {} } });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-x", "--owner", "me", "--max-age", "30m"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => /^\/v1\/profiles\/profile-x\/hosts/.test(h.url));
    assert.ok(hit, "called /hosts");
    assert.match(hit.url, /owner=me/);
    assert.match(hit.url, /max_age=30m/);
  } finally {
    srv.close();
  }
});

test("hosts (remote): --json emits the parsed match", async () => {
  const body = { profile: "profile-codex", satisfiable: [{ agent: "agent-bob", owner: "person-bob", age_seconds: 1 }], unsatisfiable: [], counts: { satisfiable: 1, unsatisfiable: 0 } };
  const { srv, base } = await hostsStub({ body });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-codex", "--json"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.profile, "profile-codex");
    assert.strictEqual(j.satisfiable[0].agent, "agent-bob");
  } finally {
    srv.close();
  }
});

test("hosts (remote): a 404 (unknown profile / no surface) fails soft", async () => {
  const { srv, base } = await hostsStub({ status: 404 });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-nope"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such profile 'profile-nope'/);
  } finally {
    srv.close();
  }
});

test("hosts (remote): a 403 (steward-scoped) reports an authorization denial, not an outage", async () => {
  // A member asking for a colleague's boxes is 403 (host visibility is steward-scoped,
  // API.md §3). It must NOT be misreported as a transport outage
  // (issue-spor-capabilities-hosts-403-misreported).
  const { srv, base } = await hostsStub({ status: 403 });
  try {
    const r = await runAsync(["capabilities", "hosts", "profile-x", "--owner", "person-bob"], remoteEnv(freshHome(), base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not authorized to view person-bob's boxes/);
    assert.match(r.stderr, /steward-scoped/);
    assert.match(r.stderr, /--owner me/);
    assert.doesNotMatch(r.stderr, /could not reach the fleet scheduler/);
  } finally {
    srv.close();
  }
});

test("hosts (remote): a dead server fails soft with a transport line", async () => {
  const r = await runAsync(["capabilities", "hosts", "profile-x"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not reach the fleet scheduler/);
});
