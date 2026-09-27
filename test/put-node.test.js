// put-node.test.js - `spor put-node` full validated node writes.
// Remote mode is the shell twin of MCP put_node / REST POST /v1/nodes. Local
// mode writes nodes/<id>.md only after validation and revision/collision checks.
require("./helpers/tmp-cleanup");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { gitBlobSha } = require("../bin/spor.js");

const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-iso-"));
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
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  spawnSync("git", ["init", "-q", home]);
  fs.writeFileSync(path.join(nodes, "dec-old.md"), nodeMd("dec-old", "Old decision", "Old summary."));
  return { home, nodes };
}
function nodeMd(id, title = "Demo decision", summary = "A demo decision used by the put-node CLI tests.") {
  return `---
id: ${id}
type: decision
project: demo
title: ${title}
summary: ${summary}
date: 2026-06-01
---
Body for ${id}.
`;
}
function tmpNodeFile(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-file-"));
  const file = path.join(dir, "node.md");
  fs.writeFileSync(file, raw);
  return file;
}
function readNode(nodes, id) {
  return fs.readFileSync(path.join(nodes, `${id}.md`), "utf8");
}
function validateGraph(nodes) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8", env: bare() });
}

test("put-node (local) creates a new node from a markdown file and validates clean", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(nodeMd("dec-new"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node created: dec-new @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-new"), fs.readFileSync(file, "utf8"));
  const v = validateGraph(nodes);
  assert.strictEqual(v.status, 0, v.stdout);
  assert.match(v.stdout, /0 errors/);
});

// task-spor-cli-write-banner-mode-echo: the resolved write target line, so a
// local write is never mistaken for one that landed on a remote server. The
// motivating incident: an agent verifying local put-node behavior had
// SPOR_SERVER set in its env, so the write silently resolved remote and
// landed on the live team graph.
test("put-node (local) banners the resolved local graph home", () => {
  const { home } = fixtureGraph();
  const file = tmpNodeFile(nodeMd("dec-banner"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, `put-node created: dec-banner @ ${gitBlobSha(fs.readFileSync(file))}\n  -> local ${home}\n`);
});

// --json output stays machine-parseable — the banner is a human-readable line,
// not part of the structured result.
test("put-node (local) --json omits the write-target banner", () => {
  const { home } = fixtureGraph();
  const file = tmpNodeFile(nodeMd("dec-json"));
  const r = run(["put-node", file, "--json"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /-> local/);
  assert.deepStrictEqual(JSON.parse(r.stdout).status, "created");
});

test("put-node (local) skips an existing node with --if-exists skip", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-old");
  const file = tmpNodeFile(nodeMd("dec-old", "Replacement", "Replacement summary."));
  const r = run(["put-node", file, "--if-exists", "skip"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node skipped: dec-old @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-old"), before);
});

test("put-node (local) updates only with a matching revision", () => {
  const { home, nodes } = fixtureGraph();
  const revision = gitBlobSha(fs.readFileSync(path.join(nodes, "dec-old.md")));
  const updated = nodeMd("dec-old", "Updated decision", "Updated summary.");
  const file = tmpNodeFile(updated);
  const r = run(["put-node", file, "--if-exists", "update", "--revision", revision], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node updated: dec-old @ [0-9a-f]{40}/);
  assert.strictEqual(readNode(nodes, "dec-old"), updated);
});

test("put-node (local) rejects stale revisions without writing", () => {
  const { home, nodes } = fixtureGraph();
  const before = readNode(nodes, "dec-old");
  const file = tmpNodeFile(nodeMd("dec-old", "Stale write", "Stale write summary."));
  const r = run(["put-node", file, "--if-exists", "update", "--revision", "0".repeat(40)], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /put-node conflict: stale revision for dec-old/);
  assert.strictEqual(readNode(nodes, "dec-old"), before);
});

test("put-node (local) rejects malformed nodes before writing", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(`---
id: dec-bad
type: decision
title: Missing summary
date: 2026-06-01
---
No summary.
`);
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /missing summary/);
  assert.ok(!fs.existsSync(path.join(nodes, "dec-bad.md")));
});

// MAX_ID_LENGTH (issue-spor-server-node-id-length-unbounded): NODE_ID_RE is
// shape-only and never bounded length, mirroring the server's unbounded
// ID_RE/SLUG_RE. Local mode writes node files directly (no server in the
// loop), so it needs its own CREATE-only cap to keep a personal graph under
// the same invariant the server now enforces.
test("put-node (local) rejects a brand-new id past MAX_ID_LENGTH", () => {
  const { home, nodes } = fixtureGraph();
  const id = "dec-" + "a".repeat(200); // well past the 200-char cap
  const file = tmpNodeFile(nodeMd(id));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exceeds 200/);
  assert.ok(!fs.existsSync(path.join(nodes, `${id}.md`)));
});

test("put-node (local) accepts an id at exactly MAX_ID_LENGTH (boundary)", () => {
  const { home, nodes } = fixtureGraph();
  const id = "dec-" + "a".repeat(196); // 200 chars total
  assert.strictEqual(id.length, 200);
  const file = tmpNodeFile(nodeMd(id));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readNode(nodes, id), fs.readFileSync(file, "utf8"));
});

