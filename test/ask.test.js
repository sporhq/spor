// ask.test.js — `spor ask "<question>" [--title ...] [--mention ID]... [--project S]`
// (task-cc-ask-question-skill): the CLI surface for /spor:ask, so the client can
// file a question the graph can't answer instead of letting it evaporate at the
// digest gate. Mirrors add/correct's mode-aware shape — remote POSTs /v1/questions
// (ask_question's REST twin), local writes an open, queueable question node file.
//
// Oracle = the REQUEST BODY the CLI POSTs in remote mode (never the server's
// framing — we script the response) + the on-disk node in local mode.
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
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ask-iso-"));
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
// Sync runner for local mode (no in-process server to talk to).
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

// A scratch local graph home (git-initialized), seeded with one node a question
// can mention. Returns { home, nodes }.
function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ask-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  spawnSync("git", ["-C", home, "config", "user.email", "alice@example.com"]);
  spawnSync("git", ["-C", home, "config", "user.name", "Alice"]);
  fs.writeFileSync(path.join(nodes, "dec-x.md"), `---
id: dec-x
type: decision
repo: demo
title: A demo decision a question can mention
summary: A demo decision used to exercise spor ask's mention edges end to end.
date: 2026-06-01
---
Body about the demo decision.
`);
  return { home, nodes };
}

