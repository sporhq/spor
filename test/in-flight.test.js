// spor next — the in-flight agent surface (task-spor-cli-in-flight-surface).
// `spor next --json` stamps each queue item with an `in_flight` flag by
// cross-referencing live background agents from `claude agents --json`
// (`spor dispatch` names each agent after its node id); --hide-dispatched drops
// the items that already have one. The cross-reference is CLIENT-SIDE (the
// server can't see local agents), runs over both render paths (local passthrough
// + remote /v1/queue), and FAILS SOFT when the claude binary is absent. Tests
// inject the agent list via SPOR_FAKE_AGENTS_JSON (mirroring SPOR_FAKE_MCP_LIST)
// and run against throwaway graphs / stub servers — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const LIB = path.join(__dirname, "..", "lib");

// No SPOR_*/SUBSTRATE_* leakage; isolate the config homes so the dev's real
// ~/.spor/config.json can't leak a server+token in and flip a local test remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-inflight-iso-"));
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
// Async spawn for the remote tests: their stub server runs IN-PROCESS, so a
// blocking spawnSync would freeze the test event loop and the server could never
// answer the CLI's request (it would time out). Mirrors spor-cli.test.js.
function runAsync(args, env) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}
function runLib(script, args, env) {
  return spawnSync(process.execPath, [path.join(LIB, script), ...args], { encoding: "utf8", env: bare(env) });
}

// A scratch graph with two open tasks (task-a, task-b) in repo `demo`.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-inflight-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const w = (id, title, date) =>
    fs.writeFileSync(
      path.join(nodes, `${id}.md`),
      `---\nid: ${id}\ntype: task\nrepo: demo\ntitle: ${title}\nsummary: ${title} for the in-flight surface test.\nstatus: open\ndate: ${date}\n---\nBody.\n`
    );
  w("task-a", "First demo task", "2026-06-01");
  w("task-b", "Second demo task", "2026-06-02");
  return { dir, nodes };
}

// `claude agents --json` shapes. A background agent's `name` is the node id.
const AGENTS = (extra = []) =>
  JSON.stringify([
    { id: "aa11", name: "task-a", kind: "background", status: "busy", state: "working", cwd: "/x" },
    ...extra,
  ]);

// ---------------- local mode (passthrough capture + annotate) ----------------

test("local next --json stamps in_flight + a dispatched summary on the matched item", () => {
  const { nodes } = fixture();
  const r = run(["next", "--json", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: AGENTS() });
  assert.strictEqual(r.status, 0, r.stderr);
  const q = JSON.parse(r.stdout);
  const byId = Object.fromEntries(q.items.map((it) => [it.id, it]));
  assert.strictEqual(byId["task-a"].in_flight, true);
  assert.strictEqual(byId["task-b"].in_flight, false);
  // the dispatched agent rides along on the in-flight item, not on the idle one
  assert.deepStrictEqual(byId["task-a"].dispatched, [
    { id: "aa11", name: "task-a", state: "working", status: "busy", cwd: "/x" },
  ]);
  assert.ok(!("dispatched" in byId["task-b"]), "no dispatched array on an idle item");
});

test("local next --json: a DONE background agent does not count as in-flight", () => {
  const { nodes } = fixture();
  // task-b has a background agent named after it, but it has finished (state:done)
  const agents = AGENTS([{ id: "bb22", name: "task-b", kind: "background", status: "idle", state: "done" }]);
  const q = JSON.parse(run(["next", "--json", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: agents }).stdout);
  const byId = Object.fromEntries(q.items.map((it) => [it.id, it]));
  assert.strictEqual(byId["task-a"].in_flight, true, "working agent counts");
  assert.strictEqual(byId["task-b"].in_flight, false, "done agent does not");
});

test("local next --json: an INTERACTIVE agent named like a node is ignored (background only)", () => {
  const { nodes } = fixture();
  const agents = JSON.stringify([
    { name: "task-a", kind: "interactive", status: "busy", state: "working", cwd: "/x" },
  ]);
  const q = JSON.parse(run(["next", "--json", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: agents }).stdout);
  assert.strictEqual(q.items.find((it) => it.id === "task-a").in_flight, false);
});

test("local next --json --hide-dispatched drops in-flight items and reports the count", () => {
  const { nodes } = fixture();
  const r = run(["next", "--json", "--hide-dispatched", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: AGENTS() });
  const q = JSON.parse(r.stdout);
  assert.deepStrictEqual(q.items.map((it) => it.id), ["task-b"]);
  assert.strictEqual(q.hidden_dispatched, 1);
  assert.strictEqual(q.count, 1, "count decremented by the hidden item");
});

