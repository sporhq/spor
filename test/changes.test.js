// changes.test.js — `spor changes`, the team's recent-activity feed
// (task-spor-changes-cli-verb). Two layers:
//   1. the LOCAL kernel/façade (lib/changes.js) — the git-log projection over a
//      real scratch git graph: newest-change-per-node, the git --name-status
//      LETTER as the change field (byte-parity with GET /v1/changes), deletion
//      handling, --since (sha range / date phrase / bad sha), --project scoping,
//      --limit clamp, and the non-git degradation; plus the shared renderer;
//   2. the CLI arms (bin/spor.js) — the REMOTE arm wrapping GET /v1/changes
//      (oracle = the GET path + query params it sends, never the server's
//      framing) and the LOCAL arm's exit codes, both over a fake server / scratch
//      home so a configured dev box can't flip a test to the live graph.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");

const changesLib = require("../lib/changes.js");
const CLI = path.join(__dirname, "..", "bin", "spor.js");

// ---------- scratch git graph ----------

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "spor-ch-")); }
function git(dir, ...args) { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); }
function initGraph() {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  git(home, "init", "-q");
  git(home, "config", "user.email", "t@t");
  git(home, "config", "user.name", "Test");
  return home;
}
function writeNode(home, id, type, extra = "", project = "spor") {
  fs.writeFileSync(path.join(home, "nodes", `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\ntitle: ${id} title\nsummary: ${id} summary.\nproject: ${project}\n${extra}---\nbody\n`);
}
function rmNode(home, id) { git(home, "rm", "-q", path.join("nodes", `${id}.md`)); }
function commit(home, when, msg) {
  git(home, "add", "-A");
  execFileSync("git", ["-C", home, "commit", "-q", "-m", msg],
    { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
}
const nodesOf = (home) => path.join(home, "nodes");

// ---------- kernel: collect() ----------

test("collect: newest change per node, newest-first, with the git LETTER as change", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task");
  writeNode(home, "dec-b", "decision");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  writeNode(home, "task-a", "task", "authored_via: distill\n"); // modify a
  commit(home, "2026-06-21T09:00:00Z", "c2");

  const r = changesLib.collect({ nodesDir: nodesOf(home) });
  assert.equal(r.count, 2);
  assert.deepEqual(r.changes.map((c) => c.id), ["task-a", "dec-b"]); // newest-first
  assert.equal(r.changes[0].change, "M"); // task-a's NEWEST change is the modify
  assert.equal(r.changes[1].change, "A"); // dec-b only ever added
  assert.deepEqual(r.node_ids, ["task-a", "dec-b"]);
  assert.equal(r.head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});

test("collect: decorates from the CURRENT node frontmatter (type/title/authored_via/author/agent/session)", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task",
    "authored_via: dispatch\nauthor: Ann <a@x>\nauthored_by_agent: agent-ann-box\nsession: sess-9\n");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  const c = changesLib.collect({ nodesDir: nodesOf(home) }).changes[0];
  assert.equal(c.type, "task");
  assert.equal(c.title, "task-a title");
  assert.equal(c.authored_via, "dispatch");
  assert.equal(c.author, "Ann <a@x>");
  assert.equal(c.authored_by_agent, "agent-ann-box");
  assert.equal(c.session, "sess-9");
  assert.equal(c.committed_by, "Test <t@t>"); // name <email>, as the server emits
});

test("collect: a deletion is change=D, undecorated (no current file)", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task");
  writeNode(home, "issue-g", "issue");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  rmNode(home, "issue-g");
  commit(home, "2026-06-21T09:00:00Z", "c2");
  const r = changesLib.collect({ nodesDir: nodesOf(home) });
  const del = r.changes.find((c) => c.id === "issue-g");
  assert.equal(del.change, "D");
  assert.equal(del.type, null);
  assert.equal(del.title, null);
});

