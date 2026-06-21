// export.test.js — `spor export [--gzip] [--out <file>]` is the shell front-door
// for GET /v1/export (task-spor-export-cli-verb): the nodes/ ustar tarball for
// seeding a local read replica or bootstrapping a fresh graph, replacing a
// hand-rolled `curl … | tar x`. Dual-mode (norm-spor-cli-mode-parity): local
// builds the tarball from the graph home (lib/tar.js, a byte-faithful twin of
// the server's ustar writer); remote downloads /v1/export and passes the body
// through.
//
// Oracle = the bytes the CLI produces (parsed back as ustar, compared
// byte-for-byte to the source nodes) + the request the remote arm makes + the
// fail-soft exits — never a live graph or the server's framing (remote
// responses are scripted).
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
const isWin = process.platform === "win32";

// Env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip a
// local-mode test to remote or leak a token), config homes isolated to a temp
// dir. Mirrors blame.test.js / spor-cli.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-iso-"));
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
// Binary-safe runner: stdout collected as a Buffer (the tarball is binary).
function runBin(args, env) {
  return new Promise((resolve) => {
    const chunks = [];
    let errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => chunks.push(d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: Buffer.concat(chunks), stderr: errOut }));
  });
}

// A minimal ustar reader: { entryName -> content Buffer }. Stops at the first
// all-zero block (the closing pair). Enough to assert the export round-trips.
function parseTar(buf) {
  const entries = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // closing zero block
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOct = header.subarray(124, 135).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOct, 8);
    off += 512;
    entries[name] = Buffer.from(buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// A scratch graph with two node files (known bytes) plus a non-.md file the
// export must ignore.
function fixtureGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-"));
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const a = `---\nid: dec-a\ntype: decision\nsummary: A decision.\n---\nBody A — with a trailing newline.\n`;
  const b = `---\nid: task-b\ntype: task\nstatus: open\nsummary: A task.\n---\nBody B.\n`;
  fs.writeFileSync(path.join(nodes, "dec-a.md"), a);
  fs.writeFileSync(path.join(nodes, "task-b.md"), b);
  fs.writeFileSync(path.join(nodes, "ignore.txt"), "not a node\n");
  return { dir, nodes, files: { "nodes/dec-a.md": a, "nodes/task-b.md": b } };
}

// --- local mode -------------------------------------------------------------

