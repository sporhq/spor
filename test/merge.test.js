// merge.test.js — `spor merge <nodes-dir|tarball> [--apply] [--force]
// [--trust-attached-code] [--id-map <file>] [--save-id-map <file>] [--json]` is
// the CLI wrapper over POST /v1/merge (task-spor-cli-merge-verb,
// dec-spor-graph-merge-endpoint): admin-gated pilot-to-org promotion, replacing
// the hand-rolled curl+jq the runbook used until now. REMOTE-ONLY — the
// endpoint merges another graph's nodes INTO the server's graph, so there is
// no local-mode equivalent (the sanctioned norm-spor-cli-mode-parity
// divergence). Defaults to plan mode; --apply is required to write.
//
// Oracle = the request body the CLI sends (nodes array, mode, id_map,
// trust_attached_code, force) + the rendered report + the fail-soft exits —
// server responses are scripted, never a live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawnSync, spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-merge-iso-"));
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
// Local-mode-only: no network involved, safe to block synchronously.
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env) });
}
// Remote-mode runner: the fake server in these tests runs IN-PROCESS, so
// spawnSync would freeze this process's event loop and starve it — the CLI
// child's fetch back to our own http.Server would then hang forever (mirrors
// export.test.js's runBin). Always use this for a test that talks to a
// mergeStub().
function runAsync(args, env) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env) });
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// A scratch source graph: a nodes/ dir with two node files.
function fixtureSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-merge-src-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const a = "---\nid: dec-a\ntype: decision\nsummary: A decision.\n---\nBody A.\n";
  const b = "---\nid: task-b\ntype: task\nstatus: open\nsummary: A task.\n---\nBody B.\n";
  fs.writeFileSync(path.join(nodes, "dec-a.md"), a);
  fs.writeFileSync(path.join(nodes, "task-b.md"), b);
  fs.writeFileSync(path.join(nodes, "ignore.txt"), "not a node\n");
  return { dir, nodes, contents: { "dec-a.md": a, "task-b.md": b } };
}

// Minimal POSIX ustar writer (name/data pairs), mirroring lib/tar.js closely
// enough for a round-trip: nodes/<id>.md entries + two closing zero blocks.
function buildTar(entries) {
  const parts = [];
  for (const { name, data } of entries) {
    const buf = Buffer.from(data, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(buf.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function fixtureTarball(gzip) {
  const tar = buildTar([
    { name: "nodes/dec-a.md", data: "---\nid: dec-a\ntype: decision\nsummary: A decision.\n---\nBody A.\n" },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-merge-tar-"));
  const file = path.join(dir, gzip ? "src.tar.gz" : "src.tar");
  fs.writeFileSync(file, gzip ? zlib.gzipSync(tar) : tar);
  return file;
}

// --- local mode: no equivalent ----------------------------------------------

test("merge (local) is rejected — remote-only, no stack", () => {
  const { dir } = fixtureSource();
  const r = run(["merge", dir], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /merge needs a team graph \(remote mode\)/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("merge with no <source> prints usage, exit 1", () => {
  const r = run(["merge"], {});
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor merge/);
});

// --- remote mode: source loading ---------------------------------------------

function mergeStub({ status = 200, body, onRequest } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* non-JSON body, left null */
      }
      hits.push({ method: req.method, url: req.url, body: parsed });
      if (onRequest) {
        const custom = onRequest(parsed, hits.length);
        if (custom) {
          res.writeHead(custom.status, { "content-type": "application/json" });
          return res.end(JSON.stringify(custom.body));
        }
      }
      if (req.url === "/v1/merge" && req.method === "POST") {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(
          JSON.stringify(
            body || {
              mode: parsed.mode,
              counts: { incoming: parsed.nodes.length, imported: parsed.nodes.length, deduped: 0, remapped: 0, conflicts: 0, errors: 0 },
              imported: parsed.nodes.map(() => ({ id: "x" })),
              deduped: [],
              remapped: [],
              conflicts: [],
              errors: [],
              id_map: {},
              generated_at: "2026-07-07T00:00:00Z",
            }
          )
        );
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found" } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("merge (remote) from a nodes/ directory: reads both .md files, skips non-.md, defaults to plan mode", async () => {
  const { dir } = fixtureSource();
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const hit = hits.find((h) => h.url === "/v1/merge");
    assert.ok(hit, "posted to /v1/merge");
    assert.strictEqual(hit.body.mode, "plan", "defaults to plan mode");
    assert.strictEqual(hit.body.nodes.length, 2, "only the two .md files, not ignore.txt");
    assert.ok(hit.body.nodes.some((n) => n.includes("id: dec-a")));
    assert.ok(hit.body.nodes.some((n) => n.includes("id: task-b")));
    assert.match(r.stdout, /merge plan: 2 nodes from/);
    assert.match(r.stdout, /plan is clean — re-run with --apply to write/);
  } finally {
    srv.close();
  }
});

test("merge (remote) from the export-parent dir (containing nodes/) resolves to the nodes/ subdir", async () => {
  const { dir } = fixtureSource(); // dir/nodes/*.md — dir itself is the export-parent shape
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits[0].body.nodes.length, 2);
  } finally {
    srv.close();
  }
});

test("merge (remote) from a plain tarball extracts nodes/*.md", async () => {
  const file = fixtureTarball(false);
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits[0].body.nodes.length, 1);
    assert.ok(hits[0].body.nodes[0].includes("id: dec-a"));
  } finally {
    srv.close();
  }
});

test("merge (remote) from a gzipped tarball (the `spor export --gzip` format) round-trips", async () => {
  const file = fixtureTarball(true);
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", file], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits[0].body.nodes.length, 1);
  } finally {
    srv.close();
  }
});

test("merge (remote) an empty source dir fails soft, no request sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-merge-empty-"));
  fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no node files found/);
    assert.strictEqual(hits.length, 0);
  } finally {
    srv.close();
  }
});