test("collect: --since <sha> bounds to sha..HEAD", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task");
  commit(home, "2026-06-19T08:00:00Z", "c1");
  const first = execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeNode(home, "dec-b", "decision");
  commit(home, "2026-06-21T09:00:00Z", "c2");
  const r = changesLib.collect({ nodesDir: nodesOf(home), since: first });
  assert.deepEqual(r.changes.map((c) => c.id), ["dec-b"]); // task-a is at/under `first`, excluded
  assert.equal(r.since, first);
});

test("collect: --since as a date phrase filters by commit time", () => {
  const home = initGraph();
  writeNode(home, "task-old", "task");
  commit(home, "2026-06-01T08:00:00Z", "old");
  writeNode(home, "task-new", "task");
  commit(home, "2026-06-21T09:00:00Z", "new");
  const r = changesLib.collect({ nodesDir: nodesOf(home), since: "2026-06-15" });
  assert.deepEqual(r.changes.map((c) => c.id), ["task-new"]);
});

test("collect: --since <today's bare date> includes a commit from earlier today (boundary is inclusive, not 'now')", () => {
  // Regression for issue-spor-changes-since-boundary-exclusive: git's approxidate
  // anchors a bare YYYY-MM-DD to the CURRENT time-of-day, not midnight, so
  // `--since=<today>` used to compare against "today at process-start time" and
  // drop anything committed earlier the same day. Commit near midnight UTC today
  // and query --since with today's bare date; it must still show up.
  const home = initGraph();
  writeNode(home, "task-early", "task");
  const today = new Date().toISOString().slice(0, 10);
  commit(home, `${today}T00:00:01Z`, "early-today");
  const r = changesLib.collect({ nodesDir: nodesOf(home), since: today });
  assert.deepEqual(r.changes.map((c) => c.id), ["task-early"]);
});

test("collect: --since <bare date> pins UTC midnight regardless of the process's local timezone", () => {
  // A bare date anchored to the process's LOCAL time (e.g. `${since} 00:00:00`,
  // parsed in TZ) would shift the boundary by the TZ offset and could still drop
  // a same-UTC-day commit made before local midnight — the same bug, just
  // relocated. Run under a non-UTC TZ and confirm a commit shortly after UTC
  // midnight still matches `--since` = that UTC date.
  const home = initGraph();
  writeNode(home, "task-early", "task");
  commit(home, "2026-07-07T00:00:01Z", "early-utc");
  const prevTz = process.env.TZ;
  process.env.TZ = "America/New_York"; // UTC-4/5 — local midnight is hours after UTC midnight
  let r;
  try {
    r = changesLib.collect({ nodesDir: nodesOf(home), since: "2026-07-07" });
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
  assert.deepEqual(r.changes.map((c) => c.id), ["task-early"]);
});

test("collect: a sha-like --since that doesn't resolve throws bad_since", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  assert.throws(
    () => changesLib.collect({ nodesDir: nodesOf(home), since: "0000000" }),
    (e) => e.code === "bad_since"
  );
});

test("collect: a keep(fm) predicate filters entries and drops deletions (fm=null)", () => {
  // The CLI passes a grouping-resolved keep(); here a plain project-stamp keep
  // exercises the same mechanism — and a deletion (fm=null) is dropped under it.
  const home = initGraph();
  writeNode(home, "task-a", "task", "", "spor");
  writeNode(home, "task-b", "task", "", "other");
  writeNode(home, "issue-g", "issue", "", "spor");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  rmNode(home, "issue-g"); // a spor node, but deleted -> no current file -> dropped by keep
  commit(home, "2026-06-21T09:00:00Z", "c2");
  const keep = (fm) => fm != null && fm.project === "spor";
  const r = changesLib.collect({ nodesDir: nodesOf(home), project: "spor", keep });
  assert.deepEqual(r.changes.map((c) => c.id), ["task-a"]);
  assert.equal(r.project, "spor"); // stamped for display even though keep does the filtering
});