test("local next default path is byte-identical passthrough (no agent cross-reference)", () => {
  const { nodes } = fixture();
  // Even with agents present, the no-flag path must NOT consult them or differ.
  const viaCli = run(["next", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: AGENTS() });
  const viaLib = runLib("queue.js", ["--nodes", nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test("local next --hide-dispatched human text == queue.js human render when nothing is in flight", () => {
  // Conformance pin (norm-cc-byte-identical-refactor): the reconstructed human
  // render must match lib/queue.js byte-for-byte; if queue.js's line format moves
  // this fails and both must move together.
  const { nodes } = fixture();
  const viaCli = run(["next", "--hide-dispatched", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: "[]" });
  const viaLib = runLib("queue.js", ["--nodes", nodes]);
  assert.strictEqual(viaCli.stdout, viaLib.stdout);
});

test("local next --hide-dispatched human text drops the item and notes the hide", () => {
  const { nodes } = fixture();
  const r = run(["next", "--hide-dispatched", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: AGENTS() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /task-a/, "in-flight item hidden");
  assert.match(r.stdout, /task-b/, "idle item kept");
  assert.match(r.stdout, /\(1 in-flight hidden — --hide-dispatched\)/);
});

test("local next --json fails soft when the claude binary is absent (every item in_flight:false)", () => {
  const { nodes } = fixture();
  // No SPOR_FAKE_AGENTS_JSON; point claude at a nonexistent binary.
  const r = run(["next", "--json", "--nodes", nodes], { SPOR_CLAUDE_CMD: "/nonexistent/claude-xyz" });
  assert.strictEqual(r.status, 0, r.stderr);
  const q = JSON.parse(r.stdout);
  assert.ok(q.items.every((it) => it.in_flight === false), "all items false, no crash");
  assert.strictEqual(r.stderr.trim(), "", "no error emitted");
});

test("local next --json fails soft on unparseable agents output", () => {
  const { nodes } = fixture();
  const r = run(["next", "--json", "--nodes", nodes], { SPOR_FAKE_AGENTS_JSON: "not json at all" });
  assert.strictEqual(r.status, 0, r.stderr);
  const q = JSON.parse(r.stdout);
  assert.ok(q.items.every((it) => it.in_flight === false));
});

// ---------------- remote mode (annotate /v1/queue result) ----------------

function queueStubServer(items) {
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && /^\/v1\/queue\?/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items,
        count: items.length,
        total_count: items.length,
        returned_count: items.length,
        truncated: false,
        next_offset: null,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("remote next --json stamps in_flight by cross-referencing claude agents", async () => {
  const items = [
    { id: "task-a", score: 1, suggest: "do", why: "queueable" },
    { id: "task-b", score: 0.5, suggest: "do", why: "queueable" },
  ];
  const { srv, base } = await queueStubServer(items);
  try {
    const r = await runAsync(["next", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: AGENTS() });
    assert.strictEqual(r.status, 0, r.stderr);
    const q = JSON.parse(r.stdout);
    const byId = Object.fromEntries(q.items.map((it) => [it.id, it]));
    assert.strictEqual(byId["task-a"].in_flight, true);
    assert.strictEqual(byId["task-b"].in_flight, false);
    assert.strictEqual(byId["task-a"].dispatched[0].id, "aa11");
  } finally {
    srv.close();
  }
});

test("remote next --json --hide-dispatched drops in-flight items and decrements count", async () => {
  const items = [
    { id: "task-a", score: 1, suggest: "do", why: "queueable" },
    { id: "task-b", score: 0.5, suggest: "do", why: "queueable" },
  ];
  const { srv, base } = await queueStubServer(items);
  try {
    const r = await runAsync(["next", "--json", "--hide-dispatched"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: AGENTS() });
    const q = JSON.parse(r.stdout);
    assert.deepStrictEqual(q.items.map((it) => it.id), ["task-b"]);
    assert.strictEqual(q.hidden_dispatched, 1);
    assert.strictEqual(q.count, 1);
  } finally {
    srv.close();
  }
});

// task-spor-next-pagination-metadata-coherence: --hide-dispatched shrinks
// .items below whatever the (possibly multi-page) assembly produced, so
// returned_count must shrink with it too or it stops matching q.items.length
// in the payload actually handed to the caller — the same coherence bug this
// task fixed for pagination, surfacing via a different code path.
test("remote next --json --hide-dispatched decrements returned_count to match the hidden-adjusted items", async () => {
  const items = [
    { id: "task-a", score: 1, suggest: "do", why: "queueable" },
    { id: "task-b", score: 0.5, suggest: "do", why: "queueable" },
  ];
  const { srv, base } = await queueStubServer(items);
  try {
    const r = await runAsync(["next", "--json", "--hide-dispatched"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: AGENTS() });
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 1);
    assert.strictEqual(q.returned_count, 1, "returned_count matches the hidden-adjusted item count");
  } finally {
    srv.close();
  }
});

test("remote next --hide-dispatched human render notes the hidden count", async () => {
  const items = [
    { id: "task-a", score: 1, suggest: "do", why: "queueable" },
    { id: "task-b", score: 0.5, suggest: "do", why: "queueable" },
  ];
  const { srv, base } = await queueStubServer(items);
  try {
    const r = await runAsync(["next", "--hide-dispatched"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: AGENTS() });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /task-a/);
    assert.match(r.stdout, /task-b/);
    assert.match(r.stdout, /\(1 in-flight hidden — --hide-dispatched\)/);
  } finally {
    srv.close();
  }
});