test("put-node (local) keeps updating a pre-existing id already past MAX_ID_LENGTH (grandfathered)", () => {
  const { home, nodes } = fixtureGraph();
  const id = "dec-" + "a".repeat(75) + "-" + "b".repeat(75) + "-" + "c".repeat(75);
  assert.ok(id.length > 200, "fixture must exceed the cap");
  // installed directly, the way a node written before this invariant existed
  // would already be resident on disk (bypassing the write door, as adminInstall
  // does server-side).
  fs.writeFileSync(path.join(nodes, `${id}.md`), nodeMd(id));
  const before = gitBlobSha(fs.readFileSync(path.join(nodes, `${id}.md`)));

  const file = tmpNodeFile(nodeMd(id, "Updated title", "Updated summary for the grandfathered over-cap id."));
  const r = run(["put-node", file, "--if-exists", "update", "--revision", before], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(readNode(nodes, id), /Updated title/);
});

// The graph-wide lint that gates a write must not hand the writer advice about
// nodes this write never touched. `spor put-node` lints the WHOLE graph, so before
// the near-cap band became opt-in (nearBodyCap) every large unrelated node in
// the graph printed an "approaching the cap" line on every single write.
test("put-node (local) does not report an unrelated node's near-the-body-cap warning", () => {
  const { home, nodes } = fixtureGraph();
  fs.writeFileSync(
    path.join(nodes, "art-log.md"),
    `---
id: art-log
type: artifact
project: demo
title: Log
summary: A running log that sits inside the near-cap warning band.
date: 2026-06-01
---
${"x".repeat(7500)}
`,
  );
  const file = tmpNodeFile(nodeMd("dec-unrelated"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const all = r.stdout + r.stderr;
  assert.ok(!/approaching the server's 8192B cap/.test(all), all);
});

function putNodeStub({ status = 200, result } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/nodes" && req.method === "POST") {
        return j(status, result || { results: [{ ok: true, status: "updated", id: "dec-remote", revision: "rev-2", warnings: [] }] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("put-node (remote) POSTs a one-entry put_node batch with policy and revision", async () => {
  const raw = nodeMd("dec-remote");
  const file = tmpNodeFile(raw);
  const { srv, hits, base } = await putNodeStub();
  try {
    const r = await runAsync(["put-node", file, "--if-exists", "update", "--revision", "rev-1"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /put-node updated: dec-remote @ rev-2/);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes");
    assert.ok(post, "POST /v1/nodes");
    assert.deepStrictEqual(JSON.parse(post.body), { nodes: [{ node: raw, if_exists: "update", revision: "rev-1" }] });
  } finally {
    srv.close();
  }
});

// task-spor-cli-write-banner-mode-echo: the remote counterpart of the local
// banner test above — the resolved server, not the graph home, on a remote write.
test("put-node (remote) banners the resolved remote server", async () => {
  const file = tmpNodeFile(nodeMd("dec-remote"));
  const { srv, base } = await putNodeStub();
  try {
    const r = await runAsync(["put-node", file, "--if-exists", "update", "--revision", "rev-1"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `put-node updated: dec-remote @ rev-2\n  -> remote ${base}\n`);
  } finally {
    srv.close();
  }
});

test("put-node (remote) surfaces a batch validation failure with details", async () => {
  const file = tmpNodeFile(nodeMd("dec-remote"));
  const result = { results: [{ ok: false, status: "error", id: "dec-remote", message: "invalid_node", details: ["dec-remote: bad edge"] }] };
  const { srv, base } = await putNodeStub({ status: 207, result });
  try {
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /put-node error 207: invalid_node; dec-remote: bad edge/);
  } finally {
    srv.close();
  }
});

// dec-spor-buildgraph-per-node-fault-isolation: the local put-node gate lints
// the WHOLE graph, so once the loader started SKIPPING a malformed node file
// instead of refusing to boot on it, an unrelated corrupt sibling would have
// locked the entire local graph read-only — with a banner naming a node the
// write never touched. Pre-existing skips are carried as warnings instead.
test("put-node (local): an unrelated unparseable node file does not block the write", () => {
  const { home, nodes } = fixtureGraph();
  fs.writeFileSync(
    path.join(nodes, "dec-corrupt.md"),
    `---
id: dec-corrupt
type: decision
project: demo
title: Corrupt
summary: A pre-existing node whose block-form edge entry never resolves a target.
date: 2026-06-01
edges:
  - type: relates-to
---
Body.
`
  );
  const file = tmpNodeFile(nodeMd("dec-fresh"));
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node created: dec-fresh/);
  assert.strictEqual(readNode(nodes, "dec-fresh"), fs.readFileSync(file, "utf8"));
  // the corruption is carried, not swallowed: named on stderr, both by the
  // loader's own skip warning and as a pre-existing lint error.
  assert.match(r.stderr, /SKIPPED unparseable node file .*dec-corrupt\.md/);
  assert.match(r.stderr, /warning: pre-existing: dec-corrupt\.md: unparseable edge entry/);
  // and `spor validate` still fails on it — the lint is the gate, not the writer.
  assert.strictEqual(validateGraph(nodes).status, 1);
});

// The complement: a fault in the node BEING WRITTEN still refuses the write.
test("put-node (local): an unparseable incoming node is still rejected", () => {
  const { home, nodes } = fixtureGraph();
  const file = tmpNodeFile(`---
id: dec-bad
type: decision
project: demo
title: Bad
summary: An incoming node whose block-form edge entry never resolves a target.
date: 2026-06-01
edges:
  - type: relates-to
---
Body.
`);
  const r = run(["put-node", file], { SPOR_HOME: home });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /unparseable edge entry/);
  assert.ok(!fs.existsSync(path.join(nodes, "dec-bad.md")), "nothing written");
});

// --- batch put-node + priority at create (task-spor-cli-put-node-batch) ------
const { splitNodeDocuments, resolverFirstOrder, chunkPutEntries } = require("../bin/spor.js");
const graphLib = require("../lib/graph.js");

function taskMd(id, extra = "", body = `Body for ${id}.`) {
  return `---
id: ${id}
type: task
project: demo
title: Task ${id}
summary: A task used by the batch put-node tests.
date: 2026-06-01
${extra}---
${body}
`;
}
function artMd(id, resolves) {
  return `---
id: ${id}
type: artifact
project: demo
title: Resolver ${id}
summary: An artifact resolving ${resolves}.
date: 2026-06-01
edges:
  - {type: resolves, to: ${resolves}}
---
Resolution for ${resolves}.
`;
}
function runStdin(args, input, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra), input });
}

test("splitNodeDocuments: one document comes back byte for byte", () => {
  const raw = nodeMd("dec-one");
  assert.deepStrictEqual(splitNodeDocuments(raw), [raw]);
  assert.deepStrictEqual(splitNodeDocuments("no frontmatter"), ["no frontmatter"]);
});

test("splitNodeDocuments: a markdown rule in a body is not a document boundary", () => {
  const raw = taskMd("task-rule", "", "Intro.\n\n---\n\nNote: this is prose, not frontmatter.\n\n---\n\nMore.");
  assert.deepStrictEqual(splitNodeDocuments(raw), [raw]);
});

test("splitNodeDocuments: concatenated nodes split at each frontmatter fence", () => {
  const a = taskMd("task-a", "", "A body.\n\n---\n\nstill A");
  const b = nodeMd("dec-b");
  const c = taskMd("task-c", "status: open\n");
  const docs = splitNodeDocuments(a + "\n" + b + c);
  assert.deepStrictEqual(docs, [a, b, c]);
  // CRLF input splits the same way
  assert.strictEqual(splitNodeDocuments((a + b).replace(/\n/g, "\r\n")).length, 2);
});

test("resolverFirstOrder: moves a resolver ahead of the node it resolves, otherwise stable", () => {
  const mk = (raw) => { const node = graphLib.parseFrontmatter(raw, "x.md"); return { id: node.id, node }; };
  const entries = [mk(taskMd("task-x", "status: done\n")), mk(nodeMd("dec-y")), mk(artMd("art-x", "task-x")), mk(nodeMd("dec-z"))];
  const order = resolverFirstOrder(entries, graphLib.seedRegistry()).map((e) => e.id);
  assert.deepStrictEqual(order, ["art-x", "task-x", "dec-y", "dec-z"]);
  // inverse spelling on the TARGET: question answered-by a decision
  const q = mk(`---\nid: question-q\ntype: question\nproject: demo\ntitle: Q\nsummary: A question.\ndate: 2026-06-01\nstatus: answered\nedges:\n  - {type: answered-by, to: dec-a}\n---\nQ?\n`);
  const order2 = resolverFirstOrder([q, mk(nodeMd("dec-a"))], graphLib.seedRegistry()).map((e) => e.id);
  assert.deepStrictEqual(order2, ["dec-a", "question-q"]);
  // no resolving edges: input order untouched
  const plain = [mk(nodeMd("dec-3")), mk(nodeMd("dec-1")), mk(nodeMd("dec-2"))];
  assert.deepStrictEqual(resolverFirstOrder(plain, null).map((e) => e.id), ["dec-3", "dec-1", "dec-2"]);
});

test("chunkPutEntries: caps a chunk at 100 entries and preserves order", () => {
  const wire = Array.from({ length: 250 }, (_, n) => ({ node: `n${n}`, if_exists: "skip" }));
  const chunks = chunkPutEntries(wire);
  assert.deepStrictEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.deepStrictEqual(chunks.flat(), wire);
  const big = Array.from({ length: 4 }, (_, n) => ({ node: "x".repeat(300 * 1024) + n }));
  assert.deepStrictEqual(chunkPutEntries(big).map((c) => c.length), [2, 2]);
});

test("put-node (local) --dir writes a batch, and a skip re-run is an auditable no-op", () => {
  const { home, nodes } = fixtureGraph();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-dir-"));
  fs.writeFileSync(path.join(dir, "a.md"), taskMd("task-done", "status: done\n"));
  fs.writeFileSync(path.join(dir, "b.md"), artMd("art-done", "task-done"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const r = run(["put-node", "--dir", dir], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.match(lines[0], /^put-node created: art-done @ [0-9a-f]{40}$/); // resolver first
  assert.match(lines[1], /^put-node created: task-done @ [0-9a-f]{40}$/);
  assert.strictEqual(lines[2], "put-node batch: 2 created (2 entries)");
  assert.strictEqual(lines[3], `  -> local ${home}`);
  assert.strictEqual(readNode(nodes, "task-done"), taskMd("task-done", "status: done\n"));

  const again = run(["put-node", "--dir", dir, "--if-exists", "skip"], { SPOR_HOME: home });
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /put-node skipped: art-done/);
  assert.match(again.stdout, /put-node batch: 2 skipped \(2 entries\)/);

  const collide = run(["put-node", "--dir", dir, "--json"], { SPOR_HOME: home });
  assert.strictEqual(collide.status, 1);
  const j = JSON.parse(collide.stdout);
  assert.deepStrictEqual(j.counts, { error: 2 });
  assert.match(j.results[0].message, /node already exists: art-done/);
});

test("put-node (local) multi-document stdin stamps priority at create like `spor priority`", () => {
  const { home, nodes } = fixtureGraph();
  spawnSync("git", ["-C", home, "config", "user.name", "Batch Tester"]);
  spawnSync("git", ["-C", home, "config", "user.email", "batch@example.com"]);
  const input = taskMd("task-p1", "priority: P1\n") + taskMd("task-plain");
  const r = runStdin(["put-node", "-"], input, { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /put-node created: task-p1 @ [0-9a-f]{40}\npriority set: task-p1 -> p1\n/);
  const raw = readNode(nodes, "task-p1");
  assert.match(raw, /\npriority: p1\npriority_by: Batch Tester <batch@example.com>\npriority_at: \S+\npriority_via: cli\n---\n/);
  assert.strictEqual(readNode(nodes, "task-plain"), taskMd("task-plain"));
  assert.strictEqual(validateGraph(nodes).status, 0);
});

test("put-node (local) batch refuses the whole input on one bad entry", () => {
  const { home, nodes } = fixtureGraph();
  const input = taskMd("task-ok") + taskMd("task-badprio", "priority: urgent\n") + taskMd("task-ok");
  const r = runStdin(["put-node"], input, { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /priority 'urgent' not allowed/);
  assert.match(r.stderr, /duplicate id 'task-ok'/);
  assert.match(r.stderr, /nothing written/);
  assert.ok(!fs.existsSync(path.join(nodes, "task-ok.md")));
});

test("put-node (local) batch is all-or-nothing: a structurally invalid later entry writes nothing", () => {
  const { home, nodes } = fixtureGraph();
  const noTitle = taskMd("task-three").replace("title: Task task-three\n", "");
  const r = runStdin(["put-node"], taskMd("task-one") + taskMd("task-two") + noTitle, { SPOR_HOME: home });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /task-three.*\n.*missing title/);
  assert.match(r.stderr, /nothing written/);
  for (const id of ["task-one", "task-two", "task-three"]) assert.ok(!fs.existsSync(path.join(nodes, `${id}.md`)), `${id} leaked`);
  // an existing entry skipped under --if-exists skip is never validated as a
  // write and does not block the batch
  fs.writeFileSync(path.join(nodes, "task-three.md"), taskMd("task-three"));
  const ok = runStdin(["put-node", "--if-exists", "skip"], taskMd("task-one") + taskMd("task-two") + noTitle, { SPOR_HOME: home });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /put-node batch: 2 created, 1 skipped \(3 entries\)/);
  assert.strictEqual(readNode(nodes, "task-three"), taskMd("task-three"));
});

test("put-node batch refuses --if-exists update and a file plus --dir", () => {
  const { home } = fixtureGraph();
  const r = runStdin(["put-node", "--if-exists", "update", "--revision", "abc"], taskMd("task-a") + taskMd("task-b"), { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /batch put-node takes --if-exists error\|skip/);
  const both = run(["put-node", "x.md", "--dir", "."], { SPOR_HOME: home });
  assert.strictEqual(both.status, 1);
  assert.match(both.stderr, /not both/);
});

function batchStub({ results } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/nodes" && req.method === "POST") {
        const nodes = JSON.parse(body).nodes;
        const rs = nodes.map((e, n) => (results && results[n]) || { ok: true, status: "created", id: /\nid: (\S+)/.exec("\n" + e.node.split("\n").slice(1).join("\n"))[1], revision: `rev-${n}`, warnings: [] });
        return j(rs.some((x) => !x.ok) ? 207 : 200, { results: rs });
      }
      const m = /^\/v1\/nodes\/([^/]+)\/priority$/.exec(req.url);
      if (m && req.method === "POST") return j(200, { ok: true, status: "updated", id: m[1], revision: "rev-prio" });
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
// batchStub's twin that also answers GET /v1/status, so the priority-POST
// skip (task-spor-cli-put-node-skip-priority-post-when-server-stamps) can be
// exercised with the capability advertised true or false.
function capabilityStub({ capable, results } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/v1/status" && req.method === "GET") {
        return j(200, { capabilities: { priority_stamped_on_create: capable } });
      }
      if (req.url === "/v1/nodes" && req.method === "POST") {
        const nodes = JSON.parse(body).nodes;
        const rs = nodes.map((e, n) => (results && results[n]) || { ok: true, status: "created", id: /\nid: (\S+)/.exec("\n" + e.node.split("\n").slice(1).join("\n"))[1], revision: `rev-${n}`, warnings: [] });
        return j(rs.some((x) => !x.ok) ? 207 : 200, { results: rs });
      }
      const m = /^\/v1\/nodes\/([^/]+)\/priority$/.exec(req.url);
      if (m && req.method === "POST") return j(200, { ok: true, status: "updated", id: m[1], revision: "rev-prio" });
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
function runStdinAsync(args, input, env) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
    c.stdin.end(input);
  });
}

test("put-node (remote) batch: ONE POST in resolver-first order, then the priority door per created node", async () => {
  const done = taskMd("task-done", "status: done\npriority: p2\n");
  const art = artMd("art-done", "task-done");
  const { srv, hits, base } = await batchStub();
  try {
    const r = await runStdinAsync(["put-node", "--if-exists", "skip"], done + art, remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const posts = hits.filter((h) => h.url === "/v1/nodes");
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(JSON.parse(posts[0].body), { nodes: [{ node: art, if_exists: "skip" }, { node: done, if_exists: "skip" }] });
    const prio = hits.filter((h) => h.url.endsWith("/priority"));
    assert.deepStrictEqual(prio.map((h) => [h.url, JSON.parse(h.body)]), [["/v1/nodes/task-done/priority", { priority: "p2" }]]);
    assert.strictEqual(r.stdout,
      "put-node created: art-done @ rev-0\nput-node created: task-done @ rev-1\npriority set: task-done -> p2\n" +
      `put-node batch: 2 created (2 entries)\n  -> remote ${base}\n`);
  } finally {
    srv.close();
  }
});

test("put-node (remote) batch reports per-entry errors and skips, exit 1, no stamp on a skip", async () => {
  const results = [
    { ok: true, status: "skipped", id: "task-a", revision: "rev-a" },
    { ok: false, status: "error", id: "task-b", code: "transition_denied", message: "resolver required", details: [] },
  ];
  const { srv, hits, base } = await batchStub({ results });
  try {
    const r = await runStdinAsync(["put-node", "--if-exists", "skip"], taskMd("task-a", "priority: p1\n") + taskMd("task-b"), remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /put-node skipped: task-a @ rev-a/);
    assert.match(r.stderr, /put-node error: task-b: 207: resolver required; transition_denied/);
    assert.match(r.stdout, /put-node batch: 1 skipped, 1 error \(2 entries\)/);
    assert.ok(!hits.some((h) => h.url.endsWith("/priority")), "a skipped node is never re-stamped");
  } finally {
    srv.close();
  }
});

test("put-node (remote) single create with a priority goes through the set_priority door", async () => {
  const { srv, hits, base } = await batchStub();
  try {
    const file = tmpNodeFile(taskMd("task-one", "priority: p3\n"));
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `put-node created: task-one @ rev-0\npriority set: task-one -> p3\n  -> remote ${base}\n`);
    assert.ok(hits.some((h) => h.url === "/v1/nodes/task-one/priority"));
  } finally {
    srv.close();
  }
});

// --- skip the follow-up priority POST when the server stamps on create ------
// (task-spor-cli-put-node-skip-priority-post-when-server-stamps)

test("put-node (remote) single create sends no priority POST when the server advertises priority_stamped_on_create", async () => {
  const { srv, hits, base } = await capabilityStub({ capable: true });
  try {
    const file = tmpNodeFile(taskMd("task-stamped", "priority: p3\n"));
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `put-node created: task-stamped @ rev-0\n  -> remote ${base}\n`);
    assert.ok(hits.some((h) => h.method === "GET" && h.url === "/v1/status"), "checked /v1/status");
    assert.ok(!hits.some((h) => h.url.endsWith("/priority")), "no follow-up priority POST");
  } finally {
    srv.close();
  }
});

test("put-node (remote) single create still POSTs priority when the server does not advertise the capability", async () => {
  const { srv, hits, base } = await capabilityStub({ capable: false });
  try {
    const file = tmpNodeFile(taskMd("task-unstamped", "priority: p3\n"));
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `put-node created: task-unstamped @ rev-0\npriority set: task-unstamped -> p3\n  -> remote ${base}\n`);
    assert.ok(hits.some((h) => h.url === "/v1/nodes/task-unstamped/priority"));
  } finally {
    srv.close();
  }
});

test("put-node (remote) single create still POSTs priority against an older server with no capabilities field at all", async () => {
  // batchStub answers 404 for GET /v1/status (no such route on an old server),
  // the same "capability absent" reading capabilityStub({capable:false}) gives.
  const { srv, hits, base } = await batchStub();
  try {
    const file = tmpNodeFile(taskMd("task-old-server", "priority: p3\n"));
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /priority set: task-old-server -> p3/);
    assert.ok(hits.some((h) => h.url === "/v1/nodes/task-old-server/priority"));
  } finally {
    srv.close();
  }
});