test("collect: project is display-only — without a keep predicate it does NOT filter", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task", "", "spor");
  writeNode(home, "task-b", "task", "", "other");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  const r = changesLib.collect({ nodesDir: nodesOf(home), project: "spor" });
  assert.deepEqual(r.changes.map((c) => c.id).sort(), ["task-a", "task-b"]); // unfiltered
  assert.equal(r.project, "spor");
});

test("collect: --limit clamps (default 100, max 500) and bounds the result", () => {
  assert.equal(changesLib.clampLimit(undefined), 100);
  assert.equal(changesLib.clampLimit(0), 100);
  assert.equal(changesLib.clampLimit("abc"), 100);
  assert.equal(changesLib.clampLimit(3), 3);
  assert.equal(changesLib.clampLimit(9999), 500);
  const home = initGraph();
  for (const id of ["task-a", "task-b", "task-c"]) writeNode(home, id, "task");
  commit(home, "2026-06-20T08:00:00Z", "c1");
  assert.equal(changesLib.collect({ nodesDir: nodesOf(home), limit: 2 }).count, 2);
});

test("collect: a non-git home returns an empty envelope (fail-open)", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  writeNode(home, "task-a", "task");
  const r = changesLib.collect({ nodesDir: nodesOf(home) });
  assert.deepEqual(r.changes, []);
  assert.equal(r.count, 0);
  assert.equal(r.head, null);
});

// ---------- renderReport ----------

test("renderReport: expands the letter, marks machine vs human, notes deletions + head", () => {
  const text = changesLib.renderReport({
    changes: [
      { id: "task-a", change: "M", date: "2026-06-21T09:30:00.000Z", type: "task", title: "Do a thing", authored_via: "capture" },
      { id: "issue-g", change: "D", date: "2026-06-21T09:00:00.000Z", type: null, title: null, authored_via: null },
      { id: "dec-b", change: "A", date: "2026-06-20T08:00:00.000Z", type: "decision", title: "A call", authored_via: null },
    ],
    count: 3, head: "abcdef1234567890", project: null, since: null,
  });
  assert.match(text, /recent changes \(3 nodes\)/);
  assert.match(text, /2026-06-21 09:30 {2}modified {4}task-a/);
  assert.match(text, /Do a thing {2}\[task, machine·capture\]/);
  assert.match(text, /deleted {5}issue-g/);
  assert.match(text, /\(deleted\) {2}\[human\]/); // undecorated deletion
  assert.match(text, /A call {2}\[decision, human\]/); // author present but not machine via
  assert.match(text, /\(head abcdef12\)/);
});

test("renderReport: project scope + since appear in the header; empty range is explicit", () => {
  const scoped = changesLib.renderReport({ changes: [], count: 0, project: "spor", since: "a1b2c3d" });
  assert.match(scoped, /recent changes — project spor \(0 nodes, since a1b2c3d\)/);
  assert.match(scoped, /\(nothing changed in range\)/);
});

// ---------- CLI: remote arm (fake server) ----------

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
function freshHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "spor-ch-home-")); }

