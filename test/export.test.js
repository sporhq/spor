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
const { hermeticEnv } = require("./helpers/env.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawnSync, spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage (a configured dev box must not flip a
// local-mode test to remote or leak a token), config homes isolated to a temp
// dir. Mirrors blame.test.js / spor-cli.test.js.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-iso-"));
function bare(extra = {}) {
  return hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, ...extra });
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

test("export (local) a long id no ustar split can hold rides a pax header: system tar and lib/tar.js extract both recover it (issue-spor-export-drops-ids-over-ustar-name-limit)", () => {
  const { dir, files } = fixtureGraph();
  const longId = `find-near-dup-${"z".repeat(140)}`; // "<id>.md" alone is well over 100 bytes
  const content = `---\nid: ${longId}\ntype: finding\ntitle: t\nsummary: s\nstatus: open\n---\n\nbody\n`;
  fs.writeFileSync(path.join(dir, "nodes", `${longId}.md`), content);
  const out = path.join(dir, "snap.tar");
  const r = run(["export", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 3 nodes/);
  assert.doesNotMatch(r.stderr, /skipped/);
  // lib/tar.js's own reader (the remote `spor query` / `get --json` fallback path)
  const tar = require(path.join(__dirname, "..", "lib", "tar.js"));
  const byName = Object.fromEntries(tar.extract(fs.readFileSync(out)).map((e) => [e.name, e.data.toString("utf8")]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ["nodes/dec-a.md", `nodes/${longId}.md`, "nodes/task-b.md"]);
  assert.strictEqual(byName[`nodes/${longId}.md`], content);
  for (const [name, c] of Object.entries(files)) assert.strictEqual(byName[name], c, name);
  // a real (pax-aware) tar agrees
  const x = path.join(dir, "x");
  fs.mkdirSync(x);
  assert.strictEqual(spawnSync("tar", ["-xf", out, "-C", x]).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(x, "nodes", `${longId}.md`), "utf8"), content);
});

test("paxRecord's length prefix counts the whole record, across a digit-count carry", () => {
  const { paxRecord } = require(path.join(__dirname, "..", "lib", "tar.js"));
  for (const len of [1, 90, 94, 95, 96, 97, 98, 995, 996]) {
    const rec = paxRecord("path", "x".repeat(len));
    assert.strictEqual(Number(rec.split(" ")[0]), Buffer.byteLength(rec, "utf8"), `value length ${len}`);
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
function exportStub({ body = Buffer.from("TAR-BYTES"), headers = {}, status = 200, errBody } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v1/export" && req.method === "GET") {
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify(errBody || { error: { code: "internal", message: "boom" } }));
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

test("export (remote) GETs /v1/export, writes the body, reports the header count", async () => {
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

test("export (remote) --gzip forwards ?gzip=1 and passes the compressed body through", async () => {
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

test("export (remote) to stdout streams the server body verbatim", async () => {
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

test("export (remote) a dead server fails soft with a transport line, no stack", async () => {
  const r = await runBin(["export"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("export (remote) a non-200 surfaces the server error message, exit 1", async () => {
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

// --- remote mode: --history (git bundle data-exit) --------------------------
// (task-spor-export-cli-verb-extensions)

test("export (remote) --history forwards ?history=1 and reports a git bundle, no count", async () => {
  const body = Buffer.from("PACK\x00git-bundle-bytes");
  const { srv, hits, base } = await exportStub({ body, headers: { "x-substrate-head": "deadbeefcafe0000" } });
  try {
    const out = path.join(ISO_HOME, "history.bundle");
    const r = await runBin(["export", "--history", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Buffer.compare(fs.readFileSync(out), body) === 0, "bundle body passed through verbatim");
    assert.match(r.stderr, /exported git history bundle/);
    assert.doesNotMatch(r.stderr, /\d+ nodes?\b/, "a bundle has no node count"); // not the substring 'node' — Node's own '(node:<pid>)' warnings would match that

    assert.match(r.stderr, /head deadbeefcafe/);
    assert.ok(hits.find((h) => h.url === "/v1/export?history=1"), "?history=1 forwarded");
  } finally {
    srv.close();
  }
});

test("export (remote) --gzip with --history is ignored (no ?gzip=1, no '(gzip)'), with a warning", async () => {
  const { srv, hits, base } = await exportStub({ body: Buffer.from("BUNDLE"), headers: { "x-substrate-head": "abc123def456" } });
  try {
    const out = path.join(ISO_HOME, "history2.bundle");
    const r = await runBin(["export", "--history", "--gzip", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /--gzip has no effect with --history/);
    assert.doesNotMatch(r.stderr, /\(gzip\)/, "no misleading (gzip) on a bundle");
    assert.ok(hits.find((h) => h.url === "/v1/export?history=1"), "history-only, gzip not forwarded");
    assert.ok(!hits.find((h) => /gzip=1/.test(h.url)), "?gzip=1 NOT forwarded with --history");
  } finally {
    srv.close();
  }
});

test("export (remote) --history with no commits surfaces the server's 409, exit 1", async () => {
  const { srv, base } = await exportStub({ status: 409, errBody: { error: { code: "conflict", message: "graph repo has no commits to bundle yet" } } });
  try {
    const r = await runBin(["export", "--history"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /export error 409: graph repo has no commits to bundle yet/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

// --- remote mode: --auth (admin-gated restore backup) -----------------------

test("export (remote) --auth forwards ?auth=1 and reports the auth-file count", async () => {
  const body = Buffer.from("FULL-TARBALL-WITH-AUTH");
  const { srv, hits, base } = await exportStub({ body, headers: { "x-substrate-node-count": "9", "x-substrate-auth-files": "3", "x-substrate-head": "0011223344556677" } });
  try {
    const out = path.join(ISO_HOME, "restore.tar");
    const r = await runBin(["export", "--auth", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Buffer.compare(fs.readFileSync(out), body) === 0);
    assert.match(r.stderr, /exported 9 nodes \+ 3 auth files/);
    assert.ok(hits.find((h) => h.url === "/v1/export?auth=1"), "?auth=1 forwarded");
  } finally {
    srv.close();
  }
});

test("export (remote) --auth --gzip forwards ?auth=1&gzip=1 and reports (gzip)", async () => {
  const { srv, hits, base } = await exportStub({ body: Buffer.from("GZ"), headers: { "x-substrate-node-count": "1", "x-substrate-auth-files": "1" } });
  try {
    const out = path.join(ISO_HOME, "restore.tar.gz");
    const r = await runBin(["export", "--auth", "--gzip", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /exported 1 node \+ 1 auth file \(gzip\)/);
    assert.ok(hits.find((h) => h.url === "/v1/export?auth=1&gzip=1"), "?auth=1&gzip=1 forwarded");
  } finally {
    srv.close();
  }
});

test("export (remote) --auth as a non-admin surfaces the server's 403, exit 1", async () => {
  const { srv, base } = await exportStub({ status: 403, errBody: { error: { code: "forbidden", message: "exporting auth state requires admin privilege: a stewards edge to the graph root" } } });
  try {
    const r = await runBin(["export", "--auth"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /export error 403: exporting auth state requires admin privilege/);
    assert.doesNotMatch(r.stderr, /at Object|Error:/);
  } finally {
    srv.close();
  }
});

// --- guards: remote-only modes, mutual exclusion ----------------------------

test("export (local) --history is rejected as remote-only, exit 1, no stack", () => {
  const { dir } = fixtureGraph();
  const r = run(["export", "--history"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--history is remote-only/);
  assert.match(r.stderr, /SPOR_SERVER/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("export (local) --auth is rejected as remote-only, exit 1, no stack", () => {
  const { dir } = fixtureGraph();
  const r = run(["export", "--auth"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--auth is remote-only/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

test("export --history and --auth together is rejected, exit 1", () => {
  const { dir } = fixtureGraph();
  const r = run(["export", "--history", "--auth"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--history and --auth are different export modes/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// --- --assets (task-split-spor-e0dad1d2959b) ---------------------------------
// The asset-inclusive export: GET /v1/export?assets=1 remotely, the same
// layout (assets/sha256/<2>/<hex> + assets/manifest.json LAST, spor-assets/1)
// built from $SPOR_HOME/assets/ locally. The oracle is the archive's entries,
// the request the remote arm makes, and what lands on disk / stderr.
const crypto = require("node:crypto");
const { gitEnv } = require("./helpers/git.js");
const tarLib = require("../lib/tar.js");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const objName = (hex) => `assets/sha256/${hex.slice(0, 2)}/${hex}`;
function descriptor(id, hex) {
  return `---\nid: ${id}\ntype: artifact\nsummary: An image.\nasset_digest: sha256:${hex}\n---\nImage.\n`;
}
function putObject(dir, bytes) {
  const hex = sha(bytes);
  const p = path.join(dir, objName(hex));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return hex;
}
function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  assert.strictEqual(r.status, 0, r.stderr);
}

test("export (local) --assets carries current AND history-only descriptor bytes, manifest last", () => {
  const { dir, nodes } = fixtureGraph();
  const cur = Buffer.from("current-image-bytes");
  const old = Buffer.from("historical-image-bytes");
  const curHex = putObject(dir, cur);
  const oldHex = putObject(dir, old);
  git(dir, ["init", "-q"]);
  // A descriptor that once named `old`, then was re-pointed at `cur`.
  fs.writeFileSync(path.join(nodes, "art-img.md"), descriptor("art-img", oldHex));
  git(dir, ["add", "nodes"]);
  git(dir, ["commit", "-qm", "v1"]);
  fs.writeFileSync(path.join(nodes, "art-img.md"), descriptor("art-img", curHex));
  git(dir, ["add", "nodes"]);
  git(dir, ["commit", "-qm", "v2"]);
  const out = path.join(dir, "a.tar");
  const r = run(["export", "--assets", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /exported 3 nodes \+ 2 asset objects/);
  assert.doesNotMatch(r.stderr, /incomplete/);
  const entries = tarLib.extract(fs.readFileSync(out));
  const names = entries.map((e) => e.name);
  assert.strictEqual(names[names.length - 1], "assets/manifest.json", "manifest is the last entry");
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  assert.ok(byName.get(objName(curHex)).equals(cur));
  assert.ok(byName.get(objName(oldHex)).equals(old));
  const m = JSON.parse(byName.get("assets/manifest.json").toString("utf8"));
  assert.strictEqual(m.format, "spor-assets/1");
  assert.strictEqual(m.inventory, 2);
  const cur1 = m.objects.find((o) => o.digest === `sha256:${curHex}`);
  const old1 = m.objects.find((o) => o.digest === `sha256:${oldHex}`);
  assert.deepStrictEqual([cur1.current, old1.current], [true, false]);
  assert.deepStrictEqual(old1.descriptors, ["art-img"]);
  assert.deepStrictEqual([m.missing, m.corrupt, m.unreadable], [[], [], []]);
});

test("export (local) --assets names missing and corrupt digests on stderr and in the manifest, still exits 0", () => {
  const { dir, nodes } = fixtureGraph();
  const goneHex = sha(Buffer.from("never-stored"));
  const badHex = putObject(dir, Buffer.from("will-rot"));
  fs.writeFileSync(path.join(dir, objName(badHex)), "rotted");
  fs.writeFileSync(path.join(nodes, "art-gone.md"), descriptor("art-gone", goneHex));
  fs.writeFileSync(path.join(nodes, "art-bad.md"), descriptor("art-bad", badHex));
  const out = path.join(dir, "a.tar.gz");
  const r = run(["export", "--assets", "--gzip", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /0 asset objects \(gzip\)/);
  assert.match(r.stderr, /asset export is incomplete — 1 missing, 1 corrupt/);
  assert.match(r.stderr, new RegExp(`missing: sha256:${goneHex} \\(art-gone\\)`));
  assert.match(r.stderr, new RegExp(`corrupt: sha256:${badHex} \\(art-bad\\)`));
  const entries = tarLib.extract(zlib.gunzipSync(fs.readFileSync(out)));
  assert.ok(!entries.some((e) => e.name.startsWith("assets/sha256/")), "a rotted object is never exported under its name");
  const m = JSON.parse(entries[entries.length - 1].data.toString("utf8"));
  assert.deepStrictEqual(m.missing.map((x) => x.digest), [`sha256:${goneHex}`]);
  assert.deepStrictEqual(m.corrupt.map((x) => x.digest), [`sha256:${badHex}`]);
});

test("export (local) without --assets is byte-identical to before (node-only, no assets/ entries)", () => {
  const { dir, nodes, files } = fixtureGraph();
  const hex = putObject(dir, Buffer.from("img"));
  fs.writeFileSync(path.join(nodes, "art-img.md"), descriptor("art-img", hex));
  const out = path.join(dir, "n.tar");
  const r = run(["export", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const names = Object.keys(parseTar(fs.readFileSync(out))).sort();
  assert.deepStrictEqual(names, [...Object.keys(files), "nodes/art-img.md"].sort());
  assert.ok(fs.readFileSync(out).equals(tarLib.buildTarball(tarLib.collectNodeEntries(nodes).descriptors)));
});

test("export (local) --assets reads history from the enclosing repo when the graph home is nested in one", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-export-nested-"));
  const dir = path.join(repo, "team-graph");
  const nodes = path.join(dir, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const oldHex = putObject(dir, Buffer.from("only-in-history"));
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(nodes, "art-img.md"), descriptor("art-img", oldHex));
  git(repo, ["add", "-A", "team-graph/nodes"]);
  git(repo, ["commit", "-qm", "v1"]);
  fs.rmSync(path.join(nodes, "art-img.md"));
  const out = path.join(repo, "n.tar");
  const r = run(["export", "--assets", "--out", out], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /0 nodes \+ 1 asset object/);
  const m = JSON.parse(tarLib.extract(fs.readFileSync(out)).pop().data.toString("utf8"));
  assert.deepStrictEqual(m.objects.map((o) => [o.digest, o.current]), [[`sha256:${oldHex}`, false]]);
});

test("export --assets --history is refused client-side, in either mode, exit 1", async () => {
  const { dir } = fixtureGraph();
  const r = run(["export", "--assets", "--history"], { SPOR_HOME: dir });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--assets cannot be combined with --history/);
  const { srv, hits, base } = await exportStub();
  try {
    const rr = await runBin(["export", "--assets", "--history"], remoteEnv(base));
    assert.strictEqual(rr.status, 1);
    assert.match(rr.stderr, /--assets cannot be combined with --history/);
    assert.strictEqual(hits.length, 0, "no request is made");
  } finally {
    srv.close();
  }
});

// A well-formed remote asset export body: nodes + objects + manifest (last).
function assetArchive({ objects = [], missing = [], dropManifest = false, lieAbout = null } = {}) {
  const entries = [{ name: "nodes/dec-a.md", data: Buffer.from("---\nid: dec-a\n---\n"), mtime: 0 }];
  const listed = [];
  for (const b of objects) {
    const hex = sha(b);
    listed.push({ digest: `sha256:${hex}`, bytes: b.length, descriptors: ["art-x"], current: true });
    entries.push({ name: objName(hex), data: b, mtime: 0 });
  }
  if (lieAbout) listed.push({ digest: `sha256:${sha(lieAbout)}`, bytes: lieAbout.length, descriptors: ["art-y"], current: true });
  const manifest = { format: "spor-assets/1", generated_at: "2026-10-10T00:00:00.000Z", head: null, tenant: "t", inventory: listed.length + missing.length, objects: listed, missing, corrupt: [], unreadable: [] };
  if (!dropManifest) entries.push({ name: "assets/manifest.json", data: Buffer.from(JSON.stringify(manifest)), mtime: 0 });
  return tarLib.buildTarballEntries(entries);
}
const ASSET_HEADERS = { "x-substrate-node-count": "1", "x-spor-asset-format": "spor-assets/1", "x-spor-asset-inventory": "1" };

test("export (remote) --assets forwards ?assets=1, verifies the manifest, reports the object count", async () => {
  const body = assetArchive({ objects: [Buffer.from("png-bytes")] });
  const { srv, hits, base } = await exportStub({ body, headers: ASSET_HEADERS });
  try {
    const out = path.join(ISO_HOME, "assets.tar");
    const r = await runBin(["export", "--assets", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(out).equals(body), "body passed through verbatim");
    assert.match(r.stderr, /exported 1 node \+ 1 asset object →/);
    assert.ok(hits.find((h) => h.url === "/v1/export?assets=1"));
  } finally {
    srv.close();
  }
});

test("export (remote) --assets --auth --gzip forwards all three params and checks the gunzipped archive", async () => {
  const body = zlib.gzipSync(assetArchive({ objects: [Buffer.from("a"), Buffer.from("b")] }));
  const { srv, hits, base } = await exportStub({ body, headers: { ...ASSET_HEADERS, "x-substrate-auth-files": "2" } });
  try {
    const r = await runBin(["export", "--assets", "--auth", "--gzip"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.equals(body));
    assert.match(r.stderr, /1 node \+ 2 auth files \+ 2 asset objects \(gzip\)/);
    assert.ok(hits.find((h) => h.url === "/v1/export?assets=1&auth=1&gzip=1"));
  } finally {
    srv.close();
  }
});

test("export (remote) --assets surfaces the manifest's missing list on stderr", async () => {
  const gone = { digest: `sha256:${sha(Buffer.from("lost"))}`, descriptors: ["art-lost"], current: true };
  const body = assetArchive({ missing: [gone] });
  const { srv, base } = await exportStub({ body, headers: ASSET_HEADERS });
  try {
    const r = await runBin(["export", "--assets", "--out", path.join(ISO_HOME, "m.tar")], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /incomplete — 1 missing/);
    assert.match(r.stderr, new RegExp(`missing: ${gone.digest} \\(art-lost\\)`));
  } finally {
    srv.close();
  }
});

test("export (remote) --assets with no manifest (a cut-short transfer) exits 1 and writes nothing", async () => {
  const body = assetArchive({ objects: [Buffer.from("x")], dropManifest: true });
  const { srv, base } = await exportStub({ body, headers: ASSET_HEADERS });
  try {
    const out = path.join(ISO_HOME, "cut.tar");
    const r = await runBin(["export", "--assets", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /cut short/);
    assert.ok(!fs.existsSync(out), "nothing written");
  } finally {
    srv.close();
  }
});

test("export (remote) --assets with a truncated gzip stream exits 1, nothing on stdout", async () => {
  const full = zlib.gzipSync(assetArchive({ objects: [crypto.randomBytes(4096)] }));
  const { srv, base } = await exportStub({ body: full.subarray(0, full.length - 40), headers: ASSET_HEADERS });
  try {
    const r = await runBin(["export", "--assets", "--gzip"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /gzip stream is incomplete/);
    assert.strictEqual(r.stdout.length, 0);
  } finally {
    srv.close();
  }
});

test("export (remote) --assets refuses a manifest that lists an object the archive lacks", async () => {
  const body = assetArchive({ lieAbout: Buffer.from("not-in-archive") });
  const { srv, base } = await exportStub({ body, headers: ASSET_HEADERS });
  try {
    const r = await runBin(["export", "--assets"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /does not carry it/);
  } finally {
    srv.close();
  }
});

test("export (remote) --assets against a server that ignores ?assets=1 (no format header) exits 1", async () => {
  const { srv, base } = await exportStub({ body: Buffer.from("NODE-ONLY"), headers: { "x-substrate-node-count": "1" } });
  try {
    const out = path.join(ISO_HOME, "old.tar");
    const r = await runBin(["export", "--assets", "--out", out], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /predates GET \/v1\/export\?assets=1/);
    assert.ok(!fs.existsSync(out));
  } finally {
    srv.close();
  }
});

test("export (remote) --assets: a transfer the server aborts mid-body is a failure, nothing written", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/x-tar", ...ASSET_HEADERS });
    res.write(Buffer.alloc(2048, 1));
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const out = path.join(ISO_HOME, "abort.tar");
    const r = await runBin(["export", "--assets", "--out", out], remoteEnv(`http://127.0.0.1:${srv.address().port}`));
    assert.strictEqual(r.status, 1);
    assert.ok(!fs.existsSync(out));
    assert.doesNotMatch(r.stderr, /at Object/);
  } finally {
    srv.close();
  }
});
