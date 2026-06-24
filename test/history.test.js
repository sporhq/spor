// history.test.js — `spor history <id> [<sha>]` is the shell verb for a node's
// per-revision git lineage (task-spor-history-cli-verb): the commit list (who /
// when / what changed) and, per revision, the diff + change type it introduced.
// Dual-mode like `get`/`blame` (norm-spor-cli-mode-parity): local runs a `git
// log` projection over the graph home (lib/history.js, a faithful twin of the
// server's computeNodeHistory / computeNodeHistoryEntry); remote dispatches to
// GET /v1/nodes/{id}/history and GET /v1/nodes/{id}/history/{sha}.
//
// Oracle = the bytes the CLI renders from a scratch git graph (local) + the
// request the remote arm makes + the fail-soft exits — never the live graph and
// never the server's framing (remote responses are scripted).
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync, spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip a
// local-mode test to remote or leak a token), config homes isolated to a temp
// dir. Mirrors blame.test.js / export.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-history-iso-"));
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
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env) });
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

// --- a scratch git graph with a real commit chain ---------------------------
// dec-x is created (by Alice, who has a person node) then modified by the server-
// internal identity; person-bob exists but never touches dec-x. The shas come
// back so the per-revision arm can target a known commit. Deterministic dates so
// the rendered "when" column is stable.
function gitc(dir, args, env = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function fixtureGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-history-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  gitc(dir, ["init", "-q"]);
  gitc(dir, ["config", "user.name", "Init"]);
  gitc(dir, ["config", "user.email", "init@example.com"]);

  const write = (id, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), body);
  write("person-alice", "---\nid: person-alice\ntype: person\nemail: Alice@Example.com\nsummary: Alice.\n---\nAlice.\n");
  write("person-bob", "---\nid: person-bob\ntype: person\nemail: bob@example.com\nsummary: Bob.\n---\nBob.\n");
  write("dec-x", "---\nid: dec-x\ntype: decision\nstatus: open\nsummary: First.\n---\nBody v1.\n");

  // commit 1: Alice creates the nodes (her email is mixed-case to prove the
  // person index lowercases, matching the server).
  const asAlice = { GIT_AUTHOR_NAME: "Alice", GIT_AUTHOR_EMAIL: "alice@example.com", GIT_COMMITTER_NAME: "Alice", GIT_COMMITTER_EMAIL: "alice@example.com", GIT_AUTHOR_DATE: "2026-06-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-06-01T10:00:00Z" };
  gitc(dir, ["add", "-A"]);
  gitc(dir, ["commit", "-qm", "feat: create dec-x and people"], asAlice);
  const shaCreate = gitc(dir, ["rev-parse", "HEAD"]).trim();

  // commit 2: the server-internal identity revises dec-x (boot reconcile shape).
  write("dec-x", "---\nid: dec-x\ntype: decision\nstatus: settled\nsummary: First, revised.\n---\nBody v2 changed.\n");
  const asServer = { GIT_AUTHOR_NAME: "server", GIT_AUTHOR_EMAIL: "server@spor.invalid", GIT_COMMITTER_NAME: "server", GIT_COMMITTER_EMAIL: "server@spor.invalid", GIT_AUTHOR_DATE: "2026-06-02T11:00:00Z", GIT_COMMITTER_DATE: "2026-06-02T11:00:00Z" };
  gitc(dir, ["add", "-A"]);
  gitc(dir, ["commit", "-qm", "chore: internal reconcile of dec-x"], asServer);
  const shaInternal = gitc(dir, ["rev-parse", "HEAD"]).trim();

  return { dir, nodes, shaCreate, shaInternal };
}

// --- local mode -------------------------------------------------------------