// Records every request; GET /v1/changes returns a scriptable envelope.
function changesStub({ status = 200, body } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url.startsWith("/v1/changes") && req.method === "GET") {
      if (status === 422) return j(422, { error: { code: "bad_since", message: "could not resolve since 'zzz'" } });
      if (status !== 200) return j(status, { error: { code: "bad_request", message: "x" } });
      return j(200, body || { changes: [], count: 0, head: null, since: null, project: null, node_ids: [] });
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (home, base, extra = {}) =>
  baseEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("changes (remote): GETs /v1/changes with since/project/limit and renders the feed", async () => {
  const body = {
    changes: [{ id: "task-a", change: "M", commit: "deadbeefcafe", date: "2026-06-21T11:00:00+00:00", committed_by: "Ann <a@x>", type: "task", title: "A task", authored_via: "capture", author: "Ann <a@x>" }],
    count: 1, head: "deadbeefcafe", since: "a1b2c3d", project: "spor", node_ids: ["task-a"],
  };
  const { srv, hits, base } = await changesStub({ body });
  try {
    const r = await runAsync(["changes", "--since", "a1b2c3d", "--project", "spor", "--limit", "5"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /recent changes — project spor \(1 node, since a1b2c3d\)/);
    assert.match(r.stdout, /modified {4}task-a/);
    assert.match(r.stdout, /A task {2}\[task, machine·capture\]/);
    const hit = hits.find((h) => h.method === "GET" && h.url.startsWith("/v1/changes?"));
    assert.ok(hit, "GET /v1/changes with a query string");
    const qs = new URLSearchParams(hit.url.split("?")[1]);
    assert.equal(qs.get("since"), "a1b2c3d");
    assert.equal(qs.get("project"), "spor");
    assert.equal(qs.get("limit"), "5");
  } finally { srv.close(); }
});

test("changes (remote): --json passes the server envelope through verbatim", async () => {
  const body = { changes: [{ id: "task-a", change: "A" }], count: 1, head: "abc", since: null, project: null, node_ids: ["task-a"] };
  const { srv, base } = await changesStub({ body });
  try {
    const r = await runAsync(["changes", "--json"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.count, 1);
    assert.equal(j.changes[0].id, "task-a");
  } finally { srv.close(); }
});

test("changes (remote): a 422 (unresolvable --since) reports a clear line, not an outage", async () => {
  const { srv, base } = await changesStub({ status: 422 });
  try {
    const r = await runAsync(["changes", "--since", "zzzzzzz"], remoteEnv(freshHome(), base));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /changes:.*could not resolve/);
    assert.doesNotMatch(r.stderr, /offline/);
  } finally { srv.close(); }
});

test("changes (remote): a dead server fails soft with an offline line", async () => {
  const r = await runAsync(["changes"], remoteEnv(freshHome(), "http://127.0.0.1:1"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /offline — could not reach server/);
});

// ---------- CLI: local arm ----------

test("changes (local): renders the git-log feed over --nodes", async () => {
  const home = initGraph();
  writeNode(home, "task-a", "task", "authored_via: capture\n");
  commit(home, "2026-06-21T09:00:00Z", "c1");
  const r = await runAsync(["changes", "--nodes", nodesOf(home)], baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recent changes \(1 node\)/);
  assert.match(r.stdout, /added {7}task-a/);
});

test("changes (local): --project resolves scope via the graph and filters the feed", async () => {
  // The CLI loads the graph and builds the grouping-resolved keep() predicate
  // (scopeFor/resolveProject) — the SAME resolution `next`/`analytics` use. With
  // no repo/grouping nodes, scopeFor falls to the slug itself, so the feed scopes
  // to spor-stamped nodes; an unrelated-project node drops out.
  const home = initGraph();
  writeNode(home, "task-a", "task", "", "spor");
  writeNode(home, "task-b", "task", "", "other-proj");
  commit(home, "2026-06-21T09:00:00Z", "c1");
  const env = baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() });
  const r = await runAsync(["changes", "--nodes", nodesOf(home), "--project", "spor"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recent changes — project spor/);
  assert.match(r.stdout, /task-a/);
  assert.doesNotMatch(r.stdout, /task-b/);
});

test("changes (local): a bad --since sha exits 1 with a clear message", async () => {
  const home = initGraph();
  writeNode(home, "task-a", "task");
  commit(home, "2026-06-21T09:00:00Z", "c1");
  const r = await runAsync(["changes", "--nodes", nodesOf(home), "--since", "0000000"], baseEnv({ SPOR_HOME: freshHome(), XDG_CONFIG_HOME: freshHome() }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /changes:.*could not resolve --since/);
});