test("export (local) --out writes a ustar tarball that reproduces nodes/ byte-for-byte", () => {
  const { dir, files } = fixtureGraph();
  const out = path.join(dir, "snap.tar");
  const r = run(["export", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "", "stdout stays clean when --out is given");
  assert.match(r.stderr, /exported 2 nodes/);
  const entries = parseTar(fs.readFileSync(out));
  assert.deepStrictEqual(Object.keys(entries).sort(), ["nodes/dec-a.md", "nodes/task-b.md"]);
  for (const [name, content] of Object.entries(files)) {
    assert.strictEqual(entries[name].toString("utf8"), content, `${name} byte-identical`);
  }
});

test("export (local) skips non-.md files", () => {
  const { dir } = fixtureGraph();
  const out = path.join(dir, "snap.tar");
  run(["export", "--out", out], { SPOR_HOME: dir });
  const entries = parseTar(fs.readFileSync(out));
  assert.ok(!("nodes/ignore.txt" in entries), "non-node file excluded");
});

test("export (local) --gzip writes a gzip that gunzips to the same tar", () => {
  const { dir, files } = fixtureGraph();
  const out = path.join(dir, "snap.tar.gz");
  const r = run(["export", "--gzip", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 2 nodes \(gzip\)/);
  const raw = zlib.gunzipSync(fs.readFileSync(out));
  const entries = parseTar(raw);
  for (const [name, content] of Object.entries(files)) {
    assert.strictEqual(entries[name].toString("utf8"), content);
  }
});

test("export (local) with no --out streams the tarball to stdout, feedback to stderr", async () => {
  const { dir, files } = fixtureGraph();
  const r = await runBin(["export"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 2 nodes.*→ stdout/);
  const entries = parseTar(r.stdout);
  assert.deepStrictEqual(Object.keys(entries).sort(), ["nodes/dec-a.md", "nodes/task-b.md"]);
  assert.strictEqual(entries["nodes/dec-a.md"].toString("utf8"), files["nodes/dec-a.md"]);
});

test("export (local) --gzip to stdout pipes round-trip", async () => {
  const { dir, files } = fixtureGraph();
  const r = await runBin(["export", "--gzip"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const entries = parseTar(zlib.gunzipSync(r.stdout));
  assert.strictEqual(entries["nodes/task-b.md"].toString("utf8"), files["nodes/task-b.md"]);
});

test("export (local) a single-node graph reports the singular and exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-one-"));
  fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nodes", "dec-only.md"), "---\nid: dec-only\ntype: decision\nsummary: x.\n---\nb.\n");
  const out = path.join(dir, "s.tar");
  const r = run(["export", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 1 node\b/);
  assert.ok(!/exported 1 nodes/.test(r.stderr), "singular, not '1 nodes'");
});

test("export (local) an empty graph is a valid empty archive (exit 0)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-empty-"));
  fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
  const out = path.join(dir, "s.tar");
  const r = run(["export", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 0 nodes/);
  const buf = fs.readFileSync(out);
  assert.strictEqual(buf.length, 1024, "two closing zero blocks only");
  assert.ok(buf.every((b) => b === 0));
});

test("export (local) with no graph home points at init, no stack", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-nohome-"));
  fs.rmSync(home, { recursive: true, force: true }); // start absent
  const r = run(["export"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no Spor graph/);
  assert.match(r.stderr, /spor init/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("export (local) an unwritable --out fails soft with a clear line, no stack", () => {
  const { dir } = fixtureGraph();
  const r = run(["export", "--out", path.join(dir, "no-such-dir", "s.tar")], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not write/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- remote mode ------------------------------------------------------------

// Returns a fixed body + scriptable headers/status; records the request path so
// the ?gzip= passthrough is observable.
function exportStub({ body = Buffer.from("TAR-BYTES"), headers = {}, status = 200 } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v1/export" && req.method === "GET") {
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "internal", message: "boom" } }));
      }
      res.writeHead(200, { "content-type": "application/x-tar", ...headers });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_HOME: ISO_HOME, SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("export (remote) GETs /v1/export, writes the body, reports the header count", { skip: isWin }, async () => {
  const body = Buffer.from("USTAR-PAYLOAD-FROM-SERVER");
  const { srv, hits, base } = await exportStub({ body, headers: { "x-substrate-node-count": "42", "x-substrate-head": "abcdef1234567890" } });
  try {
    const out = path.join(ISO_HOME, "remote.tar");
    const r = await runBin(["export", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Buffer.compare(fs.readFileSync(out), body) === 0, "body passed through verbatim");
    assert.match(r.stderr, /exported 42 nodes/);
    assert.match(r.stderr, /head abcdef123456/); // first 12 chars
    const hit = hits.find((h) => h.method === "GET" && h.url === "/v1/export");
    assert.ok(hit, "GET /v1/export (no ?gzip)");
  } finally {
    srv.close();
  }
});

test("export (remote) --gzip forwards ?gzip=1 and passes the compressed body through", { skip: isWin }, async () => {
  const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00]); // gzip magic + junk
  const { srv, hits, base } = await exportStub({ body, headers: { "x-substrate-node-count": "7" } });
  try {
    const out = path.join(ISO_HOME, "remote.tar.gz");
    const r = await runBin(["export", "--gzip", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Buffer.compare(fs.readFileSync(out), body) === 0);
    assert.match(r.stderr, /exported 7 nodes \(gzip\)/);
    assert.ok(hits.find((h) => h.url === "/v1/export?gzip=1"), "?gzip=1 forwarded");
  } finally {
    srv.close();
  }
});

test("export (remote) to stdout streams the server body verbatim", { skip: isWin }, async () => {
  const body = Buffer.from("STREAMED-TARBALL");
  const { srv, base } = await exportStub({ body, headers: { "x-substrate-node-count": "1" } });
  try {
    const r = await runBin(["export"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Buffer.compare(r.stdout, body) === 0);
    assert.match(r.stderr, /exported 1 node\b/);
  } finally {
    srv.close();
  }
});

test("export (remote) a dead server fails soft with a transport line, no stack", { skip: isWin }, async () => {
  const r = await runBin(["export"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("export (remote) a non-200 surfaces the server error message, exit 1", { skip: isWin }, async () => {
  const { srv, base } = await exportStub({ status: 500 });
  try {
    const r = await runBin(["export"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /export error 500: boom/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});
