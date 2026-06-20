// spor next — the --limit flag (task-spor-next-limit-flag). --limit N caps the
// queue at N items (default 20, both modes); --limit 0 means "all". Local mode
// passes the flag straight through to lib/queue.js, which translates 0 -> the
// whole ranked set (kernel slice with an unbounded limit). Remote mode pages
// GET /v1/queue at <=100 items/request, so --limit 0 (and any finite N>100) is
// assembled client-side by walking next_offset over offset; the full-set
// aggregates (count, counts_by_*) are taken from the first page. These tests run
// against throwaway graphs / an in-process paging stub — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// No SPOR_*/SUBSTRATE_* leakage; isolate the config homes so the dev's real
// ~/.spor/config.json can't leak a server+token in and flip a local test remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-limit-iso-"));
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
// blocking spawnSync would freeze the test event loop (mirrors in-flight.test.js).
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

// A scratch graph with N open tasks (task-1 .. task-N).
function fixture(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-limit-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(
      path.join(nodes, `task-${i}.md`),
      `---\nid: task-${i}\ntype: task\nrepo: demo\ntitle: Task ${i}\nsummary: Task ${i} for the limit test.\nstatus: open\ndate: 2026-06-${String(i).padStart(2, "0")}\n---\nBody.\n`
    );
  }
  return { dir, nodes };
}

function itemLines(stdout) {
  // Local human render: "N. [score] id — title (...)"; remote: "score  suggest  id".
  return stdout.split("\n").filter((l) => /^\d/.test(l.trim()) && / — | do | close /.test(l));
}

// ---------------- local mode (passthrough to lib/queue.js) ----------------

test("local next --limit 0 shows ALL items (more than the default page)", () => {
  const { nodes } = fixture(25); // > the default 20
  const all = run(["next", "--nodes", nodes, "--limit", "0"]);
  assert.strictEqual(all.status, 0, all.stderr);
  assert.strictEqual(itemLines(all.stdout).length, 25);
  assert.doesNotMatch(all.stdout, /more — raise --limit/);
});

test("local next default caps at 20 and reports the overflow", () => {
  const { nodes } = fixture(25);
  const def = run(["next", "--nodes", nodes]);
  assert.strictEqual(itemLines(def.stdout).length, 20);
  assert.match(def.stdout, /\(5 more — raise --limit\)/);
});

test("local next --limit N caps at N", () => {
  const { nodes } = fixture(25);
  const r = run(["next", "--nodes", nodes, "--limit", "3"]);
  assert.strictEqual(itemLines(r.stdout).length, 3);
  assert.match(r.stdout, /\(22 more — raise --limit\)/);
});

// ---------------- remote mode (paged GET /v1/queue) ----------------

// A stub that paginates a fixed item list, honoring ?limit (capped at `pageCap`)
// and ?offset, and returning next_offset — the contract fetchQueuePaged walks
// (API.md §5). `requests` records each {limit, offset} the client asked for, so a
// test can prove the offset loop fired.
function pagingStub(allItems, pageCap = 100) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const m = /^\/v1\/queue\?(.*)$/.exec(req.url);
    if (req.method === "GET" && m) {
      const p = new URLSearchParams(m[1]);
      const limit = Math.min(pageCap, Math.max(1, Number(p.get("limit")) || 20));
      const offset = Math.max(0, Math.floor(Number(p.get("offset")) || 0));
      requests.push({ limit: Number(p.get("limit")), offset });
      const page = allItems.slice(offset, offset + limit);
      const end = offset + page.length;
      const next_offset = end < allItems.length ? end : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: page,
        count: allItems.length,
        total_count: allItems.length,
        offset,
        returned_count: page.length,
        next_offset,
        truncated: next_offset != null,
        counts_by_type: { task: allItems.length },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, requests }))
  );
}

const mkItems = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `task-${i + 1}`, score: n - i, suggest: "do", why: "queueable" }));

test("remote next default requests limit=20 (one page) and reports overflow", async () => {
  const { srv, base, requests } = await pagingStub(mkItems(50));
  try {
    const r = await runAsync(["next", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: "[]" });
    assert.strictEqual(r.status, 0, r.stderr);
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 20, "default page size is 20");
    assert.strictEqual(q.count, 50, "count is the full-set total");
    assert.deepStrictEqual(requests, [{ limit: 20, offset: 0 }], "exactly one request at limit 20");
  } finally {
    srv.close();
  }
});

test("remote next --limit 0 walks offset across pages and assembles ALL items", async () => {
  // pageCap 3 forces the server to cap each page, so 7 items => 3 pages.
  const { srv, base, requests } = await pagingStub(mkItems(7), 3);
  try {
    const r = await runAsync(["next", "--limit", "0", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: "[]" });
    assert.strictEqual(r.status, 0, r.stderr);
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 7, "every item assembled");
    assert.deepStrictEqual(q.items.map((i) => i.id), mkItems(7).map((i) => i.id), "order preserved across pages");
    // client asks for 100/page; offset walks 0 -> 3 -> 6 (server next_offset)
    assert.deepStrictEqual(requests.map((x) => x.offset), [0, 3, 6], "offset walked the pages");
  } finally {
    srv.close();
  }
});

test("remote next --limit N stops at N even when more pages exist", async () => {
  const { srv, base, requests } = await pagingStub(mkItems(20), 3);
  try {
    const r = await runAsync(["next", "--limit", "5", "--json"], { SPOR_SERVER: base, SPOR_TOKEN: "t", SPOR_FAKE_AGENTS_JSON: "[]" });
    const q = JSON.parse(r.stdout);
    assert.strictEqual(q.items.length, 5, "capped at the requested 5");
    assert.strictEqual(q.count, 20, "count still the full-set total");
    // 5 wanted, server caps pages at 3: page(0,3) then page(3,2) => 2 requests
    assert.deepStrictEqual(requests.map((x) => x.offset), [0, 3]);
  } finally {
    srv.close();
  }
});

test("remote next --limit 0 human render shows all and no overflow line", async () => {
  const { srv, base } = await pagingStub(mkItems(5), 3);
  try {
    const r = await runAsync(["next", "--limit", "0"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(itemLines(r.stdout).length, 5);
    assert.doesNotMatch(r.stdout, /more — raise --limit/);
  } finally {
    srv.close();
  }
});

test("remote next --limit N human render reports the overflow with the --limit 0 hint", async () => {
  const { srv, base } = await pagingStub(mkItems(20), 100);
  try {
    const r = await runAsync(["next", "--limit", "5"], { SPOR_SERVER: base, SPOR_TOKEN: "t" });
    assert.match(r.stdout, /\(15 more — raise --limit, or --limit 0 for all\)/);
  } finally {
    srv.close();
  }
});