test("merge (remote) a nonexistent source fails soft, no stack", async () => {
  const r = await runAsync(["merge", "/no/such/path-xyz"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /merge: could not read/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- remote mode: mode / flags -----------------------------------------------

test("merge (remote) --apply sends mode:apply and reports what was applied", async () => {
  const { dir } = fixtureSource();
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir, "--apply"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits[0].body.mode, "apply");
    assert.match(r.stdout, /merge apply: 2 nodes from/);
    assert.match(r.stdout, /applied 2 nodes/);
  } finally {
    srv.close();
  }
});

test("merge (remote) --force and --trust-attached-code pass through in the request body", async () => {
  const { dir } = fixtureSource();
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir, "--apply", "--force", "--trust-attached-code"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(hits[0].body.force, true);
    assert.strictEqual(hits[0].body.trust_attached_code, true);
  } finally {
    srv.close();
  }
});

test("merge (remote) --id-map reads a JSON file and threads it into the request", async () => {
  const { dir } = fixtureSource();
  const mapFile = path.join(dir, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify({ "cap-2026-01-01-1": "cap-2026-01-01-1-abc1234" }));
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir, "--id-map", mapFile], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(hits[0].body.id_map, { "cap-2026-01-01-1": "cap-2026-01-01-1-abc1234" });
  } finally {
    srv.close();
  }
});

test("merge (remote) a bad --id-map file fails soft, no request sent", async () => {
  const { dir } = fixtureSource();
  const badMap = path.join(dir, "bad-map.json");
  fs.writeFileSync(badMap, "not json");
  const { srv, hits, base } = await mergeStub();
  try {
    const r = await runAsync(["merge", dir, "--id-map", badMap], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not read --id-map/);
    assert.strictEqual(hits.length, 0);
  } finally {
    srv.close();
  }
});

test("merge (remote) --save-id-map writes the response's id_map to a file", async () => {
  const { dir } = fixtureSource();
  const outFile = path.join(dir, "next-batch.json");
  const { srv, base } = await mergeStub({
    body: {
      mode: "plan",
      counts: { incoming: 2, imported: 1, deduped: 0, remapped: 1, conflicts: 0, errors: 0 },
      imported: [{ id: "dec-a" }],
      deduped: [],
      remapped: [{ id: "task-b", new_id: "task-b-abc1234" }],
      conflicts: [],
      errors: [],
      id_map: { "task-b": "task-b-abc1234" },
    },
  });
  try {
    const r = await runAsync(["merge", dir, "--save-id-map", outFile], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), { "task-b": "task-b-abc1234" });
    assert.match(r.stdout, /remapped:\n\s+task-b -> task-b-abc1234/);
  } finally {
    srv.close();
  }
});