test("history (local) lists revisions newest-first, labels internal, maps the actor to a person", () => {
  const { dir, shaCreate, shaInternal } = fixtureGraph();
  const r = run(["history", "dec-x"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /dec-x — 2 revisions/);
  // newest (server-internal) first, then Alice's creation mapped to her person node
  const internalAt = r.stdout.indexOf(shaInternal.slice(0, 7));
  const createAt = r.stdout.indexOf(shaCreate.slice(0, 7));
  assert.ok(internalAt > -1 && createAt > -1 && internalAt < createAt, "newest-first order");
  assert.match(r.stdout, /server \(internal\)/);
  assert.match(r.stdout, /Alice <alice@example\.com>\s+\[Alice@Example\.com\]/);
  assert.match(r.stdout, /chore: internal reconcile of dec-x/);
  assert.match(r.stdout, /\(head /);
});

test("history (local) --json is the {id, head, count, history} envelope", () => {
  const { dir, shaInternal } = fixtureGraph();
  const r = run(["history", "dec-x", "--json"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.id, "dec-x");
  assert.strictEqual(j.count, 2);
  assert.strictEqual(j.head, shaInternal);
  assert.strictEqual(j.history[0].sha, shaInternal);
  assert.strictEqual(j.history[0].internal, true);
  assert.strictEqual(j.history[0].person, null);
  assert.strictEqual(j.history[1].internal, false);
  assert.strictEqual(j.history[1].person, "person-alice");
  assert.strictEqual(j.history[1].person_name, "Alice@Example.com");
  assert.strictEqual(j.history[1].actor, "Alice <alice@example.com>");
});

test("history (local) --limit caps the list", () => {
  const { dir, shaInternal } = fixtureGraph();
  const j = JSON.parse(run(["history", "dec-x", "--limit", "1", "--json"], { SPOR_HOME: dir }).stdout);
  assert.strictEqual(j.count, 1);
  assert.strictEqual(j.history[0].sha, shaInternal); // newest only
});

test("history (local) <sha> shows that revision's change type, diff, and actor", () => {
  const { dir, shaCreate } = fixtureGraph();
  const r = run(["history", "dec-x", shaCreate], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${shaCreate.slice(0, 7)}\\s+created\\s+dec-x`));
  assert.match(r.stdout, /Alice <alice@example\.com>\s+\[Alice@Example\.com\]/);
  assert.match(r.stdout, /\+Body v1\./); // the patch this commit introduced
  assert.doesNotMatch(r.stdout, /--- content @/); // no full content without --content
});

test("history (local) <sha> --content appends the full node at that revision", () => {
  const { dir, shaInternal } = fixtureGraph();
  const r = run(["history", "dec-x", shaInternal, "--content"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${shaInternal.slice(0, 7)}\\s+modified\\s+dec-x`));
  assert.match(r.stdout, /--- content @ /);
  assert.match(r.stdout, /summary: First, revised\./); // node body AT that revision
});

test("history (local) <sha> --json is the entry envelope (change, patch, content)", () => {
  const { dir, shaCreate } = fixtureGraph();
  const j = JSON.parse(run(["history", "dec-x", shaCreate, "--json"], { SPOR_HOME: dir }).stdout);
  assert.strictEqual(j.id, "dec-x");
  assert.strictEqual(j.sha, shaCreate);
  assert.strictEqual(j.change, "A");
  assert.match(j.patch, /\+Body v1\./);
  assert.match(j.content, /id: dec-x/);
  assert.strictEqual(j.person, "person-alice");
});

test("history (local) an unknown node id is a 'no history' miss (exit 1, no stack)", () => {
  const { dir } = fixtureGraph();
  const r = run(["history", "dec-nope"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /node 'dec-nope' has no history \(unknown id\)/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("history (local) rejects a bad id and a bad sha client-side", () => {
  const { dir } = fixtureGraph();
  const badId = run(["history", "Bad_ID"], { SPOR_HOME: dir });
  assert.strictEqual(badId.status, 1);
  assert.match(badId.stderr, /bad node id 'Bad_ID'/);
  const badSha = run(["history", "dec-x", "zzz"], { SPOR_HOME: dir });
  assert.strictEqual(badSha.status, 1);
  assert.match(badSha.stderr, /bad sha 'zzz'/);
});

test("history (local) <sha> that didn't touch the node is reported, exit 1", () => {
  const { dir, shaInternal } = fixtureGraph();
  // the internal commit revised dec-x, not person-bob — so it's not in bob's lineage
  const r = run(["history", "person-bob", shaInternal], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, new RegExp(`commit '${shaInternal}' did not change node 'person-bob'`));
});

test("history (local) an unresolvable but well-formed sha is 'not found', exit 1", () => {
  const { dir } = fixtureGraph();
  const r = run(["history", "dec-x", "deadbeef"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /commit 'deadbeef' not found/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("history with no id exits 1 with usage", () => {
  const { dir } = fixtureGraph();
  const r = run(["history"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor history/);
});

test("history (local) works when the graph home is nested inside a larger git repo", () => {
  // The `graph:` marker / monorepo case: the git root is the parent, so nodes/
  // is NOT an immediate child of the repo root. The list/patch pathspecs and the
  // content fetch must all resolve cwd-relative (a root-relative <sha>:<path>
  // would miss). SPOR_HOME = <root>/graph, nodes at <root>/graph/nodes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-history-nested-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  gitc(root, ["init", "-q"]);
  gitc(root, ["config", "user.name", "A"]);
  gitc(root, ["config", "user.email", "a@b.c"]);
  fs.writeFileSync(path.join(home, "nodes", "dec-n.md"), "---\nid: dec-n\ntype: decision\nsummary: nested.\n---\nBody nested.\n");
  gitc(root, ["add", "-A"]);
  gitc(root, ["commit", "-qm", "create dec-n nested"]);
  const sha = gitc(root, ["rev-parse", "HEAD"]).trim();

  const list = run(["history", "dec-n"], { SPOR_HOME: home });
  assert.strictEqual(list.status, 0, list.stderr);
  assert.match(list.stdout, /dec-n — 1 revision/);

  // the content fetch is the sensitive one — it must show the node, not the
  // "(node absent at this revision)" placeholder.
  const entry = run(["history", "dec-n", sha, "--content"], { SPOR_HOME: home });
  assert.strictEqual(entry.status, 0, entry.stderr);
  assert.match(entry.stdout, /\+Body nested\./); // the patch
  assert.match(entry.stdout, /summary: nested\./); // the full content at that revision
  assert.doesNotMatch(entry.stdout, /node absent at this revision/);
});

test("history (local) with no graph home points at init, no stack", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-history-nohome-"));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const r = run(["history", "dec-x"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no Spor graph/);
  assert.match(r.stderr, /spor init/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- remote mode ------------------------------------------------------------

// Records every request; serves a scriptable history list at /v1/nodes/{id}/
// history and a per-revision entry at /v1/nodes/{id}/history/{sha}, so the GET
// path + ?limit passthrough are observable.
function historyStub({ list = null, entry = null, listStatus = 200, entryStatus = 200 } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x");
    const mList = u.pathname.match(/^\/v1\/nodes\/([^/]+)\/history$/);
    const mEntry = u.pathname.match(/^\/v1\/nodes\/([^/]+)\/history\/([^/]+)$/);
    if (mEntry && req.method === "GET") {
      if (entryStatus !== 200) return j(entryStatus, { error: { code: "not_found", message: `commit '${decodeURIComponent(mEntry[2])}' did not change node '${decodeURIComponent(mEntry[1])}'` } });
      return j(200, entry);
    }
    if (mList && req.method === "GET") {
      if (listStatus !== 200) return j(listStatus, { error: { code: "not_found", message: `node '${decodeURIComponent(mList[1])}' has no history (unknown id)` } });
      return j(200, list);
    }
    return j(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) =>
  bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

const LIST_BODY = {
  id: "dec-x",
  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  count: 2,
  history: [
    { sha: "bbbbbbbbbbbb", short: "bbbbbbb", actor: "server <server@spor.invalid>", actor_name: "server", actor_email: "server@spor.invalid", date: "2026-06-02T11:00:00+00:00", message: "chore: internal reconcile", internal: true, person: null },
    { sha: "cccccccccccc", short: "ccccccc", actor: "Alice <alice@example.com>", actor_name: "Alice", actor_email: "alice@example.com", date: "2026-06-01T10:00:00+00:00", message: "feat: create dec-x", internal: false, person: "person-alice" },
  ],
};
const ENTRY_BODY = {
  sha: "cccccccccccc", short: "ccccccc", actor: "Alice <alice@example.com>", actor_name: "Alice", actor_email: "alice@example.com",
  date: "2026-06-01T10:00:00+00:00", message: "feat: create dec-x", internal: false, person: "person-alice",
  id: "dec-x", change: "A", patch: "@@ -0,0 +1 @@\n+Body v1.", content: "---\nid: dec-x\n---\nBody v1.\n",
};

test("history (remote) GETs /v1/nodes/<id>/history and renders the list", async () => {
  const { srv, hits, base } = await historyStub({ list: LIST_BODY });
  try {
    const r = await runAsync(["history", "dec-x"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /dec-x — 2 revisions/);
    assert.match(r.stdout, /server \(internal\)/);
    assert.match(r.stdout, /Alice <alice@example\.com>\s+\[person-alice\]/);
    assert.ok(hits.find((h) => h.method === "GET" && h.url === "/v1/nodes/dec-x/history"), "GET .../history");
  } finally {
    srv.close();
  }
});

test("history (remote) --limit forwards ?limit and --json passes the envelope through", async () => {
  const { srv, hits, base } = await historyStub({ list: LIST_BODY });
  try {
    const r = await runAsync(["history", "dec-x", "--limit", "10", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), LIST_BODY);
    assert.ok(hits.find((h) => h.url === "/v1/nodes/dec-x/history?limit=10"), "?limit=10 forwarded");
  } finally {
    srv.close();
  }
});

test("history (remote) <sha> GETs the per-revision route and renders the diff", async () => {
  const { srv, hits, base } = await historyStub({ entry: ENTRY_BODY });
  try {
    const r = await runAsync(["history", "dec-x", "cccccccccccc"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ccccccc\s+created\s+dec-x/);
    assert.match(r.stdout, /\+Body v1\./);
    assert.ok(hits.find((h) => h.url === "/v1/nodes/dec-x/history/cccccccccccc"), "GET .../history/<sha>");
  } finally {
    srv.close();
  }
});

test("history (remote) an unknown node is a 'no history' miss (exit 1)", async () => {
  const { srv, base } = await historyStub({ listStatus: 404 });
  try {
    const r = await runAsync(["history", "dec-nope"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /node 'dec-nope' has no history \(unknown id\)/);
  } finally {
    srv.close();
  }
});

test("history (remote) <sha> 404 surfaces the server's message", async () => {
  const { srv, base } = await historyStub({ entryStatus: 404 });
  try {
    const r = await runAsync(["history", "dec-x", "deadbeef"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /did not change node 'dec-x'/);
  } finally {
    srv.close();
  }
});

test("history (remote) a dead server fails soft with a transport line, no stack", async () => {
  const r = await runAsync(["history", "dec-x"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("history (remote) validates the id client-side before any request", async () => {
  const { srv, hits, base } = await historyStub({ list: LIST_BODY });
  try {
    const r = await runAsync(["history", "Bad_ID"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /bad node id 'Bad_ID'/);
    assert.strictEqual(hits.length, 0, "no request made for an invalid id");
  } finally {
    srv.close();
  }
});