// Records every request; POST /v1/questions echoes an ask_question result.
function askStub({ status = 201, routed_to = "person-steward", via = "mentions", unrouted = false, errCode = "invalid_node", message = "x", details = [] } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/questions" && req.method === "POST") {
        if (status >= 400) return j(status, { error: { code: errCode, message, details } });
        return j(status, { status: "created", id: "question-42", project: "spor", routed_to: unrouted ? null : routed_to, via: unrouted ? null : via, asker: "person-alice", revision: "abc123", warnings: [] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// ---------------- local mode ----------------

test("ask (local) writes an open, queueable question node that validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["ask", "Why does the gardener skip resident schema nodes", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /question filed: question-why-does-the-gardener-skip-resident-schema-nodes \(open\)/);
  const md = fs.readFileSync(path.join(nodes, "question-why-does-the-gardener-skip-resident-schema-nodes.md"), "utf8");
  assert.match(md, /^type: question$/m);
  assert.match(md, /^status: open$/m);
  assert.match(md, /^repo: demo$/m);
  assert.match(md, /^summary: Why does the gardener skip resident schema nodes$/m);
  // the body carries the full question prose
  assert.match(md, /Why does the gardener skip resident schema nodes/);
  // and it validates
  const v = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
  assert.match(v.stdout, /1 question/);
});

test("ask (local) --mention writes mentions edges", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["ask", "Is this still the right call", "--mention", "dec-x", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = fs.readdirSync(nodes).find((f) => f.startsWith("question-is-this-still"));
  assert.ok(file, "question node written");
  const md = fs.readFileSync(path.join(nodes, file), "utf8");
  assert.match(md, /- \{type: mentions, to: dec-x\}/);
  const v = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
  assert.match(v.stdout, /0 errors/);
});

test("ask (local) with no mention writes no edges block", () => {
  const { home, nodes } = fixtureGraph();
  run(["ask", "a plain question with no mentions", "--project", "demo"], { SPOR_HOME: home });
  const file = fs.readdirSync(nodes).find((f) => f.startsWith("question-a-plain-question"));
  const md = fs.readFileSync(path.join(nodes, file), "utf8");
  assert.doesNotMatch(md, /edges:/);
});

test("ask (local) honors --title and --id, uniquifies a colliding id", () => {
  const { home, nodes } = fixtureGraph();
  const a = run(["ask", "first", "--id", "question-dup", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(path.join(nodes, "question-dup.md")));
  const b = run(["ask", "second with a longer title here", "--title", "A custom title", "--id", "question-dup", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(fs.existsSync(path.join(nodes, "question-dup-2.md")), "id uniquified on collision");
  assert.match(fs.readFileSync(path.join(nodes, "question-dup-2.md"), "utf8"), /^title: A custom title$/m);
});

test("ask (local) truncates an over-long question into a <=500-char summary", () => {
  const { home, nodes } = fixtureGraph();
  const long = "x ".repeat(400).trim(); // ~799 chars
  const r = run(["ask", long, "--id", "question-long", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(nodes, "question-long.md"), "utf8");
  const summary = md.match(/^summary: (.*)$/m)[1];
  assert.ok(summary.length <= 500, `summary ${summary.length} <= 500`);
  assert.match(summary, /\.\.\.$/);
  // the full prose still survives in the body
  assert.match(md, /x x x/);
});

test("ask (local) with no question text exits 1 with usage", () => {
  const { home } = fixtureGraph();
  const r = run(["ask"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor ask/);
});

// issue-spor-local-add-ask-project-normalization-edge-validation: local mode
// stamped --project verbatim and wrote --mention edges without validation.

test("ask (local) normalizes a non-canonical --project to the canonical slug", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["ask", "why is the slug messy", "--project", "Weird.Slug"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(nodes, "question-why-is-the-slug-messy.md"), "utf8");
  assert.match(md, /^repo: weird-slug$/m); // not the verbatim Weird.Slug
});

test("ask (local) rejects a --mention id that would not round-trip", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["ask", "a question with a broken mention", "--mention", "dec-bad:id", "--project", "demo"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --mention id "dec-bad:id"/);
  assert.ok(!fs.readdirSync(nodes).some((f) => f.startsWith("question-a-question-with")), "no node written on a bad mention id");
});

test("ask (local) rejects a --project with no slug characters", () => {
  const { home } = fixtureGraph();
  const r = run(["ask", "a question under a garbage project", "--project", "***"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid --project "\*\*\*"/);
});

test("ask --help prints the command page (table-driven, alias listed)", () => {
  const r = run(["ask", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor ask "<question>"/m);
  assert.match(r.stdout, /question/); // 'question' alias listed
});

// ---------------- remote mode ----------------

test("ask (remote) POSTs {text} to /v1/questions and reports routing", async () => {
  const { srv, hits, base } = await askStub();
  try {
    const r = await runAsync(["ask", "Where do tenant OTEL spans get dropped?"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /question filed: question-42/);
    assert.match(r.stdout, /routed to person-steward \(via mentions\)/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/questions");
    assert.ok(post, "POSTed to /v1/questions");
    assert.deepStrictEqual(JSON.parse(post.body), { text: "Where do tenant OTEL spans get dropped?" });
  } finally {
    srv.close();
  }
});

test("ask (remote) includes title/mentions/project only when given", async () => {
  const { srv, hits, base } = await askStub();
  try {
    const r = await runAsync(
      ["ask", "Did the token-rotation hook land?", "--title", "OAuth phase B?", "--mention", "dec-a", "--mention", "dec-b", "--project", "spor-server"],
      remoteEnv(base),
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/questions");
    assert.deepStrictEqual(JSON.parse(post.body), {
      text: "Did the token-rotation hook land?",
      title: "OAuth phase B?",
      mentions: ["dec-a", "dec-b"],
      project: "spor-server",
    });
  } finally {
    srv.close();
  }
});

test("ask (remote) omits project by default so the server derives it", async () => {
  const { srv, hits, base } = await askStub();
  try {
    await runAsync(["ask", "a mention-less question"], remoteEnv(base));
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/questions");
    const body = JSON.parse(post.body);
    assert.ok(!("project" in body), "no project key — server derives from neighborhood");
    assert.ok(!("mentions" in body), "no mentions key when none given");
    assert.ok(!("title" in body), "no title key when none given");
  } finally {
    srv.close();
  }
});

test("ask (remote) reports an unrouted question as visible to everyone", async () => {
  const { srv, base } = await askStub({ unrouted: true });
  try {
    const r = await runAsync(["ask", "a question no steward owns"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /unrouted — no steward matched; visible to everyone/);
  } finally {
    srv.close();
  }
});

test("ask (remote) surfaces a rejection's message and details", async () => {
  const { srv, base } = await askStub({ status: 400, errCode: "invalid_project", message: "malformed project slug", details: ["slug must match ^[a-z0-9][a-z0-9-]*$"] });
  try {
    const r = await runAsync(["ask", "q", "--project", "Bad_Slug"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /ask error 400: malformed project slug \(slug must match/);
  } finally {
    srv.close();
  }
});

test("ask (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["ask", "q"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});