test("merge (remote) --json prints the raw report verbatim", async () => {
  const { dir } = fixtureSource();
  const report = {
    mode: "plan",
    counts: { incoming: 2, imported: 2, deduped: 0, remapped: 0, conflicts: 0, errors: 0 },
    imported: [{ id: "dec-a" }, { id: "task-b" }],
    deduped: [],
    remapped: [],
    conflicts: [],
    errors: [],
    id_map: {},
    generated_at: "2026-07-07T00:00:00Z",
  };
  const { srv, base } = await mergeStub({ body: report });
  try {
    const r = await runAsync(["merge", dir, "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), report);
  } finally {
    srv.close();
  }
});

// --- remote mode: conflict / error surfaces ----------------------------------

test("merge (remote) plan mode reports conflicts and errors without failing (exit 0)", async () => {
  const { dir } = fixtureSource();
  const { srv, base } = await mergeStub({
    body: {
      mode: "plan",
      counts: { incoming: 2, imported: 0, deduped: 0, remapped: 0, conflicts: 1, errors: 1 },
      imported: [],
      deduped: [],
      remapped: [],
      conflicts: [{ id: "dec-a", reason: "different content, semantic id" }],
      errors: [{ id: "task-b", errors: ["missing summary"] }],
      id_map: {},
    },
  });
  try {
    const r = await runAsync(["merge", dir], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /conflicts:\n\s+dec-a \(different content, semantic id\)/);
    assert.match(r.stdout, /errors:\n\s+task-b: missing summary/);
    assert.match(r.stdout, /plan is not clean/);
  } finally {
    srv.close();
  }
});

test("merge (remote) --apply refused with 409 (unclean plan) exits 1, reports conflicts, does not claim success", async () => {
  const { dir } = fixtureSource();
  const { srv, base } = await mergeStub({
    status: 409,
    body: {
      mode: "apply",
      counts: { incoming: 2, imported: 0, deduped: 0, remapped: 0, conflicts: 1, errors: 0 },
      imported: [],
      deduped: [],
      remapped: [],
      conflicts: [{ id: "dec-a", reason: "different content, semantic id" }],
      errors: [],
      id_map: {},
    },
  });
  try {
    const r = await runAsync(["merge", dir, "--apply"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /apply refused \(409\)/);
    assert.match(r.stdout, /conflicts:\n\s+dec-a/);
    assert.doesNotMatch(r.stdout, /applied \d+ nodes?/, "must not read as a success");
    assert.match(r.stdout, /nothing written/);
  } finally {
    srv.close();
  }
});

test("merge (remote) --apply --json refused with 409 prints the raw report, exit 1", async () => {
  const { dir } = fixtureSource();
  const report = {
    mode: "apply",
    counts: { incoming: 1, imported: 0, deduped: 0, remapped: 0, conflicts: 1, errors: 0 },
    imported: [],
    deduped: [],
    remapped: [],
    conflicts: [{ id: "dec-a" }],
    errors: [],
    id_map: {},
  };
  const { srv, base } = await mergeStub({ status: 409, body: report });
  try {
    const r = await runAsync(["merge", dir, "--apply", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.deepStrictEqual(JSON.parse(r.stdout), report);
  } finally {
    srv.close();
  }
});

// --- remote mode: transport / admin / server errors --------------------------

test("merge (remote) a dead server fails soft with a transport line, no stack", async () => {
  const { dir } = fixtureSource();
  const r = await runAsync(["merge", dir], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("merge (remote) a 403 surfaces the admin hint, exit 1", async () => {
  const { dir } = fixtureSource();
  const { srv, base } = await mergeStub({ status: 403, body: { error: { code: "forbidden", message: "admin privilege required" } } });
  try {
    const r = await runAsync(["merge", dir, "--apply"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /forbidden — admin privilege required/);
    assert.match(r.stderr, /spor whoami/);
  } finally {
    srv.close();
  }
});

test("merge (remote) a non-200/403/409 surfaces the server error message, exit 1", async () => {
  const { dir } = fixtureSource();
  const { srv, base } = await mergeStub({ status: 500, body: { error: { code: "internal", message: "boom" } } });
  try {
    const r = await runAsync(["merge", dir], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /merge error 500: boom/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});