test("put-node (remote) batch sends no priority POST for any created node when the server stamps on create", async () => {
  const done = taskMd("task-done-stamped", "status: done\npriority: p2\n");
  const art = artMd("art-done-stamped", "task-done-stamped");
  const { srv, hits, base } = await capabilityStub({ capable: true });
  try {
    const r = await runStdinAsync(["put-node", "--if-exists", "skip"], done + art, remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout,
      "put-node created: art-done-stamped @ rev-0\nput-node created: task-done-stamped @ rev-1\n" +
      `put-node batch: 2 created (2 entries)\n  -> remote ${base}\n`);
    assert.ok(!hits.some((h) => h.url.endsWith("/priority")), "no follow-up priority POST for any entry");
  } finally {
    srv.close();
  }
});

test("put-node (remote) a create with no priority never probes /v1/status", async () => {
  const { srv, hits, base } = await capabilityStub({ capable: true });
  try {
    const file = tmpNodeFile(taskMd("task-no-priority"));
    const r = await runAsync(["put-node", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `put-node created: task-no-priority @ rev-0\n  -> remote ${base}\n`);
    assert.ok(!hits.some((h) => h.url === "/v1/status"), "the capability probe is only paid when a create actually carries a priority");
  } finally {
    srv.close();
  }
});

// A bad priority under --if-exists skip/update is judged only AFTER the
// create lands (--if-exists error is the only policy that pre-refuses it),
// via the very call the capability skip guards — so the skip must never let
// an invalid value through just because the server also stamps on create.
test("put-node (remote) still refuses a bad priority on create even when the server advertises priority_stamped_on_create", async () => {
  const { srv, hits, base } = await capabilityStub({ capable: true });
  try {
    const file = tmpNodeFile(taskMd("task-badprio-capable", "priority: high\n"));
    const r = await runAsync(["put-node", file, "--if-exists", "skip"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /priority 'high' not allowed — use p1, p2, or p3/);
    assert.ok(!hits.some((h) => h.url === "/v1/status"), "an invalid priority is refused before the capability is ever probed");
    assert.ok(!hits.some((h) => h.url.endsWith("/priority")), "no priority POST for a value that was never valid");
  } finally {
    srv.close();
  }
});

// review fixes: fenced examples, unindented list entries, positional files,
// legacy priorities on non-creates, CRLF stamping.
test("splitNodeDocuments: a node documenting the node format in a code fence stays one document", () => {
  const raw = taskMd("task-doc", "", "How to write a node:\n\n```markdown\n---\nid: task-example\ntype: task\n---\nbody\n```\n\nDone.");
  assert.deepStrictEqual(splitNodeDocuments(raw), [raw]);
  const tilde = taskMd("task-doc2", "", "~~~\n---\nid: task-example\n---\n~~~");
  assert.deepStrictEqual(splitNodeDocuments(tilde + nodeMd("dec-after")), [tilde, nodeMd("dec-after")]);
  const inline = taskMd("task-inline", "", "Run ```bash npm test``` first.");
  assert.deepStrictEqual(splitNodeDocuments(inline + nodeMd("dec-next")), [inline, nodeMd("dec-next")]);
});

test("splitNodeDocuments: an unindented `- ` edge list still opens a document", () => {
  const b = "---\nid: task-b\ntype: task\nedges:\n- {type: blocks, to: task-a}\n---\nbody b\n";
  assert.deepStrictEqual(splitNodeDocuments(taskMd("task-a") + b), [taskMd("task-a"), b]);
});

test("put-node (local) a positional file is one node even if it looks multi-document", () => {
  const { home, nodes } = fixtureGraph();
  const raw = taskMd("task-file", "", "Body.\n---\nid: task-ghost\ntype: task\n---\nghost");
  const r = run(["put-node", tmpNodeFile(raw)], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readNode(nodes, "task-file"), raw);
  assert.ok(!fs.existsSync(path.join(nodes, "task-ghost.md")));
});

test("put-node (local) a legacy priority on an existing node does not block skip/update; refuses a create", () => {
  const { home, nodes } = fixtureGraph();
  fs.writeFileSync(path.join(nodes, "task-legacy.md"), taskMd("task-legacy", "priority: high\n"));
  const skip = run(["put-node", tmpNodeFile(taskMd("task-legacy", "priority: high\n")), "--if-exists", "skip"], { SPOR_HOME: home });
  assert.strictEqual(skip.status, 0, skip.stderr);
  const rev = gitBlobSha(fs.readFileSync(path.join(nodes, "task-legacy.md")));
  const upd = run(["put-node", tmpNodeFile(taskMd("task-legacy", "priority: high\n", "New body.")), "--if-exists", "update", "--revision", rev], { SPOR_HOME: home });
  assert.strictEqual(upd.status, 0, upd.stderr);
  const create = run(["put-node", tmpNodeFile(taskMd("task-new-legacy", "priority: high\n"))], { SPOR_HOME: home });
  assert.strictEqual(create.status, 1);
  assert.match(create.stderr, /priority 'high' not allowed/);
  assert.ok(!fs.existsSync(path.join(nodes, "task-new-legacy.md")));
});

// issue-spor-put-node-crlf-preservation-violation: put-node must preserve a
// CRLF-terminated input's line endings — with no priority the write is
// byte-identical to the input, and with a priority only the new
// priority_by/_at/_via lines are added, also CRLF.
test("put-node (local) a CRLF node with no priority is written byte-identical", () => {
  const { home, nodes } = fixtureGraph();
  const raw = taskMd("task-crlf-plain").replace(/\n/g, "\r\n");
  const r = run(["put-node", tmpNodeFile(raw)], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readNode(nodes, "task-crlf-plain"), raw);
});

test("put-node (local) stamps a priority on a CRLF node while preserving CRLF line endings", () => {
  const { home, nodes } = fixtureGraph();
  spawnSync("git", ["-C", home, "config", "user.name", "Batch Tester"]);
  spawnSync("git", ["-C", home, "config", "user.email", "batch@example.com"]);
  const r = run(["put-node", tmpNodeFile(taskMd("task-crlf", "priority: p2\n").replace(/\n/g, "\r\n"))], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const written = readNode(nodes, "task-crlf");
  assert.doesNotMatch(written, /(?<!\r)\n/, "every line ending stays CRLF, none flattened to bare LF");
  assert.match(written, /\r\npriority: p2\r\npriority_by: Batch Tester <batch@example\.com>\r\npriority_at: \S+\r\npriority_via: cli\r\n---\r\n/);
});

test("put-node (remote) --if-exists error refuses a bad priority before writing", async () => {
  const { srv, hits, base } = await batchStub();
  try {
    const r = await runAsync(["put-node", tmpNodeFile(taskMd("task-bad", "priority: high\n"))], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /priority 'high' not allowed/);
    assert.strictEqual(hits.length, 0);
  } finally {
    srv.close();
  }
});
